"""有依据的语义失败与确定性拒绝；不把脚本或合法引用当真实质量证明。"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import time
import unittest
from uuid import uuid4

import psycopg

from tests.fidelity_http_support import FidelityHttpFixture


class FidelityApiTests(FidelityHttpFixture, unittest.TestCase):
    def body(self, contact_id, *, target_id=None):
        content = ({"type": "reply_to_message", "target_message_id": target_id,
                    "direction": "今天不参加聚会。"} if target_id else
                   {"type": "rewrite_draft", "draft_text": "今天不参加聚会。",
                    "include_relationship_context": True})
        return {"contact_id": contact_id, "idempotency_key": str(uuid4()), "content": content}

    def test_public_semantic_counterexamples_are_visible_with_actual_inputs_and_replay(self):
        populated, target, _ = self.prepare_contact(self.owner_id)
        empty, _, _ = self.prepare_contact(self.owner_id, history=False)
        plans = json.loads((Path(__file__).parents[2] / "fixtures/fidelity/content-public-plans.json").read_text())
        rows = []
        for case in plans:
            with self.subTest(case=case["case_id"]):
                contact = empty if case["empty_history"] else populated
                self.reply_model.plans.append(case["output"])
                before, start = len(self.reply_model.seen_calls), time.perf_counter()
                body = self.body(contact, target_id=None if case["empty_history"] else target)
                status, result = self.backend.request("/api/reply/generate", body)
                latency = (time.perf_counter() - start) * 1000
                self.assertEqual(status, 200, result)
                self.assertEqual(result["candidates"][0]["text"], case["output"]["text"])
                self.assertEqual(result["candidates"][0]["basis"], case["output"]["basis"])
                self.assertEqual(len(self.reply_model.seen_calls) - before, 1)
                payload = self.reply_model.payloads[-1]
                self.assertEqual(payload["fidelity_contract"]["current_intent"]["text"], "今天不参加聚会。")
                self.assertEqual({item["kind"] for item in payload["evidence"]},
                                 {"user_draft"} if case["empty_history"] else {"message"})
                if not case["empty_history"]:
                    message = next(item for item in payload["evidence"] if "旧聊天" in item["text"])
                    self.assertEqual(message["factual_role"], "source_message_statement")
                    self.assertTrue(message["timing"]["source_started_at"].startswith("2025-01-01"))
                path = f"/api/contacts/{contact}/replies/{result['reply_request_id']}/evidence"
                self.assertEqual(self.backend.request(path)[0], 200)
                self.assertEqual(self.backend.request("/api/reply/generate", body), (200, result))
                self.assertEqual(len(self.reply_model.seen_calls) - before, 1)
                system = "\n".join(str(message.content) for message in self.reply_model.seen_calls[-1]
                                   if message.type == "system")
                rows.append({"case_id": case["case_id"], "owner_id": str(self.owner_id),
                             "contact_id": contact, "payload": payload, "system_prompt": system,
                             "output": result, "latency_ms": latency, "call_count": 1})
        if path := os.environ.get("NOTALONE_FIDELITY_CAPTURE"):
            Path(path).write_text(json.dumps({"data_kind": "synthetic", "data_version": "content-http-v1", "entry_point": "http",
                                             "rows": rows}, ensure_ascii=False, indent=2) + "\n")

    def test_foreign_scope_target_is_rejected_before_model(self):
        a, _, _ = self.prepare_contact(self.owner_id)
        b, target, _ = self.prepare_contact(self.owner_id)
        for backend, contact in ((self.backend, a), (self.other_backend, b)):
            with self.subTest(owner=backend.owner_id):
                status, result = backend.request("/api/reply/generate", self.body(contact, target_id=target))
                self.assertNotEqual(status, 200, result)
        self.assertEqual(self.reply_model.seen_calls, [])
        self.assertEqual(self.reply_model.payloads, [])

    def test_invalid_structure_or_foreign_citation_is_not_a_valid_persisted_result(self):
        contact, _, _ = self.prepare_contact(self.owner_id)
        for plan in ({"text": "", "basis": "空正文无效。"},
                     {"text": "本次不参加。", "basis": "越权引用。", "citation_ids": [str(uuid4())]}):
            with self.subTest(plan=plan):
                self.reply_model.plans.append(plan)
                status, result = self.backend.request("/api/reply/generate", self.body(contact))
                self.assertNotEqual(status, 200, result)
                self.assertNotIn("candidates", result)
        self.assertEqual(len(self.reply_model.seen_calls), 2)
        with psycopg.connect(self.database_url) as connection:
            count = connection.execute("SELECT count(*) FROM public.reply_candidate WHERE owner_id=%s",
                                       (self.owner_id,)).fetchone()[0]
        self.assertEqual(count, 0)

    def test_source_withdrawn_during_model_prevents_valid_result(self):
        contact, target, source = self.prepare_contact(self.owner_id)
        self.reply_model.plans.append({"text": "本次不参加。", "basis": "仅按本次方向。"})
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(self.backend.request, "/api/reply/generate", self.body(contact, target_id=target))
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                with psycopg.connect(self.database_url) as connection:
                    connection.execute("UPDATE public.source_document SET status='delete_requested' WHERE id=%s AND owner_id=%s",
                                       (source, self.owner_id))
            finally:
                gate.set()
            status, result = future.result(timeout=10)
        self.assertNotEqual(status, 200, result)
        self.assertNotIn("candidates", result)
        with psycopg.connect(self.database_url) as connection:
            count = connection.execute("SELECT count(*) FROM public.reply_candidate WHERE owner_id=%s",
                                       (self.owner_id,)).fetchone()[0]
        self.assertEqual(count, 0)

    def test_completed_source_invalidates_evidence_and_same_key_without_new_model_call(self):
        contact, target, source = self.prepare_contact(self.owner_id)
        self.reply_model.plans.append({"text": "今天不参加聚会。", "basis": "本次明确方向。"})
        body = self.body(contact, target_id=target)
        status, result = self.backend.request("/api/reply/generate", body)
        self.assertEqual(status, 200, result)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET status='delete_requested' WHERE id=%s AND owner_id=%s",
                               (source, self.owner_id))
        evidence = f"/api/contacts/{contact}/replies/{result['reply_request_id']}/evidence"
        with self.subTest(entry="evidence"):
            self.assertNotEqual(self.backend.request(evidence)[0], 200)
        with self.subTest(entry="same_key_replay"):
            self.assertNotEqual(self.backend.request("/api/reply/generate", body)[0], 200)
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        self.assertEqual(len(self.reply_model.payloads), 1)
