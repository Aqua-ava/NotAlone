"""候选回复 Module 的公开 Interface。"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Callable, Literal, TypeAlias
from uuid import UUID

from notalone.scopes import ContactScope, VerifiedConversationScope
from notalone.reply.input_budget import InputBudgetDecision


class AccumulatedReplyRequirements(str):
    """已解析要求的完整集合；单次 JSON 声明的长度限制仍由公开解析器执行。"""

    def __new__(cls, requirements: tuple[str, ...]) -> AccumulatedReplyRequirements:
        if (not isinstance(requirements, tuple) or not requirements
                or any(not isinstance(value, str) or not value.strip() for value in requirements)):
            raise ValueError("累积表达要求无效。")
        return super().__new__(cls, "；".join(requirements))


class DirectionSource(StrEnum):
    """用户确认本次表达方向的来源。"""

    DIRECT_INPUT = "direct_input"
    CONFIRMED_SUGGESTION = "confirmed_suggestion"


@dataclass(frozen=True, slots=True, repr=False)
class SuggestionReference:
    """选择及实际输入身份；整数仅兼容未装配的旧组件，不授予生成权限。"""

    task_id: UUID
    input_version: UUID | int
    suggestion_id: UUID

    def __post_init__(self) -> None:
        if (not isinstance(self.task_id, UUID) or not isinstance(self.suggestion_id, UUID)
                or not (isinstance(self.input_version, UUID)
                        or type(self.input_version) is int and self.input_version >= 1)):
            raise ValueError("探索选择引用身份无效。")


@dataclass(frozen=True, slots=True, repr=False)
class ConfirmedDirection:
    """用户已经直接输入或确认的单次表达方向。"""

    text: str
    source: DirectionSource
    suggestion: SuggestionReference | None = None

    def __post_init__(self) -> None:
        if not self.text.strip():
            raise ValueError("已确认表达方向不能为空。")
        if self.suggestion is not None and (not isinstance(self.suggestion, SuggestionReference)
                                           or self.source is not DirectionSource.CONFIRMED_SUGGESTION
                                           and not isinstance(self.suggestion.input_version, UUID)):
            raise ValueError("方向确认引用无效。")


@dataclass(frozen=True, slots=True)
class ReplyToMessage:
    """针对一条已归属规范消息生成回复。"""

    target_message_id: UUID
    direction: ConfirmedDirection
    understanding_correction: str | None = None
    user_instruction: str | None = None
    clarification_answer: str | None = None


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
    understanding_correction: str | None = None
    user_instruction: str | None = None
    clarification_answer: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.purpose, ConfirmedDirection):
            raise TypeError("主动联系目的必须由用户明确输入或确认。")
        if not _valid_scenario_declarations(self):
            raise ValueError("本次表达说明无效。")


ReplyInput: TypeAlias = ReplyToMessage | RewriteDraft | InitiateConversation


def _valid_scenario_declarations(content: ReplyToMessage | InitiateConversation) -> bool:
    """本次用户声明不升级为确认意愿、外部事实或长期资料。"""

    declarations_valid = all(value is None or isinstance(value, str) and len(value) <= 4096 for value in (
        content.understanding_correction, content.clarification_answer,
    ))
    instruction = content.user_instruction
    return declarations_valid and (instruction is None or isinstance(instruction, str) and (
        len(instruction) <= 4096 or isinstance(instruction, AccumulatedReplyRequirements)
    ))


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
                and _valid_scenario_declarations(self.content)
            )
        elif isinstance(self.content, InitiateConversation):
            content_valid = isinstance(self.content.purpose, ConfirmedDirection) and _valid_scenario_declarations(self.content)
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
    style_sample_ids: tuple[UUID, ...] = ()


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
class CandidateMessage:
    """同一备选方案中的一条有序消息，顺序由消息元组确定。"""

    message_id: UUID
    text: str


def candidate_message_group(
    candidate_id: UUID, texts: tuple[str, ...], uuid_factory: Callable[[], UUID],
) -> tuple[CandidateMessage, ...]:
    """两个存储边界沿用同一逐条身份规则，旧单句使用候选ID。"""

    return tuple(CandidateMessage(candidate_id if index == 0 else uuid_factory(), text)
                 for index, text in enumerate(texts))


@dataclass(frozen=True, slots=True, repr=False)
class ReplyCandidate:
    """只在 NotAlone 内展示和编辑的候选回复。"""

    candidate_id: UUID
    text: str
    basis: str
    citation_ids: tuple[UUID, ...]
    risk_notes: tuple[str, ...]
    messages: tuple[CandidateMessage, ...] = ()

    @property
    def message_group(self) -> tuple[CandidateMessage, ...]:
        return self.messages or (CandidateMessage(self.candidate_id, self.text),)


@dataclass(frozen=True, slots=True)
class ReplyGenerated:
    """已经持久化、可以交给 UI 展示的候选结果。"""

    reply_request_id: UUID
    candidates: tuple[ReplyCandidate, ...]
    context_receipt: ContextReceipt
    used_skill: SkillUse | None
    input_budget: InputBudgetDecision | None = None


ReplyOutcome = ReplyGenerated
