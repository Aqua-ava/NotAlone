"""类型化持续输入的窄 Interface；已知规范输入作为独立期望。"""

from __future__ import annotations

import unittest
from dataclasses import replace
from uuid import UUID, uuid4

from notalone.application.assistant_continuation_identity import (
    AssistantContinuationInvalid, AssistantContinuationReplyRequest,
    continuation_commit_input, continuation_digest_input, continuation_input_payload,
)
from notalone.application.reply_service import ReplyServiceRequest
from notalone.reply.assistant_continuation_reference import (
    AssistantContinuationReference, ContinuationGenerateReply,
)
from notalone.reply.interface import CandidateMessage, RewriteDraft
from notalone.scopes import ContactScope


METADATA = {
    "version": 1, "scope": "this_assistant_session_only", "candidate_id": None,
    "version_id": None, "effective_requirements": ["简短一点"],
}
NORMALIZED_INPUT = (
    '{"continued_from_candidate_id":null,"draft_text":"合成身份草稿",'
    '"include_relationship_context":false,"mode":"rewrite_draft",'
    '"skill":"auto","user_instruction":"简短一点"}'
)
IDENTITY_INPUT = (
    r'{"continuation":{"candidate_id":null,"effective_requirements":["简短一点"],'
    r'"scope":"this_assistant_session_only","version":1,"version_id":null},'
    r'"reply":"{\"continued_from_candidate_id\":null,\"draft_text\":\"合成身份草稿\",'
    r'\"include_relationship_context\":false,\"mode\":\"rewrite_draft\",'
    r'\"skill\":\"auto\",\"user_instruction\":\"简短一点\"}"}'
)


class AssistantContinuationIdentityTest(unittest.TestCase):
    def _request(self, **changes: object) -> AssistantContinuationReplyRequest:
        request = AssistantContinuationReplyRequest(
            idempotency_key=uuid4(), continuation=dict(METADATA),
            content=RewriteDraft(draft_text="合成身份草稿", user_instruction="简短一点"),
        )
        return replace(request, **changes)

    def _command(self, request: AssistantContinuationReplyRequest) -> ContinuationGenerateReply:
        owner_id, contact_id, binding_id = uuid4(), uuid4(), uuid4()
        command = request.build_command(owner_id=owner_id, contact_id=contact_id, binding_id=binding_id)
        self.assertIsInstance(command, ContinuationGenerateReply)
        self.assertEqual(command.scope, ContactScope(owner_id, contact_id))
        self.assertEqual(command.conversation_binding_id, binding_id)
        self.assertEqual(command.idempotency_key, request.idempotency_key)
        return command

    def test_typed_request_builds_the_same_identity_for_digest_and_commit(self) -> None:
        request = self._request()
        command = self._command(request)
        self.assertEqual(continuation_digest_input(request, NORMALIZED_INPUT), IDENTITY_INPUT)
        self.assertEqual(continuation_digest_input(command, NORMALIZED_INPUT), IDENTITY_INPUT)
        self.assertEqual(continuation_commit_input(command, NORMALIZED_INPUT, {"continuation": METADATA}),
                         IDENTITY_INPUT)
        payload = {"content": {"type": "rewrite_draft", "draft_text": "合成身份草稿"}}
        self.assertEqual(continuation_input_payload(request, payload), {**payload, "continuation": METADATA})
        self.assertNotIn("continuation", payload)
        self.assertEqual(repr(request), "AssistantContinuationReplyRequest(<private>)")
        self.assertEqual(repr(command), "ContinuationGenerateReply(<private>)")

    def test_legacy_request_keeps_its_normalized_input_and_payload(self) -> None:
        request = ReplyServiceRequest(idempotency_key=uuid4(), content=RewriteDraft("合成普通草稿"))
        command = request.build_command(owner_id=uuid4(), contact_id=uuid4(), binding_id=uuid4())
        self.assertIsNotNone(command)
        self.assertEqual(continuation_digest_input(request, NORMALIZED_INPUT), NORMALIZED_INPUT)
        self.assertEqual(continuation_commit_input(command, NORMALIZED_INPUT, None), NORMALIZED_INPUT)
        self.assertEqual(continuation_input_payload(request, {"content": "合成普通输入"}),
                         {"content": "合成普通输入"})

    def test_typed_identity_cannot_be_missing_mismatched_or_downgraded(self) -> None:
        request = self._request()
        command = self._command(request)
        plain = ReplyServiceRequest(request.idempotency_key, request.content).build_command(
            owner_id=command.scope.owner_id, contact_id=command.scope.contact_id,
            binding_id=command.conversation_binding_id,
        )
        cases = (
            (command, None), (command, {"continuation": None}),
            (command, {"continuation": {**METADATA, "effective_requirements": ["详细一点"]}}),
            (plain, {"continuation": METADATA}),
        )
        for typed, payload in cases:
            with self.subTest(payload_present=payload is not None, typed=isinstance(typed, ContinuationGenerateReply)):
                with self.assertRaises(AssistantContinuationInvalid):
                    continuation_commit_input(typed, NORMALIZED_INPUT, payload)

    def test_selected_reference_keeps_exact_version_identity_even_with_same_text(self) -> None:
        candidate_id = UUID("23f41592-14c7-4ca6-aac0-bb7f59b175b6")
        version_id = UUID("519c3aa3-37a2-4ea9-b168-13248b08f2ee")
        reference = AssistantContinuationReference(candidate_id, version_id, (
            CandidateMessage(candidate_id, "合成第一句"), CandidateMessage(uuid4(), "合成第二句"),
        ))
        metadata = {**METADATA, "candidate_id": str(candidate_id), "version_id": str(version_id)}
        command = self._command(self._request(
            continuation=metadata, reference=reference, continued_from_candidate_id=candidate_id,
        ))
        self.assertIs(command.continuation_reference, reference)
        self.assertEqual(reference.text, "合成第一句\n\n合成第二句")
        continuation_commit_input(command, "known-input", {"continuation": metadata})
        for invalid in (replace(command, continuation_reference=None),
                        replace(command, continuation_reference=replace(reference, version_id=uuid4())),
                        replace(command, continued_from_candidate_id=uuid4())):
            with self.subTest(has_reference=invalid.continuation_reference is not None):
                with self.assertRaises(AssistantContinuationInvalid):
                    continuation_commit_input(invalid, "known-input", {"continuation": metadata})

    def test_invalid_base_request_cannot_build_a_typed_command(self) -> None:
        request = self._request(skill_disabled=True, skill_version_id=uuid4())
        self.assertIsNone(request.build_command(owner_id=uuid4(), contact_id=uuid4(), binding_id=uuid4()))


if __name__ == "__main__":
    unittest.main()
