"""公开的持续要求命令不能绕过展示身份的结构验证。"""

import unittest
from uuid import uuid4

from notalone.application.assistant_continuation import (
    AssistantContinuationClarification, AssistantContinuationInvalid, ContinueAssistantSession,
    continuation_reference, continuation_submission,
)


class AssistantContinuationCommandTest(unittest.TestCase):
    def test_typed_call_without_display_frame_is_a_safe_invalid_command(self):
        command = ContinueAssistantSession(uuid4(), uuid4(), "第二条自然一点", None)  # type: ignore[arg-type]
        with self.assertRaises(AssistantContinuationInvalid):
            continuation_submission(command)

    def test_unsupported_ordinal_asks_for_a_candidate_instead_of_becoming_a_requirement(self):
        with self.assertRaises(AssistantContinuationClarification):
            continuation_reference("第两条自然一点")


if __name__ == "__main__":
    unittest.main()


class HistoryContinuationConsentTest(unittest.TestCase):
    def test_new_continuation_carries_its_own_explicit_history_confirmation(self):
        from notalone.application.assistant_continuation import parse_continuation, continuation_submission
        payload = {"idempotency_key": str(uuid4()), "expected_input_version_id": str(uuid4()),
            "instruction": "简短一点", "displayed_group": {"session_id": str(uuid4()),
                "candidate_group_id": str(uuid4()), "candidates": []}, "allow_incomplete_history": True}
        command = parse_continuation(payload)
        self.assertTrue(command.allow_incomplete_history)
        self.assertEqual(continuation_submission(command), payload)
