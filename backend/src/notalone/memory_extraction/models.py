"""记忆提取的领域值对象。"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

from notalone.memory.dimension_evidence import DimensionEvidence
from notalone.memory.pragmatics import (
    AssertionStatus, FigurativeType, SpeechAct,
)

from notalone.memory.models import (
    SourceDependencyMode,
    FactSubject,
    MemoryCategory,
    MemoryTopic,
)
from notalone.memory.timing import MemoryTiming
from notalone.memory.events import MemoryEvent

__all__ = [
    "AssertionStatus",
    "ExtractedFact",
    "ExtractionFailureKind",
    "ExtractionWindow",
    "FactSubject",
    "FigurativeType",
    "MAX_TARGET_MESSAGES_PER_WINDOW",
    "MessageRef",
    "MessageSender",
    "MemoryTopic",
    "SpeechAct",
]


MAX_TARGET_MESSAGES_PER_WINDOW = 20


class MessageSender(StrEnum):
    """窗口内一条消息的发送者。"""

    SELF = "self"
    CONTACT = "contact"


class ExtractionFailureKind(StrEnum):
    """批次级提取失败的分类；只有输出不可用才允许跳过。"""

    UNAVAILABLE = "unavailable"
    INVALID_OUTPUT = "invalid_output"


def _validate_datetime(value: datetime | None, label: str) -> None:
    if value is not None and (
        not isinstance(value, datetime) or value.tzinfo is None
    ):
        raise ValueError(f"{label}必须是带时区的 datetime。")


@dataclass(frozen=True, slots=True)
class ExtractedFact:
    """一条带语用解释、尚未落库的关系记忆候选。"""

    text: str
    category: MemoryCategory
    subject: FactSubject
    topic: MemoryTopic
    source_message_ids: tuple[UUID, ...]
    confidence: float
    risk_flags: tuple[str, ...] = ()
    valid_at: datetime | None = None
    invalid_at: datetime | None = None
    speech_act: SpeechAct = SpeechAct.UNKNOWN
    assertion_status: AssertionStatus = AssertionStatus.UNKNOWN
    figurative_type: FigurativeType = FigurativeType.UNKNOWN
    alternatives: tuple[str, ...] = ()
    interpretation_reason: str = ""
    timing: MemoryTiming = MemoryTiming()
    dimension_evidence: DimensionEvidence | None = None
    event: MemoryEvent | None = None
    # 同次独立核验的临时回执，仅绑定候选和窗口摘要，不从持久候选恢复。
    verified_source_receipt: tuple[str, str, str, bool] | None = None

    source_dependency_mode: SourceDependencyMode = SourceDependencyMode.ANY
    requires_all_sources: bool = False

    def __post_init__(self) -> None:
        if type(self.requires_all_sources) is not bool:
            raise TypeError("完整正文的来源依赖标记必须为布尔值。")
        if not isinstance(self.source_dependency_mode, SourceDependencyMode):
            raise TypeError("来源依赖方式必须是受控枚举。")
        if self.event is not None and not isinstance(self.event, MemoryEvent):
            raise ValueError("提取事件结构无效。")
        if self.dimension_evidence is not None and not isinstance(
            self.dimension_evidence, DimensionEvidence
        ):
            raise TypeError("事实维度依据必须使用版本化定位字段。")
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
        if not isinstance(self.speech_act, SpeechAct):
            raise ValueError("说话行为必须使用受控枚举。")
        if not isinstance(self.assertion_status, AssertionStatus):
            raise ValueError("断言状态必须使用受控枚举。")
        if not isinstance(self.figurative_type, FigurativeType):
            raise ValueError("修辞状态必须使用受控枚举。")
        if not isinstance(self.alternatives, tuple) or any(
            not isinstance(item, str) or not item.strip()
            for item in self.alternatives
        ):
            raise ValueError("备选解释必须是非空字符串元组。")
        if not isinstance(self.interpretation_reason, str):
            raise ValueError("语用判断依据必须是字符串。")
        if not isinstance(self.timing, MemoryTiming):
            raise TypeError("提取事实时间信息无效。")
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
    occurred_at: datetime | None
    # 早于提取保存的来源处理快照；空集合表示真实缺口，不补造原始记录。
    source_snapshots: tuple[dict[str, Any], ...] = ()
    message_snapshot: dict[str, Any] = field(default_factory=dict)
    message_type: str = "unknown"
    text_representation: str = "unknown"

    def __post_init__(self) -> None:
        if not isinstance(self.message_type, str) or not self.message_type.strip():
            raise ValueError("消息类型必须来自受控来源或保持未知。")
        if self.text_representation not in {
            "text", "processed_text", "placeholder", "unknown"
        }:
            raise ValueError("消息文字表示无效。")
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
    target_message_ids: tuple[UUID, ...] | None = None

    def __post_init__(self) -> None:
        if not self.messages:
            raise ValueError("提取窗口必须包含至少一条消息。")
        times = [
            message.occurred_at for message in self.messages
            if message.occurred_at is not None
        ]
        if any(later < earlier for earlier, later in zip(times, times[1:])):
            raise ValueError("提取窗口必须按时间正序排列。")
        if self.target_message_ids is not None:
            if (
                not isinstance(self.target_message_ids, tuple)
                or not self.target_message_ids
                or len(self.target_message_ids)
                > MAX_TARGET_MESSAGES_PER_WINDOW
                or any(
                    not isinstance(item, UUID)
                    for item in self.target_message_ids
                )
            ):
                raise ValueError(
                    "目标消息 ID 必须是 1 到 "
                    f"{MAX_TARGET_MESSAGES_PER_WINDOW} 个 UUID。"
                )
            if not set(self.target_message_ids) <= self.message_id_set:
                raise ValueError("目标消息必须属于提取窗口。")

    @property
    def message_id_set(self) -> set[UUID]:
        return {message.message_id for message in self.messages}

    @property
    def target_message_id_set(self) -> set[UUID]:
        """返回本次需要提取的消息；未指定时兼容旧调用，全部视为目标。"""

        if self.target_message_ids is None:
            return self.message_id_set
        return set(self.target_message_ids)
