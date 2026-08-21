"""ConversationPort 的合成适配器。"""

from __future__ import annotations

from collections.abc import Iterable
from uuid import UUID

from notalone.conversation.models import (
    ConversationBinding,
    ConversationBindingStatus,
    ConversationObservation,
    ConversationObservationState,
    ConversationResolution,
    VerificationReason,
)


class InMemoryConversationPort:
    """只用于合成测试和本地演示的会话绑定验证器。"""

    __slots__ = ("_bindings", "_observation")

    def __init__(
        self,
        *,
        bindings: Iterable[ConversationBinding],
        observation: ConversationObservation,
    ) -> None:
        binding_map: dict[UUID, ConversationBinding] = {}
        for binding in bindings:
            if binding.binding_id in binding_map:
                raise ValueError("会话绑定标识不能重复。")
            binding_map[binding.binding_id] = binding
        self._bindings = binding_map
        self._observation = observation

    def verify_current(self) -> ConversationResolution:
        observation = self._observation
        if observation.state is ConversationObservationState.FIRST_BINDING:
            return ConversationResolution.needs_user_confirmation(
                VerificationReason.FIRST_BINDING,
            )
        if observation.state is ConversationObservationState.CONVERSATION_CHANGED:
            return ConversationResolution.needs_user_confirmation(
                VerificationReason.CONVERSATION_CHANGED,
            )
        if observation.state is ConversationObservationState.AMBIGUOUS:
            return ConversationResolution.needs_user_confirmation(
                VerificationReason.AMBIGUOUS_MATCH,
            )
        if observation.state is ConversationObservationState.LOW_CONFIDENCE:
            return ConversationResolution.needs_user_confirmation(
                VerificationReason.LOW_CONFIDENCE,
            )
        if observation.state is ConversationObservationState.UNAVAILABLE:
            return ConversationResolution.rejected(
                VerificationReason.NO_ACTIVE_BINDING,
            )
        if observation.binding_id is None:
            return ConversationResolution.rejected(
                VerificationReason.NO_ACTIVE_BINDING,
            )

        binding = self._bindings.get(observation.binding_id)
        if binding is None:
            return ConversationResolution.rejected(
                VerificationReason.NO_ACTIVE_BINDING,
            )
        if binding.status is ConversationBindingStatus.REVOKED:
            return ConversationResolution.rejected(
                VerificationReason.BINDING_REVOKED,
            )
        return ConversationResolution.ready(binding.verified_scope())
