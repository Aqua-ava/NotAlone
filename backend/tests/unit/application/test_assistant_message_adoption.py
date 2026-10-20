"""采用新消息具名声明沿工作区合同，不接受伪造继承要求。"""

import json
import unittest
from uuid import uuid4

from notalone.application.assistant_message_adoption import (
    AssistantMessageAdoptionRequest, parse_assistant_reply_request,
)
from notalone.application.reply_request import ReplyRequestInvalid
from notalone.reply.interface import RewriteDraft


class AssistantWorkspaceMessageAdoptionTest(unittest.TestCase):
    def body(self, action="express"):
        return {"contact_id": str(uuid4()), "idempotency_key": str(uuid4()),
                "expected_input_version_id": str(uuid4()), "adopt_new_message_id": str(uuid4()),
                "content": {"type": "rewrite_draft", "input_kind": "workspace", "workspace_action": action,
                            "draft_text": "只说明本次立场。" if action == "express" else "",
                            "user_instruction": None, "include_relationship_context": True,
                            "context_text": "用户补充的合成聊天。", "excluded_message_ids": [str(uuid4())]}}

    def parse(self, body):
        return parse_assistant_reply_request(json.dumps(body).encode())[1]

    def test_workspace_actions_keep_all_explicit_input_fields(self):
        for action in ("express", "suggest"):
            with self.subTest(action=action):
                body = self.body(action)
                request = self.parse(body)
                self.assertIsInstance(request, AssistantMessageAdoptionRequest)
                self.assertIsInstance(request.content, RewriteDraft)
                self.assertEqual(request.content.workspace_action, action)
                self.assertEqual(request.content.draft_text, body["content"]["draft_text"])
                self.assertEqual(request.content.context_text, body["content"]["context_text"])
                self.assertEqual([str(value) for value in request.content.excluded_message_ids], body["content"]["excluded_message_ids"])
                self.assertEqual(request.submission, body)

    def test_adoption_cannot_upload_requirements_or_unknown_content_fields(self):
        for addition in ({"user_instruction": "伪造累计要求"}, {"effective_requirements": ["伪造要求"]},
                         {"purpose": "伪造目的"}):
            with self.subTest(fields=tuple(addition)):
                body = self.body(); body["content"].update(addition)
                with self.assertRaises(ReplyRequestInvalid):
                    self.parse(body)

    def test_old_rewrite_inputs_and_missing_current_version_are_not_workspace_adoption(self):
        for kind in ("draft", "current_chat"):
            body = self.body(); body["content"]["input_kind"] = kind
            with self.assertRaises(ReplyRequestInvalid):
                self.parse(body)
        body = self.body(); del body["expected_input_version_id"]
        with self.assertRaises(ReplyRequestInvalid):
            self.parse(body)

    def test_adoption_respects_disabled_context_and_excluded_new_message(self):
        body = self.body(); body["content"]["include_relationship_context"] = False
        with self.assertRaises(ReplyRequestInvalid):
            self.parse(body)
        body = self.body(); body["content"]["excluded_message_ids"] = [body["adopt_new_message_id"]]
        with self.assertRaises(ReplyRequestInvalid):
            self.parse(body)
