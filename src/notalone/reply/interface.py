"""候选回复 Module 的公开 Interface。"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from uuid import UUID

from notalone.scopes import ContactScope


class DirectionSource(StrEnum):
    """用户确认本次表达方向的来源。"""

    DIRECT_INPUT = "direct_input"
    CONFIRMED_SUGGESTION = "confirmed_suggestion"


@dataclass(frozen=True, slots=True, repr=False)
class ConfirmedDirection:
    """用户已经直接输入或确认的单次表达方向。"""

    text: str
    source: DirectionSource

    def __post_init__(self) -> None:
        if not self.text.strip():
            raise ValueError("已确认表达方向不能为空。")


@dataclass(frozen=True, slots=True)
class ReplyToMessage:
    """针对一条已归属规范消息生成回复。"""

    target_message_id: UUID
    direction: ConfirmedDirection


@dataclass(frozen=True, slots=True)
class AutoSkill:
    """允许运行时从当前联系人目录中按需选择至多一个 Skill。"""


@dataclass(frozen=True, slots=True)
class GenerateReply:
    """调用者提交给候选回复 Module 的唯一命令。"""

    idempotency_key: UUID
    scope: ContactScope
    conversation_binding_id: UUID
    content: ReplyToMessage
    skill: AutoSkill = AutoSkill()


@dataclass(frozen=True, slots=True)
class ContextReceipt:
    """本次生成实际使用的依据引用。"""

    evidence_ids: tuple[UUID, ...]


@dataclass(frozen=True, slots=True)
class SkillUse:
    """本次实际加载的不可变回复 Skill 版本。"""

    skill_id: UUID
    version_id: UUID
    name: str


@dataclass(frozen=True, slots=True, repr=False)
class ReplyCandidate:
    """只在 NotAlone 内展示和编辑的候选回复。"""

    candidate_id: UUID
    text: str
    basis: str
    citation_ids: tuple[UUID, ...]
    risk_notes: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ReplyGenerated:
    """已经持久化、可以交给 UI 展示的候选结果。"""

    reply_request_id: UUID
    candidates: tuple[ReplyCandidate, ...]
    context_receipt: ContextReceipt
    used_skill: SkillUse | None


ReplyOutcome = ReplyGenerated
