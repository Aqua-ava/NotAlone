"""候选回复进入 Reply 前的联系人与会话验证流程。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from notalone.conversation import (
    ConversationPort,
    ConversationResolution,
    ConversationResolutionState,
    VerificationReason,
)
from notalone.reply import (
    GenerateReply,
    ReplyOutcome,
)
from notalone.scopes import ContactScope, VerifiedConversationScope


class ReplyPort(Protocol):
    """应用层调用现有 Reply 入口的最小、框架无关边界。"""

    def generate(
        self,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
    ) -> ReplyOutcome:
        """在已验证范围内生成候选结果。"""


@dataclass(frozen=True, slots=True)
class CandidateReplyFlowResult:
    """外层验证结果和可选 Reply 输出。"""

    verification: ConversationResolution
    reply: ReplyOutcome | None


class CandidateReplyFlow:
    """只负责把当前会话验证结果交给后续候选回复流程。"""

    __slots__ = ("_conversation",)

    def __init__(self, *, conversation: ConversationPort) -> None:
        self._conversation = conversation

    def resolve_current_scope(self) -> ConversationResolution:
        """验证当前会话；任何适配器异常都安全收敛为拒绝。"""

        try:
            resolution = self._conversation.verify_current()
        except Exception:
            return ConversationResolution.rejected(
                VerificationReason.VERIFICATION_UNAVAILABLE,
            )
        if not isinstance(resolution, ConversationResolution):
            return ConversationResolution.rejected(
                VerificationReason.INVALID_VERIFICATION_RESULT,
            )
        return resolution

    def execute(
        self,
        *,
        reply: ReplyPort,
        command: GenerateReply | None,
    ) -> CandidateReplyFlowResult:
        """只有 Ready 才调用 Reply；其他状态直接返回且不触发下游。"""

        if command is None:
            return self._rejected_result(VerificationReason.MISSING_REPLY_INPUT)

        verification = self.resolve_current_scope()
        if verification.state is not ConversationResolutionState.READY:
            return CandidateReplyFlowResult(
                verification=verification,
                reply=None,
            )
        if verification.scope is None:
            invalid = ConversationResolution.rejected(
                VerificationReason.INVALID_VERIFICATION_RESULT,
            )
            return CandidateReplyFlowResult(verification=invalid, reply=None)
        if not self._is_valid_command(command):
            return self._rejected_result(VerificationReason.INVALID_REPLY_INPUT)
        if not command.matches_verified_scope(verification.scope):
            return self._rejected_result(VerificationReason.SCOPE_MISMATCH)
        return CandidateReplyFlowResult(
            verification=verification,
            reply=reply.generate(
                command=command,
                verified_scope=verification.scope,
            ),
        )

    @staticmethod
    def _is_valid_command(command: object) -> bool:
        return (
            isinstance(command, GenerateReply)
            and isinstance(command.idempotency_key, UUID)
            and isinstance(command.scope, ContactScope)
            and isinstance(command.conversation_binding_id, UUID)
            and command.has_valid_content()
        )

    @staticmethod
    def _rejected_result(
        reason: VerificationReason,
    ) -> CandidateReplyFlowResult:
        return CandidateReplyFlowResult(
            verification=ConversationResolution.rejected(reason),
            reply=None,
        )
