"""候选回复的共享应用层入口：会话验证、范围检查与生成编排。

回复请求统一经此服务进入 Reply 模块：先按联系人在既有绑定目录里
查 active 绑定（已绑定会话自动认出），再经会话验证端口确认范围，
最后才调用 ReplyPort 生成候选。任一环节失败都返回稳定 reason，
不触发任何外部发送能力。
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Callable, Protocol
from uuid import UUID

from notalone.conversation import (
    ConversationPort,
    ConversationResolution,
    ConversationResolutionState,
    VerificationReason,
)
from notalone.conversation.models import (
    ConversationBinding,
)
from notalone.reply import GenerateReply, ReplyOutcome
from notalone.reply.interface import (
    AutoSkill,
    InitiateConversation,
    NoSkill,
    ReplyToMessage,
    RewriteDraft,
    SuggestionReference,
    UserSkillChoice,
)
from notalone.scopes import ContactScope, VerifiedConversationScope

if TYPE_CHECKING:
    from notalone.application.reply_exploration import ReplyExplorationService


class ReplyPort(Protocol):
    """应用层调用 Reply 入口的框架无关边界。"""

    def prepare(self, command: GenerateReply, *, verified_scope: VerifiedConversationScope) -> None: ...

    def generate(
        self,
        command: GenerateReply,
        *,
        verified_scope: VerifiedConversationScope,
    ) -> ReplyOutcome: ...


@dataclass(frozen=True, slots=True)
class ReplyServiceResult:
    """回复请求的结果投影：拒绝时 reply 为 None、reason 为稳定码。"""

    reply: ReplyOutcome | None
    reason: str | None

    @property
    def rejected(self) -> bool:
        return self.reply is None


class ReplyService:
    """按已验证会话范围编排候选回复的薄服务。"""

    __slots__ = (
        "_binding_lookup",
        "_conversation_factory",
        "_reply",
        "_exploration",
        "_skill_review",
        "_manual_scope_lookup",
    )

    def __init__(
        self,
        *,
        binding_lookup: Callable[[UUID, UUID], ConversationBinding | None],
        conversation_factory: Callable[[ConversationBinding], ConversationPort],
        reply: ReplyPort,
        exploration: ReplyExplorationService | None = None,
        skill_review=None,
        manual_scope_lookup: Callable[[UUID, UUID], VerifiedConversationScope | None] | None = None,
    ) -> None:
        self._binding_lookup = binding_lookup
        self._conversation_factory = conversation_factory
        self._reply = reply
        self._exploration = exploration
        self._skill_review = skill_review
        self._manual_scope_lookup = manual_scope_lookup

    @property
    def skill_review(self):
        return self._skill_review

    @property
    def exploration(self) -> ReplyExplorationService | None:
        return self._exploration

    def generate(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        request: ReplyServiceRequest,
        prepare_only: bool = False,
    ) -> ReplyServiceResult:
        """按绑定目录解析真实会话范围后生成候选。"""

        if not isinstance(owner_id, UUID) or not isinstance(contact_id, UUID):
            raise TypeError("owner_id 与 contact_id 必须是 UUID。")
        if not isinstance(request, ReplyServiceRequest):
            raise TypeError("request 必须是 ReplyServiceRequest。")

        manual_scope = self._manual_scope_lookup(owner_id, contact_id) if self._manual_scope_lookup else None
        from notalone.application.manual_input_scope import manual_input_contact
        if manual_input_contact.get() is not None and manual_scope is None:
            return ReplyServiceResult(reply=None, reason="manual_contact_unconfirmed")
        binding = None if manual_scope else self._binding_lookup(owner_id, contact_id)
        if binding is None and manual_scope is None:
            # list_active_bindings 只返回 active 绑定：无绑定即不可用。
            return ReplyServiceResult(reply=None, reason="no_active_binding")

        try:
            command = request.build_command(
                owner_id=owner_id,
                contact_id=contact_id,
                binding_id=manual_scope.conversation_binding_id if manual_scope else binding.binding_id,
            )
        except (TypeError, ValueError):
            return ReplyServiceResult(reply=None, reason="invalid_reply_input")
        if command is None or not command.has_valid_content():
            return ReplyServiceResult(reply=None, reason="invalid_reply_input")

        verification = (ConversationResolution.ready(manual_scope) if manual_scope
                        else self._conversation_factory(binding).verify_current())
        if verification.state is not ConversationResolutionState.READY:
            return ReplyServiceResult(
                reply=None,
                reason=_reason_for(verification),
            )
        if verification.scope is None:
            return ReplyServiceResult(reply=None, reason="invalid_verification")
        if not command.matches_verified_scope(verification.scope):
            return ReplyServiceResult(reply=None, reason="scope_mismatch")
        if isinstance(command.content, (ReplyToMessage, InitiateConversation)):
            from notalone.reply.interface import DirectionSource

            intent = command.content.direction if isinstance(command.content, ReplyToMessage) else command.content.purpose
            if request.suggestion is not None and isinstance(request.suggestion.input_version, UUID):
                if self._exploration is None:
                    return ReplyServiceResult(reply=None, reason="suggestion_unconfirmed")
            elif intent.source is DirectionSource.CONFIRMED_SUGGESTION:
                return ReplyServiceResult(reply=None, reason="suggestion_unconfirmed")
            elif request.suggestion is not None:
                return ReplyServiceResult(reply=None, reason="invalid_reply_input")
        # 生成阶段的异常（含持久层/基础设施故障）不折叠为业务拒绝：
        # 由调用方映射为 5xx，避免把服务端故障伪装成客户端冲突。
        if prepare_only:
            self._reply.prepare(command=command, verified_scope=verification.scope)
            return ReplyServiceResult(reply=None, reason=None)
        outcome = self._reply.generate(
            command=command,
            verified_scope=verification.scope,
        )
        if outcome is None:
            return ReplyServiceResult(reply=None, reason="no_reply_outcome")
        return ReplyServiceResult(reply=outcome, reason=None)


@dataclass(frozen=True, slots=True)
class ReplyServiceRequest:
    """应用层回复请求：由解析器产出，绑定解析在服务层完成。"""

    idempotency_key: UUID
    content: ReplyToMessage | RewriteDraft | InitiateConversation
    continued_from_candidate_id: UUID | None = None
    skill_version_id: UUID | None = None
    skill_disabled: bool = False
    expected_input_version_id: UUID | None = None
    suggestion: SuggestionReference | None = None
    scene: str | None = None

    def build_command(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
    ) -> GenerateReply | None:
        """按服务解析出的真实范围构造 GenerateReply。"""

        if not isinstance(binding_id, UUID):
            return None
        if self.skill_disabled and self.skill_version_id is not None:
            return None
        if self.suggestion is not None and (
            not isinstance(self.suggestion, SuggestionReference)
            or not isinstance(self.suggestion.input_version, UUID)
        ):
            return None
        content = self.content
        if isinstance(content, (ReplyToMessage, InitiateConversation)):
            from notalone.reply.interface import DirectionSource

            intent = content.direction if isinstance(content, ReplyToMessage) else content.purpose
            if intent.source is DirectionSource.CONFIRMED_SUGGESTION and self.suggestion is None:
                return None
        skill: AutoSkill | UserSkillChoice | NoSkill = NoSkill() if self.skill_disabled else AutoSkill()
        if self.skill_version_id is not None:
            skill = UserSkillChoice(version_id=self.skill_version_id)
        if isinstance(content, ReplyToMessage) and self.suggestion is not None:
            content = replace(content, direction=replace(content.direction, suggestion=self.suggestion))
        elif isinstance(content, InitiateConversation) and self.suggestion is not None:
            content = replace(content, purpose=replace(content.purpose, suggestion=self.suggestion))
        return GenerateReply(
            idempotency_key=self.idempotency_key,
            scope=ContactScope(owner_id=owner_id, contact_id=contact_id),
            conversation_binding_id=binding_id,
            content=content,
            continued_from_candidate_id=self.continued_from_candidate_id,
            skill=skill,
            scene=self.scene,
        )


def _reason_for(verification: ConversationResolution) -> str:
    """把会话验证结果映射为稳定 reason 码。"""

    reason = verification.reason
    if reason is None:
        return "not_verified"
    mapping = {
        VerificationReason.FIRST_BINDING: "binding_unconfirmed",
        VerificationReason.CONVERSATION_CHANGED: "conversation_changed",
        VerificationReason.AMBIGUOUS_MATCH: "ambiguous_binding",
        VerificationReason.LOW_CONFIDENCE: "binding_low_confidence",
        VerificationReason.NO_ACTIVE_BINDING: "no_active_binding",
        VerificationReason.BINDING_REVOKED: "binding_revoked",
        VerificationReason.MISSING_REPLY_INPUT: "missing_reply_input",
        VerificationReason.INVALID_REPLY_INPUT: "invalid_reply_input",
        VerificationReason.SCOPE_MISMATCH: "scope_mismatch",
        VerificationReason.VERIFICATION_UNAVAILABLE: "verification_unavailable",
        VerificationReason.INVALID_VERIFICATION_RESULT: "invalid_verification",
    }
    return mapping.get(reason, reason.value)
