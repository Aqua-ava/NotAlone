"""消息流的 PostgreSQL 读取适配器。

按联系人范围倒序分页返回 active 来源的规范消息，并解析引用消息的
目标（引用目标仍存在时回到目标消息；缺失时保持未解析引用）。
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from notalone.application.message_stream import (
    MessagePage,
    MessageStreamPort,
    QuotedMessageView,
    StreamedMessage,
)
from notalone.persistence.message_sources import valid_source_ref_exists_sql
from notalone.scopes import ContactScope


class PostgresMessageStream:
    """按 owner/contact 范围读取消息流。"""

    __slots__ = ("_database_url",)

    def __init__(self, database_url: str) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url

    def contact_exists(self, owner_id: UUID, contact_id: UUID) -> bool:
        """联系人是否属于当前 owner；跨 owner 读取必须被拒绝。"""

        self._validate_uuid(owner_id, "owner_id")
        self._validate_uuid(contact_id, "contact_id")
        try:
            with self._connect() as connection:
                row = connection.execute(
                    """
                    SELECT 1
                    FROM public.contact
                    WHERE owner_id = %s AND id = %s
                    """,
                    (owner_id, contact_id),
                ).fetchone()
        except psycopg.Error:
            raise MessageStreamPersistenceError("联系人范围校验失败。") from None
        return row is not None

    def page_messages(
        self,
        *,
        scope: ContactScope,
        limit: int,
        before_message_id: UUID | None = None,
    ) -> MessagePage:
        """按时间倒序返回一页消息；无更多页时 next_cursor 为 None。"""

        if not isinstance(limit, int) or limit <= 0:
            raise ValueError("limit 必须是正整数。")
        try:
            with self._connect() as connection:
                cursor_at = None
                if before_message_id is not None:
                    cursor_at = self._cursor_timestamp(
                        connection,
                        scope=scope,
                        message_id=before_message_id,
                    )
                conditions = [
                    "m.owner_id = %s",
                    "m.contact_id = %s",
                    valid_source_ref_exists_sql("m"),
                ]
                parameters: list[Any] = [scope.owner_id, scope.contact_id]
                if before_message_id is not None:
                    # 与 ORDER BY occurred_at DESC NULLS LAST, id DESC 一致：
                    # 空时间排在最后；游标时间非空时还要带上其后所有空时间消息。
                    if cursor_at is None:
                        conditions.append(
                            "(m.occurred_at IS NULL AND m.id < %s)"
                        )
                        parameters.append(before_message_id)
                    else:
                        conditions.append(
                            """
                            (m.occurred_at IS NULL
                             OR (m.occurred_at, m.id) < (%s, %s))
                            """
                        )
                        parameters.extend((cursor_at, before_message_id))
                parameters.append(limit + 1)
                rows = connection.execute(
                    f"""
                    SELECT m.id AS message_id,
                           m.speaker,
                           m.message_type,
                           m.text_content,
                           m.media_placeholder,
                           m.occurred_at,
                           quote_ref.quoted_text,
                           quote_ref.quoted_server_id,
                           target.id AS quoted_target_id
                    FROM public.message AS m
                    LEFT JOIN LATERAL (
                        SELECT payload.raw_payload -> 'quote' ->> 'text'
                                   AS quoted_text,
                               payload.raw_payload
                                   -> 'quote'
                                   -> 'id'
                                   ->> 'server_id_str'
                                   AS quoted_server_id
                        FROM public.message_source_ref AS payload
                        WHERE payload.message_id = m.id
                          AND payload.owner_id = m.owner_id
                          AND payload.contact_id = m.contact_id
                        LIMIT 1
                    ) AS quote_ref ON quote_ref.quoted_server_id IS NOT NULL
                    LEFT JOIN public.wechat_message_metadata AS target_meta
                        ON target_meta.owner_id = m.owner_id
                       AND target_meta.contact_id = m.contact_id
                       AND quote_ref.quoted_server_id IS NOT NULL
                       AND target_meta.external_server_id = quote_ref.quoted_server_id
                    LEFT JOIN public.message AS target
                        ON target.id = target_meta.message_id
                       AND target.owner_id = target_meta.owner_id
                       AND target.contact_id = target_meta.contact_id
                    WHERE {' AND '.join(conditions)}
                    ORDER BY m.occurred_at DESC NULLS LAST, m.id DESC
                    LIMIT %s
                    """,
                    parameters,
                ).fetchall()
        except psycopg.Error:
            raise MessageStreamPersistenceError("消息流读取失败。") from None

        messages = tuple(self._message_from_row(row, scope) for row in rows)
        # keyset 分页：多取一条探测是否还有下一页；有则返回本页结尾
        # 消息作为游标，无则 next_cursor 为 None。
        next_cursor: UUID | None = None
        if len(messages) > limit:
            messages = messages[:limit]
            next_cursor = messages[-1].message_id
        return MessagePage(messages=messages, next_cursor=next_cursor)

    def _message_from_row(
        self,
        row: dict[str, Any],
        scope: ContactScope,
    ) -> StreamedMessage:
        quoted = None
        if row.get("quoted_server_id") is not None:
            quoted = QuotedMessageView(
                text=row["quoted_text"] or "",
                target_message_id=row["quoted_target_id"],
            )
        return StreamedMessage(
            message_id=row["message_id"],
            scope=scope,
            speaker=row["speaker"],
            message_type=row["message_type"],
            text=row["text_content"],
            media_placeholder=row["media_placeholder"],
            occurred_at=row["occurred_at"],
            quoted=quoted,
        )

    def _cursor_timestamp(
        self,
        connection: Any,
        *,
        scope: ContactScope,
        message_id: UUID,
    ) -> Any | None:
        """返回游标消息的 occurred_at（没有时间记录时返回 None）。"""

        row = connection.execute(
            """
            SELECT occurred_at
            FROM public.message
            WHERE owner_id = %s AND contact_id = %s AND id = %s
            """,
            (scope.owner_id, scope.contact_id, message_id),
        ).fetchone()
        if row is None:
            raise MessageStreamPersistenceError("消息流游标无效。")
        return row["occurred_at"]

    def _connect(self) -> Any:
        return psycopg.connect(self._database_url, row_factory=dict_row)

    @staticmethod
    def _validate_uuid(value: UUID, name: str) -> None:
        if not isinstance(value, UUID):
            raise TypeError(f"{name} 必须是 UUID。")


class MessageStreamPersistenceError(RuntimeError):
    """不暴露 SQL 或连接信息的消息流读取错误。"""