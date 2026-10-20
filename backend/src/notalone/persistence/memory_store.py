"""关系记忆的 PostgreSQL 持久化适配器。"""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Sequence
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.memory.dimension_evidence import (
    DimensionEvidence,
    require_current_dimension_evidence,
)
from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.persistence.reply_layered_cleanup import erase_layered_reply_dependencies
from notalone.memory.events import MemoryEvent
from notalone.memory.conditions import MemoryConditions
from notalone.persistence.memory_conditions import bind_memory_conditions, manual_conditions
from notalone.persistence.memory_events import bind_memory_event, has_event_schema
from notalone.memory.versions import (
    MemoryVersionConflict, require_auto_previous, require_auto_update_previous,
    require_auto_update_receipt, require_version_receipt,
)
from notalone.persistence.dimension_evidence import (
    bind_stored_dimension_evidence, has_dimension_evidence,
    supports_dimension_evidence_version,
)

from notalone.memory.models import (
    MemoryChangeKind, MemoryRetirementReason,
    AdoptionMethod,
    ConfirmedMemory,
    ConfirmedMemoryStatus,
    FactSubject,
    MemoryCandidate,
    MemoryCandidateStatus,
    MemoryCategory,
    MemoryTopic,
    SourceDependencyMode,
)
from notalone.persistence.source_dependency import (
    dependency_mode, ensure_all_sources, insert_dependency,
)
from notalone.memory.candidates import same_pending_identity
from notalone.persistence.extraction_trace import erase_record_traces
from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.persistence.memory_timing import timed_memory_rows
from notalone.persistence.memory_versions import (
    bind_version_evidence, create_version_evidence, prepare_auto_revert, scoped_version_ids, validate_version_sources,
    erase_reverted_version,
    restored_version_evidence,
)
from notalone.memory.version_evidence import VersionEvidence
from notalone.persistence.message_sources import valid_source_ref_exists_sql
from notalone.persistence.correction_evidence import validate_frozen_snapshot
from notalone.persistence.memory_correction import (
    available_correction_memories, capture_evidence, erase_deleted_memory_bodies, has_correction_schema,
    persist_protection, protect_candidate, record_decision,
    require_reviewed_decisions,
)
from notalone.scopes import ContactScope

def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class MemoryPersistenceError(RuntimeError):
    """不暴露 SQL、连接信息或关系记忆正文的持久化错误。"""


class MemoryInvariantError(MemoryPersistenceError):
    """数据库中的关系记忆记录违反了领域数据契约。"""


_CANDIDATE_COLUMNS = """
    id AS candidate_id,
    owner_id,
    contact_id,
    text_content AS candidate_text,
    category AS candidate_category,
    topic AS candidate_topic,
    subject AS candidate_subject,
    source_ids AS candidate_source_ids,
    status AS candidate_status,
    valid_at AS candidate_valid_at,
    invalid_at AS candidate_invalid_at,
    confidence AS candidate_confidence,
    risk_flags AS candidate_risk_flags,
    alternatives AS candidate_alternatives,
    interpretation_reason AS candidate_interpretation_reason,
    failure_reason AS candidate_failure_reason,
    to_jsonb(memory_candidate)->'dimension_evidence' AS candidate_dimension_evidence,
    to_jsonb(memory_candidate)->'event' AS candidate_event,
    to_jsonb(memory_candidate)->'conditions' AS candidate_conditions,
    to_jsonb(memory_candidate)->>'source_dependency_mode' AS candidate_dependency_mode,
    to_jsonb(memory_candidate)->'requires_all_sources' AS candidate_requires_all_sources,
    created_at AS recorded_at
"""

_MEMORY_COLUMNS = """
    id AS memory_id,
    owner_id,
    contact_id,
    text_content AS memory_text,
    category AS memory_category,
    topic AS memory_topic,
    source_ids AS memory_source_ids,
    source_candidate_id,
    adoption_method,
    status AS memory_status,
    valid_at,
    invalid_at,
    revision,
    confidence AS memory_confidence,
    risk_flags AS memory_risk_flags,
    supersedes_memory_id,
    to_jsonb(confirmed_memory)->'event' AS memory_event,
    to_jsonb(confirmed_memory)->'conditions' AS memory_conditions,
    to_jsonb(confirmed_memory)->'version_evidence' AS version_evidence,
    to_jsonb(confirmed_memory)->>'retirement_reason' AS retirement_reason,
    (to_jsonb(confirmed_memory)->>'retired_at')::timestamptz AS retired_at,
    to_jsonb(confirmed_memory)->>'source_dependency_mode' AS memory_dependency_mode,
    to_jsonb(confirmed_memory)->'requires_all_sources' AS memory_requires_all_sources,
    created_at AS recorded_at
"""


class PostgresMemoryStore:
    """按联系人范围原子保存关系记忆候选和已确认记忆。"""

    __slots__ = ("_clock", "_database_url", "_id_factory", "_connection_factory")

    def __init__(
        self,
        database_url: str,
        *,
        clock: Callable[[], datetime] = _utc_now,
        id_factory: Callable[[], UUID] = uuid4,
        connection_factory=None,
    ) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        if not callable(clock) or not callable(id_factory):
            raise TypeError("MemoryStore 的时钟和标识生成器必须可调用。")
        self._database_url = database_url
        self._clock = clock
        self._id_factory = id_factory
        self._connection_factory = connection_factory

    @property
    def database_url(self) -> str:
        """供同一数据库内的提取追踪装配使用。"""
        return self._database_url

    def assess_correction(self, candidate: MemoryCandidate) -> MemoryCandidate:
        """提取可提前查询保护；实际保存和确认仍在写入事务复验。"""
        with self._connect() as connection:
            return protect_candidate(connection, candidate)[0]

    def create_candidate(self, candidate: MemoryCandidate) -> MemoryCandidate:
        """保存一条带来源和联系人范围的候选。"""

        if not isinstance(candidate, MemoryCandidate):
            raise TypeError("关系记忆候选结构无效。")
        try:
            with self._connect() as connection:
                lock_contact_scope(
                    connection,
                    owner_id=candidate.scope.owner_id,
                    contact_id=candidate.scope.contact_id,
                )
                lock_owner_scope(connection, owner_id=candidate.scope.owner_id)
                self._ensure_active_sources(
                    connection,
                    candidate.scope,
                    candidate.source_ids,
                )
                pending_rows = connection.execute(
                    f"SELECT {_CANDIDATE_COLUMNS} FROM public.memory_candidate "
                    "WHERE owner_id=%s AND contact_id=%s AND status='pending' "
                    "AND NOT EXISTS (SELECT 1 FROM public.memory_candidate collision WHERE collision.id=%s) "
                    "FOR UPDATE",
                    (candidate.scope.owner_id, candidate.scope.contact_id, candidate.candidate_id),
                ).fetchall()
                for row in self._timed_candidates(connection, pending_rows):
                    existing = self._candidate_from_row(row)
                    if same_pending_identity(existing, candidate):
                        protected, snapshot = protect_candidate(connection, existing)
                        if snapshot is not None:
                            persist_protection(connection, protected, snapshot)
                        return protected
                candidate, correction_evidence = protect_candidate(connection, candidate)
                if candidate.source_dependency_mode is SourceDependencyMode.ALL:
                    ensure_all_sources(connection, owner_id=candidate.scope.owner_id,
                                       contact_id=candidate.scope.contact_id,
                                       source_ids=candidate.source_ids)
                    if (candidate.dimension_evidence is not None
                            and candidate.dimension_evidence.version != 4):
                        raise MemoryInvariantError("ALL候选不能保存旧版依据。")
                else:
                    self._ensure_active_sources(connection, candidate.scope, candidate.source_ids)
                    if (candidate.dimension_evidence is not None
                            and candidate.dimension_evidence.version == 4):
                        raise MemoryInvariantError("新版本依据必须使用ALL来源。")
                mode_column, mode_value, mode_params = insert_dependency(candidate.source_dependency_mode, requires_all_sources=candidate.requires_all_sources, connection=connection, table='memory_candidate')
                evidence_column = ""
                evidence_value = ""
                evidence_params: tuple[Any, ...] = ()
                if candidate.dimension_evidence is not None:
                    if not supports_dimension_evidence_version(
                        connection, candidate.dimension_evidence.version,
                    ):
                        raise MemoryPersistenceError(
                            "数据库尚未启用维度依据；须先批准并完成迁移。"
                        )
                    if candidate.dimension_evidence.version in {2, 3, 4}:
                        current = bind_stored_dimension_evidence(
                            connection, candidate, lock_sources=True,
                        )
                        require_current_dimension_evidence(
                            current, candidate.dimension_evidence,
                        )
                    evidence_column = ", dimension_evidence"
                    evidence_value = ", %s"
                    evidence_params = (Jsonb(candidate.dimension_evidence.to_payload()),)
                if candidate.event is not None:
                    if not has_event_schema(connection):
                        raise MemoryPersistenceError("数据库尚未启用事件字段，须先批准并完成迁移。")
                    evidence_column += ", event"
                    evidence_value += ", %s"
                    evidence_params += (Jsonb(candidate.event.to_payload()),)
                if candidate.conditions is not None:
                    evidence_column += ", conditions"
                    evidence_value += ", %s"
                    evidence_params += (Jsonb(candidate.conditions.to_payload()),)
                if correction_evidence is not None:
                    evidence_column += ", correction_evidence"
                    evidence_value += ", %s"
                    evidence_params += (Jsonb(correction_evidence),)
                row = connection.execute(
                    f"""
                    INSERT INTO public.memory_candidate (
                        id, owner_id, contact_id, text_content, category,
                        topic, subject, source_ids, status, valid_at, invalid_at,
                        confidence, risk_flags, alternatives,
                        interpretation_reason, failure_reason{evidence_column}{mode_column}
                    )
                    VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s{evidence_value}{mode_value}
                    )
                    RETURNING {_CANDIDATE_COLUMNS}
                    """,
                    (
                        candidate.candidate_id,
                        candidate.scope.owner_id,
                        candidate.scope.contact_id,
                        candidate.text,
                        candidate.category.value,
                        candidate.topic.value,
                        candidate.subject.value,
                        list(candidate.source_ids),
                        candidate.status.value,
                        candidate.valid_at,
                        candidate.invalid_at,
                        candidate.confidence,
                        list(candidate.risk_flags),
                        list(candidate.alternatives),
                        candidate.interpretation_reason or None,
                        candidate.failure_reason,
                    ) + evidence_params + mode_params,
                ).fetchone()
                if row is None:
                    raise MemoryInvariantError(
                        "关系记忆候选写入结果为空。"
                    )
                return self._candidate_from_row(
                    self._timed_candidates(connection, [row])[0]
                )
        except psycopg.errors.UniqueViolation:
            raise ValueError("关系记忆候选标识重复。") from None
        except MemoryPersistenceError:
            raise
        except psycopg.Error:
            raise MemoryPersistenceError(
                "关系记忆数据库操作失败。"
            ) from None
        except (KeyError, TypeError, ValueError):
            raise MemoryInvariantError(
                "关系记忆数据库记录结构无效。"
            ) from None

    def create_manual_candidate(self, candidate: MemoryCandidate) -> MemoryCandidate:
        """为手动录入创建一条 manual 来源并保存候选（同一事务）。

        手动录入不依赖提取来源：这里以候选正文的 SHA-256 为指纹创建
        一条 manual 类型来源记录，再按普通候选路径保存，保证后续
        confirm 与检索过滤（仍要有有效来源）都能通过。
        """

        if not isinstance(candidate, MemoryCandidate):
            raise TypeError("关系记忆候选结构无效。")
        if candidate.source_dependency_mode is not SourceDependencyMode.ANY:
            raise ValueError("独立手动录入必须使用ANY来源。")
        try:
            digest = hashlib.sha256(
                candidate.text.encode("utf-8")
            ).hexdigest()
            with self._connect() as connection:
                lock_contact_scope(
                    connection,
                    owner_id=candidate.scope.owner_id,
                    contact_id=candidate.scope.contact_id,
                )
                lock_owner_scope(connection, owner_id=candidate.scope.owner_id)
                source_row = connection.execute(
                    """
                    INSERT INTO public.source_document (
                        owner_id, contact_id, source_type, file_name,
                        content_sha256, record_count
                    )
                    VALUES (%s, %s, 'manual', %s, %s, 1)
                    ON CONFLICT (owner_id, contact_id, content_sha256)
                    DO NOTHING
                    RETURNING id
                    """,
                    (
                        candidate.scope.owner_id,
                        candidate.scope.contact_id,
                        f"manual-{candidate.candidate_id}.jsonl",
                        digest,
                    ),
                ).fetchone()
                if source_row is None:
                    source_row = connection.execute(
                        """
                        SELECT id
                        FROM public.source_document
                        WHERE owner_id = %s
                          AND contact_id = %s
                          AND content_sha256 = %s
                        """,
                        (
                            candidate.scope.owner_id,
                            candidate.scope.contact_id,
                            digest,
                        ),
                    ).fetchone()
                if source_row is None:
                    raise MemoryInvariantError("手动来源创建结果为空。")
                source_id = source_row["id"]
                row = connection.execute(
                    f"""
                    INSERT INTO public.memory_candidate (
                        id, owner_id, contact_id, text_content, category,
                        topic, subject, source_ids, status, valid_at, invalid_at,
                        confidence, risk_flags, alternatives,
                        interpretation_reason, failure_reason
                    )
                    VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s
                    )
                    RETURNING {_CANDIDATE_COLUMNS}
                    """,
                    (
                        candidate.candidate_id,
                        candidate.scope.owner_id,
                        candidate.scope.contact_id,
                        candidate.text,
                        candidate.category.value,
                        candidate.topic.value,
                        candidate.subject.value,
                        [source_id],
                        candidate.status.value,
                        candidate.valid_at,
                        candidate.invalid_at,
                        candidate.confidence,
                        list(candidate.risk_flags),
                        list(candidate.alternatives),
                        candidate.interpretation_reason or None,
                        candidate.failure_reason,
                    ),
                ).fetchone()
                if row is None:
                    raise MemoryInvariantError(
                        "关系记忆候选写入结果为空。"
                    )
                if has_correction_schema(connection):
                    # 只在本次明确主动录入时建立当前依据，不回填历史 NULL 候选。
                    evidence = capture_evidence(
                        connection, scope=candidate.scope, source_ids=(source_id,),
                    )
                    connection.execute(
                        "UPDATE public.memory_candidate SET correction_evidence=%s WHERE owner_id=%s AND id=%s",
                        (Jsonb(evidence), candidate.scope.owner_id, candidate.candidate_id),
                    )
                return self._candidate_from_row(
                    self._timed_candidates(connection, [row])[0]
                )
        except psycopg.errors.UniqueViolation:
            raise ValueError("关系记忆候选标识重复。") from None
        except MemoryPersistenceError:
            raise
        except psycopg.Error:
            raise MemoryPersistenceError(
                "关系记忆数据库操作失败。"
            ) from None
        except (KeyError, TypeError, ValueError):
            raise MemoryInvariantError(
                "关系记忆数据库记录结构无效。"
            ) from None

    def get_candidate(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
    ) -> MemoryCandidate:
        """读取指定候选并强制校验联系人范围。"""

        self._validate_scope(scope)
        self._validate_uuid(candidate_id, "candidate_id")
        try:
            with self._connect() as connection:
                row = connection.execute(
                    f"""
                    SELECT {_CANDIDATE_COLUMNS}
                    FROM public.memory_candidate
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                    """,
                    (scope.owner_id, scope.contact_id, candidate_id),
                ).fetchone()
                if row is None:
                    exists = connection.execute(
                        "SELECT 1 FROM public.memory_candidate WHERE id = %s",
                        (candidate_id,),
                    ).fetchone()
                    if exists is not None:
                        raise PermissionError("关系记忆范围校验失败。")
                    raise LookupError("关系记忆候选不存在。")
                self._ensure_scope(row, scope)
                return self._candidate_from_row(
                    self._timed_candidates(connection, [row])[0]
                )
        except (LookupError, PermissionError, MemoryPersistenceError):
            raise
        except psycopg.Error:
            raise MemoryPersistenceError("关系记忆数据库操作失败。") from None
        except (KeyError, TypeError, ValueError):
            raise MemoryInvariantError("关系记忆数据库记录结构无效。") from None

    def confirm_merge(self, *, scope, candidate_id, expected_parents, expected_dimension_evidence=None):
        """原子合并多个自动版本，手动版本及过期裁决均拒绝。"""
        from notalone.persistence.memory_merge import confirm_merge
        return confirm_merge(self, scope=scope, candidate_id=candidate_id,
            expected_parents=expected_parents, expected_dimension_evidence=expected_dimension_evidence, owner=False)

    def confirm(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
        adoption_method: AdoptionMethod = AdoptionMethod.AUTO,
        expected_dimension_evidence: DimensionEvidence | None = None,
        expected_correction_decision_ids: tuple[UUID, ...] | None = None,
        expected_previous: ConfirmedMemory | None = None,
    ) -> ConfirmedMemory:
        """在同一事务中确认候选并创建已确认记忆。"""

        self._validate_scope(scope)
        self._validate_uuid(candidate_id, "candidate_id")
        if not isinstance(adoption_method, AdoptionMethod):
            raise TypeError("关系记忆采纳方式无效。")
        if expected_previous is not None:
            if not isinstance(expected_previous, ConfirmedMemory):
                raise TypeError("自动替代原版本无效。")
            if expected_previous.scope != scope:
                raise PermissionError("关系记忆范围校验失败。")
        try:
            with self._connect() as connection:
                lock_contact_scope(
                    connection,
                    owner_id=scope.owner_id,
                    contact_id=scope.contact_id,
                )
                lock_owner_scope(connection, owner_id=scope.owner_id)
                candidate_row = self._candidate_for_update(
                    connection, candidate_id, scope
                )
                if candidate_row is None:
                    raise LookupError("关系记忆候选不存在。")
                self._ensure_scope(candidate_row, scope)
                current_candidate = self._candidate_from_row(
                    self._timed_candidates(connection, [candidate_row])[0]
                )
                protected, snapshot = protect_candidate(connection, current_candidate)
                require_reviewed_decisions(
                    protected, adoption_method, expected_correction_decision_ids,
                )
                status = MemoryCandidateStatus(candidate_row["candidate_status"])
                if status is MemoryCandidateStatus.CONFIRMED:
                    memory_row = connection.execute(
                        f"""
                        SELECT {_MEMORY_COLUMNS}
                        FROM public.confirmed_memory
                        WHERE owner_id = %s
                          AND contact_id = %s
                          AND source_candidate_id = %s
                        """,
                        (scope.owner_id, scope.contact_id, candidate_id),
                    ).fetchone()
                    if memory_row is None:
                        raise MemoryInvariantError(
                            "已确认候选缺少对应关系记忆。"
                        )
                    actual = self._memory_from_row(
                        self._timed_memories(connection, [memory_row])[0]
                    )
                    if expected_previous is not None:
                        if adoption_method is AdoptionMethod.AUTO:
                            require_auto_update_receipt(actual, expected_previous)
                        else:
                            require_version_receipt(actual, expected_previous, adoption_method)
                        previous_row = self._memory_for_update(
                            connection, expected_previous.memory_id, follow_current=False,
                        )
                        if previous_row is None:
                            raise MemoryCorrectionConflictError("原资料已删除，自动回执不可复用。")
                        require_auto_update_previous(
                            self._memory_from_row(self._timed_memories(connection, [previous_row])[0]),
                            expected_previous, allow_manual=adoption_method is AdoptionMethod.MANUAL,
                        )
                    return actual
                if status is not MemoryCandidateStatus.PENDING:
                    raise RuntimeError("关系记忆候选当前不可确认。")
                if expected_previous is not None:
                    previous_row = self._memory_for_update(
                        connection, expected_previous.memory_id, follow_current=False,
                    )
                    if previous_row is None:
                        raise MemoryCorrectionConflictError("原资料已删除，自动替代未应用。")
                    self._ensure_scope(previous_row, scope)
                    require_auto_previous(
                        self._memory_from_row(self._timed_memories(connection, [previous_row])[0]),
                        expected_previous, allow_manual=adoption_method is AdoptionMethod.MANUAL,
                    )
                    self._ensure_active_sources(connection, scope, expected_previous.source_ids)
                if snapshot is not None:
                    persist_protection(connection, protected, snapshot)
                source_ids = self._source_ids(candidate_row["candidate_source_ids"])
                if expected_previous is not None:
                    if (adoption_method is AdoptionMethod.AUTO and not set(source_ids) - set(expected_previous.source_ids)
                            or connection.execute(
                                "SELECT 1 FROM public.confirmed_memory WHERE owner_id=%s "
                                "AND contact_id=%s AND supersedes_memory_id=%s AND status='active'",
                                (scope.owner_id, scope.contact_id, expected_previous.memory_id),
                            ).fetchone() is not None):
                        raise MemoryVersionConflict("自动更新需要新依据和当前叶子版本。")
                    source_ids = tuple(dict.fromkeys((*expected_previous.source_ids, *source_ids)))
                self._ensure_active_sources(connection, scope, source_ids)
                mode = dependency_mode(candidate_row.get("candidate_dependency_mode"))
                if expected_previous is not None and expected_previous.source_dependency_mode is SourceDependencyMode.ALL:
                    mode = SourceDependencyMode.ALL
                if mode is SourceDependencyMode.ALL:
                    ensure_all_sources(connection, owner_id=scope.owner_id,
                                       contact_id=scope.contact_id, source_ids=source_ids)
                else:
                    self._ensure_active_sources(connection, scope, source_ids)
                requires_all_sources = bool(candidate_row.get('candidate_requires_all_sources')) or bool(expected_previous and expected_previous.requires_all_sources)
                mode_column, mode_value, mode_params = insert_dependency(mode, requires_all_sources=requires_all_sources, connection=connection, table='confirmed_memory')

                candidate = self._candidate_from_row(self._timed_candidates(
                    connection, [candidate_row], lock_sources=True
                )[0])
                if adoption_method is AdoptionMethod.AUTO:
                    require_current_dimension_evidence(
                        candidate.dimension_evidence, expected_dimension_evidence
                    )

                memory_id = self._new_uuid()
                event_column = ", event" if candidate.event is not None else ""
                event_value = ", %s" if candidate.event is not None else ""
                event_params = (Jsonb(candidate.event.to_payload()),) if candidate.event is not None else ()
                if candidate.conditions is not None:
                    event_column += ", conditions"
                    event_value += ", %s"
                    event_params += (Jsonb(candidate.conditions.to_payload()),)
                if expected_previous is not None:
                    proposed = ConfirmedMemory(
                        memory_id=memory_id, scope=scope, text=candidate.text,
                        category=candidate.category, topic=candidate.topic, source_ids=source_ids,
                        source_candidate_id=candidate_id, adoption_method=adoption_method,
                        valid_at=candidate.valid_at, invalid_at=candidate.invalid_at,
                        confidence=candidate.confidence, risk_flags=candidate.risk_flags,
                        revision=expected_previous.revision + 1,
                        supersedes_memory_id=expected_previous.memory_id, event=candidate.event, conditions=candidate.conditions,
                        source_dependency_mode=mode, requires_all_sources=requires_all_sources,
                    )
                    proof = create_version_evidence(connection, previous=expected_previous, current=proposed)
                    if adoption_method is AdoptionMethod.AUTO:
                        validate_version_sources(connection, owner_id=scope.owner_id, evidence=proof)
                    event_column += ", version_evidence"
                    event_value += ", %s"
                    event_params += (Jsonb(proof.to_payload()),)
                memory_row = connection.execute(
                    f"""
                    INSERT INTO public.confirmed_memory (
                        id, owner_id, contact_id, text_content, category,
                        topic, source_ids, source_candidate_id, adoption_method,
                        valid_at, invalid_at, confidence, risk_flags,
                        revision, supersedes_memory_id{event_column}{mode_column}
                    )
                    VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s{event_value}{mode_value}
                    )
                    RETURNING {_MEMORY_COLUMNS}
                    """,
                    (
                        memory_id,
                        scope.owner_id,
                        scope.contact_id,
                        candidate_row["candidate_text"],
                        candidate_row["candidate_category"],
                        candidate_row["candidate_topic"],
                        list(source_ids),
                        candidate_id,
                        adoption_method.value,
                        candidate_row["candidate_valid_at"],
                        candidate_row["candidate_invalid_at"],
                        candidate_row["candidate_confidence"],
                        candidate_row["candidate_risk_flags"],
                        expected_previous.revision + 1 if expected_previous else 1,
                        expected_previous.memory_id if expected_previous else None,
                        *event_params,
                    ) + mode_params,
                ).fetchone()
                if memory_row is None:
                    raise MemoryInvariantError("关系记忆写入结果为空。")
                erase_layered_reply_dependencies(connection, scope, {candidate_id, *source_ids})
                if expected_previous is not None:
                    erase_layered_reply_dependencies(connection, scope,
                        {expected_previous.memory_id, *expected_previous.source_ids})
                    invalidated = connection.execute(
                        "UPDATE public.confirmed_memory SET status='invalidated', "
                        "revision=revision+1, updated_at=now() "
                        "WHERE owner_id=%s AND contact_id=%s AND id=%s "
                        "AND status='active' AND revision=%s AND adoption_method=%s",
                        (scope.owner_id, scope.contact_id,
                         expected_previous.memory_id, expected_previous.revision,
                         expected_previous.adoption_method.value),
                    ).rowcount
                    if invalidated != 1:
                        raise MemoryCorrectionConflictError("原资料已变化，自动替代未应用。")
                updated = connection.execute(
                    """
                    UPDATE public.memory_candidate
                    SET status = 'confirmed', updated_at = now()
                    WHERE owner_id = %s
                      AND contact_id = %s
                      AND id = %s
                      AND status = 'pending'
                    """,
                    (scope.owner_id, scope.contact_id, candidate_id),
                ).rowcount
                if updated != 1:
                    raise MemoryInvariantError(
                        "关系记忆候选状态更新失败。"
                    )
                self._bump_memory_revision(connection, scope)
                return self._memory_from_row(
                    self._timed_memories(connection, [memory_row])[0]
                )
        except (LookupError, PermissionError, RuntimeError, MemoryPersistenceError):
            raise
        except psycopg.Error:
            raise MemoryPersistenceError(
                "关系记忆数据库操作失败。"
            ) from None
        except (KeyError, TypeError, ValueError):
            raise MemoryInvariantError(
                "关系记忆数据库记录结构无效。"
            ) from None

    def correct(
        self,
        *,
        scope: ContactScope,
        memory_id: UUID,
        text: str,
        category: MemoryCategory | None = None,
        change_kind: MemoryChangeKind = MemoryChangeKind.ERROR_CORRECTION,
        conditions: object = ...,
    ) -> ConfirmedMemory:
        """修正 active 记忆并递增 revision。"""

        self._validate_scope(scope)
        self._validate_uuid(memory_id, "memory_id")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("修正后的关系记忆不能为空。")
        if category is not None and not isinstance(category, MemoryCategory):
            raise TypeError("关系记忆分类无效。")
        change_kind = MemoryChangeKind(change_kind)
        try:
            with self._connect() as connection:
                lock_contact_scope(
                    connection,
                    owner_id=scope.owner_id,
                    contact_id=scope.contact_id,
                )
                lock_owner_scope(connection, owner_id=scope.owner_id)
                memory_row = self._memory_for_update(connection, memory_id, follow_current=False)
                if memory_row is None:
                    raise LookupError("关系记忆不存在。")
                self._ensure_scope(memory_row, scope)
                if memory_row["memory_status"] != (
                    ConfirmedMemoryStatus.ACTIVE.value
                ):
                    replay = connection.execute(
                        f"SELECT {_MEMORY_COLUMNS} FROM public.confirmed_memory "
                        "WHERE owner_id=%s AND contact_id=%s AND supersedes_memory_id=%s "
                        "AND status='active' AND adoption_method='manual' AND text_content=%s "
                        "AND category=%s",
                        (scope.owner_id, scope.contact_id, memory_id, text,
                         category.value if category else memory_row["memory_category"]),
                    ).fetchone()
                    if (replay is not None
                            and memory_row.get("retirement_reason") == change_kind.value):
                        if not available_correction_memories(
                            connection, owner_id=scope.owner_id, record_kind="contact_memory", rows=[replay],
                        ):
                            raise MemoryCorrectionConflictError("人工修正的参与来源正在删除或已不可用。")
                        self._ensure_active_sources(connection, scope, self._source_ids(replay["memory_source_ids"]))
                        for decision in connection.execute(
                            "SELECT evidence FROM public.memory_correction_decision "
                            "WHERE owner_id=%s AND contact_id=%s AND replacement_memory_id=%s",
                            (scope.owner_id, scope.contact_id, replay["memory_id"]),
                        ).fetchall():
                            validate_frozen_snapshot(connection, owner_id=scope.owner_id, evidence=decision["evidence"])
                        return self._memory_from_row(self._timed_memories(connection, [replay])[0])
                    raise MemoryCorrectionConflictError("资料版本已变化，请重新查看后修正。")
                next_category = (
                    category.value
                    if category
                    else memory_row["memory_category"]
                )
                source_ids = self._source_ids(memory_row["memory_source_ids"])
                mode = dependency_mode(memory_row.get("memory_dependency_mode"))
                if mode is SourceDependencyMode.ALL:
                    ensure_all_sources(connection, owner_id=scope.owner_id,
                                       contact_id=scope.contact_id, source_ids=source_ids)
                else:
                    self._ensure_active_sources(connection, scope, source_ids)
                requires_all_sources = bool(memory_row.get('memory_requires_all_sources'))
                mode_column, mode_value, mode_params = insert_dependency(mode, requires_all_sources=requires_all_sources, connection=connection, table='confirmed_memory')
                next_conditions = manual_conditions(connection, owner_id=scope.owner_id, previous=memory_row.get("memory_conditions"), proposed=conditions, source_ids=source_ids)
                if next_conditions is not None:
                    mode_column += ", conditions"
                    mode_value += ", %s"
                    mode_params += (Jsonb(next_conditions.to_payload()),)
                next_revision = memory_row["revision"] + 1
                retirement_columns = connection.execute(
                    "SELECT count(*) AS count FROM pg_attribute "
                    "WHERE attrelid = 'public.confirmed_memory'::regclass AND NOT attisdropped "
                    "AND attname IN ('retirement_reason', 'retired_at')"
                ).fetchone()["count"]
                if retirement_columns == 1 or (retirement_columns == 0
                        and change_kind is not MemoryChangeKind.ERROR_CORRECTION):
                    raise MemoryPersistenceError("关系记忆结构尚不支持本次修正。")
                # 旧库纠错仍使原版失效，读回保持unknown；不能把缺少退役记录的旧版当作合法历史。
                retirement_update = "retirement_reason = %s, retired_at = %s," if retirement_columns == 2 else ""
                retirement_params = (change_kind.value, self._now()) if retirement_columns == 2 else ()
                updated = connection.execute(
                    f"""
                    INSERT INTO public.confirmed_memory (
                        id, owner_id, contact_id, text_content, category,
                        topic, source_ids, source_candidate_id, adoption_method,
                        status, valid_at, invalid_at, revision,
                        confidence, risk_flags, supersedes_memory_id{mode_column}
                    )
                    VALUES (
                        %s, %s, %s, %s, %s, %s, %s, NULL, 'manual', 'active',
                        %s, %s, %s, %s, %s, %s{mode_value}
                    )
                    RETURNING {_MEMORY_COLUMNS}
                    """,
                    (
                        self._new_uuid(),
                        scope.owner_id,
                        scope.contact_id,
                        text,
                        next_category,
                        memory_row["memory_topic"],
                        list(source_ids),
                        memory_row["valid_at"],
                        memory_row["invalid_at"],
                        next_revision,
                        memory_row["memory_confidence"],
                        memory_row["memory_risk_flags"],
                        memory_row["memory_id"],
                    ) + mode_params,
                ).fetchone()
                if updated is None:
                    raise MemoryInvariantError("关系记忆新版本写入结果为空。")
                # 同事务先保存合法后继，避免旧叶失效触发器误判整条手录链已删除。
                invalidated = connection.execute(
                    f"""
                    UPDATE public.confirmed_memory
                    SET status = 'invalidated',
                        {retirement_update}
                        revision = %s,
                        updated_at = now()
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                    """,
                    retirement_params + (
                        next_revision,
                        scope.owner_id,
                        scope.contact_id,
                        memory_row["memory_id"],
                    ),
                ).rowcount
                if invalidated != 1:
                    raise MemoryInvariantError("原关系记忆失效更新失败。")
                source_candidate = None
                if memory_row["source_candidate_id"] is not None:
                    candidate_row = self._candidate_for_update(
                        connection, memory_row["source_candidate_id"], scope,
                    )
                    if candidate_row is not None:
                        source_candidate = self._candidate_from_row(
                            self._timed_candidates(connection, [candidate_row])[0]
                        )
                record_decision(
                    connection, change_kind=change_kind.value, scope=scope, record_kind="contact_memory",
                    record_id=memory_id, rejected_text=memory_row["memory_text"],
                    corrected_text=text, replacement_memory_id=updated["memory_id"],
                    source_ids=source_ids, candidate=source_candidate,
                )
                self._bump_memory_revision(connection, scope)
                return self._memory_from_row(
                    self._timed_memories(connection, [updated])[0]
                )
        except (LookupError, PermissionError, RuntimeError, MemoryPersistenceError):
            raise
        except psycopg.Error:
            raise MemoryPersistenceError(
                "关系记忆数据库操作失败。"
            ) from None
        except (KeyError, TypeError, ValueError):
            raise MemoryInvariantError(
                "关系记忆数据库记录结构无效。"
            ) from None

    def reject_candidate(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
    ) -> MemoryCandidate:
        """拒绝 pending 候选。"""

        return self._transition_candidate(
            scope=scope,
            candidate_id=candidate_id,
            next_status=MemoryCandidateStatus.REJECTED,
            error_message="当前关系记忆候选不能拒绝。",
        )

    def invalidate_candidate(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
    ) -> MemoryCandidate:
        """使 pending 候选失效。"""

        return self._transition_candidate(
            scope=scope,
            candidate_id=candidate_id,
            next_status=MemoryCandidateStatus.INVALIDATED,
            error_message="当前关系记忆候选不能失效。",
        )

    def discard_candidate_with_fingerprint(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
    ) -> MemoryCandidate:
        """拒绝候选并在同一事务写入删除指纹。

        丢弃是不再想要的候选：除候选失效外，还要在 confirmed_memory
        写入一条 deleted 指纹行（source_candidate_id 指向被拒候选），
        使同一文本的自动提取不会再复活（adoption 检查 deleted_texts）。
        手动录入不受限（不走该路径）。
        """

        self._validate_scope(scope)
        self._validate_uuid(candidate_id, "candidate_id")
        try:
            with self._connect() as connection:
                lock_contact_scope(
                    connection,
                    owner_id=scope.owner_id,
                    contact_id=scope.contact_id,
                )
                lock_owner_scope(connection, owner_id=scope.owner_id)
                row = self._candidate_for_update(connection, candidate_id, scope)
                if row is None:
                    raise LookupError("关系记忆候选不存在。")
                self._ensure_scope(row, scope)
                if row["candidate_status"] == MemoryCandidateStatus.REJECTED.value:
                    return self._candidate_from_row(self._timed_candidates(connection, [row])[0])
                if row["candidate_status"] != MemoryCandidateStatus.PENDING.value:
                    raise MemoryCorrectionConflictError("当前关系记忆候选不能丢弃。")
                erase_layered_reply_dependencies(connection, scope,
                    {candidate_id, *self._source_ids(row["candidate_source_ids"])})
                from notalone.managed_update_backups import erase_managed_update_backups
                erase_managed_update_backups(connection)
                record_decision(
                    connection, scope=scope, record_kind="candidate",
                    record_id=candidate_id, rejected_text=row["candidate_text"],
                    source_ids=self._source_ids(row["candidate_source_ids"]),
                    candidate=self._candidate_from_row(
                        self._timed_candidates(connection, [row])[0]
                    ),
                )
                mode = dependency_mode(row.get("candidate_dependency_mode"))
                requires_all_sources = bool(row.get('candidate_requires_all_sources'))
                mode_column, mode_value, mode_params = insert_dependency(mode, requires_all_sources=requires_all_sources, connection=connection, table='confirmed_memory')
                if mode is SourceDependencyMode.ALL:
                    ensure_all_sources(connection, owner_id=scope.owner_id,
                                       contact_id=scope.contact_id,
                                       source_ids=self._source_ids(row["candidate_source_ids"]))
                erase_record_traces(
                    connection,
                    owner_id=scope.owner_id,
                    record_kind="candidate",
                    record_id=candidate_id,
                )
                clear_evidence = (
                    ", dimension_evidence = NULL"
                    if row.get("candidate_dimension_evidence") is not None else ""
                )
                updated = connection.execute(
                    f"""
                    UPDATE public.memory_candidate
                    SET status = 'rejected', updated_at = now(){clear_evidence}
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                    RETURNING {_CANDIDATE_COLUMNS}
                    """,
                    (scope.owner_id, scope.contact_id, candidate_id),
                ).fetchone()
                if updated is None:
                    raise MemoryInvariantError(
                        "关系记忆候选状态更新为空。"
                    )
                source_ids = self._source_ids(row["candidate_source_ids"])
                # 删除指纹行：text 用于阻止自动复活，source_ids 指向候选来源，
                # source_candidate_id 引用被拒候选（UNIQUE 允许）。
                connection.execute(
                    f"""
                    INSERT INTO public.confirmed_memory (
                        id, owner_id, contact_id, text_content, category,
                        topic, source_ids, source_candidate_id, adoption_method,
                        status, revision{mode_column}
                    )
                    VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s, 'auto', 'deleted', 1{mode_value}
                    )
                    """,
                    (
                        self._new_uuid(),
                        scope.owner_id,
                        scope.contact_id,
                        row["candidate_text"],
                        row["candidate_category"],
                        row["candidate_topic"],
                        list(source_ids),
                        candidate_id,
                    ) + mode_params,
                )
                return self._candidate_from_row(
                    self._timed_candidates(connection, [updated])[0]
                )
        except (LookupError, PermissionError, RuntimeError, MemoryPersistenceError):
            raise
        except psycopg.Error:
            raise MemoryPersistenceError(
                "关系记忆数据库操作失败。"
            ) from None
        except (KeyError, TypeError, ValueError):
            raise MemoryInvariantError(
                "关系记忆数据库记录结构无效。"
            ) from None

    def invalidate(self, *, scope: ContactScope, memory_id: UUID) -> ConfirmedMemory:
        """使记忆失效并保留审计状态。"""

        return self._transition_memory(
            scope=scope,
            memory_id=memory_id,
            next_status=ConfirmedMemoryStatus.INVALIDATED,
            reject_deleted=True,
            error_message="已删除的关系记忆不能再次失效。",
        )

    def delete(self, *, scope: ContactScope, memory_id: UUID) -> ConfirmedMemory:
        """标记记忆删除，使其不再进入检索。"""

        return self._transition_memory(
            scope=scope,
            memory_id=memory_id,
            next_status=ConfirmedMemoryStatus.DELETED,
            reject_deleted=False,
            error_message="关系记忆删除失败。",
        )

    def list_confirmed(self, scope: ContactScope, *, include_expired: bool = False, include_invalidated: bool = False) -> tuple[ConfirmedMemory, ...]:
        """检索默认排除过期；管理列表可包含失效记录，但仍须有合法来源。"""

        self._validate_scope(scope)
        if type(include_expired) is not bool or type(include_invalidated) is not bool:
            raise TypeError("历史回看标记必须是 bool。")
        current = self._now()
        try:
            with self._connect() as connection:
                # 外层提供的共享事务已经开始，隔离与提交由该事务决定。
                if self._connection_factory is None:
                    connection.execute(
                        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
                    )
                rows = connection.execute(
                    f"""
                    SELECT {_MEMORY_COLUMNS.replace("to_jsonb(confirmed_memory)", "to_jsonb(memory)")}
                    FROM public.confirmed_memory AS memory
                    WHERE memory.owner_id = %s
                      AND memory.contact_id = %s
                      AND (memory.status = 'active' OR (%s AND memory.status = 'invalidated'))
                      AND (
                          memory.valid_at IS NULL OR memory.valid_at <= %s
                      )
                      AND (
                          %s OR memory.invalid_at IS NULL OR %s < memory.invalid_at
                      )
                      AND (
                          EXISTS (
                              SELECT 1
                              FROM public.source_document AS source
                              WHERE source.owner_id = memory.owner_id
                                AND source.contact_id = memory.contact_id
                                AND source.id = ANY(memory.source_ids)
                                AND source.status = 'active'
                          )
                          OR EXISTS (
                              SELECT 1
                              FROM public.local_wechat_observation AS observation
                              WHERE observation.owner_id = memory.owner_id
                                AND observation.contact_id = memory.contact_id
                                AND observation.id = ANY(memory.source_ids)
                          )
                          OR EXISTS (
                              SELECT 1
                              FROM public.message AS message
                              WHERE message.owner_id = memory.owner_id
                                AND message.contact_id = memory.contact_id
                                AND message.id = ANY(memory.source_ids)
                                AND {valid_source_ref_exists_sql("message")}
                          )
                      )
                    ORDER BY memory.created_at, memory.id
                    """,
                    (scope.owner_id, scope.contact_id, include_invalidated, current, include_expired, current),
                ).fetchall()
                rows = available_correction_memories(
                    connection, owner_id=scope.owner_id, record_kind="contact_memory", rows=rows,
                )
                visible = []
                for row in rows:
                    if row["memory_status"] == "invalidated":
                        # 旧版回看沿用版本详情的完整来源门槛，不能恢复已删来源的正文。
                        try:
                            self._ensure_active_sources(connection, scope, tuple(row["memory_source_ids"]))
                        except PermissionError:
                            continue
                    visible.append(row)
                return tuple(self._memory_from_row(row)
                             for row in self._timed_memories(connection, visible))
        except MemoryPersistenceError:
            raise
        except psycopg.Error:
            raise MemoryPersistenceError(
                "关系记忆数据库操作失败。"
            ) from None
        except (KeyError, TypeError, ValueError):
            raise MemoryInvariantError(
                "关系记忆数据库记录结构无效。"
            ) from None

    def list_versions(self, *, scope: ContactScope, memory_id: UUID) -> tuple[ConfirmedMemory, ...]:
        self._validate_scope(scope)
        self._validate_uuid(memory_id, "memory_id")
        with self._connect() as connection:
            lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
            ids = scoped_version_ids(connection, table="confirmed_memory", owner_id=scope.owner_id,
                                     contact_id=scope.contact_id, memory_id=memory_id)
            rows = connection.execute(
                f"SELECT {_MEMORY_COLUMNS} FROM public.confirmed_memory "
                "WHERE owner_id=%s AND contact_id=%s AND id=ANY(%s) ORDER BY array_position(%s::uuid[],id)",
                (scope.owner_id, scope.contact_id, list(ids), list(ids)),
            ).fetchall()
            for row in rows:
                self._ensure_active_sources(connection, scope, tuple(row["memory_source_ids"]))
            return tuple(self._memory_from_row(row) for row in self._timed_memories(connection, rows))

    def revert_auto_update(self, *, scope: ContactScope, memory_id: UUID, expected_revision: int) -> ConfirmedMemory:
        self._validate_scope(scope)
        self._validate_uuid(memory_id, "memory_id")
        with self._connect() as connection:
            lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
            lock_owner_scope(connection, owner_id=scope.owner_id)
            current, previous = prepare_auto_revert(
                connection, table="confirmed_memory", owner_id=scope.owner_id,
                contact_id=scope.contact_id, memory_id=memory_id, expected_revision=expected_revision,
            )
            self._ensure_active_sources(connection, scope, tuple(dict.fromkeys(
                (*current["source_ids"], *previous["source_ids"])
            )))
            erase_layered_reply_dependencies(connection, scope,
                {memory_id, previous["id"], *current["source_ids"], *previous["source_ids"]})
            proof = restored_version_evidence(connection, previous=previous, revision=expected_revision + 1)
            from notalone.persistence.reply_cleanup import delete_contact_memory_replies
            delete_contact_memory_replies(connection, scope=scope, memory_id=memory_id)
            erase_reverted_version(connection, table="confirmed_memory", owner_id=scope.owner_id, current=current)
            restored = connection.execute(
                f"UPDATE public.confirmed_memory SET status='active', revision=%s, version_evidence=%s, updated_at=now() "
                f"WHERE owner_id=%s AND contact_id=%s AND id=%s RETURNING {_MEMORY_COLUMNS}",
                (expected_revision + 1, Jsonb(proof.to_payload()) if proof else None,
                 scope.owner_id, scope.contact_id, previous["id"]),
            ).fetchone()
            self._bump_memory_revision(connection, scope)
            return self._memory_from_row(self._timed_memories(connection, [restored])[0])

    def list_pending_candidates(self, scope: ContactScope) -> tuple[MemoryCandidate, ...]:
        """返回联系人范围内所有 pending 候选，供人工处理。"""

        self._validate_scope(scope)
        try:
            with self._connect() as connection:
                if self._connection_factory is None:
                    connection.execute(
                        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
                    )
                rows = connection.execute(
                    f"""
                    SELECT {_CANDIDATE_COLUMNS}
                    FROM public.memory_candidate
                    WHERE owner_id = %s
                      AND contact_id = %s
                      AND status = 'pending'
                    ORDER BY created_at, id
                    """,
                    (scope.owner_id, scope.contact_id),
                ).fetchall()
                candidates = (
                    self._candidate_from_row(row)
                    for row in self._timed_candidates(connection, rows)
                )
                return tuple(candidate for candidate in candidates
                             if candidate.status is MemoryCandidateStatus.PENDING)
        except MemoryPersistenceError:
            raise
        except psycopg.Error:
            raise MemoryPersistenceError(
                "关系记忆数据库操作失败。"
            ) from None
        except (KeyError, TypeError, ValueError):
            raise MemoryInvariantError(
                "关系记忆数据库记录结构无效。"
            ) from None

    def deleted_texts(self, scope: ContactScope) -> tuple[str, ...]:
        """返回该联系人范围内已删除记忆的文本，用于阻止自动提取复活。"""

        self._validate_scope(scope)
        try:
            with self._connect() as connection:
                rows = connection.execute(
                    """
                    SELECT text_content
                    FROM public.confirmed_memory AS memory
                    WHERE owner_id = %s AND contact_id = %s
                      AND status = 'deleted'
                    """,
                    (scope.owner_id, scope.contact_id),
                ).fetchall()
        except Exception as error:
            raise MemoryPersistenceError(
                "关系记忆数据库操作失败。"
            ) from error
        return tuple(row["text_content"] for row in rows)

    def fail_automatic_candidate(self, *, scope: ContactScope, candidate_id: UUID) -> None:
        """仅终结自动写入临时候选；不登记用户拒绝，也不清除其他资料依赖。"""
        self._validate_scope(scope)
        self._validate_uuid(candidate_id, "candidate_id")
        with self._connect() as connection:
            lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
            lock_owner_scope(connection, owner_id=scope.owner_id)
            connection.execute("UPDATE public.memory_candidate SET status='rejected', "
                "failure_reason=COALESCE(failure_reason,'automatic_write_failed') "
                "WHERE id=%s AND owner_id=%s AND contact_id=%s AND status='pending'",
                (candidate_id, scope.owner_id, scope.contact_id))

    def _transition_candidate(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
        next_status: MemoryCandidateStatus,
        error_message: str,
    ) -> MemoryCandidate:
        self._validate_scope(scope)
        self._validate_uuid(candidate_id, "candidate_id")
        try:
            with self._connect() as connection:
                lock_contact_scope(
                    connection,
                    owner_id=scope.owner_id,
                    contact_id=scope.contact_id,
                )
                lock_owner_scope(connection, owner_id=scope.owner_id)
                row = self._candidate_for_update(connection, candidate_id, scope)
                if row is None:
                    raise LookupError("关系记忆候选不存在。")
                self._ensure_scope(row, scope)
                if row["candidate_status"] == next_status.value:
                    return self._candidate_from_row(self._timed_candidates(connection, [row])[0])
                erase_layered_reply_dependencies(connection, scope,
                    {candidate_id, *self._source_ids(row["candidate_source_ids"])})
                if next_status is MemoryCandidateStatus.REJECTED:
                    if row["candidate_status"] == MemoryCandidateStatus.REJECTED.value:
                        return self._candidate_from_row(self._timed_candidates(connection, [row])[0])
                    record_decision(
                        connection, scope=scope, record_kind="candidate", record_id=candidate_id,
                        rejected_text=row["candidate_text"], source_ids=self._source_ids(row["candidate_source_ids"]),
                        candidate=self._candidate_from_row(self._timed_candidates(connection, [row])[0]),
                    )
                if row["candidate_status"] != MemoryCandidateStatus.PENDING.value:
                    raise RuntimeError(error_message)
                clear_evidence = (
                    ", dimension_evidence = NULL"
                    if row.get("candidate_dimension_evidence") is not None else ""
                )
                updated = connection.execute(
                    f"""
                    UPDATE public.memory_candidate
                    SET status = %s, updated_at = now(){clear_evidence}
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                    RETURNING {_CANDIDATE_COLUMNS}
                    """,
                    (
                        next_status.value,
                        scope.owner_id,
                        scope.contact_id,
                        candidate_id,
                    ),
                ).fetchone()
                if updated is None:
                    raise MemoryInvariantError(
                        "关系记忆候选状态更新为空。"
                    )
                return self._candidate_from_row(
                    self._timed_candidates(connection, [updated])[0]
                )
        except (LookupError, PermissionError, RuntimeError, MemoryPersistenceError):
            raise
        except psycopg.Error:
            raise MemoryPersistenceError(
                "关系记忆数据库操作失败。"
            ) from None
        except (KeyError, TypeError, ValueError):
            raise MemoryInvariantError(
                "关系记忆数据库记录结构无效。"
            ) from None

    def _transition_memory(
        self,
        *,
        scope: ContactScope,
        memory_id: UUID,
        next_status: ConfirmedMemoryStatus,
        reject_deleted: bool,
        error_message: str,
    ) -> ConfirmedMemory:
        self._validate_scope(scope)
        self._validate_uuid(memory_id, "memory_id")
        now = self._now()
        try:
            with self._connect() as connection:
                lock_contact_scope(
                    connection,
                    owner_id=scope.owner_id,
                    contact_id=scope.contact_id,
                )
                lock_owner_scope(connection, owner_id=scope.owner_id)
                row = self._memory_for_update(
                    connection, memory_id,
                    follow_current=next_status is not ConfirmedMemoryStatus.DELETED,
                )
                if row is None:
                    raise LookupError("关系记忆不存在。")
                self._ensure_scope(row, scope)
                if row["memory_status"] != next_status.value:
                    erase_layered_reply_dependencies(connection, scope,
                        {memory_id, *self._source_ids(row["memory_source_ids"])})
                if next_status is ConfirmedMemoryStatus.DELETED:
                    if row["memory_status"] == ConfirmedMemoryStatus.DELETED.value:
                        return self._memory_from_row(self._timed_memories(connection, [row])[0])
                    if connection.execute(
                        "SELECT EXISTS (SELECT 1 FROM public.confirmed_memory "
                        "WHERE owner_id=%s AND contact_id=%s AND (supersedes_memory_id=%s OR to_jsonb(confirmed_memory)->'merge_parent_ids' ? %s::text)) AS replaced",
                        (scope.owner_id, scope.contact_id, memory_id, memory_id),
                    ).fetchone()["replaced"]:
                        raise MemoryCorrectionConflictError("资料版本已变化，请重新查看当前版本后删除。")
                    from notalone.managed_update_backups import erase_managed_update_backups
                    erase_managed_update_backups(connection)
                    source_candidate = None
                    if row["source_candidate_id"] is not None:
                        candidate_row = self._candidate_for_update(connection, row["source_candidate_id"], scope)
                        if candidate_row is not None:
                            source_candidate = self._candidate_from_row(self._timed_candidates(connection, [candidate_row])[0])
                    record_decision(
                        connection, scope=scope, record_kind="contact_memory",
                        record_id=row["memory_id"], rejected_text=None,
                        source_ids=self._source_ids(row["memory_source_ids"]), candidate=source_candidate,
                    )
                    from notalone.persistence.reply_cleanup import delete_contact_memory_replies
                    delete_contact_memory_replies(connection, scope=scope, memory_id=memory_id)
                    erase_record_traces(
                        connection,
                        owner_id=scope.owner_id,
                        record_kind="contact_memory",
                        record_id=memory_id,
                    )
                    erase_deleted_memory_bodies(
                        connection, owner_id=scope.owner_id,
                        record_kind="contact_memory", memory_id=row["memory_id"],
                    )
                if reject_deleted and row["memory_status"] == (
                    ConfirmedMemoryStatus.DELETED.value
                ):
                    raise RuntimeError(error_message)
                updated = connection.execute(
                    f"""
                    UPDATE public.confirmed_memory
                    SET status = %s,
                        invalid_at = COALESCE(invalid_at, %s),
                        revision = revision + 1,
                        updated_at = now()
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                    RETURNING {_MEMORY_COLUMNS}
                    """,
                    (
                        next_status.value,
                        now,
                        scope.owner_id,
                        scope.contact_id,
                        row["memory_id"],
                    ),
                ).fetchone()
                if updated is None:
                    raise MemoryInvariantError("关系记忆状态更新为空。")
                self._bump_memory_revision(connection, scope)
                return self._memory_from_row(
                    self._timed_memories(connection, [updated])[0]
                )
        except (LookupError, PermissionError, RuntimeError, MemoryPersistenceError):
            raise
        except psycopg.Error:
            raise MemoryPersistenceError(
                "关系记忆数据库操作失败。"
            ) from None
        except (KeyError, TypeError, ValueError):
            raise MemoryInvariantError(
                "关系记忆数据库记录结构无效。"
            ) from None

    def _candidate_for_update(
        self,
        connection: psycopg.Connection[Any],
        candidate_id: UUID,
        scope: ContactScope,
    ) -> dict[str, Any] | None:
        row = connection.execute(
            f"""
            SELECT {_CANDIDATE_COLUMNS}
            FROM public.memory_candidate
            WHERE owner_id = %s AND contact_id = %s AND id = %s
            FOR UPDATE
            """,
            (scope.owner_id, scope.contact_id, candidate_id),
        ).fetchone()
        if row is None and connection.execute(
            "SELECT 1 FROM public.memory_candidate WHERE id = %s",
            (candidate_id,),
        ).fetchone() is not None:
            raise PermissionError("关系记忆范围校验失败。")
        return row

    def _memory_for_update(
        self,
        connection: psycopg.Connection[Any],
        memory_id: UUID,
        *, follow_current: bool = True,
    ) -> dict[str, Any] | None:
        row = connection.execute(
            f"""
            SELECT {_MEMORY_COLUMNS}
            FROM public.confirmed_memory
            WHERE id = %s
            FOR UPDATE
            """,
            (memory_id,),
        ).fetchone()
        if row is None or not follow_current:
            return row
        visited: set[UUID] = set()
        while row["memory_id"] not in visited:
            visited.add(row["memory_id"])
            child = connection.execute(
                f"""
                SELECT {_MEMORY_COLUMNS}
                FROM public.confirmed_memory
                WHERE owner_id = %s
                  AND contact_id = %s
                  AND (supersedes_memory_id = %s OR to_jsonb(confirmed_memory)->'merge_parent_ids' ? %s::text)
                  AND status = 'active'
                ORDER BY revision DESC, id DESC
                LIMIT 1
                FOR UPDATE
                """,
                (
                    row["owner_id"],
                    row["contact_id"],
                    row["memory_id"], row["memory_id"],
                ),
            ).fetchone()
            if child is None:
                return row
            row = child
        raise MemoryInvariantError("关系记忆版本链无效。")

    @staticmethod
    def _ensure_active_sources(
        connection: psycopg.Connection[Any],
        scope: ContactScope,
        source_ids: tuple[UUID, ...],
    ) -> None:
        unique_source_ids = tuple(dict.fromkeys(source_ids))
        available = connection.execute(
            f"""
            SELECT count(*) AS source_count
            FROM (
                SELECT source.id AS source_id
                FROM public.source_document AS source
                WHERE source.owner_id = %s
                  AND source.contact_id = %s
                  AND source.status = 'active'
                  AND source.id = ANY(%s)
                UNION
                SELECT observation.id AS source_id
                FROM public.local_wechat_observation AS observation
                WHERE observation.owner_id = %s
                  AND observation.contact_id = %s
                  AND observation.id = ANY(%s)
                UNION
                SELECT message.id AS source_id
                FROM public.message AS message
                WHERE message.owner_id = %s
                  AND message.contact_id = %s
                  AND {valid_source_ref_exists_sql("message")}
                  AND message.id = ANY(%s)
            ) AS available_sources
            """,
            (
                scope.owner_id,
                scope.contact_id,
                list(unique_source_ids),
                scope.owner_id,
                scope.contact_id,
                list(unique_source_ids),
                scope.owner_id,
                scope.contact_id,
                list(unique_source_ids),
            ),
        ).fetchone()
        if available is None:
            raise MemoryInvariantError("关系记忆来源校验结果为空。")
        available_count = available["source_count"]
        if available_count != len(unique_source_ids):
            raise PermissionError("关系记忆来源范围校验失败。")

    @staticmethod
    def _bump_memory_revision(
        connection: Any,
        scope: ContactScope,
    ) -> None:
        connection.execute(
            """
            INSERT INTO public.contact_memory_state (
                owner_id, contact_id, memory_revision
            ) VALUES (%s, %s, 1)
            ON CONFLICT (owner_id, contact_id)
            DO UPDATE SET
                memory_revision = contact_memory_state.memory_revision + 1,
                updated_at = now()
            """,
            (scope.owner_id, scope.contact_id),
        )

    def _connect(self) -> Any:
        return (self._connection_factory() if self._connection_factory is not None
                else psycopg.connect(self._database_url, row_factory=dict_row))

    def _now(self) -> datetime:
        value = self._clock()
        if not isinstance(value, datetime) or value.tzinfo is None:
            raise TypeError("MemoryStore 时钟必须返回带时区的 datetime。")
        return value

    def _new_uuid(self) -> UUID:
        value = self._id_factory()
        if not isinstance(value, UUID):
            raise TypeError("MemoryStore 标识生成器必须返回 UUID。")
        return value

    @staticmethod
    def _validate_scope(scope: ContactScope) -> None:
        if not isinstance(scope, ContactScope):
            raise TypeError("scope 必须是 ContactScope。")

    @staticmethod
    def _validate_uuid(value: UUID, name: str) -> None:
        if not isinstance(value, UUID):
            raise TypeError(f"{name} 必须是 UUID。")

    @staticmethod
    def _ensure_scope(row: dict[str, Any], scope: ContactScope) -> None:
        if (
            row["owner_id"] != scope.owner_id
            or row["contact_id"] != scope.contact_id
        ):
            raise PermissionError("关系记忆范围校验失败。")

    @classmethod
    def _candidate_from_row(cls, row: dict[str, Any]) -> MemoryCandidate:
        evidence = row.get("_bound_dimension_evidence")
        if "_bound_dimension_evidence" not in row:
            raw = row.get("candidate_dimension_evidence")
            evidence = DimensionEvidence.from_payload(raw) if raw is not None else None
        return MemoryCandidate(
            candidate_id=row["candidate_id"],
            scope=ContactScope(row["owner_id"], row["contact_id"]),
            text=row["candidate_text"],
            category=MemoryCategory(row["candidate_category"]),
            topic=MemoryTopic(row["candidate_topic"]),
            subject=FactSubject(row["candidate_subject"]),
            source_ids=cls._source_ids(row["candidate_source_ids"]),
            status=MemoryCandidateStatus(row["candidate_status"]),
            valid_at=row["candidate_valid_at"],
            invalid_at=row["candidate_invalid_at"],
            confidence=row["candidate_confidence"],
            risk_flags=tuple(row["candidate_risk_flags"] or ()),
            alternatives=tuple(row["candidate_alternatives"] or ()),
            interpretation_reason=row["candidate_interpretation_reason"] or "",
            failure_reason=row["candidate_failure_reason"],
            timing=row["timing"],
            dimension_evidence=evidence,
            correction_review=row.get("_correction_review", ()),
            conditions=(MemoryConditions.from_payload(row.get("candidate_conditions")).with_current_sources(evidence is not None and evidence.source_bound) if row.get("candidate_conditions") is not None and "_bound_dimension_evidence" in row else MemoryConditions.from_payload(row.get("candidate_conditions"))),
            event=(MemoryEvent.from_payload(row.get("candidate_event")).with_current_sources(
                evidence is not None and evidence.source_bound
            ) if row.get("candidate_event") is not None and "_bound_dimension_evidence" in row
                   else MemoryEvent.from_payload(row.get("candidate_event"))),
            source_dependency_mode=dependency_mode(row.get("candidate_dependency_mode")),
            requires_all_sources=bool(row.get("candidate_requires_all_sources")),
        )

    @classmethod
    def _memory_from_row(cls, row: dict[str, Any]) -> ConfirmedMemory:
        return ConfirmedMemory(
            memory_id=row["memory_id"],
            scope=ContactScope(row["owner_id"], row["contact_id"]),
            text=row["memory_text"],
            category=MemoryCategory(row["memory_category"]),
            topic=MemoryTopic(row["memory_topic"]),
            source_ids=cls._source_ids(row["memory_source_ids"]),
            source_candidate_id=row["source_candidate_id"],
            adoption_method=AdoptionMethod(row["adoption_method"]),
            status=ConfirmedMemoryStatus(row["memory_status"]),
            valid_at=row["valid_at"],
            invalid_at=row["invalid_at"],
            revision=row["revision"],
            confidence=row["memory_confidence"],
            risk_flags=tuple(row["memory_risk_flags"] or ()),
            supersedes_memory_id=row["supersedes_memory_id"],
            timing=row["timing"], event=row.get("_bound_event", MemoryEvent.from_payload(row.get("memory_event"))),
            conditions=row.get("_bound_conditions", MemoryConditions.from_payload(row.get("memory_conditions"))),
            version_evidence=row.get("_bound_version_evidence", VersionEvidence.from_payload(row.get("version_evidence"))),
            can_revert_auto_update=row.get("_can_revert_auto_update", False),
            retirement_reason=MemoryRetirementReason(row.get("retirement_reason") or "unknown"),
            retired_at=row.get("retired_at"),
            source_dependency_mode=dependency_mode(row.get("memory_dependency_mode")),
            requires_all_sources=bool(row.get("memory_requires_all_sources")),
        )

    @classmethod
    def _timed_candidates(
        cls, connection: psycopg.Connection[Any], rows: Sequence[dict[str, Any]],
        *, lock_sources: bool = False,
    ) -> list[dict[str, Any]]:
        timed = timed_memory_rows(connection, rows, source_ids_key="candidate_source_ids")
        for row in timed:
            row["_bound_dimension_evidence"] = bind_stored_dimension_evidence(
                connection, cls._candidate_from_row(row), lock_sources=lock_sources,
            )
            protected, _ = protect_candidate(connection, cls._candidate_from_row(row), validate_generation=lock_sources)
            row["candidate_status"] = protected.status.value
            row["candidate_failure_reason"] = protected.failure_reason
            row["_correction_review"] = protected.correction_review
        return timed

    @classmethod
    def _timed_memories(
        cls, connection: psycopg.Connection[Any], rows: Sequence[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        timed = timed_memory_rows(connection, rows, source_ids_key="memory_source_ids")
        for row in timed:
            row["_bound_conditions"] = bind_memory_conditions(connection, owner_id=row["owner_id"], candidate_id=row["source_candidate_id"], raw=row.get("memory_conditions"), text=row["memory_text"])
            row["_bound_event"] = bind_memory_event(connection, owner_id=row["owner_id"],
                candidate_id=row["source_candidate_id"], raw=row.get("memory_event"))
            row["_bound_version_evidence"], row["_can_revert_auto_update"] = bind_version_evidence(
                connection, memory=cls._memory_from_row(row), raw=row.get("version_evidence"),
            )
        return timed

    @staticmethod
    def _source_ids(value: Any) -> tuple[UUID, ...]:
        if not isinstance(value, (list, tuple)) or not value:
            raise ValueError("关系记忆来源引用结构无效。")
        if any(not isinstance(source_id, UUID) for source_id in value):
            raise ValueError("关系记忆来源引用结构无效。")
        return tuple(value)
