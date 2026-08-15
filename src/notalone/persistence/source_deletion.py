"""PostgreSQL 来源级删除与不可检索验证。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID, uuid4

import psycopg


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
