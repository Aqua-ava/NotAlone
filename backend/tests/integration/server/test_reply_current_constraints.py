"""公开回复直接返回候选供用户选择，保留来源检查；只替换外部模型。"""

import json
import unittest
from concurrent.futures import ThreadPoolExecutor
import threading
from uuid import uuid4

import psycopg
from langchain_core.messages import HumanMessage

from tests.integration.server.core_business_flow_support import (
    CoreBusinessFlowFixture, ScriptedCoreModel, tool_response,
)


class ConstraintReviewModel(ScriptedCoreModel):
    review_verdicts: list[str] = ["supported", "reject", "reject"]
    candidate_texts: list[str] | None = None
    candidate_bases: list[str] | None = None
    citation_override: str | None = None
    entered: threading.Event | None = None

    def __init__(self):
        super().__init__()
        self.entered = threading.Event()

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        payload = next(json.loads(item.content) for item in messages if isinstance(item, HumanMessage))
        self.entered.set()
        citation = self.citation_override or payload["evidence"][0]["evidence_id"]
        texts = self.candidate_texts or [
            "这件事对我很重要，我想认真把自己的考虑说明白。等我说明之后，也想听听你怎么看，有哪些想法。",
            "这件事对我很重要，我想先把自己的考虑讲清楚，再听听你的看法。",
            "之前听你说过项目的事，想聊的话随时找我，我都在。",
        ]
        self.responses.append(tool_response("ReplyRuntimeOutput", {
            "candidates": [{"text": text, "basis": self.candidate_bases[index] if self.candidate_bases else "合成生成结果。",
                            "citation_ids": [citation], "risk_notes": []} for index, text in enumerate(texts)],
            "used_skill_version_id": None,
        }))
        return super()._generate(messages, stop, run_manager, **kwargs)


class ReplyCurrentConstraintsHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    production_model_wiring = True
    reply_model_factory = ConstraintReviewModel

    def setUp(self):
        super().setUp()
        self.contact_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES(%s,%s,'约束合成联系人')",
                               (self.owner_id, self.contact_id))
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=self.contact_id,
                                     channel="wechat", account_scope="synthetic-constraint-review",
                                     conversation_locator="synthetic-" + self.contact_id.hex)
        status, self.preference = self.backend.request("/api/expression-preferences", {
            "operation_key": str(uuid4()), "text": "平时尽量只用一句短句。",
            "scope": {"contact_id": str(self.contact_id), "reply_mode": "rewrite_draft"},
            "origin": {"kind": "manual"}, "confirm_long_term": True,
        })
        self.assertEqual(status, 200, self.preference)

    def body(self):
        return {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()), "content": {
            "type": "rewrite_draft", "draft_text": "这件事对我很重要，我希望解释清楚我的考虑，再听听你的意见。",
            "user_instruction": "这次请详细一些，保留认真说明和邀请对方表达两层意思。",
        }}

    def test_candidates_are_returned_for_user_selection_without_model_review(self):
        body = self.body()
        status, result = self.backend.request("/api/reply/generate", body)
        self.assertEqual(status, 200, result)
        self.assertEqual([item["text"] for item in result["candidates"]], [
            "这件事对我很重要，我想认真把自己的考虑说明白。等我说明之后，也想听听你怎么看，有哪些想法。",
            "这件事对我很重要，我想先把自己的考虑讲清楚，再听听你的看法。",
            "之前听你说过项目的事，想聊的话随时找我，我都在。",
        ])
        payload = next(json.loads(item.content) for item in self.reply_model.seen_calls[0]
                       if isinstance(item, HumanMessage))
        self.assertEqual(payload["user_instruction"], body["content"]["user_instruction"])
        self.assertNotIn("expression_preferences", payload)
        self.assertNotIn("generation_stage", payload)
        self.assertEqual(self.reply_model.review_calls, 0)
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        self.assertEqual(self.backend.request("/api/reply/generate", body), (200, result))
        self.assertEqual(len(self.reply_model.seen_calls), 1)

    def test_pasted_contact_text_uses_confirmed_direction_without_draft_review(self):
        self.reply_model.candidate_texts = ["这次不参加，祝你们玩得开心。"]
        for instruction in ("保留拒绝，不增加下次承诺。", None):
            with self.subTest(instruction=instruction):
                body = self.body()
                body["content"].update(
                    draft_text="今晚一起参加活动吗？", input_kind="current_chat",
                    pasted_direction="这次拒绝参加，祝对方活动顺利。", user_instruction=instruction,
                )
                calls_before = len(self.reply_model.seen_calls)
                status, result = self.backend.request("/api/reply/generate", body)
                self.assertEqual(status, 200, result)
                self.assertEqual([item["text"] for item in result["candidates"]], self.reply_model.candidate_texts)
                self.assertEqual(len(self.reply_model.seen_calls) - calls_before, 1)
                self.assertEqual(self.reply_model.review_calls, 0)
                payload = next(json.loads(item.content) for item in self.reply_model.seen_calls[-1]
                               if isinstance(item, HumanMessage))
                self.assertEqual(payload["input_mode"], "reply_to_pasted_text")
                self.assertEqual(payload["current_text"], body["content"]["draft_text"])
                self.assertEqual(payload["confirmed_direction"], body["content"]["pasted_direction"])
                self.assertNotIn("draft_text", payload)
                self.assertNotIn("literal_changes", payload)
                self.assertNotIn("generation_stage", payload)
                if not instruction:
                    self.assertEqual(payload["expression_preferences"][0]["text"], self.preference["preference"]["text"])


    def test_deleted_preference_during_generation_prevents_candidate_persistence(self):
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, "/api/reply/generate", self.body())
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                preference = self.preference["preference"]
                status, deleted = self.backend.request(
                    f"/api/expression-preferences/{preference['preference_id']}?contact_id={self.contact_id}",
                    {"operation_key": str(uuid4()), "expected_revision": preference["revision"]}, method="DELETE",
                )
                self.assertEqual(status, 200, deleted)
                gate.set()
                status, result = pending.result(timeout=10)
            finally:
                gate.set()
        self.assertNotEqual(status, 200, result)
        self.assertEqual(self.reply_model.review_calls, 0)
        self.assertEqual(len(self.reply_model.seen_calls), 1)


    def test_unknown_citation_is_still_rejected_without_model_review(self):
        self.reply_model.citation_override = str(uuid4())
        status, result = self.backend.request("/api/reply/generate", self.body())
        self.assertEqual((status, result), (409, {"error": "reply_candidates_rejected"}))
        self.assertEqual(self.reply_model.review_calls, 0)
        self.assertEqual(len(self.reply_model.seen_calls), 1)

    def test_cached_model_is_rejected_without_a_fake_outbound_record(self):
        self.reply_model.cache = True
        status, result = self.backend.request("/api/reply/generate", self.body())
        self.assertNotEqual(status, 200, result)
        self.assertEqual(len(self.reply_model.seen_calls), 0)
        with psycopg.connect(self.database_url) as connection:
            count = connection.execute("SELECT count(*) FROM public.outbound_ledger_entry WHERE owner_id=%s AND contact_id=%s",
                                       (self.owner_id, self.contact_id)).fetchone()[0]
        self.assertEqual(count, 0)
