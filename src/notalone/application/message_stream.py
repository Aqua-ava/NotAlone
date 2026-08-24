"""消息流的共享应用层读取路径。

消息流是消息「按时间倒序分页展示」的读取，与检索（PostgresRetrieval）
不同：检索面向问答式查询，消息流面向界面分页。两者都只允许当前
联系人范围内 active 来源的规范消息。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol
from uuid import UUID

from notalone.scopes import ContactScope


@dataclass(frozen=True, slots=True)
class QuotedMessageView:
    """引用消息按领域定义的投影：正文与被引用内容是两段不同证据。

    ``text`` 是被引用内容的原文（来自来源元数据）；``target_message_id``
    在引用目标仍在本联系人范围内存在时为目标消息，否则为 None，界面
    显示为未解析引用。不能把被引用内容冒充当前消息正文。
    """

    text: str
    target_message_id: UUID | None


@dataclass(frozen=True, slots=True)
class StreamedMessage:
    """消息流中的一条规范消息投影。"""

    message_id: UUID
    scope: ContactScope
    speaker: str
    message_type: str
    text: str
    media_placeholder: str | None
    occurred_at: datetime | None
    quoted: QuotedMessageView | None

    def __post_init__(self) -> None:
        if not isinstance(self.message_id, UUID):
            raise TypeError("消息引用必须是 UUID。")
        if not isinstance(self.scope, ContactScope):
            raise TypeError("消息流投影必须带联系人范围。")
        if not self.speaker or self.speaker not in {"user", "contact", "system"}:
            raise ValueError("消息流说话人无效。")
        if not self.message_type or not self.message_type.strip():
            raise ValueError("消息流类型不能为空。")
        if self.media_placeholder is not None and not self.media_placeholder.strip():
            raise ValueError("媒体占位文本不能是空字符串。")
        if (
            not self.text.strip()
            and (self.media_placeholder is None or not self.media_placeholder.strip())
        ):
            raise ValueError("消息流投影必须包含正文或媒体占位。")
        if self.occurred_at is not None and not isinstance(self.occurred_at, datetime):
            raise TypeError("消息时间结构无效。")
        if self.quoted is not None and not isinstance(self.quoted, QuotedMessageView):
            raise TypeError("引用消息投影结构无效。")


@dataclass(frozen=True, slots=True)
class MessagePage:
    """一页消息流结果与下一页游标。"""

    messages: tuple[StreamedMessage, ...]
    next_cursor: UUID | None


class MessageStreamPort(Protocol):
    """消息流持久化端口。"""

    def page_messages(
        self,
        *,
        scope: ContactScope,
        limit: int,
        before_message_id: UUID | None = None,
    ) -> MessagePage: ...

    def contact_exists(self, owner_id: UUID, contact_id: UUID) -> bool:
        """联系人是否属于当前 owner；跨 owner 读取必须被拒绝。"""


class MessageStream:
    """供本地后端共用的消息流应用服务。"""

    __slots__ = ("_port",)

    def __init__(self, port: MessageStreamPort) -> None:
        self._port = port

    def page_messages(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        limit: int = 50,
        before_message_id: UUID | None = None,
    ) -> MessagePage:
        """返回当前 owner 范围内联系人的一页消息；跨 owner 抛错。"""

        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        if not isinstance(contact_id, UUID):
            raise TypeError("contact_id 必须是 UUID。")
        if not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("消息流 limit 超出范围。")
        if before_message_id is not None and not isinstance(
            before_message_id,
            UUID,
        ):
            raise TypeError("before_message_id 必须是 UUID 或 None。")
        if not self._port.contact_exists(owner_id, contact_id):
            raise MessageStreamContactNotFound(contact_id=contact_id)
        return self._port.page_messages(
            scope=ContactScope(owner_id=owner_id, contact_id=contact_id),
            limit=limit,
            before_message_id=before_message_id,
        )


class MessageStreamContactNotFound(RuntimeError):
    """联系人不存在或不属于当前 owner（跨联系人读取被拒绝）。"""

    def __init__(self, *, contact_id: UUID) -> None:
        self.contact_id = contact_id
        super().__init__("联系人不存在或超出当前 owner 范围。")