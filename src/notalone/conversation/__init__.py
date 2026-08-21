"""联系人会话绑定与验证 Module。"""

from notalone.conversation.adapters import InMemoryConversationPort
from notalone.conversation.models import (
    ConversationBinding,
    ConversationBindingStatus,
    ConversationObservation,
    ConversationObservationState,
    ConversationResolution,
    ConversationResolutionState,
    VerificationReason,
)
from notalone.conversation.ports import ConversationPort

__all__ = [
    "ConversationPort",
    "ConversationBinding",
    "ConversationBindingStatus",
    "ConversationObservation",
    "ConversationObservationState",
    "ConversationResolution",
    "ConversationResolutionState",
    "InMemoryConversationPort",
    "VerificationReason",
]
