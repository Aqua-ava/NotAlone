"""候选回复 Module 的公开 Interface。"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal, TypeAlias
from uuid import UUID

from notalone.scopes import ContactScope, VerifiedConversationScope


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
class RewriteDraft:
    """使用用户原句进行一次性改写或基础润色。"""

    draft_text: str
    user_instruction: str | None = None
    include_relationship_context: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.draft_text, str) or not self.draft_text.strip():
            raise ValueError("改写草稿不能为空。")
        if self.user_instruction is not None and (
            not isinstance(self.user_instruction, str)
            or not self.user_instruction.strip()
        ):
            raise ValueError("一次性改写要求不能为空字符串。")
        if not isinstance(self.include_relationship_context, bool):
            raise TypeError("是否使用联系人背景必须是布尔值。")

    def is_valid(self) -> bool:
        """供应用边界重复校验不可信输入。"""

        return (
            isinstance(self.draft_text, str)
            and bool(self.draft_text.strip())
            and (
                self.user_instruction is None
                or (
                    isinstance(self.user_instruction, str)
                    and bool(self.user_instruction.strip())
                )
            )
            and isinstance(self.include_relationship_context, bool)
        )


@dataclass(frozen=True, slots=True, repr=False)
class InitiateConversation:
    """没有待回复目标时，由用户明确目的发起联系。"""

    purpose: ConfirmedDirection

    def __post_init__(self) -> None:
        if not isinstance(self.purpose, ConfirmedDirection):
            raise TypeError("主动联系目的必须由用户明确输入或确认。")


ReplyInput: TypeAlias = ReplyToMessage | RewriteDraft | InitiateConversation


@dataclass(frozen=True, slots=True)
class AutoSkill:
    """允许运行时从当前联系人目录中按需选择至多一个 Skill。"""


@dataclass(frozen=True, slots=True)
class NoSkill:
    """用户明确关闭策略；后续生成不能重新自动选回。"""


@dataclass(frozen=True, slots=True)
class UserSkillChoice:
    """用户手动指定一个 active 版本的 Skill；范围校验由加载层执行。"""

    version_id: UUID


SkillSelection: TypeAlias = AutoSkill | UserSkillChoice | NoSkill


@dataclass(frozen=True, slots=True)
class GenerateReply:
    """调用者提交给候选回复 Module 的唯一命令。"""

    idempotency_key: UUID
    scope: ContactScope
    conversation_binding_id: UUID
    content: ReplyInput
    continued_from_candidate_id: UUID | None = None
    skill: SkillSelection = AutoSkill()

    def has_valid_content(self) -> bool:
        """判断联合输入是否满足应用层的最小结构约束。"""

        if isinstance(self.content, ReplyToMessage):
            content_valid = (
                isinstance(self.content.target_message_id, UUID)
                and isinstance(self.content.direction, ConfirmedDirection)
            )
        elif isinstance(self.content, InitiateConversation):
            content_valid = isinstance(self.content.purpose, ConfirmedDirection)
        else:
            content_valid = (
                isinstance(self.content, RewriteDraft) and self.content.is_valid()
            )
        return content_valid and (
            self.continued_from_candidate_id is None
            or isinstance(self.continued_from_candidate_id, UUID)
        ) and (
            isinstance(self.skill, (AutoSkill, NoSkill))
            or (
                isinstance(self.skill, UserSkillChoice)
                and isinstance(self.skill.version_id, UUID)
            )
        )

    def matches_verified_scope(self, scope: VerifiedConversationScope) -> bool:
        """判断请求声明的联系人和会话是否与已验证范围一致。"""

        return (
            isinstance(self.scope, ContactScope)
            and isinstance(self.conversation_binding_id, UUID)
            and self.scope.owner_id == scope.owner_id
            and self.scope.contact_id == scope.contact_id
            and self.conversation_binding_id == scope.conversation_binding_id
        )


@dataclass(frozen=True, slots=True)
class ContextReceipt:
    """本次生成实际使用的依据引用。"""

    evidence_ids: tuple[UUID, ...]


@dataclass(frozen=True, slots=True)
class SkillUse:
    """本次实际加载的不可变回复 Skill 版本与运行记录。"""

    skill_id: UUID
    version_id: UUID
    name: str
    selection_method: Literal["auto", "user"] = "auto"
    selection_reason: str = ""
    resource_paths: tuple[str, ...] = ()
    load_state: Literal["loaded", "resource_failed"] = "loaded"

    def __post_init__(self) -> None:
        if not isinstance(self.skill_id, UUID) or not isinstance(
            self.version_id,
            UUID,
        ):
            raise TypeError("Skill 使用摘要标识必须是 UUID。")
        if not isinstance(self.name, str) or not self.name.strip():
            raise ValueError("Skill 名称不能为空。")
        if self.selection_method not in ("auto", "user"):
            raise ValueError("Skill 选择方式无效。")
        if not isinstance(self.selection_reason, str):
            raise TypeError("Skill 选择原因必须是字符串。")
        if not isinstance(self.resource_paths, tuple) or any(
            not isinstance(path, str) or not path.strip()
            for path in self.resource_paths
        ):
            raise TypeError("Skill 资源路径摘要无效。")
        if len(self.resource_paths) != len(set(self.resource_paths)):
            raise ValueError("Skill 资源路径摘要重复。")
        if self.load_state not in ("loaded", "resource_failed"):
            raise ValueError("Skill 加载状态无效。")


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
