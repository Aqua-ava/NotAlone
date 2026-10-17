"""固定准备复原兼容两种权威提交身份，损坏版本仍关闭执行。"""

import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.application.assistant_continuation_identity import (
    AssistantContinuationInvalid, AssistantContinuationReplyRequest,
)
from notalone.application.reply_service import ReplyServiceRequest
from notalone.persistence.assistant_continuation import restore_prepared_reply_request
from notalone.reply.interface import RewriteDraft
from notalone.scopes import ContactScope


class PreparedContinuationRestoreTest(unittest.TestCase):
    def setUp(self):
        self.scope = ContactScope(uuid4(), uuid4())
        self.key, self.session, self.version = uuid4(), uuid4(), uuid4()
        self.request = ReplyServiceRequest(idempotency_key=self.key, content=RewriteDraft("合成草稿"))

    def restore(self, submission):
        metadata = {"submission": submission, "candidate_id": None}
        with patch("notalone.persistence.assistant_continuation._request_from_input", return_value=self.request):
            return restore_prepared_reply_request(object(), self.scope, self.session, self.key,
                                                  {"continuation": metadata})

    def test_normal_continuation_retains_expected_version(self):
        restored = self.restore({"expected_input_version_id": str(self.version)})
        self.assertIsInstance(restored, AssistantContinuationReplyRequest)
        self.assertEqual(restored.expected_input_version_id, self.version)
        self.assertEqual(restored.content, self.request.content)

    def test_interrupted_recovery_restores_original_version_and_typed_identity(self):
        submission = {"original_turn_id": str(uuid4()), "original_input_version_id": str(self.version)}
        restored = self.restore(submission)
        self.assertIsInstance(restored, AssistantContinuationReplyRequest)
        self.assertEqual(restored.expected_input_version_id, self.version)
        self.assertEqual(restored.continuation["submission"], submission)
        self.assertIsNone(restored.reference)

    def test_invalid_expected_version_cannot_fall_back_to_recovery_version(self):
        for submission in ({}, None, {"original_input_version_id": "bad"},
                           {"expected_input_version_id": "", "original_input_version_id": str(self.version)}):
            with self.subTest(submission=submission), self.assertRaises(AssistantContinuationInvalid):
                self.restore(submission)
