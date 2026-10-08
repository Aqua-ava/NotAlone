"""通过应用层公共 seam 验证联系人与会话范围。"""

from __future__ import annotations

import unittest
from dataclasses import dataclass, replace
from uuid import UUID
from typing import cast

from notalone.application import CandidateReplyFlow
from notalone.conversation import (
    ConversationBinding,
    ConversationBindingStatus,
    ConversationObservation,
    ConversationObservationState,
    ConversationResolution,
    ConversationResolutionState,
    InMemoryConversationPort,
    VerificationReason,
)
from notalone.reply import (
    ConfirmedDirection,
    DirectionSource,
    GenerateReply,
    ReplyOutcome,
    ReplyToMessage,
)
from notalone.scopes import ContactScope, VerifiedConversationScope


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
CONTACT_ID = UUID("22222222-2222-2222-2222-222222222222")
BINDING_ID = UUID("33333333-3333-3333-3333-333333333333")
MESSAGE_ID = UUID("44444444-4444-4444-4444-444444444444")
REQUEST_KEY = UUID("55555555-5555-5555-5555-555555555555")


@dataclass
class RecordingConversationPort:
    resolution: ConversationResolution
    calls: int = 0

    def verify_current(self) -> ConversationResolution:
        self.calls += 1
        return self.resolution


@dataclass
class RecordingReplyPort:
    outcome: ReplyOutcome = cast(ReplyOutcome, "合成候选")
    command: GenerateReply | None = None
    verified_scope: VerifiedConversationScope | None = None
    calls: int = 0

    def generate(
        self,
        *,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
    ) -> ReplyOutcome:
        self.calls += 1
        self.command = command
        self.verified_scope = verified_scope
        return self.outcome


class CandidateReplyFlowTest(unittest.TestCase):
    @staticmethod
    def _reply_command(
        *,
        scope: ContactScope | None = None,
        conversation_binding_id: UUID = BINDING_ID,
    ) -> GenerateReply:
        return GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope or ContactScope(OWNER_ID, CONTACT_ID),
            conversation_binding_id=conversation_binding_id,
            content=ReplyToMessage(
                target_message_id=MESSAGE_ID,
                direction=ConfirmedDirection(
                    text="自然地回复",
                    source=DirectionSource.DIRECT_INPUT,
                ),
            ),
        )

    def test_active_in_memory_binding_returns_ready_scope(self) -> None:
        binding = ConversationBinding(
            binding_id=BINDING_ID,
            scope=ContactScope(OWNER_ID, CONTACT_ID),
            status=ConversationBindingStatus.ACTIVE,
        )
        conversation = InMemoryConversationPort(
            bindings=(binding,),
            observation=ConversationObservation.confirmed(BINDING_ID),
        )

        result = CandidateReplyFlow(conversation=conversation).resolve_current_scope()

        self.assertEqual(result.state, ConversationResolutionState.READY)
        self.assertEqual(
            result.scope,
            VerifiedConversationScope(OWNER_ID, CONTACT_ID, BINDING_ID),
        )

    def test_ready_enters_reply_with_verified_scope(self) -> None:
        scope = VerifiedConversationScope(OWNER_ID, CONTACT_ID, BINDING_ID)
        conversation = RecordingConversationPort(ConversationResolution.ready(scope))
        reply = RecordingReplyPort()
        command = self._reply_command()

        result = CandidateReplyFlow(conversation=conversation).execute(
            reply=reply,
            command=command,
        )

        self.assertEqual(result.verification.state, ConversationResolutionState.READY)
        self.assertEqual(result.reply, "合成候选")
        self.assertIs(reply.command, command)
        self.assertEqual(reply.verified_scope, scope)
        self.assertEqual(reply.calls, 1)

    def test_ready_rejects_unverified_scope_type(self) -> None:
        with self.assertRaisesRegex(ValueError, "Ready"):
            ConversationResolution(
                state=ConversationResolutionState.READY,
                scope=ContactScope(OWNER_ID, CONTACT_ID),  # type: ignore[arg-type]
                reason=VerificationReason.ACTIVE_BINDING,
            )

    def test_non_ready_does_not_enter_reply(self) -> None:
        conversation = RecordingConversationPort(
            ConversationResolution.needs_user_confirmation(
                VerificationReason.AMBIGUOUS_MATCH,
            ),
        )
        reply = RecordingReplyPort()

        result = CandidateReplyFlow(conversation=conversation).execute(
            reply=reply,
            command=self._reply_command(),
        )

        self.assertEqual(
            result.verification.state,
            ConversationResolutionState.NEEDS_USER_CONFIRMATION,
        )
        self.assertIsNone(result.reply)
        self.assertEqual(reply.calls, 0)

    def test_scope_mismatch_is_rejected_before_reply(self) -> None:
        scope = VerifiedConversationScope(OWNER_ID, CONTACT_ID, BINDING_ID)
        conversation = RecordingConversationPort(ConversationResolution.ready(scope))
        reply = RecordingReplyPort()
        command = self._reply_command(
            scope=ContactScope(OWNER_ID, UUID("22222222-2222-2222-2222-333333333333")),
        )

        result = CandidateReplyFlow(conversation=conversation).execute(
            reply=reply,
            command=command,
        )

        self.assertEqual(result.verification.state, ConversationResolutionState.REJECTED)
        self.assertEqual(result.verification.reason, VerificationReason.SCOPE_MISMATCH)
        self.assertIsNone(result.reply)
        self.assertEqual(reply.calls, 0)

    def test_invalid_reply_fields_are_rejected_before_reply(self) -> None:
        scope = VerifiedConversationScope(OWNER_ID, CONTACT_ID, BINDING_ID)
        conversation = RecordingConversationPort(ConversationResolution.ready(scope))

        invalid_commands = (
            replace(self._reply_command(), idempotency_key="不是 UUID"),
            replace(self._reply_command(), content="不是 ReplyToMessage"),
            replace(
                self._reply_command(),
                content=ReplyToMessage(
                    target_message_id="不是 UUID",
                    direction=ConfirmedDirection(
                        text="自然地回复",
                        source=DirectionSource.DIRECT_INPUT,
                    ),
                ),
            ),
        )
        for command in invalid_commands:
            with self.subTest(command=command):
                reply = RecordingReplyPort()
                result = CandidateReplyFlow(
                    conversation=conversation,
                ).execute(reply=reply, command=command)

                self.assertEqual(
                    result.verification.reason,
                    VerificationReason.INVALID_REPLY_INPUT,
                )
                self.assertIsNone(result.reply)
                self.assertEqual(reply.calls, 0)

    def test_missing_reply_input_is_rejected_before_conversation_check(self) -> None:
        conversation = RecordingConversationPort(
            ConversationResolution.ready(
                VerifiedConversationScope(OWNER_ID, CONTACT_ID, BINDING_ID),
            ),
        )
        reply = RecordingReplyPort()

        result = CandidateReplyFlow(conversation=conversation).execute(
            reply=reply,
            command=None,
        )

        self.assertEqual(result.verification.state, ConversationResolutionState.REJECTED)
        self.assertEqual(
            result.verification.reason,
            VerificationReason.MISSING_REPLY_INPUT,
        )
        self.assertEqual(conversation.calls, 0)
        self.assertEqual(reply.calls, 0)

    def test_revoked_in_memory_binding_is_rejected(self) -> None:
        binding = ConversationBinding(
            binding_id=BINDING_ID,
            scope=ContactScope(OWNER_ID, CONTACT_ID),
            status=ConversationBindingStatus.REVOKED,
        )
        conversation = InMemoryConversationPort(
            bindings=(binding,),
            observation=ConversationObservation.confirmed(BINDING_ID),
        )

        result = CandidateReplyFlow(conversation=conversation).resolve_current_scope()

        self.assertEqual(result.state, ConversationResolutionState.REJECTED)
        self.assertEqual(result.reason, VerificationReason.BINDING_REVOKED)

    def test_unknown_in_memory_binding_is_rejected(self) -> None:
        conversation = InMemoryConversationPort(
            bindings=(),
            observation=ConversationObservation.confirmed(BINDING_ID),
        )

        result = CandidateReplyFlow(conversation=conversation).resolve_current_scope()

        self.assertEqual(result.state, ConversationResolutionState.REJECTED)
        self.assertEqual(result.reason, VerificationReason.NO_ACTIVE_BINDING)

    def test_unresolved_in_memory_observation_requires_confirmation(self) -> None:
        conversation = InMemoryConversationPort(
            bindings=(),
            observation=ConversationObservation(
                state=ConversationObservationState.AMBIGUOUS,
                binding_id=None,
            ),
        )

        result = CandidateReplyFlow(conversation=conversation).resolve_current_scope()

        self.assertEqual(
            result.state,
            ConversationResolutionState.NEEDS_USER_CONFIRMATION,
        )
        self.assertEqual(result.reason, VerificationReason.AMBIGUOUS_MATCH)

    def test_active_binding_returns_ready_verified_scope(self) -> None:
        scope = VerifiedConversationScope(
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
            conversation_binding_id=BINDING_ID,
        )
        conversation = RecordingConversationPort(
            ConversationResolution.ready(scope),
        )

        result = CandidateReplyFlow(conversation=conversation).resolve_current_scope()

        self.assertEqual(result.state, ConversationResolutionState.READY)
        self.assertEqual(result.scope, scope)
        self.assertEqual(result.reason, VerificationReason.ACTIVE_BINDING)
        self.assertEqual(conversation.calls, 1)

    def test_uncertain_binding_requires_user_confirmation(self) -> None:
        for reason in (
            VerificationReason.FIRST_BINDING,
            VerificationReason.CONVERSATION_CHANGED,
            VerificationReason.AMBIGUOUS_MATCH,
            VerificationReason.LOW_CONFIDENCE,
        ):
            with self.subTest(reason=reason):
                conversation = RecordingConversationPort(
                    ConversationResolution.needs_user_confirmation(reason),
                )

                result = CandidateReplyFlow(
                    conversation=conversation,
                ).resolve_current_scope()

                self.assertEqual(
                    result.state,
                    ConversationResolutionState.NEEDS_USER_CONFIRMATION,
                )
                self.assertIsNone(result.scope)
                self.assertEqual(result.reason, reason)

    def test_revoked_or_unavailable_binding_is_rejected(self) -> None:
        for reason in (
            VerificationReason.BINDING_REVOKED,
            VerificationReason.NO_ACTIVE_BINDING,
        ):
            with self.subTest(reason=reason):
                conversation = RecordingConversationPort(
                    ConversationResolution.rejected(reason),
                )

                result = CandidateReplyFlow(
                    conversation=conversation,
                ).resolve_current_scope()

                self.assertEqual(result.state, ConversationResolutionState.REJECTED)
                self.assertIsNone(result.scope)
                self.assertEqual(result.reason, reason)

    def test_verification_failure_fails_closed(self) -> None:
        class FailingConversationPort:
            def verify_current(self) -> ConversationResolution:
                raise RuntimeError("private desktop/session detail")

        result = CandidateReplyFlow(
            conversation=FailingConversationPort(),
        ).resolve_current_scope()

        self.assertEqual(result.state, ConversationResolutionState.REJECTED)
        self.assertIsNone(result.scope)
        self.assertEqual(
            result.reason,
            VerificationReason.VERIFICATION_UNAVAILABLE,
        )


if __name__ == "__main__":
    unittest.main()
