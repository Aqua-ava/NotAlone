"""回复服务的参数门禁与范围拒绝测试；不连接数据库。"""

from __future__ import annotations

import unittest
from types import SimpleNamespace
from uuid import UUID, uuid4

from notalone.application.reply_service import (
    ReplyService,
    ReplyServiceRequest,
)
from notalone.conversation.models import (
    ConversationBinding,
    ConversationBindingStatus,
    ConversationObservation,
    ConversationObservationState,
    ConversationResolution,
    VerificationReason,
)
from notalone.reply.interface import (
    ConfirmedDirection,
    ContextReceipt,
    DirectionSource,
    ReplyGenerated,
    ReplyToMessage,
)
from notalone.scopes import ContactScope, VerifiedConversationScope


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
CONTACT_ID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
BINDING_ID = UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
MESSAGE_ID = UUID("cccccccc-cccc-cccc-cccc-cccccccccccc")


def _binding(*, status: ConversationBindingStatus = ConversationBindingStatus.ACTIVE) -> ConversationBinding:
    return ConversationBinding(
        binding_id=BINDING_ID,
        scope=ContactScope(owner_id=OWNER_ID, contact_id=CONTACT_ID),
        status=status,
    )


def _request() -> ReplyServiceRequest:
    return ReplyServiceRequest(
        idempotency_key=uuid4(),
        content=ReplyToMessage(
            target_message_id=MESSAGE_ID,
            direction=ConfirmedDirection(
                text="自然地答应",
                source=DirectionSource.DIRECT_INPUT,
            ),
        ),
    )


class FakeConversationPort:
    def __init__(self, resolution: ConversationResolution) -> None:
        self.resolution = resolution

    def verify_current(self) -> ConversationResolution:
        return self.resolution


class FakeReplyPort:
    def __init__(self) -> None:
        self.calls = 0
        self.outcome: ReplyGenerated | None = None
        self.last_command = None

    def generate(self, command, verified_scope):
        self.calls += 1
        self.last_command = command
        return self.outcome


class ReplyServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.reply = FakeReplyPort()
        self.service = ReplyService(
            binding_lookup=lambda owner_id, contact_id: self.binding,
            conversation_factory=lambda binding: self.conversation,
            reply=self.reply,
        )
        self.binding: ConversationBinding | None = _binding()
        self.conversation = FakeConversationPort(
            ConversationResolution.ready(
                VerifiedConversationScope(
                    owner_id=OWNER_ID,
                    contact_id=CONTACT_ID,
                    conversation_binding_id=BINDING_ID,
                )
            )
        )
        self.reply.outcome = ReplyGenerated(
            reply_request_id=uuid4(),
            candidates=(),
            context_receipt=ContextReceipt(evidence_ids=()),
            used_skill=None,
        )

    def test_generates_when_binding_and_scope_ready(self) -> None:
        result = self.service.generate(
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
            request=_request(),
        )

        self.assertFalse(result.rejected)
        self.assertEqual(self.reply.calls, 1)

    def test_rejects_when_no_active_binding(self) -> None:
        self.binding = None

        result = self.service.generate(
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
            request=_request(),
        )

        self.assertTrue(result.rejected)
        self.assertEqual(result.reason, "no_active_binding")
        self.assertEqual(self.reply.calls, 0)

    def test_service_only_accepts_lookup_resolved_binding(self) -> None:
        # 绑定状态由 binding_lookup 决定（生产 lookup 只返回 active）；
        # 服务层不重复检查状态。
        self.binding = _binding(status=ConversationBindingStatus.REVOKED)

        result = self.service.generate(
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
            request=_request(),
        )

        self.assertFalse(result.rejected)
        self.assertEqual(self.reply.calls, 1)

    def test_rejects_when_conversation_not_verified(self) -> None:
        self.conversation = FakeConversationPort(
            ConversationResolution.rejected(
                VerificationReason.NO_ACTIVE_BINDING,
            )
        )

        result = self.service.generate(
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
            request=_request(),
        )

        self.assertTrue(result.rejected)
        self.assertEqual(result.reason, "no_active_binding")
        self.assertEqual(self.reply.calls, 0)

    def test_rejects_non_generate_input_types(self) -> None:
        with self.assertRaises(TypeError):
            self.service.generate(
                owner_id=OWNER_ID,
                contact_id=CONTACT_ID,
                request=object(),
            )

    def test_generation_failure_propagates_not_folded(self) -> None:
        def failing_reply(command, verified_scope):
            raise RuntimeError("持久层故障")

        service = ReplyService(
            binding_lookup=lambda owner_id, contact_id: self.binding,
            conversation_factory=lambda binding: self.conversation,
            reply=SimpleNamespace(generate=failing_reply),
        )

        with self.assertRaises(RuntimeError):
            service.generate(
                owner_id=OWNER_ID,
                contact_id=CONTACT_ID,
                request=_request(),
            )

    def test_passes_user_skill_choice_to_command(self) -> None:
        from notalone.reply.interface import UserSkillChoice

        skill_version = uuid4()

        result = self.service.generate(
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
            request=ReplyServiceRequest(
                idempotency_key=uuid4(),
                content=ReplyToMessage(
                    target_message_id=MESSAGE_ID,
                    direction=ConfirmedDirection(
                        text="自然地答应",
                        source=DirectionSource.DIRECT_INPUT,
                    ),
                ),
                skill_version_id=skill_version,
            ),
        )

        self.assertFalse(result.rejected)
        self.assertIsNotNone(self.reply.last_command)
        self.assertEqual(
            self.reply.last_command.skill,
            UserSkillChoice(version_id=skill_version),
        )

    def test_rejects_invalid_arguments(self) -> None:
        with self.assertRaises(TypeError):
            self.service.generate(owner_id="bad", contact_id=CONTACT_ID, request=_request())
        with self.assertRaises(TypeError):
            self.service.generate(owner_id=OWNER_ID, contact_id=CONTACT_ID, request=object())


if __name__ == "__main__":
    unittest.main()