"""owner 级自我记忆的 PostgreSQL 适配器。"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row

from notalone.memory.models import (
    AdoptionMethod,
    ConfirmedMemoryStatus,
    FactSubject,
    MemoryCandidate,
    MemoryCandidateStatus,
    MemoryCategory,
    MemoryTopic,
    OwnerMemory,
)
from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.scopes import ContactScope


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
    source_candidate_id
"""


class OwnerMemoryPersistenceError(RuntimeError):
    """不暴露 SQL、连接信息或记忆正文的持久化错误。"""


class PostgresOwnerMemoryStore:
    """写入与查询 owner 级自我记忆；软删除保留指纹。"""

    __slots__ = ("_database_url",)

    def __init__(self, database_url: str) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url

    def create(self, memory: OwnerMemory) -> OwnerMemory:
        if not isinstance(memory, OwnerMemory):
            raise OwnerMemoryPersistenceError(
                "owner 记忆写入参数必须是 OwnerMemory。"
            )
        try:
            with self._connect() as connection:
                lock_owner_scope(connection, owner_id=memory.owner_id)
                connection.execute(
                    """
                    INSERT INTO public.owner_memory (
                        id, owner_id, text_content, category, topic,
                        source_ids, adoption_method, status,
                        valid_at, invalid_at, revision, confidence, risk_flags,
                        source_candidate_id
                    ) VALUES (
                        %(memory_id)s, %(owner_id)s, %(text)s, %(category)s,
                        %(topic)s, %(source_ids)s, %(adoption_method)s,
                        %(status)s, %(valid_at)s, %(invalid_at)s, %(revision)s,
                        %(confidence)s, %(risk_flags)s, %(source_candidate_id)s
                    )
                    """,
                    _to_row(memory),
                )
                connection.commit()
        except OwnerMemoryPersistenceError:
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
    ) -> OwnerMemory:
        """原子确认 self 候选并把它写入 owner 级记忆。"""

        if not isinstance(candidate, MemoryCandidate):
            raise OwnerMemoryPersistenceError("owner 候选结构无效。")
        if not isinstance(adoption_method, AdoptionMethod):
            raise OwnerMemoryPersistenceError("owner 候选采纳方式无效。")
        scope = candidate.scope
        candidate_id = candidate.candidate_id
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
                           invalid_at, confidence, risk_flags
                    FROM public.memory_candidate
                    WHERE id = %s
                    FOR UPDATE
                    """,
                    (candidate_id,),
                ).fetchone()
                if candidate_row is None:
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
                    return _from_row(existing)
                if status is not MemoryCandidateStatus.PENDING:
                    raise RuntimeError("关系记忆候选当前不可确认。")

                memory = OwnerMemory(
                    memory_id=uuid4(),
                    owner_id=scope.owner_id,
                    text=candidate_row["text_content"],
                    category=MemoryCategory(candidate_row["category"]),
                    topic=MemoryTopic(candidate_row["topic"]),
                    source_ids=tuple(candidate_row["source_ids"]),
                    source_candidate_id=candidate_id,
                    adoption_method=adoption_method,
                    status=ConfirmedMemoryStatus.ACTIVE,
                    valid_at=candidate_row["valid_at"],
                    invalid_at=candidate_row["invalid_at"],
                    confidence=candidate_row["confidence"],
                    risk_flags=tuple(candidate_row["risk_flags"] or ()),
                )
                row = connection.execute(
                    f"""
                    INSERT INTO public.owner_memory (
                        id, owner_id, text_content, category, topic,
                        source_ids, adoption_method, status, valid_at,
                        invalid_at, revision, confidence, risk_flags,
                        source_candidate_id
                    ) VALUES (
                        %(memory_id)s, %(owner_id)s, %(text)s, %(category)s,
                        %(topic)s, %(source_ids)s, %(adoption_method)s,
                        %(status)s, %(valid_at)s, %(invalid_at)s, %(revision)s,
                        %(confidence)s, %(risk_flags)s, %(source_candidate_id)s
                    )
                    RETURNING {_OWNER_MEMORY_COLUMNS}
                    """,
                    _to_row(memory),
                ).fetchone()
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
                return _from_row(row)
        except (LookupError, PermissionError, RuntimeError, OwnerMemoryPersistenceError):
            raise
        except Exception as error:
            raise OwnerMemoryPersistenceError(_OWNER_MEMORY_UNAVAILABLE) from error

    def list_active(self, owner_id: UUID) -> tuple[OwnerMemory, ...]:
        _validate_owner_id(owner_id)
        try:
            with self._connect() as connection:
                rows = connection.execute(
                    f"""
                    SELECT {_OWNER_MEMORY_COLUMNS}
                    FROM public.owner_memory
                    WHERE owner_id = %s AND status = 'active'
                    ORDER BY created_at, id
                    """,
                    (owner_id,),
                ).fetchall()
        except Exception as error:
            raise OwnerMemoryPersistenceError(
                _OWNER_MEMORY_UNAVAILABLE
            ) from error
        now = datetime.now(timezone.utc)
        return tuple(
            _from_row(row)
            for row in rows
            if _is_effective(_from_row(row), now)
        )

    def delete(self, owner_id: UUID, memory_id: UUID) -> OwnerMemory:
        _validate_owner_id(owner_id)
        try:
            with self._connect() as connection:
                lock_owner_scope(connection, owner_id=owner_id)
                row = connection.execute(
                    f"""
                    UPDATE public.owner_memory
                    SET status = 'deleted', updated_at = now()
                    WHERE owner_id = %s AND id = %s
                    RETURNING {_OWNER_MEMORY_COLUMNS}
                    """,
                    (owner_id, memory_id),
                ).fetchone()
                connection.commit()
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
                row = connection.execute(
                    f"""
                    UPDATE public.owner_memory
                    SET status = 'invalidated', updated_at = now()
                    WHERE owner_id = %s AND id = %s
                    RETURNING {_OWNER_MEMORY_COLUMNS}
                    """,
                    (owner_id, memory_id),
                ).fetchone()
                connection.commit()
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
        return psycopg.connect(self._database_url, row_factory=dict_row)


def _validate_owner_id(owner_id: UUID) -> None:
    if not isinstance(owner_id, UUID):
        raise OwnerMemoryPersistenceError("owner ID 无效。")


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
    )
