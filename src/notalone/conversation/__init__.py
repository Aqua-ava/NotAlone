"""联系人会话绑定与验证 Module。"""

from notalone.conversation.adapters import InMemoryConversationPort
from notalone.conversation.matcher import (
    BindingMatchDecision,
    BindingMatchKind,
    BindingMatchReason,
    FrontSessionEvidence,
    StoredBindingEvidence,
    match_front_session,
    normalize_display_text,
    summarize_evidence,
)
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
    "BindingMatchDecision",
    "BindingMatchKind",
    "BindingMatchReason",
    "ConversationPort",
    "ConversationBinding",
    "ConversationBindingStatus",
    "ConversationObservation",
    "ConversationObservationState",
    "ConversationResolution",
    "ConversationResolutionState",
    "FrontSessionEvidence",
    "InMemoryConversationPort",
    "StoredBindingEvidence",
    "VerificationReason",
    "match_front_session",
    "normalize_display_text",
    "summarize_evidence",
]
