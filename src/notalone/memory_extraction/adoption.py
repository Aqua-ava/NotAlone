"""提取结果的自动采纳外壳：主体分流、写入裁决、置信度门槛、删除指纹。"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import UUID, uuid4

from notalone.ledger.models import LedgerEntry, LedgerOutcome
from notalone.ledger.ports import OutboundLedgerPort
from notalone.memory.models import (
    AdoptionMethod,
    ConfirmedMemory,
    ConfirmedMemoryStatus,
    MemoryCandidate,
    MemoryCandidateStatus,
    MemoryCategory,
    MemoryTopic,
    OwnerMemory,
)
from notalone.memory.ports import MemoryPort, OwnerMemoryPort
from notalone.memory_extraction.adjudication import (
    AdjudicationAction,
    AdjudicationRuntime,
    SimilarMemory,
    similarity,
)
from notalone.memory_extraction.dimensions import (
    DimensionRelease,
    dimension_key,
)
from notalone.memory_extraction.errors import ExtractionRuntimeError
from notalone.memory_extraction.flow import ExtractionOutcome
from notalone.memory_extraction.models import ExtractedFact, FactSubject
from notalone.memory_extraction.pragmatics import (
    MemoryDisposition,
    PragmaticDecision,
    PragmaticInterpreter,
)
from notalone.memory_trace import TraceWriteError
from notalone.memory_trace.context import (
    current_trace,
    record,
    record_ledger_entry,
)
from notalone.scopes import ContactScope

DEFAULT_CONFIDENCE_THRESHOLD = 0.7
DEFAULT_SIMILARITY_THRESHOLD = 0.2
# 只有明确表示没有风险的事实才允许绕过人工确认；未知标签按风险处理。
AUTO_ADOPTABLE_RISK_FLAGS = frozenset({"", "low", "low_risk", "none", "无", "低风险"})


@dataclass(frozen=True, slots=True)
class AdoptionStats:
    """一次采纳的统计。"""

    adopted: int = 0
    updated: int = 0
    pending: int = 0
    skipped_duplicate: int = 0
    skipped_deleted: int = 0
    rejected_by_contract: int = 0
    skipped_non_memory: int = 0


@dataclass(frozen=True, slots=True)
class _PoolItem:
    memory_id: UUID
    text: str
    category: MemoryCategory
    topic: MemoryTopic
    source_ids: tuple[UUID, ...] = ()
    version: object = None


class MemoryAdoption:
    """把通过证据契约的候选按主体分流落库，演变经写入裁决接管。"""

    __slots__ = (
        "_memory_port",
        "_owner_memory_port",
        "_adjudication_runtime",
        "_ledger",
        "_threshold",
        "_similarity_threshold",
        "_pragmatic_interpreter",
        "_dimension_release",
    )

    def __init__(
        self,
        *,
        memory_port: MemoryPort,
        owner_memory_port: OwnerMemoryPort | None = None,
        adjudication_runtime: AdjudicationRuntime | None = None,
        ledger: OutboundLedgerPort | None = None,
        confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
        similarity_threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
        pragmatic_interpreter: PragmaticInterpreter | None = None,
        dimension_release: DimensionRelease | None = None,
    ) -> None:
        if memory_port is None:
            raise TypeError("必须显式注入联系人级记忆 port。")
        if not 0.0 < confidence_threshold <= 1.0:
            raise ValueError("置信度门槛必须在 0 到 1 之间。")
        # None 表示沿用台账默认放行表与运维开关（ADR-036），不是"全部放行"。
        dimension_release = DimensionRelease.resolve(dimension_release)
        self._memory_port = memory_port
        self._owner_memory_port = owner_memory_port
        self._adjudication_runtime = adjudication_runtime
        self._ledger = ledger
        self._threshold = confidence_threshold
        self._similarity_threshold = similarity_threshold
        self._pragmatic_interpreter = (
            pragmatic_interpreter or PragmaticInterpreter()
        )
        self._dimension_release = dimension_release

    def adopt(self, scope: ContactScope, outcome: ExtractionOutcome) -> AdoptionStats:
        """按主体逐条采纳；晚发生故障可保留此前已提交的结果。"""

        if outcome.failure_reason is not None:
            return AdoptionStats(rejected_by_contract=outcome.rejected_count)

        pool_started_at = datetime.now(timezone.utc)
        contact_pool = self._contact_pool(scope)
        owner_pool = self._owner_pool(scope.owner_id)
        deleted = self._deleted_texts(scope)
        record(
            "memory_pool",
            {
                "contact_pool": contact_pool,
                "owner_pool": owner_pool,
                "scope": scope,
                "rule": "active_memory_pool",
            },
            dependency_ids=tuple(
                dict.fromkeys(
                    source
                    for item in (*contact_pool, *owner_pool)
                    for source in (item.memory_id, *item.source_ids)
                )
            ),
            started_at=pool_started_at,
        )

        adopted = updated = pending = duplicate = deleted_skip = 0
        skipped_non_memory = 0
        for index, fact in enumerate(outcome.accepted):
            trace = current_trace()
            if trace is not None:
                trace.candidate_trace_id = (
                    outcome.candidate_trace_ids[index]
                    if outcome.candidate_trace_ids
                    else uuid4()
                )
            pragmatic_started_at = datetime.now(timezone.utc)
            pragmatic_decision = self._pragmatic_interpreter.interpret(fact)
            record(
                "pragmatics",
                {
                    "input": fact,
                    "decision": pragmatic_decision,
                    "phase": "adoption",
                },
                started_at=pragmatic_started_at,
            )
            if pragmatic_decision.disposition is MemoryDisposition.NONE:
                record(
                    "candidate_result",
                    {
                        "disposition": "non_memory",
                        "not_executed": [
                            "deleted_fingerprint",
                            "duplicate",
                            "adoption_gates",
                            "similarity",
                            "adjudication",
                            "write",
                        ],
                    },
                )
                skipped_non_memory += 1
                continue
            prepare_started_at = datetime.now(timezone.utc)
            before = fact
            fact = self._pragmatic_interpreter.prepare_for_adoption(
                fact,
                decision=pragmatic_decision,
            )
            record(
                "prepare_for_adoption",
                {"before": before, "after": fact},
                started_at=prepare_started_at,
            )
            fingerprint_started_at = datetime.now(timezone.utc)
            normalized = _normalize(fact.text)
            record(
                "deleted_fingerprint",
                {
                    "rule": "whitespace_lowercase_exact",
                    "candidate_fingerprint": hashlib.sha256(
                        normalized.encode()
                    ).hexdigest(),
                    "deleted_fingerprints": [
                        hashlib.sha256(value.encode()).hexdigest()
                        for value in sorted(deleted)
                    ],
                    "matched": normalized in deleted,
                },
                started_at=fingerprint_started_at,
            )
            if normalized in deleted:
                record(
                    "candidate_result",
                    {
                        "disposition": "deleted_fingerprint",
                        "not_executed": [
                            "duplicate",
                            "adoption_gates",
                            "similarity",
                            "adjudication",
                            "write",
                        ],
                    },
                )
                deleted_skip += 1
                continue
            pool = (
                owner_pool
                if fact.subject is FactSubject.SELF
                else contact_pool
            )
            duplicate_started_at = datetime.now(timezone.utc)
            matching = [
                item for item in pool if normalized == _normalize(item.text)
            ]
            record(
                "duplicate",
                {
                    "rule": "whitespace_lowercase_exact",
                    "compared": pool,
                    "matches": [item.memory_id for item in matching],
                    "kind": "active_memory",
                },
                started_at=duplicate_started_at,
            )
            if matching:
                record(
                    "candidate_result",
                    {
                        "disposition": "duplicate_memory",
                        "matched_ids": [item.memory_id for item in matching],
                    },
                )
                duplicate += 1
                continue
            if self._pending_exists(scope, fact):
                record(
                    "candidate_result", {"disposition": "duplicate_candidate"}
                )
                duplicate += 1
                continue
            gates_started_at = datetime.now(timezone.utc)
            passed = self._passes_all_adoption_gates(
                fact,
                pragmatic_decision=pragmatic_decision,
            )
            record(
                "adoption_gates",
                {
                    "pragmatic": {
                        "actual": pragmatic_decision.disposition,
                        "required": MemoryDisposition.CONFIRMABLE,
                        "passed": pragmatic_decision.disposition
                        is MemoryDisposition.CONFIRMABLE,
                    },
                    "confidence": {
                        "actual": fact.confidence,
                        "threshold": self._threshold,
                        "passed": fact.confidence >= self._threshold,
                    },
                    "risk": {
                        "actual": fact.risk_flags,
                        "allowed": sorted(AUTO_ADOPTABLE_RISK_FLAGS),
                        "passed": all(
                            flag.strip().lower() in AUTO_ADOPTABLE_RISK_FLAGS
                            for flag in fact.risk_flags
                        ),
                    },
                    "dimension": {
                        "key": dimension_key(fact),
                        "gate_enabled": self._dimension_release.gate_enabled,
                        "allowed": sorted(self._dimension_release.allowed),
                        "released": sorted(self._dimension_release.released),
                        "passed": self._dimension_release.allows(fact),
                    },
                    "passed": passed,
                },
                started_at=gates_started_at,
                status="passed" if passed else "pending",
            )
            if not passed:
                self._create_pending_candidate(scope, fact)
                record(
                    "candidate_result",
                    {
                        "disposition": "pending",
                        "not_executed": ["similarity", "adjudication"],
                    },
                )
                pending += 1
                continue

            similarity_started_at = datetime.now(timezone.utc)
            similar = self._similar_memories(fact, pool)
            record(
                "similarity",
                {
                    "threshold": self._similarity_threshold,
                    "rule": "character_bigram_jaccard",
                    "compared": [
                        {
                            "memory": item,
                            "topic_matches": item.topic == fact.topic,
                            "category_matches": item.category == fact.category,
                            "score": similarity(fact.text, item.text),
                        }
                        for item in pool
                    ],
                    "shortlist": similar,
                },
                started_at=similarity_started_at,
            )
            action, replaced_id = self._adjudicate(fact, similar, scope)
            if action is AdjudicationAction.NOOP:
                record("candidate_result", {"disposition": "noop"})
                duplicate += 1
                continue
            if action is AdjudicationAction.UPDATE and replaced_id is not None:
                self._invalidate_replaced(scope, fact, replaced_id, pool)
                updated += 1
            elif action is AdjudicationAction.UPDATE:
                # 裁决要求更新但缺少有效的被取代记忆（结构化输出丢字
                # 段或指向范围外）：不能静默按 ADD 落库，否则被取代的
                # 旧记忆保持 active，与新事实并存。降级为待定候选，
                # 由用户确认。
                self._create_pending_candidate(scope, fact)
                record(
                    "candidate_result",
                    {"disposition": "pending_invalid_update"},
                )
                pending += 1
                continue
            else:
                adopted += 1
            persisted_memory = (
                self._create_owner_memory(scope, fact)
                if fact.subject is FactSubject.SELF
                else self._confirm_contact_memory(scope, fact)
            )
            pool.append(
                _PoolItem(
                    memory_id=persisted_memory.memory_id,
                    text=fact.text,
                    category=fact.category,
                    topic=fact.topic,
                    source_ids=fact.source_message_ids,
                    version=persisted_memory,
                )
            )
            record(
                "candidate_result",
                {
                    "disposition": (
                        "updated"
                        if action is AdjudicationAction.UPDATE
                        else "adopted"
                    ),
                    "memory_id": persisted_memory.memory_id,
                    "replaced_memory_id": replaced_id,
                },
            )
        trace = current_trace()
        if trace is not None:
            trace.candidate_trace_id = None
        return AdoptionStats(
            adopted=adopted,
            updated=updated,
            pending=pending,
            skipped_duplicate=duplicate,
            skipped_deleted=deleted_skip,
            rejected_by_contract=outcome.rejected_count,
            skipped_non_memory=skipped_non_memory,
        )

    def _adjudicate(self, fact, similar, scope: ContactScope):
        if not similar or self._adjudication_runtime is None:
            record(
                "adjudication",
                {
                    "status": "not_executed",
                    "reason": (
                        "no_similar_memory"
                        if not similar
                        else "runtime_not_configured"
                    ),
                    "action": AdjudicationAction.ADD,
                },
            )
            return AdjudicationAction.ADD, None
        started_ns = time.perf_counter()
        record(
            "adjudication_input",
            {
                "candidate_text": fact.text,
                "similar": similar,
                "raw_window_included": False,
            },
        )
        adjudication_started_at = datetime.now(timezone.utc)
        try:
            decision = self._adjudication_runtime.adjudicate(
                candidate_text=fact.text,
                similar=tuple(
                    SimilarMemory(
                        memory_id=item.memory_id,
                        text=item.text,
                        topic=item.topic.value,
                    )
                    for item in similar
                ),
            )
        except ExtractionRuntimeError:
            record(
                "adjudication_failure",
                {"status": "failed", "not_executed": ["invalidate", "write"]},
                started_at=adjudication_started_at,
                status="failed",
            )
            self._record_ledger(scope, LedgerOutcome.RUN_FAILED, started_ns)
            raise
        outcome = LedgerOutcome.SUCCEEDED
        if (
            decision.action is AdjudicationAction.UPDATE
            and decision.replaced_memory_id
            not in {item.memory_id for item in similar}
        ):
            decision_replaced = None
            outcome = LedgerOutcome.REJECTED_BY_VALIDATION
        else:
            decision_replaced = decision.replaced_memory_id
        record(
            "adjudication",
            {
                "decision": decision,
                "replacement_in_shortlist": (
                    decision_replaced is not None
                    if decision.action is AdjudicationAction.UPDATE
                    else None
                ),
                "actual_action": decision.action,
                "actual_replaced_memory_id": decision_replaced,
            },
            started_at=adjudication_started_at,
        )
        self._record_ledger(
            scope,
            outcome,
            started_ns,
            model_name=decision.model_name,
            input_tokens=decision.input_tokens,
            output_tokens=decision.output_tokens,
        )
        # 裁决要求更新但缺少有效被取代 id 时返回 (UPDATE, None)：
        # adopt 会把它降级为待定候选，而不是静默按 ADD 落库让被取代
        # 的旧记忆保持 active。
        return decision.action, decision_replaced

    def _similar_memories(self, fact, pool: list) -> list:
        return [
            item
            for item in pool
            if item.topic == fact.topic
            and item.category == fact.category
            and similarity(fact.text, item.text) >= self._similarity_threshold
        ]

    def _invalidate_replaced(
        self, scope, fact, replaced_id: UUID, pool: list
    ) -> None:
        previous = next(
            (item for item in pool if item.memory_id == replaced_id), None
        )
        record(
            "write_plan",
            {
                "operation": "invalidate",
                "previous": previous,
                "memory_id": replaced_id,
            },
        )
        write_started_at = datetime.now(timezone.utc)
        result: object = None
        if fact.subject is FactSubject.SELF:
            if self._owner_memory_port is not None:
                result = self._owner_memory_port.invalidate(
                    scope.owner_id, replaced_id
                )
        else:
            result = self._memory_port.invalidate(
                scope=scope, memory_id=replaced_id
            )
        record(
            "write_result",
            {
                "operation": "invalidate",
                "previous": previous,
                "actual": result,
                "commit_status": "committed",
            },
            started_at=write_started_at,
            status="committed",
        )
        pool[:] = [item for item in pool if item.memory_id != replaced_id]

    def _record_ledger(
        self,
        scope: ContactScope,
        outcome: LedgerOutcome,
        started_ns: float,
        *,
        model_name: str | None = None,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
    ) -> None:
        if self._ledger is None:
            return
        entry = LedgerEntry(
            entry_id=uuid4(),
            owner_id=scope.owner_id,
            contact_id=scope.contact_id,
            provider="deepseek",
            model_name=model_name or "unreported",
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            latency_ms=int((time.perf_counter() - started_ns) * 1000),
            outcome=outcome,
            called_at=datetime.now(timezone.utc),
        )
        started_at = datetime.now(timezone.utc)
        try:
            record_ledger_entry(
                "adjudication", self._ledger, entry, started_at=started_at
            )
        except TraceWriteError:
            raise
        except Exception as error:
            raise ExtractionRuntimeError("出站台账记录失败。") from error

    def _contact_pool(self, scope: ContactScope) -> list:
        return [
            _PoolItem(
                memory_id=memory.memory_id,
                text=memory.text,
                category=memory.category,
                topic=memory.topic,
                source_ids=memory.source_ids,
                version=memory,
            )
            for memory in self._memory_port.list_confirmed(scope)
        ]

    def _owner_pool(self, owner_id: UUID) -> list:
        if self._owner_memory_port is None:
            return []
        return [
            _PoolItem(
                memory_id=memory.memory_id,
                text=memory.text,
                category=memory.category,
                topic=memory.topic,
                source_ids=memory.source_ids,
                version=memory,
            )
            for memory in self._owner_memory_port.list_active(owner_id)
        ]

    def _deleted_texts(self, scope: ContactScope) -> set[str]:
        deleted_texts = getattr(self._memory_port, "deleted_texts", None)
        texts = set(
            _normalize(text) for text in deleted_texts(scope)
        ) if callable(deleted_texts) else set()
        if self._owner_memory_port is not None:
            owner_deleted_texts = getattr(
                self._owner_memory_port,
                "deleted_texts",
                None,
            )
            texts.update(
                _normalize(text)
                for text in owner_deleted_texts(scope.owner_id)
            ) if callable(owner_deleted_texts) else None
        return texts

    def _passes_all_adoption_gates(
        self,
        fact,
        *,
        pragmatic_decision=None,
    ) -> bool:
        """四道合取项：语用、置信度、风险白名单，以及维度放行。

        前三项的判定仍由 :func:`can_auto_adopt` 负责，语义不变；维度放行
        是独立的第四项，默认空放行表下任何维度都安静待确认（ADR-036）。
        """

        decision = pragmatic_decision or self._pragmatic_interpreter.interpret(fact)
        return can_auto_adopt(
            fact, decision, confidence_threshold=self._threshold
        ) and self._dimension_release.allows(fact)

    def _pending_exists(self, scope: ContactScope, fact) -> bool:
        duplicate_started_at = datetime.now(timezone.utc)
        list_pending = getattr(
            self._memory_port, "list_pending_candidates", None
        )
        if not callable(list_pending):
            record(
                "duplicate",
                {"kind": "pending_candidate", "status": "not_available"},
            )
            return False
        normalized = _normalize(fact.text)
        source_ids = set(fact.source_message_ids)
        compared = tuple(list_pending(scope))
        matches = tuple(
            candidate
            for candidate in compared
            if (
                candidate.scope == scope
                and candidate.category is fact.category
                and candidate.topic is fact.topic
                and _normalize(candidate.text) == normalized
                and set(candidate.source_ids) == source_ids
            )
        )
        record(
            "duplicate",
            {
                "kind": "pending_candidate",
                "compared": compared,
                "matched_ids": [
                    candidate.candidate_id for candidate in matches
                ],
                "fields": [
                    "scope",
                    "category",
                    "topic",
                    "normalized_text",
                    "source_ids",
                ],
            },
            dependency_ids=tuple(
                dict.fromkeys(
                    source
                    for candidate in compared
                    for source in (
                        candidate.candidate_id,
                        *candidate.source_ids,
                    )
                )
            ),
            started_at=duplicate_started_at,
        )
        return bool(matches)

    def _create_pending_candidate(self, scope: ContactScope, fact) -> None:
        candidate = MemoryCandidate(
            candidate_id=uuid4(),
            scope=scope,
            text=fact.text,
            category=fact.category,
            source_ids=fact.source_message_ids,
            topic=fact.topic,
            subject=fact.subject,
            status=MemoryCandidateStatus.PENDING,
            valid_at=fact.valid_at,
            invalid_at=fact.invalid_at,
            confidence=fact.confidence,
            risk_flags=fact.risk_flags,
            alternatives=fact.alternatives,
            interpretation_reason=fact.interpretation_reason,
            timing=fact.timing,
        )
        link = {
            "record_kind": "candidate",
            "record_id": candidate.candidate_id,
            "commit_status": "planned",
        }
        record(
            "write_plan",
            {"operation": "create_pending", "candidate": candidate},
            links=(link,),
        )
        write_started_at = datetime.now(timezone.utc)
        actual = self._memory_port.create_candidate(candidate)
        record(
            "write_result",
            {
                "operation": "create_pending",
                "actual": actual,
                "commit_status": "committed",
            },
            links=({**link, "commit_status": "committed"},),
            started_at=write_started_at,
            status="committed",
        )

    def _create_owner_memory(self, scope: ContactScope, fact) -> OwnerMemory:
        if self._owner_memory_port is None:
            raise TypeError("self 主体事实需要注入 owner 级记忆 port。")
        memory = OwnerMemory(
            memory_id=uuid4(),
            owner_id=scope.owner_id,
            text=fact.text,
            category=fact.category,
            topic=fact.topic,
            source_ids=fact.source_message_ids,
            adoption_method=AdoptionMethod.AUTO,
            status=ConfirmedMemoryStatus.ACTIVE,
            valid_at=fact.valid_at,
            invalid_at=fact.invalid_at,
            confidence=fact.confidence,
            risk_flags=fact.risk_flags,
            timing=fact.timing,
        )
        link = {
            "record_kind": "owner_memory",
            "record_id": memory.memory_id,
            "commit_status": "planned",
        }
        record(
            "write_plan",
            {"operation": "create_owner_memory", "memory": memory},
            links=(link,),
        )
        write_started_at = datetime.now(timezone.utc)
        actual = self._owner_memory_port.create(memory)
        record(
            "write_result",
            {
                "operation": "create_owner_memory",
                "actual": actual,
                "commit_status": "committed",
            },
            links=({**link, "commit_status": "committed"},),
            started_at=write_started_at,
            status="committed",
        )
        return actual

    def _confirm_contact_memory(
        self, scope: ContactScope, fact
    ) -> ConfirmedMemory:
        planned = MemoryCandidate(
            candidate_id=uuid4(),
            scope=scope,
            text=fact.text,
            category=fact.category,
            source_ids=fact.source_message_ids,
            topic=fact.topic,
            subject=fact.subject,
            valid_at=fact.valid_at,
            invalid_at=fact.invalid_at,
            confidence=fact.confidence,
            risk_flags=fact.risk_flags,
            alternatives=fact.alternatives,
            interpretation_reason=fact.interpretation_reason,
            timing=fact.timing,
        )
        link = {
            "record_kind": "candidate",
            "record_id": planned.candidate_id,
            "commit_status": "planned",
        }
        record(
            "write_plan",
            {"operation": "create_candidate", "candidate": planned},
            links=(link,),
        )
        write_started_at = datetime.now(timezone.utc)
        candidate = self._memory_port.create_candidate(planned)
        record(
            "write_result",
            {
                "operation": "create_candidate",
                "actual": candidate,
                "commit_status": "committed",
            },
            links=({**link, "commit_status": "committed"},),
            started_at=write_started_at,
            status="committed",
        )
        record(
            "write_plan",
            {
                "operation": "confirm_contact",
                "candidate_id": candidate.candidate_id,
                "adoption_method": "auto",
            },
        )
        write_started_at = datetime.now(timezone.utc)
        actual = self._memory_port.confirm(
            scope=scope,
            candidate_id=candidate.candidate_id,
            adoption_method=AdoptionMethod.AUTO,
        )
        record(
            "write_result",
            {
                "operation": "confirm_contact",
                "actual": actual,
                "commit_status": "committed",
            },
            links=(
                {
                    "record_kind": "contact_memory",
                    "record_id": actual.memory_id,
                    "commit_status": "committed",
                },
            ),
            started_at=write_started_at,
            status="committed",
        )
        return actual


def _normalize(text: str) -> str:
    return "".join(text.split()).lower()


def can_auto_adopt(
    fact: ExtractedFact,
    decision: PragmaticDecision,
    *,
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
) -> bool:
    """共享的无副作用采纳门槛；通过只代表可走自动采纳路径。

    这里只判定原有三道合取项（语用 CONFIRMABLE、置信度、风险白名单），
    供评测工具报告"若放行该维度"的理想去向。实际采纳还要再过
    :class:`~notalone.memory_extraction.dimensions.DimensionRelease`
    这一道独立的维度放行项，见 :meth:`MemoryAdoption._passes_all_adoption_gates`。
    """
    return (
        decision.disposition is MemoryDisposition.CONFIRMABLE
        and fact.confidence >= confidence_threshold
        and all(
            flag.strip().lower() in AUTO_ADOPTABLE_RISK_FLAGS
            for flag in fact.risk_flags
        )
    )
