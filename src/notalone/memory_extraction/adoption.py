"""提取结果的自动采纳外壳：主体分流、写入裁决、置信度门槛、删除指纹。"""

from __future__ import annotations

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
from notalone.memory_extraction.errors import ExtractionRuntimeError
from notalone.memory_extraction.flow import ExtractionOutcome
from notalone.memory_extraction.models import ExtractedFact, FactSubject
from notalone.memory_extraction.pragmatics import (
    MemoryDisposition,
    PragmaticInterpreter,
    PragmaticDecision,
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
    ) -> None:
        if memory_port is None:
            raise TypeError("必须显式注入联系人级记忆 port。")
        if not 0.0 < confidence_threshold <= 1.0:
            raise ValueError("置信度门槛必须在 0 到 1 之间。")
        self._memory_port = memory_port
        self._owner_memory_port = owner_memory_port
        self._adjudication_runtime = adjudication_runtime
        self._ledger = ledger
        self._threshold = confidence_threshold
        self._similarity_threshold = similarity_threshold
        self._pragmatic_interpreter = (
            pragmatic_interpreter or PragmaticInterpreter()
        )

    def adopt(self, scope: ContactScope, outcome: ExtractionOutcome) -> AdoptionStats:
        """按主体分流落库并返回统计；整体失败时不产生任何写入。"""

        if outcome.failure_reason is not None:
            return AdoptionStats(rejected_by_contract=outcome.rejected_count)

        contact_pool = self._contact_pool(scope)
        owner_pool = self._owner_pool(scope.owner_id)
        deleted = self._deleted_texts(scope)

        adopted = updated = pending = duplicate = deleted_skip = 0
        skipped_non_memory = 0
        for fact in outcome.accepted:
            pragmatic_decision = self._pragmatic_interpreter.interpret(fact)
            if pragmatic_decision.disposition is MemoryDisposition.NONE:
                skipped_non_memory += 1
                continue
            fact = self._pragmatic_interpreter.prepare_for_adoption(
                fact,
                decision=pragmatic_decision,
            )
            normalized = _normalize(fact.text)
            if normalized in deleted:
                deleted_skip += 1
                continue
            pool = owner_pool if fact.subject is FactSubject.SELF else contact_pool
            if any(normalized == _normalize(item.text) for item in pool):
                duplicate += 1
                continue
            if self._pending_exists(scope, fact):
                duplicate += 1
                continue
            if not self._can_auto_adopt(
                fact,
                pragmatic_decision=pragmatic_decision,
            ):
                self._create_pending_candidate(scope, fact)
                pending += 1
                continue

            similar = self._similar_memories(fact, pool)
            action, replaced_id = self._adjudicate(fact, similar, scope)
            if action is AdjudicationAction.NOOP:
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
                )
            )
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
            return AdjudicationAction.ADD, None
        started_ns = time.perf_counter()
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

    def _invalidate_replaced(self, scope, fact, replaced_id: UUID, pool: list) -> None:
        if fact.subject is FactSubject.SELF:
            if self._owner_memory_port is not None:
                self._owner_memory_port.invalidate(scope.owner_id, replaced_id)
        else:
            self._memory_port.invalidate(scope=scope, memory_id=replaced_id)
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
        try:
            self._ledger.record(entry)
        except Exception as error:
            raise ExtractionRuntimeError("出站台账记录失败。") from error

    def _contact_pool(self, scope: ContactScope) -> list:
        return [
            _PoolItem(
                memory_id=memory.memory_id,
                text=memory.text,
                category=memory.category,
                topic=memory.topic,
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

    def _can_auto_adopt(
        self,
        fact,
        *,
        pragmatic_decision=None,
    ) -> bool:
        decision = pragmatic_decision or self._pragmatic_interpreter.interpret(fact)
        return can_auto_adopt(fact, decision, confidence_threshold=self._threshold)


    def _pending_exists(self, scope: ContactScope, fact) -> bool:
        list_pending = getattr(self._memory_port, "list_pending_candidates", None)
        if not callable(list_pending):
            return False
        normalized = _normalize(fact.text)
        source_ids = set(fact.source_message_ids)
        return any(
            candidate.scope == scope
            and candidate.category is fact.category
            and candidate.topic is fact.topic
            and _normalize(candidate.text) == normalized
            and set(candidate.source_ids) == source_ids
            for candidate in list_pending(scope)
        )

    def _create_pending_candidate(self, scope: ContactScope, fact) -> None:
        self._memory_port.create_candidate(
            MemoryCandidate(
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
            )
        )

    def _create_owner_memory(self, scope: ContactScope, fact) -> OwnerMemory:
        if self._owner_memory_port is None:
            raise TypeError("self 主体事实需要注入 owner 级记忆 port。")
        return self._owner_memory_port.create(
            OwnerMemory(
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
            )
        )

    def _confirm_contact_memory(
        self, scope: ContactScope, fact
    ) -> ConfirmedMemory:
        candidate = self._memory_port.create_candidate(
            MemoryCandidate(
                candidate_id=uuid4(),
                scope=scope,
                text=fact.text,
                category=fact.category,
                source_ids=fact.source_message_ids,
                topic=fact.topic,
                valid_at=fact.valid_at,
                invalid_at=fact.invalid_at,
                confidence=fact.confidence,
                risk_flags=fact.risk_flags,
            )
        )
        return self._memory_port.confirm(
            scope=scope,
            candidate_id=candidate.candidate_id,
            adoption_method=AdoptionMethod.AUTO,
        )


def _normalize(text: str) -> str:
    return "".join(text.split()).lower()


def can_auto_adopt(
    fact: ExtractedFact,
    decision: PragmaticDecision,
    *,
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
) -> bool:
    """共享的无副作用采纳门槛；通过只代表可走自动采纳路径。"""
    return (
        decision.disposition is MemoryDisposition.CONFIRMABLE
        and fact.confidence >= confidence_threshold
        and all(
            flag.strip().lower() in AUTO_ADOPTABLE_RISK_FLAGS
            for flag in fact.risk_flags
        )
    )
