"""关系记忆的 PostgreSQL 持久化适配器。"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row

from notalone.memory.models import (
    MemoryTopic,
    AdoptionMethod,
    ConfirmedMemory,
    ConfirmedMemoryStatus,
    MemoryCandidate,
    MemoryCandidateStatus,
    MemoryCategory,
)
from notalone.scopes import ContactScope
from notalone.persistence.locks import lock_contact_scope
from notalone.persistence.message_sources import valid_source_ref_exists_sql


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
    source_ids AS candidate_source_ids,
    status AS candidate_status,
    valid_at AS candidate_valid_at,
    invalid_at AS candidate_invalid_at
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
    revision
"""


class PostgresMemoryStore:
    """按联系人范围原子保存关系记忆候选和已确认记忆。"""

    __slots__ = ("_clock", "_database_url", "_id_factory")

    def __init__(
        self,
        database_url: str,
        *,
        clock: Callable[[], datetime] = _utc_now,
        id_factory: Callable[[], UUID] = uuid4,
    ) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        if not callable(clock) or not callable(id_factory):
            raise TypeError("MemoryStore 的时钟和标识生成器必须可调用。")
        self._database_url = database_url
        self._clock = clock
        self._id_factory = id_factory

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
                self._ensure_active_sources(
                    connection,
                    candidate.scope,
                    candidate.source_ids,
                )
                row = connection.execute(
                    f"""
                    INSERT INTO public.memory_candidate (
                        id, owner_id, contact_id, text_content, category,
                        topic, source_ids, status, valid_at, invalid_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING {_CANDIDATE_COLUMNS}
                    """,
                    (
                        candidate.candidate_id,
                        candidate.scope.owner_id,
                        candidate.scope.contact_id,
                        candidate.text,
                        candidate.category.value,
                        candidate.topic.value,
                        list(candidate.source_ids),
                        candidate.status.value,
                        candidate.valid_at,
                        candidate.invalid_at,
                    ),
                ).fetchone()
                if row is None:
                    raise MemoryInvariantError(
                        "关系记忆候选写入结果为空。"
                    )
                return self._candidate_from_row(row)
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
                        topic, source_ids, status, valid_at, invalid_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING {_CANDIDATE_COLUMNS}
                    """,
                    (
                        candidate.candidate_id,
                        candidate.scope.owner_id,
                        candidate.scope.contact_id,
                        candidate.text,
                        candidate.category.value,
                        candidate.topic.value,
                        [source_id],
                        candidate.status.value,
                        candidate.valid_at,
                        candidate.invalid_at,
                    ),
                ).fetchone()
                if row is None:
                    raise MemoryInvariantError(
                        "关系记忆候选写入结果为空。"
                    )
                return self._candidate_from_row(row)
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

    def confirm(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
        adoption_method: AdoptionMethod = AdoptionMethod.AUTO,
    ) -> ConfirmedMemory:
        """在同一事务中确认候选并创建已确认记忆。"""

        self._validate_scope(scope)
        self._validate_uuid(candidate_id, "candidate_id")
        if not isinstance(adoption_method, AdoptionMethod):
            raise TypeError("关系记忆采纳方式无效。")
        try:
            with self._connect() as connection:
                lock_contact_scope(
                    connection,
                    owner_id=scope.owner_id,
                    contact_id=scope.contact_id,
                )
                candidate_row = self._candidate_for_update(
                    connection,
                    candidate_id,
                )
                if candidate_row is None:
                    raise LookupError("关系记忆候选不存在。")
                self._ensure_scope(candidate_row, scope)
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
                    return self._memory_from_row(memory_row)
                if status is not MemoryCandidateStatus.PENDING:
                    raise RuntimeError("关系记忆候选当前不可确认。")
                source_ids = self._source_ids(candidate_row["candidate_source_ids"])
                self._ensure_active_sources(connection, scope, source_ids)

                memory_id = self._new_uuid()
                memory_row = connection.execute(
                    f"""
                    INSERT INTO public.confirmed_memory (
                        id, owner_id, contact_id, text_content, category,
                        topic, source_ids, source_candidate_id, adoption_method,
                        valid_at, invalid_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING {_MEMORY_COLUMNS}
                    """,
                    (
                        memory_id,
                        scope.owner_id,
                        scope.contact_id,
                        candidate_row["candidate_text"],
                        candidate_row["candidate_category"],
                        candidate_row["candidate_topic"],
                        candidate_row["candidate_source_ids"],
                        candidate_id,
                        adoption_method.value,
                        candidate_row["candidate_valid_at"],
                        candidate_row["candidate_invalid_at"],
                    ),
                ).fetchone()
                if memory_row is None:
                    raise MemoryInvariantError("关系记忆写入结果为空。")
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
                return self._memory_from_row(memory_row)
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
    ) -> ConfirmedMemory:
        """修正 active 记忆并递增 revision。"""

        self._validate_scope(scope)
        self._validate_uuid(memory_id, "memory_id")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("修正后的关系记忆不能为空。")
        if category is not None and not isinstance(category, MemoryCategory):
            raise TypeError("关系记忆分类无效。")
        try:
            with self._connect() as connection:
                lock_contact_scope(
                    connection,
                    owner_id=scope.owner_id,
                    contact_id=scope.contact_id,
                )
                memory_row = self._memory_for_update(connection, memory_id)
                if memory_row is None:
                    raise LookupError("关系记忆不存在。")
                self._ensure_scope(memory_row, scope)
                if memory_row["memory_status"] != (
                    ConfirmedMemoryStatus.ACTIVE.value
                ):
                    raise RuntimeError(
                        "失效或删除的关系记忆不能直接修正。"
                    )
                next_category = (
                    category.value
                    if category
                    else memory_row["memory_category"]
                )
                updated = connection.execute(
                    f"""
                    UPDATE public.confirmed_memory
                    SET text_content = %s,
                        category = %s,
                        revision = revision + 1,
                        updated_at = now()
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                    RETURNING {_MEMORY_COLUMNS}
                    """,
                    (
                        text,
                        next_category,
                        scope.owner_id,
                        scope.contact_id,
                        memory_id,
                    ),
                ).fetchone()
                if updated is None:
                    raise MemoryInvariantError("关系记忆修正结果为空。")
                self._bump_memory_revision(connection, scope)
                return self._memory_from_row(updated)
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
                row = self._candidate_for_update(connection, candidate_id)
                if row is None:
                    raise LookupError("关系记忆候选不存在。")
                self._ensure_scope(row, scope)
                if row["candidate_status"] != MemoryCandidateStatus.PENDING.value:
                    raise RuntimeError("当前关系记忆候选不能丢弃。")
                updated = connection.execute(
                    f"""
                    UPDATE public.memory_candidate
                    SET status = 'rejected', updated_at = now()
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
                    """
                    INSERT INTO public.confirmed_memory (
                        id, owner_id, contact_id, text_content, category,
                        topic, source_ids, source_candidate_id, adoption_method,
                        status, revision
                    )
                    VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s, 'auto', 'deleted', 1
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
                    ),
                )
                return self._candidate_from_row(updated)
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

    def list_confirmed(self, scope: ContactScope) -> tuple[ConfirmedMemory, ...]:
        """返回当前联系人范围内可检索的 active 记忆。"""

        self._validate_scope(scope)
        current = self._now()
        try:
            with self._connect() as connection:
                connection.execute(
                    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
                )
                rows = connection.execute(
                    f"""
                    SELECT {_MEMORY_COLUMNS}
                    FROM public.confirmed_memory AS memory
                    WHERE memory.owner_id = %s
                      AND memory.contact_id = %s
                      AND memory.status = 'active'
                      AND (
                          memory.valid_at IS NULL OR memory.valid_at <= %s
                      )
                      AND (
                          memory.invalid_at IS NULL OR %s < memory.invalid_at
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
                    (scope.owner_id, scope.contact_id, current, current),
                ).fetchall()
                return tuple(self._memory_from_row(row) for row in rows)
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

    def list_pending_candidates(self, scope: ContactScope) -> tuple[MemoryCandidate, ...]:
        """返回联系人范围内所有 pending 候选，供人工处理。"""

        self._validate_scope(scope)
        try:
            with self._connect() as connection:
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
                return tuple(self._candidate_from_row(row) for row in rows)
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
                    FROM public.confirmed_memory
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
                row = self._candidate_for_update(connection, candidate_id)
                if row is None:
                    raise LookupError("关系记忆候选不存在。")
                self._ensure_scope(row, scope)
                if row["candidate_status"] != MemoryCandidateStatus.PENDING.value:
                    raise RuntimeError(error_message)
                updated = connection.execute(
                    f"""
                    UPDATE public.memory_candidate
                    SET status = %s, updated_at = now()
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
                return self._candidate_from_row(updated)
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
                row = self._memory_for_update(connection, memory_id)
                if row is None:
                    raise LookupError("关系记忆不存在。")
                self._ensure_scope(row, scope)
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
                        memory_id,
                    ),
                ).fetchone()
                if updated is None:
                    raise MemoryInvariantError("关系记忆状态更新为空。")
                self._bump_memory_revision(connection, scope)
                return self._memory_from_row(updated)
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
    ) -> dict[str, Any] | None:
        return connection.execute(
            f"""
            SELECT {_CANDIDATE_COLUMNS}
            FROM public.memory_candidate
            WHERE id = %s
            FOR UPDATE
            """,
            (candidate_id,),
        ).fetchone()

    def _memory_for_update(
        self,
        connection: psycopg.Connection[Any],
        memory_id: UUID,
    ) -> dict[str, Any] | None:
        return connection.execute(
            f"""
            SELECT {_MEMORY_COLUMNS}
            FROM public.confirmed_memory
            WHERE id = %s
            FOR UPDATE
            """,
            (memory_id,),
        ).fetchone()

    @staticmethod
    def _ensure_active_sources(
        connection: psycopg.Connection[Any],
        scope: ContactScope,
        source_ids: tuple[UUID, ...],
    ) -> None:
        unique_source_ids = tuple(dict.fromkeys(source_ids))
        available_count = connection.execute(
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
        ).fetchone()["source_count"]
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
        return psycopg.connect(self._database_url, row_factory=dict_row)

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
        return MemoryCandidate(
            candidate_id=row["candidate_id"],
            scope=ContactScope(row["owner_id"], row["contact_id"]),
            text=row["candidate_text"],
            category=MemoryCategory(row["candidate_category"]),
            topic=MemoryTopic(row["candidate_topic"]),
            source_ids=cls._source_ids(row["candidate_source_ids"]),
            status=MemoryCandidateStatus(row["candidate_status"]),
            valid_at=row["candidate_valid_at"],
            invalid_at=row["candidate_invalid_at"],
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
        )

    @staticmethod
    def _source_ids(value: Any) -> tuple[UUID, ...]:
        if not isinstance(value, (list, tuple)) or not value:
            raise ValueError("关系记忆来源引用结构无效。")
        if any(not isinstance(source_id, UUID) for source_id in value):
            raise ValueError("关系记忆来源引用结构无效。")
        return tuple(value)
