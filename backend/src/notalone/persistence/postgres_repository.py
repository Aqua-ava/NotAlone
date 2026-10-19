"""使用 PostgreSQL 原子写入单联系人聊天记录。"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import UUID, uuid4

import psycopg

from notalone.ingest.models import (
    ExistingContactSelection,
    ImportBatch,
    ImportConfirmationRequest,
)
from notalone.persistence.background_tasks import (
    PostgresBackgroundTaskRepository,
)
from notalone.persistence.locks import lock_contact_scope
from notalone.persistence.source_processing import (
    SourceProcessingWriteError,
    save_processing_batch,
)
from notalone.scopes import ContactScope
from notalone.source_processing.models import ProcessingRecord
from notalone.source_processing.rule_capture import capture_execution


_IMPORT_WRITE_ROWS = 500
_IMPORT_WRITE_BYTES = 2 * 1024 * 1024


def _insert_import_rows(
    cursor: psycopg.Cursor[Any],
    statement: str,
    placeholders: str,
    rows: Iterable[tuple[Any, ...]],
) -> None:
    """按行数和 UTF-8 参数体积限制单条写入；超大单行完整保留。"""
    block: list[tuple[Any, ...]] = []
    block_bytes = 0
    for row in rows:
        row_bytes = len(placeholders) + sum(
            len(value.encode("utf-8")) if isinstance(value, str) else 32
            for value in row
        )
        if block and (
            len(block) >= _IMPORT_WRITE_ROWS
            or block_bytes + row_bytes > _IMPORT_WRITE_BYTES
        ):
            cursor.execute(
                statement + ",".join([placeholders] * len(block)),
                tuple(value for parameters in block for value in parameters),
            )
            block = []
            block_bytes = 0
        block.append(row)
        block_bytes += row_bytes
    if block:
        cursor.execute(
            statement + ",".join([placeholders] * len(block)),
            tuple(value for parameters in block for value in parameters),
        )


class ImportPersistenceError(RuntimeError):
    """不暴露 SQL、连接信息或聊天内容的持久化错误。"""


class OwnerNotFoundError(ImportPersistenceError):
    """指定的 NotAlone 用户不存在。"""


class OwnerChannelIdentityConflictError(ImportPersistenceError):
    """owner 的微信渠道身份与已确认身份冲突。"""


class OwnerChannelIdentityNotFoundError(ImportPersistenceError):
    """owner 尚未完成微信渠道身份初始化。"""


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
    task_id: UUID
    owner_id: UUID | None = None


class PostgresIngestRepository:
    """在一个 PostgreSQL 事务中写入联系人、来源和消息。"""

    __slots__ = ("_database_url",)

    def __init__(self, database_url: str) -> None:
        if not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url

    def validate_preview_identity(
        self,
        *,
        owner_id: UUID,
        owner_external_id: str,
        contact_external_id: str,
        contact_id: UUID | None = None,
    ) -> None:
        """只读核对本人和所选联系人的渠道，不初始化或恢复身份。"""

        try:
            with psycopg.connect(self._database_url) as connection:
                connection.execute(
                    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
                )
                owner = connection.execute(
                    "SELECT 1 FROM public.owner WHERE id = %s", (owner_id,),
                ).fetchone()
                if owner is None:
                    raise OwnerNotFoundError("指定的 owner 不存在。")
                active = connection.execute(
                    """SELECT external_id FROM public.owner_channel_identity
                       WHERE owner_id = %s AND channel = 'wechat'
                         AND status = 'active'""", (owner_id,),
                ).fetchone()
                if active is not None and active[0] != owner_external_id:
                    raise OwnerChannelIdentityConflictError(
                        "本人渠道身份与预览不一致。"
                    )
                if active is None:
                    previous = connection.execute(
                        """SELECT 1 FROM public.owner_channel_identity
                           WHERE owner_id = %s AND channel = 'wechat' LIMIT 1""",
                        (owner_id,),
                    ).fetchone()
                    if previous is not None:
                        raise OwnerChannelIdentityNotFoundError(
                            "本人渠道身份已撤销。"
                        )
                occupied = connection.execute(
                    """SELECT owner_id FROM public.owner_channel_identity
                       WHERE channel = 'wechat' AND external_id = %s
                         AND status = 'active'""", (owner_external_id,),
                ).fetchone()
                if occupied is not None and occupied[0] != owner_id:
                    raise OwnerChannelIdentityConflictError(
                        "本人渠道身份与已有绑定冲突。"
                    )
                if contact_id is not None:
                    contact = connection.execute(
                        "SELECT 1 FROM public.contact WHERE owner_id = %s AND id = %s",
                        (owner_id, contact_id),
                    ).fetchone()
                    if contact is None:
                        raise ContactNotFoundError("选择的联系人不存在。")
                    channel = connection.execute(
                        """SELECT external_id FROM public.channel_identity
                           WHERE owner_id = %s AND contact_id = %s
                             AND channel = 'wechat' AND status = 'active'""",
                        (owner_id, contact_id),
                    ).fetchone()
                    if channel is not None and channel[0] != contact_external_id:
                        raise ChannelIdentityConflictError(
                            "联系人渠道身份与预览不一致。"
                        )
                    occupied_contact = connection.execute(
                        """SELECT contact_id FROM public.channel_identity
                           WHERE owner_id = %s AND channel = 'wechat'
                             AND external_id = %s AND status = 'active'""",
                        (owner_id, contact_external_id),
                    ).fetchone()
                    if (
                        occupied_contact is not None
                        and occupied_contact[0] != contact_id
                    ):
                        raise ChannelIdentityConflictError(
                            "联系人渠道身份与已有绑定冲突。"
                        )
        except psycopg.Error:
            raise ImportPersistenceError("预览身份核对暂不可用。") from None

    def import_document(
        self,
        *,
        owner_id: UUID | None,
        initialize_owner: bool = False,
        initialize_first_owner_identity: bool = False,
        document: ImportBatch,
        confirmation: ImportConfirmationRequest,
    ) -> ImportResult:
        """导入规范批次；重复 active 来源幂等，首次身份选项不能恢复撤销。"""

        try:
            # Psycopg 连接上下文在正常退出时提交，异常退出时先回滚再关闭连接。
            with psycopg.connect(self._database_url) as connection:
                return self._import_in_transaction(
                    connection=connection,
                    owner_id=owner_id,
                    initialize_owner=initialize_owner,
                    initialize_first_owner_identity=initialize_first_owner_identity,
                    document=document,
                    confirmation=confirmation,
                )
        except (
            ChannelIdentityConflictError,
            ContactNotFoundError,
            OverlappingSourceError,
            OwnerChannelIdentityConflictError,
            OwnerChannelIdentityNotFoundError,
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
                "owner_channel_identity_active_owner_channel_unique",
                "owner_channel_identity_active_external_unique",
            }:
                raise OwnerChannelIdentityConflictError(
                    "owner 微信身份与已有绑定冲突，未执行导入。"
                ) from None
            if error.diag.constraint_name in {
                "message_contact_external_local_id_unique",
                "wechat_message_metadata_contact_local_time_unique",
                "wechat_message_metadata_stable_identity_unique",
                "message_source_ref_document_locator_unique",
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

    def record_input_failure(
        self, *, scope: ContactScope, record: ProcessingRecord
    ) -> None:
        """未验证输入仅保存无正文失败定位，未选定／无权访问联系人时不建记录。"""

        try:
            with psycopg.connect(self._database_url) as connection:
                lock_contact_scope(
                    connection,
                    owner_id=scope.owner_id,
                    contact_id=scope.contact_id,
                )
                exists = connection.execute(
                    "SELECT 1 FROM public.contact WHERE owner_id=%s AND id=%s FOR KEY SHARE",
                    (scope.owner_id, scope.contact_id),
                ).fetchone()
                if exists is None:
                    return
                save_processing_batch(
                    connection,
                    scope=scope,
                    source_kind="source_document",
                    source_id=None,
                    records=(record,),
                    receipts={},
                    status="failed",
                )
        except psycopg.Error:
            raise SourceProcessingWriteError() from None

    @staticmethod
    def _import_in_transaction(
        *,
        connection: psycopg.Connection[Any],
        owner_id: UUID | None,
        initialize_owner: bool,
        initialize_first_owner_identity: bool,
        document: ImportBatch,
        confirmation: ImportConfirmationRequest,
    ) -> ImportResult:
        started_at = datetime.now(timezone.utc)
        owner_id = PostgresIngestRepository._resolve_owner(
            connection=connection,
            owner_id=owner_id,
            initialize_owner=initialize_owner,
            initialize_first_owner_identity=initialize_first_owner_identity,
            document=document,
        )

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
            contact_id = PostgresIngestRepository._confirmed_create_replay(
                connection=connection,
                owner_id=owner_id,
                document=document,
                display_name=selection.display_name,
            )
            if contact_id is None:
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
                raise ImportPersistenceError(
                    "无法确认重复来源的联系人确认记录。"
                )
            (
                confirmation_id,
                existing_channel_identity_id,
                confirmation_method,
            ) = existing_confirmation
            task_id = PostgresIngestRepository._ensure_import_task(
                connection=connection,
                owner_id=owner_id,
                contact_id=contact_id,
                source_document_id=source_document_id,
                message_count=record_count,
            )
            PostgresIngestRepository._save_processing(
                connection,
                owner_id=owner_id,
                contact_id=contact_id,
                source_id=source_document_id,
                document=document,
                reused=True,
                started_at=started_at,
            )
            return ImportResult(
                contact_id=contact_id,
                channel_identity_id=existing_channel_identity_id,
                source_document_id=source_document_id,
                confirmation_id=confirmation_id,
                confirmation_method=confirmation_method,
                outcome="already_imported",
                message_count=record_count,
                task_id=task_id,
                owner_id=owner_id,
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
        with connection.cursor() as cursor:
            _insert_import_rows(
                cursor,
                "INSERT INTO public.message (id,owner_id,contact_id,speaker,"
                "message_type,text_content,media_placeholder,occurred_at) VALUES ",
                "(%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    (message_id, owner_id, contact_id, message.speaker,
                     message.message_type, message.text_content,
                     message.media_placeholder, message.occurred_at)
                    for message_id, message, _ in messages_with_ids
                ),
            )
            _insert_import_rows(
                cursor,
                "INSERT INTO public.wechat_message_metadata (message_id,owner_id,"
                "contact_id,external_local_id,external_server_id,external_talker,"
                "source_create_time) VALUES ",
                "(%s,%s,%s,%s,%s,%s,%s)",
                (
                    (message_id, owner_id, contact_id, metadata.external_local_id,
                     metadata.external_server_id, metadata.external_talker,
                     metadata.source_create_time)
                    for message_id, _, metadata in messages_with_ids
                ),
            )
            # 每条消息写一条导入来源引用；原始 JSON 作为来源证据随引用保存。
            _insert_import_rows(
                cursor,
                "INSERT INTO public.message_source_ref (message_id,owner_id,"
                "contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES ",
                "(%s,%s,%s,'source_document',%s,%s,%s::jsonb)",
                (
                    (message_id, owner_id, contact_id, source_document_id,
                     message.source_locator, metadata.raw_payload_json)
                    for message_id, message, metadata in messages_with_ids
                ),
            )

        task_id = PostgresIngestRepository._ensure_import_task(
            connection=connection,
            owner_id=owner_id,
            contact_id=contact_id,
            source_document_id=source_document_id,
            message_count=document.record_count,
        )
        PostgresIngestRepository._save_processing(
            connection,
            owner_id=owner_id,
            contact_id=contact_id,
            source_id=source_document_id,
            document=document,
            reused=False,
            started_at=started_at,
        )
        return ImportResult(
            contact_id=contact_id,
            channel_identity_id=channel_identity_id,
            source_document_id=source_document_id,
            confirmation_id=confirmation_id,
            confirmation_method=confirmation_method,
            outcome="imported",
            message_count=document.record_count,
            task_id=task_id,
            owner_id=owner_id,
        )

    @staticmethod
    def _save_processing(
        connection: psycopg.Connection[Any],
        *,
        owner_id: UUID,
        contact_id: UUID,
        source_id: UUID,
        document: ImportBatch,
        reused: bool,
        started_at: datetime,
    ) -> None:
        records = tuple(
            message.processing_record
            for message in document.messages
            if message.processing_record is not None
        )
        if not records:
            return
        refs = connection.execute(
            "SELECT id, message_id, source_locator FROM public.message_source_ref WHERE owner_id=%s AND contact_id=%s AND source_document_id=%s",
            (owner_id, contact_id, source_id),
        ).fetchall()
        receipts = {
            row[2]: {
                "message_id": row[1],
                "source_ref_id": row[0],
                "outcome": (
                    "source_and_message_reused"
                    if reused
                    else "message_created"
                ),
                "source_ref_added": not reused,
                "dedup_rule": "active_source_sha256_reuse_else_reject_overlapping_message",
                "execution": capture_execution(
                    started_at, __file__, status="prepared_for_commit"
                ),
            }
            for row in refs
        }
        save_processing_batch(
            connection,
            scope=ContactScope(owner_id, contact_id),
            source_kind="source_document",
            source_id=source_id,
            records=records,
            receipts=receipts,
        )

    @staticmethod
    def _ensure_import_task(
        *,
        connection: psycopg.Connection[Any],
        owner_id: UUID,
        contact_id: UUID,
        source_document_id: UUID,
        message_count: int,
    ) -> UUID:
        try:
            return PostgresBackgroundTaskRepository.create_import_task(
                connection,
                owner_id=owner_id,
                contact_id=contact_id,
                source_document_id=source_document_id,
                message_count=message_count,
            )
        except RuntimeError:
            raise ImportPersistenceError(
                "数据库导入失败，未写入任何数据。"
            ) from None

    @staticmethod
    def _confirmed_create_replay(
        *,
        connection: psycopg.Connection[Any],
        owner_id: UUID,
        document: ImportBatch,
        display_name: str,
    ) -> UUID | None:
        """只复用同一已确认的新建导入，不按昵称匹配或恢复撤销身份。"""

        identities = connection.execute(
            """
            SELECT id, contact_id, status
            FROM public.channel_identity
            WHERE owner_id = %s AND channel = 'wechat' AND external_id = %s
            FOR UPDATE
            """,
            (owner_id, document.channel_identity.external_id),
        ).fetchall()
        if not identities:
            return None
        if len(identities) != 1 or identities[0][2] != "active":
            raise ChannelIdentityConflictError("渠道身份需要重新选择既有联系人。")
        identity_id, contact_id, _ = identities[0]
        contact = connection.execute(
            """SELECT display_name FROM public.contact
               WHERE owner_id = %s AND id = %s FOR UPDATE""",
            (owner_id, contact_id),
        ).fetchone()
        source = connection.execute(
            """SELECT id, status FROM public.source_document
               WHERE owner_id = %s AND contact_id = %s AND content_sha256 = %s
               FOR UPDATE""",
            (owner_id, contact_id, document.content_sha256),
        ).fetchone()
        if contact is None or contact[0] != display_name or source is None:
            raise ChannelIdentityConflictError("导入确认需要重新选择既有联系人。")
        if source[1] != "active":
            raise SourceStateConflictError("同一来源处于非 active 状态。")
        confirmation = connection.execute(
            """SELECT channel_identity_id, method FROM public.import_confirmation
               WHERE owner_id = %s AND contact_id = %s AND source_document_id = %s
               FOR UPDATE""",
            (owner_id, contact_id, source[0]),
        ).fetchone()
        if confirmation != (identity_id, "manual_create"):
            raise ChannelIdentityConflictError("原确认需要重新选择既有联系人。")
        return contact_id

    @staticmethod
    def _resolve_owner(
        *,
        connection: psycopg.Connection[Any],
        owner_id: UUID | None,
        initialize_owner: bool,
        initialize_first_owner_identity: bool,
        document: ImportBatch,
    ) -> UUID:
        """解析或显式初始化 owner，并校验其微信渠道身份。"""

        external_id = document.owner_channel_identity.external_id
        if owner_id is None and not initialize_owner:
            raise OwnerNotFoundError("缺少受控运行身份。")
        if owner_id is None:
            existing = connection.execute(
                """
                SELECT owner_id
                FROM public.owner_channel_identity
                WHERE channel = 'wechat'
                  AND external_id = %s
                  AND status = 'active'
                FOR KEY SHARE
                """,
                (external_id,),
            ).fetchone()
            if existing is not None:
                owner_id = existing[0]
            elif initialize_owner:
                owner_id = uuid4()
                connection.execute(
                    """
                    INSERT INTO public.owner (id, display_name)
                    VALUES (%s, %s)
                    """,
                    (owner_id, document.owner_channel_identity.observed_name),
                )
            else:
                raise OwnerNotFoundError("缺少受控运行身份。")
        else:
            owner = connection.execute(
                # 首次渠道身份初始化按 owner 串行，避免并发确认重复绑定。
                (
                    "SELECT 1 FROM public.owner WHERE id = %s FOR UPDATE"
                    if initialize_first_owner_identity
                    else "SELECT 1 FROM public.owner WHERE id = %s FOR KEY SHARE"
                ),
                (owner_id,),
            ).fetchone()
            if owner is None:
                raise OwnerNotFoundError("指定的 owner 不存在。")

        active_identity = connection.execute(
            """
            SELECT external_id
            FROM public.owner_channel_identity
            WHERE owner_id = %s
              AND channel = 'wechat'
              AND status = 'active'
            FOR UPDATE
            """,
            (owner_id,),
        ).fetchone()
        if active_identity is not None:
            if active_identity[0] != external_id:
                raise OwnerChannelIdentityConflictError(
                    "owner 微信身份不一致，未执行导入。"
                )
            return owner_id

        if not initialize_owner:
            if not initialize_first_owner_identity:
                raise OwnerChannelIdentityNotFoundError(
                    "owner 尚未绑定微信身份，请首次导入时加 --initialize-owner。"
                )
            previous_identity = connection.execute(
                """
                SELECT 1
                FROM public.owner_channel_identity
                WHERE owner_id = %s AND channel = 'wechat'
                LIMIT 1
                """,
                (owner_id,),
            ).fetchone()
            if previous_identity is not None:
                raise OwnerChannelIdentityNotFoundError(
                    "owner 微信身份已撤销，请显式重新绑定后导入。"
                )

        existing_external = connection.execute(
            """
            SELECT owner_id
            FROM public.owner_channel_identity
            WHERE channel = 'wechat'
              AND external_id = %s
              AND status = 'active'
            FOR KEY SHARE
            """,
            (external_id,),
        ).fetchone()
        if existing_external is not None and existing_external[0] != owner_id:
            raise OwnerChannelIdentityConflictError(
                "微信身份已经绑定到其他 owner，未执行导入。"
            )
        connection.execute(
            """
            INSERT INTO public.owner_channel_identity (
                owner_id,
                channel,
                external_id,
                observed_name
            )
            VALUES (%s, 'wechat', %s, %s)
            """,
            (
                owner_id,
                external_id,
                document.owner_channel_identity.observed_name,
            ),
        )
        return owner_id
