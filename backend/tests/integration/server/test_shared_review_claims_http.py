"""生产 HTTP 直接保存结构合法候选，不再要求额外模型核验报告。"""
import unittest
from uuid import uuid4

import psycopg

from tests.fidelity_http_support import FidelityHttpFixture


class SharedReviewClaimsHttpTest(FidelityHttpFixture, unittest.TestCase):
    def test_current_direction_candidate_persists_without_a_review_call(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        status, session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        text = "那段往事我还有印象。你最近怎么样？"
        self.reply_model.plans.append({"text": text, "basis": "按本次明确方向。"})
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}/replies"
        command = {"contact_id": contact, "idempotency_key": str(uuid4()), "content": {
            "type": "rewrite_draft", "input_kind": "current_chat", "draft_text": "那会儿的事情还记得吗？",
            "pasted_direction": "告诉对方我记得这段往事，继续问他的近况。", "include_relationship_context": False}}

        status, result = self.backend.request(path, command)

        self.assertEqual(status, 200, result)
        self.assertEqual(result["candidates"][0]["text"], text)
        self.assertEqual(self.backend.request(path, command), (200, result))
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        self.assertEqual(self.reply_model.review_calls, 0)
        with psycopg.connect(self.database_url) as db:
            count = db.execute("SELECT count(*) FROM public.reply_candidate WHERE owner_id=%s", (self.owner_id,)).fetchone()[0]
        self.assertEqual(count, 1)
