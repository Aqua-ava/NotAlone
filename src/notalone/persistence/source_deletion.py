"""PostgreSQL 来源级删除与不可检索验证。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID, uuid4

import psycopg
from psycopg.types.json import Jsonb

from notalone.persistence.locks import lock_contact_scope, lock_owner_scope


class SourceDeletionError(RuntimeError):
    """不暴露 SQL 或私密内容的来源删除错误。"""


class SourceNotFoundError(SourceDeletionError):
    """指定隔离范围内不存在该来源。"""


class SourceDeletionVerificationError(SourceDeletionError):
    """删除后仍能检索到来源内容。"""


@dataclass(frozen=True, slots=True)
class SourceDeletionResult:
    """来源删除的非敏感结果。"""

    source_document_id: UUID
    outcome: Literal["deleted", "already_deleted"]
    deleted_at: datetime


class PostgresSourceDeletionRepository:
    """执行来源状态迁移、级联清除和不可检索验证。"""

    __slots__ = ("_database_url",)

    def __init__(self, database_url: str) -> None:
        if not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url

    def delete_source(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        source_document_id: UUID,
    ) -> SourceDeletionResult:
        operation_id = uuid4()
        try:
            with psycopg.connect(self._database_url) as connection:
                lock_contact_scope(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                )
                lock_owner_scope(connection, owner_id=owner_id)
                source = connection.execute(
                    """
                    SELECT status, deleted_at
                    FROM public.source_document
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                    FOR UPDATE
                    """,
                    (owner_id, contact_id, source_document_id),
                ).fetchone()
                if source is None:
                    raise SourceNotFoundError("指定范围内不存在该来源。")
                if source[0] == "deleted":
                    return SourceDeletionResult(
                        source_document_id=source_document_id,
                        outcome="already_deleted",
                        deleted_at=source[1],
                    )

                connection.execute(
                    """
                    UPDATE public.source_document
                    SET status = 'delete_requested',
                        deletion_operation_id = %s,
                        deletion_error_code = NULL
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                    """,
                    (operation_id, owner_id, contact_id, source_document_id),
                )
                connection.execute(
                    """
                    UPDATE public.source_document
                    SET status = 'deleting'
                    WHERE owner_id = %s
                      AND contact_id = %s
                      AND id = %s
                      AND deletion_operation_id = %s
                    """,
                    (owner_id, contact_id, source_document_id, operation_id),
                )
                self._cancel_background_task(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    source_document_id=source_document_id,
                )
                source_message_ids = tuple(
                    row[0]
                    for row in connection.execute(
                        """
                        SELECT id
                        FROM public.message
                        WHERE owner_id = %s
                          AND contact_id = %s
                          AND source_document_id = %s
                        """,
                        (owner_id, contact_id, source_document_id),
                    ).fetchall()
                )
                self._cleanup_derived_data(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    source_document_id=source_document_id,
                    source_message_ids=source_message_ids,
                )
                connection.execute(
                    """
                    DELETE FROM public.import_confirmation
                    WHERE owner_id = %s
                      AND contact_id = %s
                      AND source_document_id = %s
                    """,
                    (owner_id, contact_id, source_document_id),
                )
                connection.execute(
                    """
                    DELETE FROM public.message
                    WHERE owner_id = %s
                      AND contact_id = %s
                      AND source_document_id = %s
                    """,
                    (owner_id, contact_id, source_document_id),
                )
                remaining = connection.execute(
                    """
                    SELECT
                        (SELECT count(*) FROM public.message
                         WHERE owner_id = %s
                           AND contact_id = %s
                           AND source_document_id = %s),
                        (SELECT count(*) FROM public.wechat_message_metadata
                         WHERE owner_id = %s
                           AND contact_id = %s
                           AND source_document_id = %s),
                        (SELECT count(*) FROM public.import_confirmation
                         WHERE owner_id = %s
                           AND contact_id = %s
                           AND source_document_id = %s)
                    """,
                    (
                        owner_id,
                        contact_id,
                        source_document_id,
                        owner_id,
                        contact_id,
                        source_document_id,
                        owner_id,
                        contact_id,
                        source_document_id,
                    ),
                ).fetchone()
                if remaining != (0, 0, 0):
                    raise SourceDeletionVerificationError(
                        "来源删除后仍存在可检索数据。"
                    )
                derived_remaining = connection.execute(
                    """
                    SELECT
                        (SELECT count(*)
                         FROM public.confirmed_memory
                         WHERE owner_id = %s
                           AND contact_id = %s
                           AND status = 'active'
                           AND source_ids && %s::uuid[]),
                        (SELECT count(*)
                         FROM public.memory_candidate
                         WHERE owner_id = %s
                           AND contact_id = %s
                           AND status IN ('pending', 'confirmed')
                           AND source_ids && %s::uuid[]),
                        (SELECT count(*)
                         FROM public.owner_memory
                         WHERE owner_id = %s
                           AND status = 'active'
                           AND source_ids && %s::uuid[])
                    """,
                    (
                        owner_id,
                        contact_id,
                        [source_document_id, *source_message_ids],
                        owner_id,
                        contact_id,
                        [source_document_id, *source_message_ids],
                        owner_id,
                        [source_document_id, *source_message_ids],
                    ),
                ).fetchone()
                if derived_remaining != (0, 0, 0):
                    raise SourceDeletionVerificationError(
                        "来源删除后仍存在依赖该来源的关系资料。"
                    )
                deleted_receipt = connection.execute(
                    """
                    UPDATE public.source_document
                    SET status = 'deleted',
                        file_name = NULL,
                        content_sha256 = NULL,
                        record_count = 0,
                        deleted_at = now(),
                        deletion_operation_id = NULL,
                        deletion_error_code = NULL
                    WHERE owner_id = %s
                      AND contact_id = %s
                      AND id = %s
                      AND deletion_operation_id = %s
                    RETURNING deleted_at
                    """,
                    (owner_id, contact_id, source_document_id, operation_id),
                ).fetchone()
                if deleted_receipt is None:
                    raise SourceDeletionVerificationError(
                        "无法写入来源删除凭证。"
                    )
                return SourceDeletionResult(
                    source_document_id=source_document_id,
                    outcome="deleted",
                    deleted_at=deleted_receipt[0],
                )
        except SourceNotFoundError:
            raise
        except SourceDeletionError:
            self._record_failure(
                owner_id=owner_id,
                contact_id=contact_id,
                source_document_id=source_document_id,
            )
            raise
        except psycopg.Error:
            self._record_failure(
                owner_id=owner_id,
                contact_id=contact_id,
                source_document_id=source_document_id,
            )
            raise SourceDeletionError("来源删除失败。") from None

    @staticmethod
    def _cancel_background_task(
        connection: psycopg.Connection,
        *,
        owner_id: UUID,
        contact_id: UUID,
        source_document_id: UUID,
    ) -> None:
        connection.execute(
            """
            UPDATE public.background_task_step AS step
            SET status = 'cancelled',
                worker_id = NULL,
                lease_expires_at = NULL,
                last_error_code = 'source_deleted',
                finished_at = now(),
                updated_at = now()
            FROM public.background_task AS task
            WHERE task.id = step.task_id
              AND task.owner_id = %s
              AND task.contact_id = %s
              AND task.source_document_id = %s
              AND step.status <> 'succeeded'
            """,
            (owner_id, contact_id, source_document_id),
        )
        connection.execute(
            """
            UPDATE public.background_task
            SET status = 'cancelled',
                last_error_code = 'source_deleted',
                finished_at = now(),
                updated_at = now()
            WHERE owner_id = %s
              AND contact_id = %s
              AND source_document_id = %s
              AND status IN ('queued', 'running', 'verifying')
            """,
            (owner_id, contact_id, source_document_id),
        )

    @staticmethod
    def _cleanup_derived_data(
        connection: psycopg.Connection,
        *,
        owner_id: UUID,
        contact_id: UUID,
        source_document_id: UUID,
        source_message_ids: tuple[UUID, ...],
    ) -> None:
        removed_ids = {source_document_id, *source_message_ids}
        source_refs = [source_document_id, *source_message_ids]
        deleted_memory_ids: list[UUID] = []
        candidates = connection.execute(
            """
            SELECT id, source_ids
            FROM public.memory_candidate
            WHERE owner_id = %s
              AND contact_id = %s
              AND status IN ('pending', 'confirmed')
              AND source_ids && %s::uuid[]
            FOR UPDATE
            """,
            (owner_id, contact_id, source_refs),
        ).fetchall()
        for candidate_id, source_ids in candidates:
            remaining_ids = [
                source_id for source_id in source_ids if source_id not in removed_ids
            ]
            if remaining_ids:
                connection.execute(
                    """
                    UPDATE public.memory_candidate
                    SET source_ids = %s, updated_at = now()
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                    """,
                    (remaining_ids, owner_id, contact_id, candidate_id),
                )
            else:
                connection.execute(
                    """
                    UPDATE public.memory_candidate
                    SET status = 'invalidated', updated_at = now()
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                    """,
                    (owner_id, contact_id, candidate_id),
                )

        memories = connection.execute(
            """
            SELECT id, source_ids
            FROM public.confirmed_memory
            WHERE owner_id = %s
              AND contact_id = %s
              AND status = 'active'
              AND source_ids && %s::uuid[]
            FOR UPDATE
            """,
            (owner_id, contact_id, source_refs),
        ).fetchall()
        if memories:
            for memory_id, source_ids in memories:
                remaining_ids = [
                    source_id
                    for source_id in source_ids
                    if source_id not in removed_ids
                ]
                if remaining_ids:
                    connection.execute(
                        """
                        UPDATE public.confirmed_memory
                        SET source_ids = %s,
                            revision = revision + 1,
                            updated_at = now()
                        WHERE owner_id = %s AND contact_id = %s AND id = %s
                        """,
                        (remaining_ids, owner_id, contact_id, memory_id),
                    )
                else:
                    deleted_memory_ids.append(memory_id)
                    connection.execute(
                        """
                        UPDATE public.confirmed_memory
                        SET status = 'deleted',
                            invalid_at = COALESCE(invalid_at, now()),
                            revision = revision + 1,
                            updated_at = now()
                        WHERE owner_id = %s AND contact_id = %s AND id = %s
                        """,
                        (owner_id, contact_id, memory_id),
                    )
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
                (owner_id, contact_id),
            )
        owner_memories = connection.execute(
            """
            SELECT id, source_ids
            FROM public.owner_memory
            WHERE owner_id = %s
              AND status = 'active'
              AND source_ids && %s::uuid[]
            FOR UPDATE
            """,
            (owner_id, source_refs),
        ).fetchall()
        for memory_id, source_ids in owner_memories:
            remaining_ids = [
                source_id for source_id in source_ids if source_id not in removed_ids
            ]
            if remaining_ids:
                connection.execute(
                    """
                    UPDATE public.owner_memory
                    SET source_ids = %s,
                        revision = revision + 1,
                        updated_at = now()
                    WHERE owner_id = %s AND id = %s
                    """,
                    (remaining_ids, owner_id, memory_id),
                )
            else:
                connection.execute(
                    """
                    UPDATE public.owner_memory
                    SET status = 'deleted',
                        revision = revision + 1,
                        updated_at = now()
                    WHERE owner_id = %s AND id = %s
                    """,
                    (owner_id, memory_id),
                )

        index_row = connection.execute(
            """
            SELECT topics
            FROM public.contact_memory_index
            WHERE owner_id = %s AND contact_id = %s
            FOR UPDATE
            """,
            (owner_id, contact_id),
        ).fetchone()
        if index_row is not None and memories:
            removed_set = set(deleted_memory_ids)
            topics = []
            for topic in index_row[0]:
                memory_ids = [
                    memory_id
                    for memory_id in topic["memory_ids"]
                    if UUID(str(memory_id)) not in removed_set
                ]
                if memory_ids:
                    topics.append({**topic, "memory_ids": memory_ids})
            connection.execute(
                """
                UPDATE public.contact_memory_index
                SET topics = %s,
                    status = 'stale',
                    updated_at = now()
                WHERE owner_id = %s AND contact_id = %s
                """,
                (Jsonb(topics), owner_id, contact_id),
            )

    def _record_failure(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        source_document_id: UUID,
    ) -> None:
        try:
            with psycopg.connect(self._database_url) as connection:
                connection.execute(
                    """
                    UPDATE public.source_document
                    SET status = 'delete_failed',
                        deletion_operation_id = NULL,
                        deletion_error_code = 'storage_delete_failed'
                    WHERE owner_id = %s
                      AND contact_id = %s
                      AND id = %s
                      AND status <> 'deleted'
                    """,
                    (owner_id, contact_id, source_document_id),
                )
        except psycopg.Error:
            pass
