"""PostgreSQL 来源级删除与不可检索验证。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID, uuid4

import psycopg

from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.persistence.message_cleanup import (
    cleanup_derived_data,
    collect_orphan_message_ids,
    delete_messages,
)


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
                # 删除来源只移除其引用；消息仅在失去全部有效引用后清理。
                source_message_ids = tuple(
                    row[0]
                    for row in connection.execute(
                        """
                        SELECT message_id
                        FROM public.message_source_ref
                        WHERE owner_id = %s
                          AND contact_id = %s
                          AND source_document_id = %s
                        """,
                        (owner_id, contact_id, source_document_id),
                    ).fetchall()
                )
                connection.execute(
                    """
                    DELETE FROM public.message_source_ref
                    WHERE owner_id = %s
                      AND contact_id = %s
                      AND source_document_id = %s
                    """,
                    (owner_id, contact_id, source_document_id),
                )
                orphan_message_ids = collect_orphan_message_ids(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    candidate_message_ids=source_message_ids,
                )
                cleanup_derived_data(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    removed_ids={source_document_id, *orphan_message_ids},
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
                delete_messages(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    message_ids=orphan_message_ids,
                )
                remaining = connection.execute(
                    """
                    SELECT
                        (SELECT count(*) FROM public.message_source_ref
                         WHERE owner_id = %s
                           AND contact_id = %s
                           AND source_document_id = %s),
                        (SELECT count(*) FROM public.wechat_message_metadata
                         WHERE owner_id = %s
                           AND contact_id = %s
                           AND message_id = ANY(%s::uuid[])),
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
                        list(orphan_message_ids),
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
                        [source_document_id, *orphan_message_ids],
                        owner_id,
                        contact_id,
                        [source_document_id, *orphan_message_ids],
                        owner_id,
                        [source_document_id, *orphan_message_ids],
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
