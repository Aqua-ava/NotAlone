"""会话验证的领域结果。"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from uuid import UUID

from notalone.scopes import ContactScope, VerifiedConversationScope


class ConversationBindingStatus(StrEnum):
    """会话绑定是否仍可用于联系人验证。"""

    ACTIVE = "active"
    REVOKED = "revoked"


class ConversationObservationState(StrEnum):
    """外部会话适配器对当前可见会话的最小判断。"""

    CONFIRMED = "confirmed"
    FIRST_BINDING = "first_binding"
    CONVERSATION_CHANGED = "conversation_changed"
    AMBIGUOUS = "ambiguous"
    LOW_CONFIDENCE = "low_confidence"
    UNAVAILABLE = "unavailable"


@dataclass(frozen=True, slots=True)
class ConversationBinding:
    """用户确认过的会话到联系人范围的绑定记录。"""

    binding_id: UUID
    scope: ContactScope
    status: ConversationBindingStatus

    def __post_init__(self) -> None:
        if not isinstance(self.binding_id, UUID):
            raise TypeError("conversation_binding_id 必须是 UUID。")
        if not isinstance(self.scope, ContactScope):
            raise TypeError("会话绑定必须携带 ContactScope。")
        if not isinstance(self.status, ConversationBindingStatus):
            raise TypeError("会话绑定状态无效。")

    def verified_scope(self) -> VerifiedConversationScope:
        """把已由调用方确认状态的绑定转换为 Reply 可用范围。"""

        return VerifiedConversationScope(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            conversation_binding_id=self.binding_id,
        )


@dataclass(frozen=True, slots=True)
class ConversationObservation:
    """当前会话适配器提供的最小、非内容型观察结果。"""

    state: ConversationObservationState
    binding_id: UUID | None

    def __post_init__(self) -> None:
        if not isinstance(self.state, ConversationObservationState):
            raise TypeError("会话观察状态无效。")
        if self.binding_id is not None and not isinstance(self.binding_id, UUID):
            raise TypeError("binding_id 必须是 UUID 或 None。")
        if self.state is ConversationObservationState.CONFIRMED:
            if self.binding_id is None:
                raise ValueError("已确认会话必须包含 binding_id。")

    @classmethod
    def confirmed(cls, binding_id: UUID) -> "ConversationObservation":
        return cls(
            state=ConversationObservationState.CONFIRMED,
            binding_id=binding_id,
        )


class ConversationResolutionState(StrEnum):
    """外层候选回复流程的会话验证结果。"""

    READY = "Ready"
    NEEDS_USER_CONFIRMATION = "NeedsUserConfirmation"
    REJECTED = "Rejected"


class VerificationReason(StrEnum):
    """不会泄漏会话内容的稳定验证原因。"""

    ACTIVE_BINDING = "active_binding"
    FIRST_BINDING = "first_binding"
    CONVERSATION_CHANGED = "conversation_changed"
    AMBIGUOUS_MATCH = "ambiguous_match"
    LOW_CONFIDENCE = "low_confidence"
    BINDING_REVOKED = "binding_revoked"
    NO_ACTIVE_BINDING = "no_active_binding"
    SCOPE_MISMATCH = "scope_mismatch"
    MISSING_REPLY_INPUT = "missing_reply_input"
    INVALID_REPLY_INPUT = "invalid_reply_input"
    VERIFICATION_UNAVAILABLE = "verification_unavailable"
    INVALID_VERIFICATION_RESULT = "invalid_verification_result"


_CONFIRMATION_REASONS = frozenset(
    {
        VerificationReason.FIRST_BINDING,
        VerificationReason.CONVERSATION_CHANGED,
        VerificationReason.AMBIGUOUS_MATCH,
        VerificationReason.LOW_CONFIDENCE,
    },
)
_REJECTION_REASONS = frozenset(
    {
        VerificationReason.BINDING_REVOKED,
        VerificationReason.NO_ACTIVE_BINDING,
        VerificationReason.SCOPE_MISMATCH,
        VerificationReason.MISSING_REPLY_INPUT,
        VerificationReason.INVALID_REPLY_INPUT,
        VerificationReason.VERIFICATION_UNAVAILABLE,
        VerificationReason.INVALID_VERIFICATION_RESULT,
    },
)


@dataclass(frozen=True, slots=True)
class ConversationResolution:
    """ConversationPort 返回给应用层的安全验证结果。"""

    state: ConversationResolutionState
    scope: VerifiedConversationScope | None
    reason: VerificationReason

    def __post_init__(self) -> None:
        if not isinstance(self.state, ConversationResolutionState):
            raise TypeError("会话验证状态无效。")
        if not isinstance(self.reason, VerificationReason):
            raise TypeError("会话验证原因无效。")
        if self.state is ConversationResolutionState.READY:
            if (
                not isinstance(self.scope, VerifiedConversationScope)
                or self.reason is not VerificationReason.ACTIVE_BINDING
            ):
                raise ValueError("Ready 必须包含有效绑定范围。")
        elif self.scope is not None:
            raise ValueError("未 Ready 的结果不能携带联系人范围。")
        elif self.state is ConversationResolutionState.NEEDS_USER_CONFIRMATION:
            if self.reason not in _CONFIRMATION_REASONS:
                raise ValueError("确认状态的原因无效。")
        elif self.reason not in _REJECTION_REASONS:
            raise ValueError("拒绝状态的原因无效。")

    @classmethod
    def ready(cls, scope: VerifiedConversationScope) -> "ConversationResolution":
        return cls(
            state=ConversationResolutionState.READY,
            scope=scope,
            reason=VerificationReason.ACTIVE_BINDING,
        )

    @classmethod
    def needs_user_confirmation(
        cls,
        reason: VerificationReason,
    ) -> "ConversationResolution":
        return cls(
            state=ConversationResolutionState.NEEDS_USER_CONFIRMATION,
            scope=None,
            reason=reason,
        )

    @classmethod
    def rejected(cls, reason: VerificationReason) -> "ConversationResolution":
        return cls(
            state=ConversationResolutionState.REJECTED,
            scope=None,
            reason=reason,
        )
