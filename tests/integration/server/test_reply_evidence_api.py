"""通过 HTTP seam 验证实际回复快照的读取与联系人隔离。"""

import unittest
from uuid import uuid4

from notalone.application.reply_evidence import ReplyEvidenceService
from notalone.reply.context import ContextEvidence, ReplyContext
from notalone.reply.interface import GenerateReply, RewriteDraft
from notalone.reply.runtime import RuntimeCandidate
from notalone.reply.store import InMemoryReplyStore, ValidatedReply
from notalone.scopes import ContactScope, VerifiedConversationScope
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient


class ReplyEvidenceApiTest(unittest.TestCase):
    def setUp(self):
        self.scope = ContactScope(uuid4(), uuid4())
        self.store = InMemoryReplyStore()
        binding_id = uuid4()
        command = GenerateReply(
            idempotency_key=uuid4(), scope=self.scope,
            conversation_binding_id=binding_id,
            content=RewriteDraft(draft_text="合成原句"),
        )
        started = self.store.start(command, VerifiedConversationScope(
            self.scope.owner_id, self.scope.contact_id, binding_id,
        ))
        self.request = started.request
        self.evidence = (
            ContextEvidence(uuid4(), "user_draft", "合成原句", self.scope,
                            selection_reason="本次用户原句"),
            ContextEvidence(uuid4(), "message", "合成背景", self.scope,
                            selection_reason="同一联系人近期消息"),
        )
        self.context = ReplyContext(
            self.request.request_id, command, self.scope, "合成原句", None,
            self.evidence, 0,
        )
        self.client = self.client_for(self.scope.owner_id)
        self.path = (f"/api/contacts/{self.scope.contact_id}/replies/"
                     f"{self.request.request_id}/evidence")

    def client_for(self, owner_id):
        return InProcessClient(create_app(
            database_url="postgresql:///unused_test", owner_id=owner_id,
            token="test-token", reply_evidence=ReplyEvidenceService(self.store),
        ))

    def save(self):
        self.store.save(self.request, self.context, ValidatedReply((
            RuntimeCandidate("合成回复", "回应原句", (self.evidence[0].evidence_id,), ()),
        ), None))

    def read(self, path=None, client=None):
        return (client or self.client).get(path or self.path, headers={
            "Authorization": "Bearer test-token",
        })

    def test_completed_snapshot_distinguishes_context_from_citations(self):
        self.save()
        response = self.read()
        self.assertEqual(response.status_code, 200)
        entries = response.json()["evidence"]
        self.assertEqual([entry["text"] for entry in entries], ["合成原句", "合成背景"])
        self.assertEqual([entry["cited"] for entry in entries], [True, False])
        self.assertEqual(entries[0]["selection_reason"], "本次用户原句")
        self.assertIn("no-store", response.headers["Cache-Control"])

    def test_other_contact_owner_and_missing_request_are_not_found(self):
        self.save()
        for path, client in (
            (self.path.replace(str(self.scope.contact_id), str(uuid4())), self.client),
            (self.path, self.client_for(uuid4())),
            (self.path.replace(str(self.request.request_id), str(uuid4())), self.client),
        ):
            response = self.read(path, client)
            self.assertEqual(response.status_code, 404)
            self.assertNotIn("合成", response.body.decode())

    def test_incomplete_snapshot_and_unauthorized_request_are_not_exposed(self):
        self.assertEqual(self.read().status_code, 409)
        self.assertEqual(self.client.get(self.path).status_code, 401)

    def test_invalid_identifiers_are_rejected(self):
        self.assertEqual(self.read(self.path.replace(str(self.scope.contact_id), "bad")).status_code, 400)
