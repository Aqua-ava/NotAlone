"""owner 级自我记忆的 PostgreSQL 适配器。"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from notalone.managed_update_backups import ManagedUpdateBackupError

from notalone.memory.dimension_evidence import (
    DimensionEvidence,
    require_current_dimension_evidence,
)
from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.memory.events import MemoryEvent
from notalone.persistence.memory_events import bind_memory_event
from notalone.memory.versions import (
    MemoryVersionConflict, require_auto_previous, require_auto_update_previous,
    require_auto_update_receipt, require_version_receipt,
)
from notalone.persistence.dimension_evidence import bind_stored_dimension_evidence

from notalone.memory.models import (
    AdoptionMethod,
    ConfirmedMemoryStatus,
    FactSubject,
    MemoryCandidate,
    MemoryCandidateStatus,
    MemoryCategory,
    MemoryTopic,
    OwnerMemory,
    SourceDependencyMode,
)
from notalone.persistence.source_dependency import dependency_mode, ensure_all_sources
from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.persistence.memory_timing import timed_memory_rows
from notalone.persistence.memory_versions import (
    bind_version_evidence, create_version_evidence, prepare_auto_revert, scoped_version_ids, validate_version_sources,
    erase_reverted_version,
    restored_version_evidence,
)
from notalone.memory.version_evidence import VersionEvidence
from notalone.persistence.message_sources import valid_source_ref_exists_sql
from notalone.persistence.memory_correction import (
    available_correction_memories, candidate_from_row, erase_deleted_memory_bodies, persist_protection, protect_candidate, record_decision,
    require_reviewed_decisions,
)
from notalone.scopes import ContactScope, OwnerScope
from notalone.persistence.reply_layered_cleanup import erase_layered_reply_dependencies

_OWNER_MEMORY_UNAVAILABLE = "owner 记忆数据库操作失败。"

_OWNER_MEMORY_COLUMNS = """
    id AS memory_id,
    owner_id,
    text_content,
    category,
    topic,
    source_ids,
    adoption_method,
    status,
    valid_at,
    invalid_at,
    revision,
    confidence,
    risk_flags,
    source_candidate_id,
    supersedes_memory_id,
    to_jsonb(owner_memory)->'event' AS memory_event,
    to_jsonb(owner_memory)->'version_evidence' AS version_evidence,
    to_jsonb(owner_memory)->>'source_dependency_mode' AS dependency_mode,
    created_at AS recorded_at
"""


class OwnerMemoryPersistenceError(RuntimeError):
    """不暴露 SQL、连接信息或记忆正文的持久化错误。"""


class PostgresOwnerMemoryStore:
    """写入与查询 owner 级自我记忆；软删除保留指纹。"""

    __slots__ = ("_database_url", "_id_factory", "_connection_factory")

    def __init__(self, database_url: str, *, id_factory=uuid4, connection_factory=None) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url
        self._id_factory, self._connection_factory = id_factory, connection_factory

    def create(self, memory: OwnerMemory) -> OwnerMemory:
        if not isinstance(memory, OwnerMemory):
            raise OwnerMemoryPersistenceError(
                "owner 记忆写入参数必须是 OwnerMemory。"
            )
        try:
            with self._connect() as connection:
                lock_owner_scope(connection, owner_id=memory.owner_id)
                manual_entry = (memory.adoption_method is AdoptionMethod.MANUAL
                                and memory.source_candidate_id is None
                                and memory.supersedes_memory_id is None
                                and memory.source_ids == (memory.owner_id,))
                if memory.source_dependency_mode is SourceDependencyMode.ALL:
                    ensure_all_sources(connection, owner_id=memory.owner_id, source_ids=memory.source_ids)
                elif not manual_entry:
                    _ensure_active_sources(
                        connection,
                        owner_id=memory.owner_id,
                        source_ids=memory.source_ids,
                    )
                mode_column, mode_value = _insert_mode(memory)
                row = connection.execute(
                    f"""
                    INSERT INTO public.owner_memory (
                        id, owner_id, text_content, category, topic,
                        source_ids, adoption_method, status,
                        valid_at, invalid_at, revision, confidence, risk_flags,
                        source_candidate_id, supersedes_memory_id{mode_column}
                    ) VALUES (
                        %(memory_id)s, %(owner_id)s, %(text)s, %(category)s,
                        %(topic)s, %(source_ids)s, %(adoption_method)s,
                        %(status)s, %(valid_at)s, %(invalid_at)s, %(revision)s,
                        %(confidence)s, %(risk_flags)s, %(source_candidate_id)s,
                        %(supersedes_memory_id)s{mode_value}
                    ) RETURNING {_OWNER_MEMORY_COLUMNS}
                    """,
                    _to_row(memory),
                ).fetchone()
                if row is None:
                    raise OwnerMemoryPersistenceError("owner 记忆写入结果为空。")
                memory = _from_row(_timed_rows(connection, [row])[0])
        except OwnerMemoryPersistenceError:
            raise
        except PermissionError:
            # 来源已被并发删除时不得创建引用已删消息的 owner 记忆；
            # 该错误按批次失败交给上层恢复策略，不能折叠成数据库错误。
            raise
        except Exception as error:
            raise OwnerMemoryPersistenceError(
                _OWNER_MEMORY_UNAVAILABLE
            ) from error
        return memory

    def confirm_candidate(
        self,
        *,
        candidate: MemoryCandidate,
        adoption_method: AdoptionMethod = AdoptionMethod.MANUAL,
        expected_correction_decision_ids: tuple[UUID, ...] | None = None,
        expected_previous: OwnerMemory | None = None,
    ) -> OwnerMemory:
        """原子确认 self 候选并把它写入 owner 级记忆。"""

        if not isinstance(candidate, MemoryCandidate):
            raise OwnerMemoryPersistenceError("owner 候选结构无效。")
        if not isinstance(adoption_method, AdoptionMethod):
            raise OwnerMemoryPersistenceError("owner 候选采纳方式无效。")
        scope = candidate.scope
        candidate_id = candidate.candidate_id
        if expected_previous is not None:
            if not isinstance(expected_previous, OwnerMemory):
                raise OwnerMemoryPersistenceError("自动替代原版本无效。")
            if expected_previous.owner_id != scope.owner_id:
                raise PermissionError("关系记忆范围校验失败。")
        try:
            with self._connect() as connection:
                lock_contact_scope(
                    connection,
                    owner_id=scope.owner_id,
                    contact_id=scope.contact_id,
                )
                lock_owner_scope(connection, owner_id=scope.owner_id)
                candidate_row = connection.execute(
                    """
                    SELECT id, owner_id, contact_id, text_content, category,
                           topic, subject, source_ids, status, valid_at,
                           invalid_at, confidence, risk_flags, alternatives,
                           interpretation_reason,
                           to_jsonb(memory_candidate)->'dimension_evidence'
                               AS dimension_evidence,
                           to_jsonb(memory_candidate)->'event' AS event,
                           to_jsonb(memory_candidate)->>'source_dependency_mode'
                               AS dependency_mode
                    FROM public.memory_candidate
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                    FOR UPDATE
                    """,
                    (scope.owner_id, scope.contact_id, candidate_id),
                ).fetchone()
                if candidate_row is None:
                    exists = connection.execute(
                        "SELECT 1 FROM public.memory_candidate WHERE id=%s",
                        (candidate_id,),
                    ).fetchone()
                    if exists is not None:
                        raise PermissionError("关系记忆范围校验失败。")
                    raise LookupError("关系记忆候选不存在。")
                if (
                    candidate_row["owner_id"] != scope.owner_id
                    or candidate_row["contact_id"] != scope.contact_id
                ):
                    raise PermissionError("关系记忆范围校验失败。")
                if FactSubject(candidate_row["subject"]) is not FactSubject.SELF:
                    raise OwnerMemoryPersistenceError(
                        "只有 self 主体候选可以确认到 owner 记忆。"
                    )
                protected, snapshot = protect_candidate(connection, candidate_from_row(candidate_row))
                require_reviewed_decisions(
                    protected, adoption_method, expected_correction_decision_ids,
                )
                status = MemoryCandidateStatus(candidate_row["status"])
                if status is MemoryCandidateStatus.CONFIRMED:
                    existing = connection.execute(
                        f"""
                        SELECT {_OWNER_MEMORY_COLUMNS}
                        FROM public.owner_memory
                        WHERE owner_id = %s AND source_candidate_id = %s
                        """,
                        (scope.owner_id, candidate_id),
                    ).fetchone()
                    if existing is None:
                        raise OwnerMemoryPersistenceError(
                            "已确认候选缺少对应 owner 记忆。"
                        )
                    actual = _from_row(_timed_rows(connection, [existing])[0])
                    if expected_previous is not None:
                        if adoption_method is AdoptionMethod.AUTO:
                            require_auto_update_receipt(actual, expected_previous)
                        else:
                            require_version_receipt(actual, expected_previous, adoption_method)
                        previous_row = connection.execute(
                            f"SELECT {_OWNER_MEMORY_COLUMNS} FROM public.owner_memory "
                            "WHERE owner_id=%s AND id=%s FOR UPDATE",
                            (scope.owner_id, expected_previous.memory_id),
                        ).fetchone()
                        if previous_row is None:
                            raise MemoryCorrectionConflictError("原资料已删除，自动回执不可复用。")
                        require_auto_update_previous(
                            _from_row(_timed_rows(connection, [previous_row])[0]), expected_previous,
                            allow_manual=adoption_method is AdoptionMethod.MANUAL,
                        )
                    return actual
                if status is not MemoryCandidateStatus.PENDING:
                    raise RuntimeError("关系记忆候选当前不可确认。")
                if expected_previous is not None:
                    previous_row = connection.execute(
                        f"SELECT {_OWNER_MEMORY_COLUMNS} FROM public.owner_memory "
                        "WHERE owner_id=%s AND id=%s FOR UPDATE",
                        (scope.owner_id, expected_previous.memory_id),
                    ).fetchone()
                    if previous_row is None:
                        raise MemoryCorrectionConflictError("原资料已删除，自动替代未应用。")
                    require_auto_previous(
                        _from_row(_timed_rows(connection, [previous_row])[0]), expected_previous,
                        allow_manual=adoption_method is AdoptionMethod.MANUAL,
                    )
                    _ensure_memory_sources(connection, owner_id=scope.owner_id, row=previous_row)
                if snapshot is not None:
                    persist_protection(connection, protected, snapshot)

                sources = tuple(candidate_row["source_ids"])
                # 候选只能声明实际聊天依据，不能借手录旧版豁免任意 UUID。
                _ensure_active_sources(connection, owner_id=scope.owner_id, source_ids=sources)
                if expected_previous is not None:
                    if (adoption_method is AdoptionMethod.AUTO and not set(sources) - set(expected_previous.source_ids)
                            or connection.execute(
                                "SELECT 1 FROM public.owner_memory WHERE owner_id=%s "
                                "AND supersedes_memory_id=%s AND status='active'",
                                (scope.owner_id, expected_previous.memory_id),
                            ).fetchone() is not None):
                        raise MemoryVersionConflict("自动更新需要新依据和当前叶子版本。")
                    sources = tuple(dict.fromkeys((*expected_previous.source_ids, *sources)))

                candidate_mode = dependency_mode(candidate_row.get("dependency_mode"))
                mode = (SourceDependencyMode.ALL if expected_previous is not None
                        and expected_previous.source_dependency_mode is SourceDependencyMode.ALL else candidate_mode)
                if mode is SourceDependencyMode.ALL:
                    ensure_all_sources(connection, owner_id=scope.owner_id,
                                       contact_id=scope.contact_id,
                                       source_ids=sources)
                if (adoption_method is AdoptionMethod.AUTO
                        or mode is SourceDependencyMode.ALL
                        and candidate_row["dimension_evidence"] is not None):
                    raw = candidate_row["dimension_evidence"]
                    stored = replace(
                        candidate,
                        text=candidate_row["text_content"],
                        category=MemoryCategory(candidate_row["category"]),
                        topic=MemoryTopic(candidate_row["topic"]),
                        subject=FactSubject(candidate_row["subject"]),
                        source_ids=tuple(candidate_row["source_ids"]),
                        valid_at=candidate_row["valid_at"],
                        invalid_at=candidate_row["invalid_at"],
                        confidence=candidate_row["confidence"],
                        risk_flags=tuple(candidate_row["risk_flags"] or ()),
                        alternatives=tuple(candidate_row["alternatives"] or ()),
                        interpretation_reason=(
                            candidate_row["interpretation_reason"] or ""
                        ),
                        source_dependency_mode=candidate_mode,
                        dimension_evidence=(
                            DimensionEvidence.from_payload(raw)
                            if raw is not None else None
                        ),
                        event=MemoryEvent.from_payload(candidate_row.get("event")),
                    )
                    current = bind_stored_dimension_evidence(
                        connection, stored, lock_sources=True
                    )
                    if adoption_method is AdoptionMethod.AUTO:
                        require_current_dimension_evidence(
                            current, candidate.dimension_evidence
                        )

                memory = OwnerMemory(
                    memory_id=self._id_factory(),
                    owner_id=scope.owner_id,
                    text=candidate_row["text_content"],
                    category=MemoryCategory(candidate_row["category"]),
                    topic=MemoryTopic(candidate_row["topic"]),
                    source_ids=sources,
                    source_candidate_id=candidate_id,
                    source_dependency_mode=mode,
                    adoption_method=adoption_method,
                    status=ConfirmedMemoryStatus.ACTIVE,
                    valid_at=candidate_row["valid_at"],
                    invalid_at=candidate_row["invalid_at"],
                    confidence=candidate_row["confidence"],
                    risk_flags=tuple(candidate_row["risk_flags"] or ()),
                    revision=expected_previous.revision + 1 if expected_previous else 1,
                    supersedes_memory_id=expected_previous.memory_id if expected_previous else None,
                    event=MemoryEvent.from_payload(candidate_row.get("event")),
                )
                event_column = ", event" if memory.event is not None else ""
                event_value = ", %(event)s" if memory.event is not None else ""
                if expected_previous is not None:
                    proof = create_version_evidence(connection, previous=expected_previous, current=memory)
                    if adoption_method is AdoptionMethod.AUTO:
                        validate_version_sources(connection, owner_id=scope.owner_id, evidence=proof)
                    memory = replace(memory, version_evidence=proof)
                    event_column += ", version_evidence"
                    event_value += ", %(version_evidence)s"
                mode_column, mode_value = _insert_mode(memory)
                row = connection.execute(
                    f"""
                    INSERT INTO public.owner_memory (
                        id, owner_id, text_content, category, topic,
                        source_ids, adoption_method, status, valid_at,
                        invalid_at, revision, confidence, risk_flags,
                        source_candidate_id, supersedes_memory_id{event_column}{mode_column}
                    ) VALUES (
                        %(memory_id)s, %(owner_id)s, %(text)s, %(category)s,
                        %(topic)s, %(source_ids)s, %(adoption_method)s,
                        %(status)s, %(valid_at)s, %(invalid_at)s, %(revision)s,
                        %(confidence)s, %(risk_flags)s, %(source_candidate_id)s,
                        %(supersedes_memory_id)s{event_value}{mode_value}
                    )
                    RETURNING {_OWNER_MEMORY_COLUMNS}
                    """,
                    _to_row(memory),
                ).fetchone()
                if expected_previous is not None:
                    erase_layered_reply_dependencies(connection, OwnerScope(scope.owner_id),
                        (expected_previous.memory_id,))
                    invalidated = connection.execute(
                        "UPDATE public.owner_memory SET status='invalidated', "
                        "revision=revision+1, updated_at=now() "
                        "WHERE owner_id=%s AND id=%s AND status='active' "
                        "AND revision=%s AND adoption_method=%s",
                        (scope.owner_id,
                         expected_previous.memory_id, expected_previous.revision,
                         expected_previous.adoption_method.value),
                    ).rowcount
                    if invalidated != 1:
                        raise MemoryCorrectionConflictError("原资料已变化，自动替代未应用。")
                updated = connection.execute(
                    """
                    UPDATE public.memory_candidate
                    SET status = 'confirmed', updated_at = now()
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                      AND status = 'pending'
                    """,
                    (scope.owner_id, scope.contact_id, candidate_id),
                ).rowcount
                if row is None or updated != 1:
                    raise OwnerMemoryPersistenceError(
                        "owner 候选确认结果无效。"
                    )
                return _from_row(_timed_rows(connection, [row])[0])
        except (LookupError, PermissionError, RuntimeError, OwnerMemoryPersistenceError):
            raise
        except Exception as error:
            raise OwnerMemoryPersistenceError(_OWNER_MEMORY_UNAVAILABLE) from error

    def list_active(self, owner_id: UUID, *, include_expired: bool = False) -> tuple[OwnerMemory, ...]:
        _validate_owner_id(owner_id)
        if type(include_expired) is not bool:
            raise TypeError("历史回看标记必须是 bool。")
        try:
            with self._connect() as connection:
                if self._connection_factory is None:
                    connection.execute(
                        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
                    )
                rows = connection.execute(
                    f"""
                    SELECT {_OWNER_MEMORY_COLUMNS.replace("to_jsonb(owner_memory)", "to_jsonb(memory)")}
                    FROM public.owner_memory AS memory
                    WHERE owner_id = %s AND status = 'active'
                      AND ((adoption_method='manual' AND source_candidate_id IS NULL
                            AND source_ids=ARRAY[owner_id]) OR EXISTS (
                          SELECT 1 FROM public.source_document AS source
                          WHERE source.owner_id=memory.owner_id AND source.id=ANY(memory.source_ids)
                            AND source.status='active'
                      ) OR EXISTS (
                          SELECT 1 FROM public.local_wechat_observation AS observation
                          WHERE observation.owner_id=memory.owner_id AND observation.id=ANY(memory.source_ids)
                      ) OR EXISTS (
                          SELECT 1 FROM public.message AS message
                          WHERE message.owner_id=memory.owner_id AND message.id=ANY(memory.source_ids)
                            AND {valid_source_ref_exists_sql('message')}
                      ))
                    ORDER BY memory.created_at, memory.id
                    """,
                    (owner_id,),
                ).fetchall()
                rows = available_correction_memories(
                    connection, owner_id=owner_id, record_kind="owner_memory", rows=rows,
                )
                rows = _timed_rows(connection, rows)
        except Exception as error:
            raise OwnerMemoryPersistenceError(
                _OWNER_MEMORY_UNAVAILABLE
            ) from error
        now = datetime.now(timezone.utc)
        return tuple(
            _from_row(row)
            for row in rows
            if (row["valid_at"] is None or row["valid_at"] <= now)
            and (include_expired or _is_effective(_from_row(row), now))
        )

    def list_versions(self, *, owner_id: UUID, memory_id: UUID) -> tuple[OwnerMemory, ...]:
        _validate_owner_id(owner_id)
        if not isinstance(memory_id, UUID):
            raise ValueError("本人资料标识无效。")
        with self._connect() as connection:
            lock_owner_scope(connection, owner_id=owner_id)
            ids = scoped_version_ids(connection, table="owner_memory", owner_id=owner_id,
                                     contact_id=None, memory_id=memory_id)
            rows = connection.execute(
                f"SELECT {_OWNER_MEMORY_COLUMNS} FROM public.owner_memory "
                "WHERE owner_id=%s AND id=ANY(%s) ORDER BY array_position(%s::uuid[],id)",
                (owner_id, list(ids), list(ids)),
            ).fetchall()
            for row in rows:
                _ensure_memory_sources(connection, owner_id=owner_id, row=row)
            return tuple(_from_row(row) for row in _timed_rows(connection, rows))

    def revert_auto_update(self, *, owner_id: UUID, memory_id: UUID, expected_revision: int) -> OwnerMemory:
        _validate_owner_id(owner_id)
        with self._connect() as connection:
            lock_owner_scope(connection, owner_id=owner_id)
            current, previous = prepare_auto_revert(
                connection, table="owner_memory", owner_id=owner_id, contact_id=None,
                memory_id=memory_id, expected_revision=expected_revision,
            )
            _ensure_active_sources(connection, owner_id=owner_id, source_ids=tuple(dict.fromkeys(
                (*current["source_ids"], *previous["source_ids"])
            )))
            proof = restored_version_evidence(connection, previous=previous, revision=expected_revision + 1)
            from notalone.persistence.reply_cleanup import delete_owner_memory_replies
            delete_owner_memory_replies(connection, owner_id=owner_id, memory_id=memory_id)
            erase_layered_reply_dependencies(connection, OwnerScope(owner_id), (memory_id, previous["id"]))
            erase_reverted_version(connection, table="owner_memory", owner_id=owner_id, current=current)
            restored = connection.execute(
                f"UPDATE public.owner_memory SET status='active', revision=%s, version_evidence=%s, updated_at=now() "
                f"WHERE owner_id=%s AND id=%s RETURNING {_OWNER_MEMORY_COLUMNS}",
                (expected_revision + 1, Jsonb(proof.to_payload()) if proof else None, owner_id, previous["id"]),
            ).fetchone()
            return _from_row(_timed_rows(connection, [restored])[0])

    def correct(
        self, *, owner_id: UUID, memory_id: UUID, text: str,
        category: MemoryCategory | None = None,
    ) -> OwnerMemory:
        """原子替换当前有效本人资料；旧版与候选链留作审计。"""
        _validate_owner_id(owner_id)
        if not isinstance(memory_id, UUID):
            raise OwnerMemoryPersistenceError("owner 记忆 ID 无效。")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("修正后的本人记忆不能为空。")
        if category is not None and not isinstance(category, MemoryCategory):
            raise TypeError("本人记忆分类无效。")
        try:
            with self._connect() as connection:
                lock_owner_scope(connection, owner_id=owner_id)
                previous = connection.execute(
                    f"""SELECT {_OWNER_MEMORY_COLUMNS}
                    FROM public.owner_memory
                    WHERE owner_id = %s AND id = %s FOR UPDATE""",
                    (owner_id, memory_id),
                ).fetchone()
                if previous is None:
                    raise LookupError("本人记忆不存在。")
                now = datetime.now(timezone.utc)
                if (previous["status"] != ConfirmedMemoryStatus.ACTIVE.value
                        or previous["valid_at"] is not None and now < previous["valid_at"]
                        or previous["invalid_at"] is not None and now >= previous["invalid_at"]):
                    raise MemoryCorrectionConflictError("本人资料版本已变化，请重新查看后修正。")
                sources = tuple(previous["source_ids"])
                mode = dependency_mode(previous.get("dependency_mode"))
                _ensure_memory_sources(connection, owner_id=owner_id, row=previous)
                corrected = OwnerMemory(
                    memory_id=uuid4(), owner_id=owner_id, text=text,
                    category=category or MemoryCategory(previous["category"]),
                    topic=MemoryTopic(previous["topic"]), source_ids=sources,
                    source_dependency_mode=mode,
                    adoption_method=AdoptionMethod.MANUAL,
                    status=ConfirmedMemoryStatus.ACTIVE,
                    supersedes_memory_id=memory_id,
                    valid_at=previous["valid_at"], invalid_at=previous["invalid_at"],
                    revision=previous["revision"] + 1,
                    confidence=previous["confidence"],
                    risk_flags=tuple(previous["risk_flags"] or ()),
                )
                erase_layered_reply_dependencies(connection, OwnerScope(owner_id), (memory_id,))
                updated = connection.execute(
                    """UPDATE public.owner_memory
                    SET status = 'invalidated', invalid_at = COALESCE(invalid_at, %s),
                        revision = %s, updated_at = now()
                    WHERE owner_id = %s AND id = %s AND status = 'active'""",
                    (now, corrected.revision, owner_id, memory_id),
                ).rowcount
                if updated != 1:
                    raise OwnerMemoryPersistenceError("本人旧版本失效更新失败。")
                mode_column, mode_value = _insert_mode(corrected)
                row = connection.execute(
                    f"""INSERT INTO public.owner_memory (
                        id, owner_id, text_content, category, topic, source_ids,
                        adoption_method, status, valid_at, invalid_at, revision,
                        confidence, risk_flags, source_candidate_id, supersedes_memory_id{mode_column}
                    ) VALUES (
                        %(memory_id)s, %(owner_id)s, %(text)s, %(category)s,
                        %(topic)s, %(source_ids)s, %(adoption_method)s, %(status)s,
                        %(valid_at)s, %(invalid_at)s, %(revision)s, %(confidence)s,
                        %(risk_flags)s, %(source_candidate_id)s, %(supersedes_memory_id)s{mode_value}
                    ) RETURNING {_OWNER_MEMORY_COLUMNS}""",
                    _to_row(corrected),
                ).fetchone()
                if row is None:
                    raise OwnerMemoryPersistenceError("本人新版本写入结果为空。")
                source_candidate = None
                if previous["source_candidate_id"] is not None:
                    raw_candidate = connection.execute(
                        "SELECT * FROM public.memory_candidate WHERE owner_id=%s AND id=%s",
                        (owner_id, previous["source_candidate_id"]),
                    ).fetchone()
                    if raw_candidate is not None:
                        source_candidate = candidate_from_row(raw_candidate)
                record_decision(
                    connection, scope=None, owner_id=owner_id, record_kind="owner_memory",
                    record_id=memory_id, rejected_text=previous["text_content"],
                    source_ids=sources, corrected_text=text,
                    replacement_memory_id=corrected.memory_id, candidate=source_candidate,
                )
                return _from_row(_timed_rows(connection, [row])[0])
        except (LookupError, PermissionError, RuntimeError, OwnerMemoryPersistenceError):
            raise
        except Exception as error:
            raise OwnerMemoryPersistenceError(_OWNER_MEMORY_UNAVAILABLE) from error

    def delete(self, owner_id: UUID, memory_id: UUID) -> OwnerMemory:
        _validate_owner_id(owner_id)
        try:
            with self._connect() as connection:
                lock_owner_scope(connection, owner_id=owner_id)
                previous = connection.execute(
                    f"SELECT {_OWNER_MEMORY_COLUMNS} FROM public.owner_memory WHERE owner_id = %s AND id = %s FOR UPDATE",
                    (owner_id, memory_id),
                ).fetchone()
                if previous is None:
                    raise LookupError("owner 记忆不存在或已删除。")
                if previous["status"] == ConfirmedMemoryStatus.DELETED.value:
                    return _from_row(_timed_rows(connection, [previous])[0])
                if connection.execute(
                    "SELECT EXISTS (SELECT 1 FROM public.owner_memory "
                    "WHERE owner_id=%s AND supersedes_memory_id=%s) AS replaced",
                    (owner_id, memory_id),
                ).fetchone()["replaced"]:
                    raise MemoryCorrectionConflictError("资料版本已变化，请重新查看当前版本后删除。")
                from notalone.managed_update_backups import erase_managed_update_backups
                erase_managed_update_backups(connection)
                source_candidate = None
                if previous["source_candidate_id"] is not None:
                    raw_candidate = connection.execute(
                        "SELECT * FROM public.memory_candidate WHERE owner_id=%s AND id=%s",
                        (owner_id, previous["source_candidate_id"]),
                    ).fetchone()
                    if raw_candidate is not None:
                        source_candidate = candidate_from_row(raw_candidate)
                record_decision(
                    connection, scope=None, owner_id=owner_id, record_kind="owner_memory",
                    record_id=memory_id, rejected_text=None,
                    source_ids=tuple(previous["source_ids"]), candidate=source_candidate,
                )
                from notalone.persistence.reply_cleanup import delete_owner_memory_replies

                delete_owner_memory_replies(connection, owner_id=owner_id, memory_id=memory_id)
                from notalone.persistence.extraction_trace import (
                    erase_record_traces,
                )

                erase_record_traces(
                    connection,
                    owner_id=owner_id,
                    record_kind="owner_memory",
                    record_id=memory_id,
                )
                erase_deleted_memory_bodies(
                    connection, owner_id=owner_id, record_kind="owner_memory", memory_id=memory_id,
                )
                row = connection.execute(
                    f"""
                    UPDATE public.owner_memory
                    SET status = 'deleted', updated_at = now()
                    WHERE owner_id = %s AND id = %s
                    RETURNING {_OWNER_MEMORY_COLUMNS}
                    """,
                    (owner_id, memory_id),
                ).fetchone()
                if row is not None:
                    row = _timed_rows(connection, [row])[0]
        except (LookupError, MemoryCorrectionConflictError, ManagedUpdateBackupError):
            raise
        except Exception as error:
            raise OwnerMemoryPersistenceError(
                _OWNER_MEMORY_UNAVAILABLE
            ) from error
        if row is None:
            raise OwnerMemoryPersistenceError("owner 记忆不存在或已删除。")
        return _from_row(row)

    def invalidate(self, owner_id: UUID, memory_id: UUID) -> OwnerMemory:
        _validate_owner_id(owner_id)
        try:
            with self._connect() as connection:
                lock_owner_scope(connection, owner_id=owner_id)
                erase_layered_reply_dependencies(connection, OwnerScope(owner_id), (memory_id,))
                row = connection.execute(
                    f"""
                    UPDATE public.owner_memory
                    SET status = 'invalidated', updated_at = now()
                    WHERE owner_id = %s AND id = %s
                    RETURNING {_OWNER_MEMORY_COLUMNS}
                    """,
                    (owner_id, memory_id),
                ).fetchone()
                if row is not None:
                    row = _timed_rows(connection, [row])[0]
        except Exception as error:
            raise OwnerMemoryPersistenceError(
                _OWNER_MEMORY_UNAVAILABLE
            ) from error
        if row is None:
            raise OwnerMemoryPersistenceError("owner 记忆不存在或已失效。")
        return _from_row(row)

    def deleted_texts(self, owner_id: UUID) -> tuple[str, ...]:
        _validate_owner_id(owner_id)
        try:
            with self._connect() as connection:
                rows = connection.execute(
                    """
                    SELECT text_content
                    FROM public.owner_memory
                    WHERE owner_id = %s AND status = 'deleted'
                    """,
                    (owner_id,),
                ).fetchall()
        except Exception as error:
            raise OwnerMemoryPersistenceError(
                _OWNER_MEMORY_UNAVAILABLE
            ) from error
        return tuple(row["text_content"] for row in rows)

    def _connect(self) -> psycopg.Connection[Any]:
        return (self._connection_factory() if self._connection_factory is not None
                else psycopg.connect(self._database_url, row_factory=dict_row))


def _validate_owner_id(owner_id: UUID) -> None:
    if not isinstance(owner_id, UUID):
        raise OwnerMemoryPersistenceError("owner ID 无效。")


def owner_memory_source_dependencies(
    connection: Any, *, owner_id: UUID, memory_id: UUID,
    source_ids: tuple[UUID, ...], text: str | None = None,
    historical: bool = False,
) -> tuple[UUID, ...]:
    """同事务复验实际手录根链，仅剔除合法归属引用，保留真实聊天依赖。"""
    raw = getattr(connection, "connection", connection)
    with raw.cursor(row_factory=dict_row) as cursor:
        row = cursor.execute(
            f"SELECT {_OWNER_MEMORY_COLUMNS} FROM public.owner_memory WHERE owner_id=%s AND id=%s",
            (owner_id, memory_id),
        ).fetchone()
        if (row is None or row["status"] not in (("active", "invalidated") if historical else ("active",))
                or set(row["source_ids"]) != set(source_ids)
                or text is not None and row["text_content"] != text):
            raise PermissionError("本人资料或来源已变化。")
        return _ensure_memory_sources(cursor, owner_id=owner_id, row=row)


def _ensure_memory_sources(
    connection: Any, *, owner_id: UUID, row: dict[str, Any],
) -> tuple[UUID, ...]:
    """本人归属引用须来自实际手录根版本；其他引用一律核对聊天来源。"""
    sources = tuple(row["source_ids"])
    if dependency_mode(row.get("dependency_mode", row.get("source_dependency_mode"))) is SourceDependencyMode.ALL:
        ensure_all_sources(connection, owner_id=owner_id, source_ids=sources)
        return sources
    if owner_id in sources:
        current = row
        visited: set[UUID] = set()
        for _ in range(100):
            identifier = current["memory_id"]
            if (identifier in visited or current["owner_id"] != owner_id
                    or current["status"] == "deleted" or current["adoption_method"] != "manual"
                    or owner_id not in current["source_ids"]):
                raise PermissionError("本人手录来源关联已失效。")
            visited.add(identifier)
            previous_id = current["supersedes_memory_id"]
            if previous_id is None:
                if current["source_candidate_id"] is not None or tuple(current["source_ids"]) != (owner_id,):
                    raise PermissionError("本人手录来源关联无效。")
                break
            current = connection.execute(
                f"SELECT {_OWNER_MEMORY_COLUMNS} FROM public.owner_memory WHERE owner_id=%s AND id=%s",
                (owner_id, previous_id),
            ).fetchone()
            if current is None:
                raise PermissionError("本人手录来源关联已清除。")
        else:
            raise PermissionError("本人手录来源关联超出可核对范围。")
        sources = tuple(source for source in sources if source != owner_id)
    _ensure_active_sources(connection, owner_id=owner_id, source_ids=sources)
    return sources


def _ensure_active_sources(
    connection: psycopg.Connection[Any],
    *,
    owner_id: UUID,
    source_ids: tuple[UUID, ...],
) -> None:
    """校验 owner 记忆的来源引用在写入时仍然有效。

    owner 级记忆按 owner 维度保存，但其证据来自某个联系人的观察与
    消息；校验按 owner 范围（任一联系人）核对，防止并发来源删除
    之后继续创建引用已删消息的记忆（删除清账不再能覆盖的残留）。
    """

    unique_source_ids = tuple(dict.fromkeys(source_ids))
    if not unique_source_ids:
        return
    available = connection.execute(
        f"""
        SELECT count(*) AS source_count
        FROM (
            SELECT source.id AS source_id
            FROM public.source_document AS source
            WHERE source.owner_id = %s
              AND source.status = 'active'
              AND source.id = ANY(%s)
            UNION
            SELECT observation.id AS source_id
            FROM public.local_wechat_observation AS observation
            WHERE observation.owner_id = %s
              AND observation.id = ANY(%s)
            UNION
            SELECT message.id AS source_id
            FROM public.message AS message
            WHERE message.owner_id = %s
              AND {valid_source_ref_exists_sql("message")}
              AND message.id = ANY(%s)
        ) AS available_sources
        """,
        (
            owner_id,
            list(unique_source_ids),
            owner_id,
            list(unique_source_ids),
            owner_id,
            list(unique_source_ids),
        ),
    ).fetchone()
    if available is None:
        raise OwnerMemoryPersistenceError("owner 记忆来源校验结果为空。")
    available_count = available["source_count"]
    if available_count != len(unique_source_ids):
        raise PermissionError("owner 记忆来源范围校验失败。")


def _is_effective(memory: OwnerMemory, now: datetime) -> bool:
    if memory.valid_at is not None and now < memory.valid_at:
        return False
    if memory.invalid_at is not None and now >= memory.invalid_at:
        return False
    return True


def _to_row(memory: OwnerMemory) -> dict[str, Any]:
    return {
        "memory_id": memory.memory_id,
        "owner_id": memory.owner_id,
        "text": memory.text,
        "category": memory.category.value,
        "topic": memory.topic.value,
        "source_ids": list(memory.source_ids),
        "adoption_method": memory.adoption_method.value,
        "status": memory.status.value,
        "valid_at": memory.valid_at,
        "invalid_at": memory.invalid_at,
        "revision": memory.revision,
        "confidence": memory.confidence,
        "risk_flags": list(memory.risk_flags),
        "source_candidate_id": memory.source_candidate_id,
        "supersedes_memory_id": memory.supersedes_memory_id,
        "event": Jsonb(memory.event.to_payload()) if memory.event is not None else None,
        "version_evidence": Jsonb(memory.version_evidence.to_payload()) if memory.version_evidence else None,
        "source_dependency_mode": memory.source_dependency_mode.value,
    }


def _from_row(row: dict[str, Any]) -> OwnerMemory:
    return OwnerMemory(
        memory_id=row["memory_id"],
        owner_id=row["owner_id"],
        text=row["text_content"],
        category=MemoryCategory(row["category"]),
        topic=MemoryTopic(row["topic"]),
        source_ids=tuple(row["source_ids"]),
        adoption_method=AdoptionMethod(row["adoption_method"]),
        status=ConfirmedMemoryStatus(row["status"]),
        valid_at=row["valid_at"],
        invalid_at=row["invalid_at"],
        revision=row["revision"],
        confidence=row["confidence"],
        risk_flags=tuple(row["risk_flags"] or ()),
        source_candidate_id=row["source_candidate_id"],
        supersedes_memory_id=row["supersedes_memory_id"],
        timing=row["timing"], event=row.get("_bound_event", MemoryEvent.from_payload(row.get("memory_event"))),
        version_evidence=row.get("_bound_version_evidence", VersionEvidence.from_payload(row.get("version_evidence"))),
        can_revert_auto_update=row.get("_can_revert_auto_update", False),
        source_dependency_mode=dependency_mode(row.get("dependency_mode")),
    )


def _timed_rows(
    connection: psycopg.Connection[Any], rows: Sequence[dict[str, Any]],
) -> list[dict[str, Any]]:
    timed = timed_memory_rows(connection, rows, source_ids_key="source_ids", contact_scoped=False)
    for row in timed:
        row["_bound_event"] = bind_memory_event(connection, owner_id=row["owner_id"],
            candidate_id=row["source_candidate_id"], raw=row.get("memory_event"))
        row["_bound_version_evidence"], row["_can_revert_auto_update"] = bind_version_evidence(
            connection, memory=_from_row(row), raw=row.get("version_evidence"),
        )
    return timed


def _insert_mode(memory: OwnerMemory) -> tuple[str, str]:
    if memory.source_dependency_mode is SourceDependencyMode.ALL:
        return ", source_dependency_mode", ", %(source_dependency_mode)s"
    return "", ""
