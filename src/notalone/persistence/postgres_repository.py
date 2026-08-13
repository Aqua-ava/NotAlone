"""使用 PostgreSQL 原子写入单联系人聊天记录。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

import psycopg

from notalone.ingest.models import ImportBatch


class ImportPersistenceError(RuntimeError):
    """不暴露 SQL、连接信息或聊天内容的持久化错误。"""


class OwnerNotFoundError(ImportPersistenceError):
    """指定的 NotAlone 用户不存在。"""


class SourceStateConflictError(ImportPersistenceError):
    """同一来源已存在，但当前状态不允许直接重复导入。"""


class OverlappingSourceError(ImportPersistenceError):
    """不同来源与已入库消息发生重叠，需要用户先处理来源。"""


@dataclass(frozen=True, slots=True)
class ImportResult:
    """一次数据库导入的非敏感结果。"""

    source_document_id: UUID
    outcome: Literal["imported", "already_imported"]
    message_count: int


class PostgresIngestRepository:
    """在一个 PostgreSQL 事务中写入联系人、来源和消息。"""

    __slots__ = ("_database_url",)

    def __init__(self, database_url: str) -> None:
        if not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url

    def import_document(
        self,
        *,
        owner_id: UUID,
        document: ImportBatch,
    ) -> ImportResult:
        """导入一个已规范化批次；重复 active 来源返回幂等结果。"""

        try:
            # Psycopg 连接上下文在正常退出时提交，异常退出时先回滚再关闭连接。
            with psycopg.connect(self._database_url) as connection:
                return self._import_in_transaction(
                    connection=connection,
                    owner_id=owner_id,
                    document=document,
                )
        except (
            OverlappingSourceError,
            OwnerNotFoundError,
            SourceStateConflictError,
        ):
            raise
        except psycopg.errors.UniqueViolation as error:
            if (
                error.diag.constraint_name
                == "message_contact_external_local_id_unique"
            ):
                raise OverlappingSourceError(
                    "文件与已导入来源包含重叠消息，未写入新来源。"
                ) from None
            raise ImportPersistenceError(
                "数据库导入失败，未写入任何数据。"
            ) from None
        except psycopg.Error:
            raise ImportPersistenceError(
                "数据库导入失败，未写入任何数据。"
            ) from None

    @staticmethod
    def _import_in_transaction(
        *,
        connection: psycopg.Connection[Any],
        owner_id: UUID,
        document: ImportBatch,
    ) -> ImportResult:
        owner = connection.execute(
            "SELECT 1 FROM public.owner WHERE id = %s FOR KEY SHARE",
            (owner_id,),
        ).fetchone()
        if owner is None:
            raise OwnerNotFoundError("指定的 owner 不存在。")

        # 只在联系人不存在时使用导出昵称，保留用户已经人工修正过的展示名称。
        connection.execute(
            """
            INSERT INTO public.contact (owner_id, id, display_name)
            VALUES (%s, %s, %s)
            ON CONFLICT (owner_id, id) DO NOTHING
            """,
            (
                owner_id,
                document.contact.contact_id,
                document.contact.display_name,
            ),
        )
        # 同一联系人的导入按 contact 行串行化，避免两个不同文件同时绕过重叠检查。
        connection.execute(
            """
            SELECT 1
            FROM public.contact
            WHERE owner_id = %s AND id = %s
            FOR UPDATE
            """,
            (owner_id, document.contact.contact_id),
        ).fetchone()

        source = connection.execute(
            """
            INSERT INTO public.source_document (
                owner_id,
                contact_id,
                source_type,
                file_name,
                content_sha256,
                record_count
            )
            VALUES (%s, %s, 'wechat_jsonl', %s, %s, %s)
            ON CONFLICT (owner_id, contact_id, content_sha256) DO NOTHING
            RETURNING id
            """,
            (
                owner_id,
                document.contact.contact_id,
                document.file_name,
                document.content_sha256,
                document.record_count,
            ),
        ).fetchone()

        if source is None:
            existing = connection.execute(
                """
                SELECT id, status, record_count
                FROM public.source_document
                WHERE owner_id = %s
                  AND contact_id = %s
                  AND content_sha256 = %s
                """,
                (
                    owner_id,
                    document.contact.contact_id,
                    document.content_sha256,
                ),
            ).fetchone()
            if existing is None:
                raise ImportPersistenceError("无法确认重复来源状态。")
            source_document_id, status, record_count = existing
            if status != "active":
                raise SourceStateConflictError(
                    "同一来源处于非 active 状态，需要先处理现有来源。"
                )
            return ImportResult(
                source_document_id=source_document_id,
                outcome="already_imported",
                message_count=record_count,
            )

        source_document_id = source[0]
        external_local_ids = [
            message.external_local_id for message in document.messages
        ]
        overlap = connection.execute(
            """
            SELECT 1
            FROM public.message
            WHERE owner_id = %s
              AND contact_id = %s
              AND external_local_id = ANY(%s::bigint[])
            LIMIT 1
            """,
            (
                owner_id,
                document.contact.contact_id,
                external_local_ids,
            ),
        ).fetchone()
        if overlap is not None:
            raise OverlappingSourceError(
                "文件与已导入来源包含重叠消息，未写入新来源。"
            )

        message_parameters = [
            (
                owner_id,
                document.contact.contact_id,
                source_document_id,
                message.external_local_id,
                message.external_server_id,
                message.external_talker,
                message.speaker,
                message.message_type,
                message.text_content,
                message.occurred_at,
                message.source_create_time,
                message.raw_payload_json,
            )
            for message in document.messages
        ]
        with connection.cursor() as cursor:
            cursor.executemany(
                """
                INSERT INTO public.message (
                    owner_id,
                    contact_id,
                    source_document_id,
                    external_local_id,
                    external_server_id,
                    external_talker,
                    speaker,
                    message_type,
                    text_content,
                    occurred_at,
                    source_create_time,
                    raw_payload
                )
                VALUES (
                    %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s::jsonb
                )
                """,
                message_parameters,
            )

        return ImportResult(
            source_document_id=source_document_id,
            outcome="imported",
            message_count=document.record_count,
        )
