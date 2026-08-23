"""使用 PostgreSQL 原子写入单联系人聊天记录。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID, uuid4

import psycopg

from notalone.ingest.models import (
    ExistingContactSelection,
    ImportBatch,
    ImportConfirmationRequest,
)


class ImportPersistenceError(RuntimeError):
    """不暴露 SQL、连接信息或聊天内容的持久化错误。"""


class OwnerNotFoundError(ImportPersistenceError):
    """指定的 NotAlone 用户不存在。"""


class ContactNotFoundError(ImportPersistenceError):
    """用户选择的 NotAlone 联系人不存在。"""


class ChannelIdentityConflictError(ImportPersistenceError):
    """微信渠道身份与已确认联系人绑定冲突。"""


class SourceStateConflictError(ImportPersistenceError):
    """同一来源已存在，但当前状态不允许直接重复导入。"""


class OverlappingSourceError(ImportPersistenceError):
    """不同来源与已入库消息发生重叠，需要用户先处理来源。"""


@dataclass(frozen=True, slots=True)
class ImportResult:
    """一次数据库导入的非敏感结果。"""

    contact_id: UUID
    channel_identity_id: UUID
    source_document_id: UUID
    confirmation_id: UUID
    confirmation_method: Literal["manual_create", "manual_select"]
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
        confirmation: ImportConfirmationRequest,
    ) -> ImportResult:
        """导入一个已规范化批次；重复 active 来源返回幂等结果。"""

        try:
            # Psycopg 连接上下文在正常退出时提交，异常退出时先回滚再关闭连接。
            with psycopg.connect(self._database_url) as connection:
                return self._import_in_transaction(
                    connection=connection,
                    owner_id=owner_id,
                    document=document,
                    confirmation=confirmation,
                )
        except (
            ChannelIdentityConflictError,
            ContactNotFoundError,
            OverlappingSourceError,
            OwnerNotFoundError,
            SourceStateConflictError,
        ):
            raise
        except psycopg.errors.UniqueViolation as error:
            if error.diag.constraint_name in {
                "channel_identity_active_contact_channel_unique",
                "channel_identity_active_external_unique",
            }:
                raise ChannelIdentityConflictError(
                    "微信渠道身份与已确认联系人冲突，未执行导入。"
                ) from None
            if error.diag.constraint_name in {
                "message_contact_external_local_id_unique",
                "wechat_message_metadata_contact_local_time_unique",
            }:
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
        confirmation: ImportConfirmationRequest,
    ) -> ImportResult:
        owner = connection.execute(
            "SELECT 1 FROM public.owner WHERE id = %s FOR KEY SHARE",
            (owner_id,),
        ).fetchone()
        if owner is None:
            raise OwnerNotFoundError("指定的 owner 不存在。")

        selection = confirmation.selection
        if isinstance(selection, ExistingContactSelection):
            contact_id = selection.contact_id
            contact = connection.execute(
                """
                SELECT 1
                FROM public.contact
                WHERE owner_id = %s AND id = %s
                FOR UPDATE
                """,
                (owner_id, contact_id),
            ).fetchone()
            if contact is None:
                raise ContactNotFoundError("选择的联系人不存在。")
            confirmation_method = "manual_select"
        else:
            contact_id = connection.execute(
                """
                INSERT INTO public.contact (owner_id, display_name)
                VALUES (%s, %s)
                RETURNING id
                """,
                (owner_id, selection.display_name),
            ).fetchone()[0]
            confirmation_method = "manual_create"

        active_identity = connection.execute(
            """
            SELECT id, external_id
            FROM public.channel_identity
            WHERE owner_id = %s
              AND contact_id = %s
              AND channel = 'wechat'
              AND status = 'active'
            """,
            (owner_id, contact_id),
        ).fetchone()
        external_id = document.channel_identity.external_id
        if active_identity is None:
            channel_identity_id = connection.execute(
                """
                INSERT INTO public.channel_identity (
                    owner_id,
                    contact_id,
                    channel,
                    external_id,
                    observed_name
                )
                VALUES (%s, %s, 'wechat', %s, %s)
                RETURNING id
                """,
                (
                    owner_id,
                    contact_id,
                    external_id,
                    document.channel_identity.observed_name,
                ),
            ).fetchone()[0]
        else:
            channel_identity_id, existing_external_id = active_identity
            if existing_external_id != external_id:
                raise ChannelIdentityConflictError(
                    "微信渠道身份与已确认联系人冲突，未执行导入。"
                )

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
                contact_id,
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
                    contact_id,
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
            existing_confirmation = connection.execute(
                """
                SELECT id, channel_identity_id, method
                FROM public.import_confirmation
                WHERE owner_id = %s
                  AND contact_id = %s
                  AND source_document_id = %s
                """,
                (owner_id, contact_id, source_document_id),
            ).fetchone()
            if existing_confirmation is None:
                raise ImportPersistenceError("无法确认重复来源的联系人确认记录。")
            confirmation_id, existing_channel_identity_id, confirmation_method = (
                existing_confirmation
            )
            return ImportResult(
                contact_id=contact_id,
                channel_identity_id=existing_channel_identity_id,
                source_document_id=source_document_id,
                confirmation_id=confirmation_id,
                confirmation_method=confirmation_method,
                outcome="already_imported",
                message_count=record_count,
            )

        source_document_id = source[0]
        confirmation_id = connection.execute(
            """
            INSERT INTO public.import_confirmation (
                owner_id,
                contact_id,
                source_document_id,
                channel_identity_id,
                method
            )
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                owner_id,
                contact_id,
                source_document_id,
                channel_identity_id,
                confirmation_method,
            ),
        ).fetchone()[0]
        wechat_metadata = tuple(
            message.wechat_metadata for message in document.messages
        )
        if any(metadata is None for metadata in wechat_metadata):
            raise ImportPersistenceError("微信导入批次缺少微信来源元数据。")
        external_local_ids = [
            metadata.external_local_id for metadata in wechat_metadata
        ]
        source_create_times = [
            metadata.source_create_time for metadata in wechat_metadata
        ]
        overlap = connection.execute(
            """
            SELECT 1
            FROM public.wechat_message_metadata AS existing
            JOIN unnest(%s::bigint[], %s::bigint[])
              AS incoming(external_local_id, source_create_time)
              ON incoming.external_local_id = existing.external_local_id
             AND incoming.source_create_time = existing.source_create_time
            WHERE existing.owner_id = %s
              AND existing.contact_id = %s
            LIMIT 1
            """,
            (
                external_local_ids,
                source_create_times,
                owner_id,
                contact_id,
            ),
        ).fetchone()
        if overlap is not None:
            raise OverlappingSourceError(
                "文件与已导入来源包含重叠消息，未写入新来源。"
            )

        messages_with_ids = [
            (uuid4(), message, metadata)
            for message, metadata in zip(
                document.messages,
                wechat_metadata,
                strict=True,
            )
        ]
        message_parameters = [
            (
                message_id,
                owner_id,
                contact_id,
                source_document_id,
                message.source_locator,
                message.speaker,
                message.message_type,
                message.text_content,
                message.media_placeholder,
                message.occurred_at,
            )
            for message_id, message, _ in messages_with_ids
        ]
        with connection.cursor() as cursor:
            cursor.executemany(
                """
                INSERT INTO public.message (
                    id,
                    owner_id,
                    contact_id,
                    source_document_id,
                    source_locator,
                    speaker,
                    message_type,
                    text_content,
                    media_placeholder,
                    occurred_at
                )
                VALUES (
                    %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s
                )
                """,
                message_parameters,
            )
            metadata_parameters = [
                (
                    message_id,
                    owner_id,
                    contact_id,
                    source_document_id,
                    metadata.external_local_id,
                    metadata.external_server_id,
                    metadata.external_talker,
                    metadata.source_create_time,
                    metadata.raw_payload_json,
                )
                for message_id, _, metadata in messages_with_ids
            ]
            cursor.executemany(
                """
                INSERT INTO public.wechat_message_metadata (
                    message_id,
                    owner_id,
                    contact_id,
                    source_document_id,
                    external_local_id,
                    external_server_id,
                    external_talker,
                    source_create_time,
                    raw_payload
                )
                VALUES (
                    %s, %s, %s, %s, %s,
                    %s, %s, %s, %s::jsonb
                )
                """,
                metadata_parameters,
            )

        return ImportResult(
            contact_id=contact_id,
            channel_identity_id=channel_identity_id,
            source_document_id=source_document_id,
            confirmation_id=confirmation_id,
            confirmation_method=confirmation_method,
            outcome="imported",
            message_count=document.record_count,
        )
