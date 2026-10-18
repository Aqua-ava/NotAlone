"""提取结果的自动采纳外壳：主体分流、写入裁决、置信度门槛、删除指纹。"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from uuid import UUID, uuid4, uuid5

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
    SourceDependencyMode,
)
from notalone.memory.ports import MemoryPort, OwnerMemoryPort
from notalone.memory.versions import MemoryVersionConflict
from notalone.memory.candidates import same_pending_identity
from notalone.memory.events import same_verified_event_claim, same_verified_occurrence
from notalone.memory.dimension_evidence import DimensionEvidenceChangedError
from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.memory_extraction.adjudication import (
    AdjudicationAction,
    AdjudicationDecision,
    AdjudicationRuntime,
    SimilarMemory,
    similarity,
)
from notalone.memory_extraction.dimensions import (
    DimensionRelease,
    dimension_key,
    required_dimensions,
    valid_evidence_dimensions,
)
from notalone.memory_extraction.errors import ExtractionInvalidOutputError, ExtractionRuntimeError
from notalone.memory_extraction.flow import ExtractionOutcome
from notalone.memory_extraction.models import ExtractedFact, FactSubject
from notalone.memory_extraction.recall import bm25_scores
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
    snapshot,
)
from notalone.scopes import ContactScope

DEFAULT_CONFIDENCE_THRESHOLD = 0.7
DEFAULT_SIMILARITY_THRESHOLD = 0.2
MAX_SIMILAR_MEMORY_CANDIDATES = 8
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
    skipped_changed: int = 0


@dataclass(frozen=True, slots=True)
class _PoolItem:
    memory_id: UUID
    text: str
    category: MemoryCategory
    topic: MemoryTopic
    source_ids: tuple[UUID, ...] = ()
    version: object = None
    dependency_ids: tuple[UUID, ...] = ()
    claim_source_ids: tuple[UUID, ...] = ()


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
        "_candidate_namespace",
        "_merge_verifier",
        "_automatic",
        "_staged_candidates",
        "_existing_candidates",
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
        candidate_namespace: UUID | None = None,
        merge_verifier=None,
        automatic: bool = False,
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
        if candidate_namespace is not None and not isinstance(candidate_namespace, UUID):
            raise TypeError('候选命名空间必须是稳定批次UUID。')
        self._candidate_namespace = candidate_namespace
        self._merge_verifier = merge_verifier
        self._automatic = automatic
        self._staged_candidates = set()
        self._existing_candidates = set()

    def adopt(self, scope: ContactScope, outcome: ExtractionOutcome) -> AdoptionStats:
        """自动流程只留下成功或失败；临时写入候选不成为人工确认任务。"""
        self._staged_candidates.clear()
        self._existing_candidates = {item.candidate_id for item in self._memory_port.list_pending_candidates(scope)} if self._automatic else set()
        try:
            stats = self._adopt(scope, outcome)
        finally:
            if self._automatic:
                for candidate in self._memory_port.list_pending_candidates(scope):
                    if candidate.candidate_id in self._staged_candidates:
                        self._memory_port.fail_automatic_candidate(scope=scope, candidate_id=candidate.candidate_id)
                        record("candidate_result", {"disposition": "automatic_write_failed",
                            "candidate_id": candidate.candidate_id, "reason": "see_preceding_adjudication_or_write_result"})
        return replace(stats, pending=0, rejected_by_contract=stats.rejected_by_contract + stats.pending) if self._automatic else stats

    def _persist_candidate(self, candidate):
        actual = self._memory_port.create_candidate(candidate)
        if actual.candidate_id == candidate.candidate_id and actual.candidate_id not in self._existing_candidates:
            self._staged_candidates.add(actual.candidate_id)
        return actual

    def _adopt(self, scope: ContactScope, outcome: ExtractionOutcome) -> AdoptionStats:
        """按主体逐条采纳；晚发生故障可保留此前已提交的结果。"""

        if outcome.failure_reason is not None:
            return AdoptionStats(rejected_by_contract=outcome.rejected_count)

        pool_started_at = datetime.now(timezone.utc)
        contact_pool = self._contact_pool(scope)
        owner_pool = self._owner_pool(scope)
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
                    for source in item.dependency_ids
                )
            ),
            started_at=pool_started_at,
        )

        batch_decisions = (self._batch_decisions(scope, outcome, contact_pool, owner_pool, deleted)
                           if not self._dimension_release.verified_sources else {})
        adopted = updated = pending = duplicate = deleted_skip = 0
        skipped_non_memory = 0
        skipped_changed = 0
        original_memory_ids = {item.memory_id for item in (*contact_pool, *owner_pool)}
        batch_plan = self._batch_plan(scope, outcome.accepted, contact_pool, owner_pool, deleted)
        for index, fact in enumerate(outcome.accepted):
            trace = current_trace()
            if trace is not None:
                trace.candidate_trace_id = (
                    outcome.candidate_trace_ids[index]
                    if outcome.candidate_trace_ids
                    else uuid4()
                )
            pragmatic_started_at = datetime.now(timezone.utc)
            pragmatic_decision = self._interpret_for_adoption(fact, scope)
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
            assess = getattr(self._memory_port, "assess_correction", None)
            if callable(assess):
                protected = assess(_candidate_from_fact(scope, fact, namespace=self._candidate_namespace))
                if protected.failure_reason == "correction:old_evidence":
                    deleted_skip += 1
                    record("candidate_result", {"disposition": "correction_old_evidence",
                        "not_executed": ["deleted_fingerprint", "duplicate", "adoption_gates", "similarity", "adjudication", "write"]})
                    continue
                if protected.correction_review or protected.failure_reason == "version:original_window_unknown":
                    if self._pending_exists(scope, fact):
                        duplicate += 1
                        continue
                    actual = self._create_pending_candidate(scope, fact)
                    pending += int(actual.status is MemoryCandidateStatus.PENDING)
                    deleted_skip += int(actual.status is not MemoryCandidateStatus.PENDING)
                    record("candidate_result", {"disposition": "pending_correction_review",
                        "not_executed": ["deleted_fingerprint", "adoption_gates", "similarity", "adjudication", "auto_confirm"]})
                    continue
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
                item for item in pool
                if normalized == _normalize(item.text)
                and item.category is fact.category
                and item.topic is fact.topic
                and (set(item.claim_source_ids or item.source_ids) == set(fact.source_message_ids)
                     or bool(set(item.claim_source_ids or item.source_ids) & set(fact.source_message_ids))
                     and same_verified_event_claim(item.version.event, fact.event))
                and item.version.valid_at == fact.valid_at
                and item.version.invalid_at == fact.invalid_at
                and (same_verified_event_claim(item.version.event, fact.event)
                     or self._is_exact_event_claim_replay(scope, item.version, fact))
                and self._same_dependencies(scope, fact, item.version)
            ]
            record(
                "duplicate",
                {
                    "rule": "same_claim_and_source_set",
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
            pending_before = self._pending_exists(scope, fact)
            gates_started_at = datetime.now(timezone.utc)
            passed = self._passes_all_adoption_gates(
                fact,
                pragmatic_decision=pragmatic_decision,
                scope=scope,
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
                        "required": sorted(required_dimensions(fact)),
                        "evidence_valid": sorted(valid_evidence_dimensions(fact)),
                        "gate_enabled": self._dimension_release.gate_enabled,
                        "policy": "verified_sources" if self._dimension_release.verified_sources else "dimension_release",
                        "allowed": sorted(self._dimension_release.allowed),
                        "released": sorted(self._dimension_release.released),
                        "passed": self._dimension_release.allows(fact, scope=scope),
                    },
                    "passed": passed,
                },
                started_at=gates_started_at,
                status="passed" if passed else "pending",
            )
            if not passed:
                if self._pending_exists(scope, fact):
                    record("candidate_result", {"disposition": "duplicate_candidate"})
                    duplicate += 1
                    continue
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
            planned = batch_plan.get(index)
            if planned is not None:
                similar, planned_decision, pending_reason = planned
                shortlist_truncated = False
            else:
                similar, shortlist_truncated = self._similar_memories(scope, fact, pool)
            recall_scores = dict(zip((item.memory_id for item in pool), bm25_scores(fact.text, [item.text for item in pool])))
            record(
                "similarity",
                {
                    "threshold": 0,
                    "legacy_similarity_threshold": self._similarity_threshold,
                    "rule": "bm25_local_embedding_rrf" if planned is not None else "local_bm25_chinese_bigrams",
                    "compared": [
                        {
                            "memory": item,
                            "topic_matches": item.topic == fact.topic,
                            "category_matches": item.category == fact.category,
                            "score": recall_scores[item.memory_id],
                        }
                        for item in pool
                    ],
                    "shortlist": similar,
                    "limit": MAX_SIMILAR_MEMORY_CANDIDATES,
                    "shortlist_truncated": shortlist_truncated,
                },
                started_at=similarity_started_at,
            )
            if planned is not None:
                decision = planned_decision
            elif shortlist_truncated:
                record("adjudication", {"status": "not_executed", "reason": "incomplete_shortlist"})
                decision = None
            else:
                decision = self._adjudicate(fact, similar, scope, batch_decisions)
            # skip 只能依附已经落库且时间边界一致的事实；首批全部 skip 不能吞掉来源。
            if planned is not None and decision and decision.action is AdjudicationAction.NOOP and not any(
                (item.memory_id not in original_memory_ids or item in similar)
                and item.version.valid_at == fact.valid_at
                and item.version.invalid_at == fact.invalid_at
                and item.version.event is None and fact.event is None
                for item in pool
            ):
                decision = None
            action = decision.action if decision else None
            replaced_id = decision.replaced_memory_id if decision else None
            if action is AdjudicationAction.MERGE or (action is AdjudicationAction.UPDATE and decision.merged_memory_ids):
                result = self._merge(scope, fact, similar, decision)
                if result is None:
                    pending += 1
                else:
                    updated += 1
                    pool[:] = [item for item in pool if item.memory_id not in decision.merged_memory_ids]
                    pool.append(_PoolItem(memory_id=result.memory_id, text=result.text,
                        category=result.category, topic=result.topic, source_ids=result.source_ids,
                        version=result, dependency_ids=(result.memory_id, *result.source_ids),
                        claim_source_ids=result.source_ids))
                continue
            if action is AdjudicationAction.NOOP:
                record("candidate_result", {"disposition": "noop"})
                duplicate += 1
                continue
            if action is None or (action is AdjudicationAction.UPDATE and replaced_id is None):
                # 裁决要求更新但缺少有效的被取代记忆（结构化输出丢字
                # 段或指向范围外）：不能静默按 ADD 落库，否则被取代的
                # 旧记忆保持 active，与新事实并存。降级为待定候选，
                # 由用户确认。
                self._create_pending_candidate(scope, fact, failure_reason=pending_reason if planned is not None else None)
                if shortlist_truncated:
                    disposition = "pending_incomplete_shortlist"
                elif action:
                    disposition = "pending_invalid_update"
                else:
                    disposition = "pending_invalid_adjudication"
                record(
                    "candidate_result",
                    {"disposition": disposition},
                )
                pending += 1
                continue
            if action is AdjudicationAction.UPDATE and decision.merged_text is not None and decision.merged_text != fact.text:
                try:
                    parents = tuple(item.version for item in similar if item.memory_id == replaced_id)
                    fact = self._merge_verifier.verify(scope=scope, fact=fact, parents=parents, text=decision.merged_text)
                    if not self._passes_all_adoption_gates(fact, scope=scope):
                        raise ValueError('更新正文未通过采纳门。')
                except (ValueError, ExtractionRuntimeError):
                    self._create_pending_candidate(scope, fact)
                    pending += 1
                    continue
            previous_item = next(
                (item for item in pool if item.memory_id == replaced_id), None,
            ) if action is AdjudicationAction.UPDATE else None
            previous = previous_item.version if previous_item is not None else None
            if action is AdjudicationAction.UPDATE and (
                previous is None or previous.adoption_method is AdoptionMethod.MANUAL
                or (previous.event is not None or fact.event is not None)
                and not same_verified_occurrence(previous.event, fact.event)
            ):
                self._create_pending_candidate(scope, fact)
                record("candidate_result", {"disposition": "pending_manual_or_changed_previous"})
                pending += 1
                continue
            if previous is not None:
                record(
                    "write_plan",
                    {"operation": "invalidate", "previous": previous_item,
                     "atomic_with": "confirm_new_version"},
                    links=({"record_kind": "owner_memory" if fact.subject is FactSubject.SELF else "contact_memory",
                            "record_id": previous.memory_id, "operation": "invalidate",
                            "commit_status": "planned"},),
                )
            persisted_memory = (
                self._create_owner_memory(scope, fact, previous=previous)
                if fact.subject is FactSubject.SELF
                else self._confirm_contact_memory(scope, fact, previous=previous)
            )
            if persisted_memory is None:
                still_pending = self._pending_exists(scope, fact)
                duplicate += int(still_pending and pending_before)
                pending += int(still_pending and not pending_before)
                skipped_changed += int(not still_pending)
                record(
                    "candidate_result",
                    {"disposition": "pending_source_changed" if still_pending else "source_or_user_decision_changed"},
                )
                continue
            if action is AdjudicationAction.UPDATE and replaced_id is not None:
                record(
                    "write_result",
                    {"operation": "invalidate", "previous": previous_item,
                     "actual": {"memory_id": previous.memory_id,
                                "status": ConfirmedMemoryStatus.INVALIDATED.value,
                                "revision": previous.revision + 1},
                     "atomic_with": persisted_memory.memory_id, "commit_status": "committed"},
                    links=({"record_kind": "owner_memory" if fact.subject is FactSubject.SELF else "contact_memory",
                            "record_id": replaced_id, "operation": "invalidate",
                            "commit_status": "committed"},),
                    status="committed",
                )
                pool[:] = [item for item in pool if item.memory_id != replaced_id]
                updated += 1
            else:
                adopted += 1
            pool.append(
                _PoolItem(
                    memory_id=persisted_memory.memory_id,
                    text=fact.text,
                    category=fact.category,
                    topic=fact.topic,
                    source_ids=persisted_memory.source_ids,
                    claim_source_ids=fact.source_message_ids,
                    version=persisted_memory,
                    dependency_ids=(
                        persisted_memory.memory_id,
                        *persisted_memory.source_ids,
                    ),
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
            skipped_changed=skipped_changed,
        )

    @staticmethod
    def _decision_key(fact, similar):
        return (fact.subject, fact.category, fact.topic, fact.text, fact.valid_at, fact.invalid_at,
                repr(fact.event), tuple(fact.source_message_ids),
                tuple((item.memory_id, item.version.revision) for item in similar))

    def _batch_decisions(self, scope, outcome, contact_pool, owner_pool, deleted):
        """冻结合格候选与旧池；后续池改变时不得复用过期裁决。"""
        batch = getattr(self._adjudication_runtime, "adjudicate_batch", None)
        if not callable(batch):
            return {}
        inputs, keys = [], []
        for original in outcome.accepted:
            pragmatic = self._interpret_for_adoption(original, scope)
            fact = self._pragmatic_interpreter.prepare_for_adoption(original, decision=pragmatic)
            if (_normalize(fact.text) in deleted or not self._passes_all_adoption_gates(
                    fact, pragmatic_decision=pragmatic, scope=scope)):
                continue
            assess = getattr(self._memory_port, "assess_correction", None)
            if callable(assess):
                protected = assess(_candidate_from_fact(scope, fact, namespace=self._candidate_namespace))
                if protected.correction_review or protected.failure_reason:
                    continue
            pool = owner_pool if fact.subject is FactSubject.SELF else contact_pool
            if any(_normalize(item.text) == _normalize(fact.text)
                   and set(item.source_ids) == set(fact.source_message_ids)
                   and item.version.valid_at == fact.valid_at and item.version.invalid_at == fact.invalid_at
                   and item.version.event == fact.event for item in pool):
                continue
            similar, truncated = self._similar_memories(scope, fact, pool)
            if not similar or truncated:
                continue
            keys.append(self._decision_key(fact, similar))
            inputs.append((fact.text, tuple(SimilarMemory(item.memory_id, item.text, item.topic.value)
                                           for item in similar)))
        if not inputs:
            return {}
        started = time.perf_counter()
        try:
            decisions = batch(candidates=tuple(inputs))
            if len(decisions) != len(inputs):
                raise ExtractionInvalidOutputError("批量裁决未覆盖全部候选。")
        except ExtractionInvalidOutputError:
            self._record_ledger(scope, LedgerOutcome.REJECTED_BY_VALIDATION, started)
            return dict.fromkeys(keys)
        except ExtractionRuntimeError:
            self._record_ledger(scope, LedgerOutcome.RUN_FAILED, started)
            raise
        usage = next((item for item in decisions if item is not None), None)
        self._record_ledger(scope, LedgerOutcome.SUCCEEDED, started,
            model_name=usage.model_name if usage else None,
            input_tokens=usage.input_tokens if usage else None,
            output_tokens=usage.output_tokens if usage else None)
        return dict(zip(keys, decisions))

    def _batch_plan(self, scope, facts, contact_pool, owner_pool, deleted):
        """同次已核验候选共享召回池；批量模型失败保留待处理而不降级新增。"""
        runtime = getattr(self._adjudication_runtime, 'adjudicate_batch', None)
        if not callable(runtime) or not self._dimension_release.verified_sources:
            return {}
        from notalone.memory_extraction.recall import hybrid_candidates, EmbeddingUnavailableError, EMBEDDING_UNAVAILABLE
        plans = {}
        prepared = []
        for index, original in enumerate(facts):
            pragmatic = self._interpret_for_adoption(original, scope)
            fact = self._pragmatic_interpreter.prepare_for_adoption(original, decision=pragmatic)
            if (_normalize(fact.text) in deleted or not self._passes_all_adoption_gates(
                    fact, pragmatic_decision=pragmatic, scope=scope)):
                continue
            assess = getattr(self._memory_port, "assess_correction", None)
            if callable(assess):
                protected = assess(_candidate_from_fact(scope, fact, namespace=self._candidate_namespace))
                if protected.correction_review or protected.failure_reason:
                    continue
            prepared.append((index, fact))
        for owner, pool in ((False, contact_pool), (True, owner_pool)):
            eligible = [(index, fact) for index, fact in prepared
                        if (fact.subject is FactSubject.SELF) == owner]
            if not eligible:
                continue
            called = False
            try:
                shortlists = hybrid_candidates([fact.text for _, fact in eligible], pool)
                unified = {str(item.memory_id): item for rows in shortlists for item in rows}
                memories = [dict(candidate_id=str(index), text=fact.text, category=fact.category.value,
                    topic=fact.topic.value, valid_at=fact.valid_at.isoformat() if fact.valid_at else None,
                    invalid_at=fact.invalid_at.isoformat() if fact.invalid_at else None,
                    event=fact.event.to_payload() if fact.event else None,
                    source_message_ids=[str(value) for value in fact.source_message_ids], candidate_ids=[str(item.memory_id) for item in rows])
                    for (index, fact), rows in zip(eligible, shortlists)]
                started = time.perf_counter()
                called = True
                decisions = runtime(memories=memories, pool=[dict(memory_id=key, text=item.text,
                    category=item.category.value, topic=item.topic.value,
                    valid_at=item.version.valid_at.isoformat() if item.version.valid_at else None,
                    invalid_at=item.version.invalid_at.isoformat() if item.version.invalid_at else None,
                    event=item.version.event.to_payload() if item.version.event else None,
                    source_message_ids=[str(value) for value in (item.claim_source_ids or item.source_ids)])
                    for key, item in unified.items()])
                self._record_ledger(scope, LedgerOutcome.SUCCEEDED, started)
                for (index, fact), rows in zip(eligible, shortlists):
                    decision = decisions.get(str(index))
                    # 事件的独立来源不能仅凭正文相似被skip吞掉。
                    if decision is not None and decision.action is AdjudicationAction.NOOP and fact.event is not None:
                        decision = None
                    plans[index] = (rows, decision, None)
                record('batch_adjudication', {'memories': memories, 'decisions': decisions,
                       'recall': 'bm25_local_embedding_rrf', 'scope_kind': 'owner' if owner else 'contact'})
            except (ValueError, ImportError, OSError, ExtractionRuntimeError) as error:
                if called:
                    self._record_ledger(scope, LedgerOutcome.RUN_FAILED, started)
                reason = EMBEDDING_UNAVAILABLE if isinstance(error, EmbeddingUnavailableError) else None
                plans.update((index, ([], None, reason)) for index, _ in eligible)
                record('batch_adjudication', {'status': 'pending', 'reason': reason or 'recall_or_model_failed'})
        return plans

    def _adjudicate(self, fact, similar, scope: ContactScope, batch_decisions=None):
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
            return AdjudicationDecision(AdjudicationAction.ADD)
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
            key = self._decision_key(fact, similar)
            cached = batch_decisions is not None and key in batch_decisions
            decision = batch_decisions[key] if cached else self._adjudication_runtime.adjudicate(
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
        except ExtractionInvalidOutputError:
            record("adjudication_failure", {"status": "rejected", "reason": "invalid_item_contract"},
                started_at=adjudication_started_at, status="failed")
            self._record_ledger(scope, LedgerOutcome.REJECTED_BY_VALIDATION, started_ns)
            return None
        except ExtractionRuntimeError:
            record(
                "adjudication_failure",
                {"status": "failed", "not_executed": ["invalidate", "write"]},
                started_at=adjudication_started_at,
                status="failed",
            )
            self._record_ledger(scope, LedgerOutcome.RUN_FAILED, started_ns)
            raise
        if decision is None:
            return None
        outcome = LedgerOutcome.SUCCEEDED
        actual_action = decision.action
        # 等价改写只允许同一来源、时态和事件；不能吞掉另一来源的新主张。
        if decision.action is AdjudicationAction.NOOP and not any(
                item.memory_id == decision.duplicate_memory_id
                and set(item.source_ids) == set(fact.source_message_ids)
                and item.version.valid_at == fact.valid_at and item.version.invalid_at == fact.invalid_at
                and item.version.event == fact.event
                and self._same_dependencies(scope, fact, item.version) for item in similar):
            actual_action = None
            outcome = LedgerOutcome.REJECTED_BY_VALIDATION
        if decision.action is not AdjudicationAction.UPDATE and decision.replaced_memory_id is not None:
            actual_action = None
            outcome = LedgerOutcome.REJECTED_BY_VALIDATION
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
                "actual_action": actual_action,
                "actual_replaced_memory_id": decision_replaced,
            },
            started_at=adjudication_started_at,
        )
        if not cached:
            self._record_ledger(scope, outcome, started_ns, model_name=decision.model_name,
                input_tokens=decision.input_tokens, output_tokens=decision.output_tokens)
        # 裁决要求更新但缺少有效被取代 id 时保留 UPDATE 与空 ID：
        # adopt 会把它降级为待定候选，而不是静默按 ADD 落库让被取代
        # 的旧记忆保持 active。
        return replace(decision, action=actual_action, replaced_memory_id=decision_replaced) if actual_action else None

    def _merge(self, scope, fact, similar, decision):
        port = self._owner_memory_port if fact.subject is FactSubject.SELF else self._memory_port
        confirm = getattr(port, "confirm_merge", None)
        try:
            ids = decision.merged_memory_ids
            if (self._merge_verifier is None or not callable(confirm) or not 2 <= len(ids) <= 8
                    or len(set(ids)) != len(ids) or not set(ids) <= {item.memory_id for item in similar}):
                raise ValueError("合并能力或目标不符合当前范围。")
            parents = tuple(next(item.version for item in similar if item.memory_id == identifier) for identifier in ids)
            if any(parent is None for parent in parents):
                raise ValueError("合并旧版本缺失。")
            merged = self._merge_verifier.verify(scope=scope, fact=fact, parents=parents, text=decision.merged_text)
            if _normalize(merged.text) in self._deleted_texts(scope):
                raise ValueError("合并正文匹配用户删除记录。")
        except (ValueError, ExtractionRuntimeError):
            self._create_pending_candidate(scope, fact)
            record("candidate_result", {"disposition": "pending_merge_rejected"})
            return None
        candidate = self._create_pending_candidate(scope, merged)
        current = _stored_candidate_fact(merged, candidate)
        if (candidate.status is not MemoryCandidateStatus.PENDING or candidate.correction_review
                or not self._passes_all_adoption_gates(current, scope=scope)):
            record("candidate_result", {"disposition": "pending_merge_gates"})
            return None
        try:
            result = confirm(scope=scope, candidate_id=candidate.candidate_id, expected_parents=parents,
                **({"expected_dimension_evidence": candidate.dimension_evidence} if self._dimension_release.gate_enabled else {}))
        except (DimensionEvidenceChangedError, MemoryCorrectionConflictError, MemoryVersionConflict):
            record("candidate_result", {"disposition": "pending_merge_changed"})
            return None
        record("candidate_result", {"disposition": "merged", "memory_id": result.memory_id,
            "merged_memory_ids": ids}, dependency_ids=(result.memory_id, *ids, *result.source_ids),
            links=({"record_kind": "owner_memory" if fact.subject is FactSubject.SELF else "contact_memory",
                    "record_id": result.memory_id, "operation": "merge", "commit_status": "committed"},), status="committed")
        return result

    def _same_dependencies(
        self, scope: ContactScope, fact: ExtractedFact,
        previous: MemoryCandidate | ConfirmedMemory | OwnerMemory,
    ) -> bool:
        """ALL只复用同一来源组与完整当前依据，清proof不能借去重恢复信用。"""
        if (previous.requires_all_sources != fact.requires_all_sources
                or fact.requires_all_sources and set(previous.source_ids) != set(fact.source_message_ids)):
            return False
        previous_mode = previous.source_dependency_mode
        if fact.source_dependency_mode is SourceDependencyMode.ANY:
            return previous_mode is SourceDependencyMode.ANY
        if (previous_mode is not SourceDependencyMode.ALL
                or set(previous.source_ids) != set(fact.source_message_ids)
                or fact.dimension_evidence is None
                or fact.dimension_evidence.version != 4):
            return False
        candidate = previous
        if not isinstance(candidate, MemoryCandidate):
            candidate_id = getattr(previous, "source_candidate_id", None)
            if candidate_id is None:
                return False
            try:
                candidate = self._memory_port.get_candidate(
                    scope=scope, candidate_id=candidate_id,
                )
            except (LookupError, PermissionError):
                return False
        evidence = candidate.dimension_evidence
        return (candidate.text == previous.text
                and candidate.category is previous.category
                and candidate.topic is previous.topic
                and candidate.source_dependency_mode is SourceDependencyMode.ALL
                and set(candidate.source_ids) == set(fact.source_message_ids)
                and evidence is not None and evidence.version == 4
                and evidence.source_bound
                and fact.dimension_evidence.source_bound
                and evidence.to_payload() == fact.dimension_evidence.to_payload())

    def _similar_memories(
        self, scope: ContactScope, fact: ExtractedFact, pool: list[_PoolItem],
    ) -> tuple[list[_PoolItem], bool]:
        # 明确更正可能换词或补足上下文，低词面重合不等于与旧事实无关。
        # 只扩大同类别同主题的有界候选，是否替换仍由裁决及原子写入门决定。
        verified_correction = (fact.speech_act.value == 'correction'
            and self._dimension_release.verified_sources and self._dimension_release.gate_enabled
            and self._dimension_release.allows(fact, scope=scope))
        scores = dict(zip((item.memory_id for item in pool), bm25_scores(fact.text, [item.text for item in pool])))
        candidates = [
            item
            for item in pool
            if ((self._merge_verifier is not None or self._dimension_release.verified_sources
                 and self._dimension_release.allows(fact, scope=scope))
                and fact.source_dependency_mode is SourceDependencyMode.ANY
                or self._same_dependencies(scope, fact, item.version))
            and (verified_correction and item.topic == fact.topic and item.category == fact.category
                 or scores[item.memory_id] > 0
                 or similarity(fact.text, item.text) >= self._similarity_threshold)
        ]
        candidates.sort(key=lambda item: (
            -scores[item.memory_id], str(item.memory_id),
        ))
        return (candidates[:MAX_SIMILAR_MEMORY_CANDIDATES],
                verified_correction and len(candidates) > MAX_SIMILAR_MEMORY_CANDIDATES)

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
                claim_source_ids=self._claim_sources(scope, memory),
                version=memory,
                dependency_ids=(memory.memory_id, *memory.source_ids),
            )
            for memory in self._memory_port.list_confirmed(scope)
        ]

    def _owner_pool(self, scope: ContactScope) -> list:
        if self._owner_memory_port is None:
            return []
        # 手输 source_ids 的 owner_id 表示归属；自身 memory_id 仍是正文删除依赖。
        return [
            _PoolItem(
                memory_id=memory.memory_id,
                text=memory.text,
                category=memory.category,
                topic=memory.topic,
                source_ids=memory.source_ids,
                claim_source_ids=self._claim_sources(scope, memory),
                version=memory,
                dependency_ids=(
                    memory.memory_id,
                    *(
                        ()
                        if memory.adoption_method is AdoptionMethod.MANUAL
                        and memory.source_candidate_id is None
                        and memory.source_ids == (scope.owner_id,)
                        else memory.source_ids
                    ),
                ),
            )
            for memory in self._owner_memory_port.list_active(scope.owner_id)
        ]

    def _claim_sources(self, scope: ContactScope, memory: ConfirmedMemory | OwnerMemory) -> tuple[UUID, ...]:
        if memory.source_candidate_id is None:
            return memory.source_ids
        try:
            candidate = self._memory_port.get_candidate(scope=scope, candidate_id=memory.source_candidate_id)
        except (LookupError, PermissionError):
            # 本人资料可来自另一联系人；不为快速去重扩大该次联系人的读取。
            return memory.source_ids
        if (candidate.text == memory.text and candidate.category is memory.category
                and candidate.topic is memory.topic and set(candidate.source_ids) <= set(memory.source_ids)):
            return candidate.source_ids
        return memory.source_ids

    def _is_exact_event_claim_replay(
        self, scope: ContactScope, memory: ConfirmedMemory | OwnerMemory, fact: ExtractedFact,
    ) -> bool:
        """只识别原主张原证明的重放；未知发生时间不能认证现实事件同一性。"""
        if (memory.source_candidate_id is None or memory.event is None or fact.event is None
                or not memory.event.source_current or not fact.event.source_current
                or memory.event.to_payload() != fact.event.to_payload()
                or fact.dimension_evidence is None or not fact.dimension_evidence.source_bound):
            return False
        try:
            original = self._memory_port.get_candidate(
                scope=scope, candidate_id=memory.source_candidate_id,
            )
        except (LookupError, PermissionError):
            return False
        evidence = original.dimension_evidence
        return (
            original.status is MemoryCandidateStatus.CONFIRMED
            and original.text == memory.text and original.category is memory.category
            and original.topic is memory.topic and original.subject is fact.subject
            and original.event == fact.event
            and set(original.source_ids) == set(fact.source_message_ids)
            and evidence is not None and evidence.source_bound and evidence.scope == scope
            and evidence.to_payload() == fact.dimension_evidence.to_payload()
        )

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

    def _interpret_for_adoption(self, fact, scope):
        if self._automatic:
            return PragmaticDecision(disposition=MemoryDisposition.CONFIRMABLE)
        decision = self._pragmatic_interpreter.interpret(fact)
        # 明确更正仍保留correction标签；仅当前逐条核验策略可解除这一项阻塞。
        # 假设、歧义、风险、来源变化和人工修正保护继续走原门禁。
        if (decision.reasons == ('correction',)
                and self._dimension_release.verified_sources
                and self._dimension_release.gate_enabled
                and self._dimension_release.allows(fact, scope=scope)):
            return PragmaticDecision(disposition=MemoryDisposition.CONFIRMABLE)
        return decision

    def _passes_all_adoption_gates(
        self,
        fact,
        *,
        pragmatic_decision=None,
        scope: ContactScope | None = None,
    ) -> bool:
        """语用、置信度、风险及当前来源核验共同决定采纳；显式旧策略保留逐维门。"""

        decision = pragmatic_decision or self._interpret_for_adoption(fact, scope)
        if self._automatic:
            # 逐条来源核验仍为准入；置信度/语用/风险字段只保留描述，不增设人工门。
            return self._dimension_release.allows(fact, scope=scope) and (
                fact.event is None or fact.event.source_current and fact.event.stage_verified and fact.event.occurrence_verified)
        return can_auto_adopt(
            fact, decision, confidence_threshold=self._threshold
        ) and self._dimension_release.allows(fact, scope=scope) and (
            fact.event is None
            or fact.event.source_current and fact.event.stage_verified and fact.event.occurrence_verified
        )

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
        proposed = _candidate_from_fact(scope, fact, namespace=self._candidate_namespace)
        compared = tuple(list_pending(scope))
        matches = tuple(
            candidate
            for candidate in compared
            if same_pending_identity(candidate, proposed) and self._same_dependencies(scope, fact, candidate)
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
                    "subject",
                    "category",
                    "topic",
                    "normalized_text",
                    "source_ids",
                    "valid_at",
                    "invalid_at",
                    "source_dependency_mode",
                    "dimension_evidence",
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

    def _create_pending_candidate(
        self, scope: ContactScope, fact: ExtractedFact, *, failure_reason: str | None = None
    ) -> MemoryCandidate:
        candidate = _candidate_from_fact(scope, fact, namespace=self._candidate_namespace)
        if failure_reason:
            candidate = replace(candidate, failure_reason=failure_reason)
        for existing in self._memory_port.list_pending_candidates(scope):
            if same_pending_identity(existing, candidate):
                record("write_result", {"operation": "reuse_pending", "actual": existing,
                                        "commit_status": "already_committed"})
                return existing
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
        actual = self._persist_candidate(candidate)
        record(
            "write_result",
            {
                "operation": "create_pending",
                "actual": actual,
                "commit_status": "committed",
            },
            links=({**link, "record_id": actual.candidate_id, "commit_status": "committed"},),
            started_at=write_started_at,
            status="committed",
        )
        return actual

    def _create_owner_memory(
        self, scope: ContactScope, fact: ExtractedFact, *, previous: OwnerMemory | None = None,
    ) -> OwnerMemory | None:
        if self._owner_memory_port is None:
            raise TypeError("self 主体事实需要注入 owner 级记忆 port。")
        if previous is not None or self._dimension_release.gate_enabled or hasattr(self._memory_port, "assess_correction"):
            candidate = self._create_pending_candidate(scope, fact)
            if candidate.status is not MemoryCandidateStatus.PENDING or candidate.correction_review:
                return None
            current = _stored_candidate_fact(fact, candidate)
            if not self._passes_all_adoption_gates(current, scope=scope):
                return None
            started = datetime.now(timezone.utc)
            try:
                actual = self._owner_memory_port.confirm_candidate(
                    candidate=candidate, adoption_method=AdoptionMethod.AUTO,
                    **({"expected_previous": previous} if previous is not None else {}),
                )
            except (DimensionEvidenceChangedError, MemoryCorrectionConflictError, MemoryVersionConflict):
                return None
            record(
                "write_result",
                {"operation": "confirm_owner", "actual": actual,
                 "commit_status": "committed"},
                started_at=started, status="committed",
                links=({"record_kind": "owner_memory",
                        "record_id": actual.memory_id,
                        "commit_status": "committed"},),
            )
            return actual
        memory = OwnerMemory(
            memory_id=uuid4(),
            owner_id=scope.owner_id,
            text=fact.text,
            category=fact.category,
            topic=fact.topic,
            source_ids=fact.source_message_ids,
            source_dependency_mode=fact.source_dependency_mode,
            requires_all_sources=fact.requires_all_sources,
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
            links=({**link, "record_id": actual.memory_id, "commit_status": "committed"},),
            started_at=write_started_at,
            status="committed",
        )
        return actual

    def _confirm_contact_memory(
        self, scope: ContactScope, fact: ExtractedFact, *, previous: ConfirmedMemory | None = None,
    ) -> ConfirmedMemory | None:
        planned = _candidate_from_fact(scope, fact, namespace=self._candidate_namespace)
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
        candidate = self._persist_candidate(planned)
        record(
            "write_result",
            {
                "operation": "create_candidate",
                "actual": candidate,
                "commit_status": "committed",
            },
            links=({**link, "record_id": candidate.candidate_id, "commit_status": "committed"},),
            started_at=write_started_at,
            status="committed",
        )
        if candidate.status is not MemoryCandidateStatus.PENDING or candidate.correction_review:
            return None
        current_fact = _stored_candidate_fact(fact, candidate)
        if not self._passes_all_adoption_gates(current_fact, scope=scope):
            return None
        record(
            "write_plan",
            {
                "operation": "confirm_contact",
                "candidate_id": candidate.candidate_id,
                "adoption_method": "auto",
            },
        )
        write_started_at = datetime.now(timezone.utc)
        try:
            if self._dimension_release.gate_enabled:
                actual = self._memory_port.confirm(
                    scope=scope,
                    candidate_id=candidate.candidate_id,
                    adoption_method=AdoptionMethod.AUTO,
                    expected_dimension_evidence=candidate.dimension_evidence,
                    **({"expected_previous": previous} if previous is not None else {}),
                )
            else:
                actual = self._memory_port.confirm(
                    scope=scope,
                    candidate_id=candidate.candidate_id,
                    adoption_method=AdoptionMethod.AUTO,
                    **({"expected_previous": previous} if previous is not None else {}),
                )
        except (DimensionEvidenceChangedError, MemoryCorrectionConflictError, MemoryVersionConflict):
            return None
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


def _candidate_from_fact(
    scope: ContactScope, fact: ExtractedFact, *, namespace: UUID | None = None,
) -> MemoryCandidate:
    frozen = snapshot(fact)
    frozen["dimension_evidence"] = fact.dimension_evidence.to_payload() if fact.dimension_evidence else None
    identifier = (uuid5(namespace, json.dumps(snapshot((scope, frozen)), sort_keys=True, ensure_ascii=False))
                  if namespace is not None else uuid4())
    return MemoryCandidate(
        candidate_id=identifier, scope=scope, text=fact.text,
        category=fact.category, source_ids=fact.source_message_ids,
        topic=fact.topic, subject=fact.subject,
        status=MemoryCandidateStatus.PENDING,
        valid_at=fact.valid_at, invalid_at=fact.invalid_at,
        confidence=fact.confidence, risk_flags=fact.risk_flags,
        alternatives=fact.alternatives,
        interpretation_reason=fact.interpretation_reason,
        timing=fact.timing, dimension_evidence=fact.dimension_evidence, event=fact.event,
        source_dependency_mode=fact.source_dependency_mode,
        requires_all_sources=fact.requires_all_sources,
    )


def _stored_candidate_fact(fact: ExtractedFact, candidate: MemoryCandidate) -> ExtractedFact:
    """复用候选时按其实际旧评分与风险重走全部门，不借新输出补认证。"""
    return replace(fact, text=candidate.text, subject=candidate.subject,
                   category=candidate.category, topic=candidate.topic,
                   source_message_ids=candidate.source_ids,
                   confidence=candidate.confidence, risk_flags=candidate.risk_flags,
                   alternatives=candidate.alternatives, interpretation_reason=candidate.interpretation_reason,
                   valid_at=candidate.valid_at, invalid_at=candidate.invalid_at,
                   dimension_evidence=candidate.dimension_evidence, event=candidate.event,
                   requires_all_sources=candidate.requires_all_sources)


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
