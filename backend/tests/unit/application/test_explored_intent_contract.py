"""共享引用只携带身份；A/B仍核验实际选择、来源和当前输入。"""

import unittest
from uuid import uuid4

from notalone.application.reply_service import ReplyServiceRequest
from notalone.reply.interface import ConfirmedDirection, DirectionSource, InitiateConversation, ReplyToMessage, SuggestionReference


class ExploredIntentContractTest(unittest.TestCase):
    def test_both_scenes_keep_actual_reference_and_single_use_fields(self):
        reference = SuggestionReference(uuid4(), uuid4(), uuid4())
        for source in DirectionSource:
            intent = ConfirmedDirection("只了解近况。", source)
            for content in (ReplyToMessage(uuid4(), intent, user_instruction="保持简短。"),
                            InitiateConversation(intent, user_instruction="保持简短。")):
                command = ReplyServiceRequest(uuid4(), content, suggestion=reference).build_command(
                    owner_id=uuid4(), contact_id=uuid4(), binding_id=uuid4(),
                )
                actual = command.content.direction if isinstance(content, ReplyToMessage) else command.content.purpose
                self.assertEqual(actual.suggestion, reference)
                self.assertEqual(actual.text, intent.text)
                self.assertEqual(actual.source, source)
                self.assertEqual(command.content.user_instruction, "保持简短。")

    def test_reference_rejects_invalid_identity_and_boolean_version(self):
        for values in (("bad", uuid4(), uuid4()), (uuid4(), True, uuid4()), (uuid4(), -1, uuid4()),
                       (uuid4(), uuid4(), "bad")):
            with self.subTest(values=values), self.assertRaises(ValueError):
                SuggestionReference(*values)

    def test_integer_compatibility_cannot_represent_direct_exploration_confirmation(self):
        with self.assertRaises(ValueError):
            ConfirmedDirection("只了解近况。", DirectionSource.DIRECT_INPUT, SuggestionReference(uuid4(), 1, uuid4()))
