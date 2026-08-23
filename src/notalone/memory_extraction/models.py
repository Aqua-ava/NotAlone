"""记忆提取的领域值对象。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import UUID

from notalone.memory.models import MemoryCategory


class FactSubject(StrEnum):
    """一条提取事实的主体：谁的事。"""

    SELF = "self"
    CONTACT = "contact"
    SHARED = "shared"


class MemoryTopic(StrEnum):
    """记忆的受控粗筛主题，只用于缩小裁决检索范围。"""

    HEALTH = "health"
    WORK = "work"
    FAMILY = "family"
    TRAVEL = "travel"
    FINANCE = "finance"
    STUDY = "study"
    EMOTION = "emotion"
    OTHER = "other"


class MessageSender(StrEnum):
    """窗口内一条消息的发送者。"""

    SELF = "self"
    CONTACT = "contact"


def _validate_datetime(value: datetime | None, label: str) -> None:
    if value is not None and (
        not isinstance(value, datetime) or value.tzinfo is None
    ):
        raise ValueError(f"{label}必须是带时区的 datetime。")


@dataclass(frozen=True, slots=True)
class ExtractedFact:
    """一条通过结构化提取产出、尚未落库的事实候选。"""

    text: str
    category: MemoryCategory
    subject: FactSubject
    topic: MemoryTopic
    source_message_ids: tuple[UUID, ...]
    confidence: float
    risk_flags: tuple[str, ...] = ()
    valid_at: datetime | None = None
    invalid_at: datetime | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.text, str) or not self.text.strip():
            raise ValueError("事实文本不能为空。")
        if not isinstance(self.category, MemoryCategory):
            raise ValueError("事实分类必须使用既有五类。")
        if not isinstance(self.subject, FactSubject):
            raise ValueError("事实主体必须是 self/contact/shared。")
        if not isinstance(self.topic, MemoryTopic):
            raise ValueError("事实主题必须是受控主题。")
        if (
            not isinstance(self.source_message_ids, tuple)
            or not self.source_message_ids
            or any(not isinstance(item, UUID) for item in self.source_message_ids)
        ):
            raise ValueError("事实必须引用至少一条来源消息。")
        if (
            not isinstance(self.confidence, (int, float))
            or not 0.0 <= float(self.confidence) <= 1.0
        ):
            raise ValueError("置信度必须在 0 到 1 之间。")
        if not isinstance(self.risk_flags, tuple) or any(
            not isinstance(flag, str) or not flag.strip() for flag in self.risk_flags
        ):
            raise ValueError("风险标记必须是非空字符串元组。")
        _validate_datetime(self.valid_at, "生效时间")
        _validate_datetime(self.invalid_at, "失效时间")
        if (
            self.valid_at is not None
            and self.invalid_at is not None
            and self.invalid_at <= self.valid_at
        ):
            raise ValueError("失效时间必须晚于生效时间。")


@dataclass(frozen=True, slots=True)
class MessageRef:
    """提取窗口内一条消息的最小引用；发送者标注是主体判断的输入依据。"""

    message_id: UUID
    text: str
    sender: MessageSender
    occurred_at: datetime

    def __post_init__(self) -> None:
        if not isinstance(self.message_id, UUID):
            raise ValueError("消息引用必须携带消息 ID。")
        if not isinstance(self.text, str) or not self.text:
            raise ValueError("消息引用文本不能为空。")
        if not isinstance(self.sender, MessageSender):
            raise ValueError("消息发送者必须是 self 或 contact。")
        _validate_datetime(self.occurred_at, "消息时间")


@dataclass(frozen=True, slots=True)
class ExtractionWindow:
    """一次提取的输入：单一联系人范围内、时间正序的消息窗口。"""

    owner_id: UUID
    contact_id: UUID
    messages: tuple[MessageRef, ...]

    def __post_init__(self) -> None:
        if not self.messages:
            raise ValueError("提取窗口必须包含至少一条消息。")
        times = [message.occurred_at for message in self.messages]
        if any(later < earlier for earlier, later in zip(times, times[1:])):
            raise ValueError("提取窗口必须按时间正序排列。")

    @property
    def message_id_set(self) -> set[UUID]:
        return {message.message_id for message in self.messages}
