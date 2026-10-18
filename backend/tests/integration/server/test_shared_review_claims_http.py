"""共享复核合同经生产装配、公开HTTP与保存链；仅使用自有合成PG及脚本模型。"""
import unittest
from uuid import uuid4

import psycopg

from tests.fidelity_http_support import FidelityHttpFixture
from tests.reply_review_support import synthetic_claim


class SharedReviewClaimsHttpTest(FidelityHttpFixture, unittest.TestCase):
    def run_case(self, fault):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        status, session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        text = "那段往事我还有印象。你最近怎么样？"
        self.reply_model.plans.append({"text": text, "basis": "按本次明确方向。"})

        def certificate(payload, report):
            path = "/current_text" if fault == "contact_source" else "/confirmed_direction"
            quote = "还记得吗" if fault == "contact_source" else "我记得这段往事"
            state = synthetic_claim("那段往事我还有印象。", kind="state", modality="stated",
                                    sources=[{"source_path": path, "source_quote": quote}])
            question = synthetic_claim("你最近怎么样？", start=len("那段往事我还有印象。") + 1)
            question["claim_id"] = 2
            row = report["reviews"]["candidate_1"]
            row["claims"] = [state] if fault == "missing_tail" else [state, question]
            return report

        self.reply_model.review_transform = certificate
        result = self.backend.request(f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}/replies", {
            "contact_id": contact, "idempotency_key": str(uuid4()), "content": {
                "type": "rewrite_draft", "input_kind": "current_chat", "draft_text": "那会儿的事情还记得吗？",
                "pasted_direction": "告诉对方我记得这段往事，继续问他的近况。", "include_relationship_context": False}})
        self.assertEqual(len(self.reply_model.seen_calls), 2)
        self.assertEqual(self.reply_model.review_calls, 1)
        with psycopg.connect(self.database_url) as db:
            count = db.execute("SELECT count(*) FROM public.reply_candidate WHERE owner_id=%s", (self.owner_id,)).fetchone()[0]
        return result, count

    def test_contact_source_denied_without_persisting_candidate(self):
        (status, result), count = self.run_case("contact_source")
        self.assertEqual((status, result), (409, {"error": "reply_candidates_rejected"}))
        self.assertEqual(count, 0)

    def test_incomplete_cover_is_provider_error_without_persisting_candidate(self):
        (status, result), count = self.run_case("missing_tail")
        self.assertEqual((status, result), (502, {"error": "reply_review_invalid"}))
        self.assertEqual(count, 0)

    def test_authorized_paraphrase_persists_original_candidate(self):
        (status, result), count = self.run_case("valid")
        self.assertEqual(status, 200, result)
        self.assertEqual(result["candidates"][0]["text"], "那段往事我还有印象。你最近怎么样？")
        self.assertEqual(count, 1)
