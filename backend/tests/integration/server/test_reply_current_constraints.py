"""公开回复在本次要求/偏好冲突时复核候选，只替换外部模型。"""

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
    entered: threading.Event | None = None

    def __init__(self):
        super().__init__()
        self.entered = threading.Event()

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        payload = next(json.loads(item.content) for item in messages if isinstance(item, HumanMessage))
        self.entered.set()
        citation = payload["evidence"][0]["evidence_id"]
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

    def test_current_requirement_and_unsupported_commitments_reject_bad_candidates(self):
        body = self.body()
        status, result = self.backend.request("/api/reply/generate", body)
        self.assertEqual(status, 200, result)
        self.assertEqual([item["text"] for item in result["candidates"]], [
            "这件事对我很重要，我想认真把自己的考虑说明白。等我说明之后，也想听听你怎么看，有哪些想法。",
        ])
        self.assertEqual(self.reply_model.review_calls, 1)
        self.assertEqual(len(self.reply_model.seen_calls), 2)
        self.assertEqual(self.backend.request("/api/reply/generate", body), (200, result))
        self.assertEqual(len(self.reply_model.seen_calls), 2)

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

    def test_expansion_check_overrides_a_generic_supported_verdict_and_review_has_no_old_preference(self):
        self.reply_model.review_verdicts = ["supported"] * 3
        self.reply_model.review_requires_expansion = True
        self.reply_model.review_changes = ["expanded", "same_or_compressed", "unknown"]
        status, result = self.backend.request("/api/reply/generate", self.body())
        self.assertEqual(status, 200, result)
        self.assertEqual(len(result["candidates"]), 1)
        payload = next(json.loads(item.content) for item in self.reply_model.seen_calls[-1] if isinstance(item, HumanMessage))
        self.assertNotIn("expression_preferences", payload)
        self.assertEqual(len(self.reply_model.seen_calls), 2)
        with psycopg.connect(self.database_url) as connection:
            rows = connection.execute("SELECT input_tokens,output_tokens,outcome FROM public.outbound_ledger_entry WHERE owner_id=%s AND contact_id=%s",
                                      (self.owner_id, self.contact_id)).fetchall()
        self.assertEqual(len(rows), 2)
        self.assertEqual([row[2] for row in rows], ["succeeded", "succeeded"])

    def test_unknown_or_malformed_review_cannot_deliver_or_trigger_automatic_regeneration(self):
        for shape in ("unknown", "duplicate", "missing"):
            with self.subTest(shape=shape):
                self.reply_model.review_verdicts = ["unknown"] * 3 if shape == "unknown" else ["supported"] * 3
                self.reply_model.review_numbers = [1, 1, 3] if shape == "duplicate" else [1, 2] if shape == "missing" else None
                before = len(self.reply_model.seen_calls)
                status, result = self.backend.request("/api/reply/generate", self.body())
                self.assertEqual((status, result), (409, {"error": "reply_candidates_rejected"})
                                 if shape == "unknown" else (500, {"error": "reply_generation_failed"}))
                self.assertEqual(len(self.reply_model.seen_calls) - before, 2)

    def test_deleted_preference_before_review_stops_the_second_model_call(self):
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

    def test_valid_rejection_has_explicit_outcome_and_no_candidates(self):
        self.reply_model.review_verdicts = ["reject"] * 3
        status, result = self.backend.request("/api/reply/generate", self.body())
        self.assertEqual((status, result), (409, {"error": "reply_candidates_rejected"}))
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_cached_model_is_rejected_without_a_fake_outbound_record(self):
        self.reply_model.cache = True
        status, result = self.backend.request("/api/reply/generate", self.body())
        self.assertNotEqual(status, 200, result)
        self.assertEqual(len(self.reply_model.seen_calls), 0)
        with psycopg.connect(self.database_url) as connection:
            count = connection.execute("SELECT count(*) FROM public.outbound_ledger_entry WHERE owner_id=%s AND contact_id=%s",
                                       (self.owner_id, self.contact_id)).fetchone()[0]
        self.assertEqual(count, 0)

    def assert_invalid_review_rejected(self, transform):
        """只替换供应商响应；观察公开 HTTP 及真实出站调用，禁止自动重生成。"""
        self.reply_model.review_verdicts = ["supported"] * 3
        self.reply_model.review_transform = transform
        calls_before = len(self.reply_model.seen_calls)
        reviews_before = self.reply_model.review_calls
        status, result = self.backend.request("/api/reply/generate", self.body())
        self.assertEqual((status, result), (500, {"error": "reply_generation_failed"}))
        self.assertEqual(len(self.reply_model.seen_calls) - calls_before, 2)
        self.assertEqual(self.reply_model.review_calls - reviews_before, 1)

    def test_missing_check_cannot_deliver_partially_reviewed_candidates(self):
        def missing_check(payload, report):
            del report["reviews"]["candidate_1"]["checks"]["facts"]
            return report

        self.assert_invalid_review_rejected(missing_check)

    def test_supported_check_with_violation_cannot_deliver(self):
        def contradictory_check(payload, report):
            report["reviews"]["candidate_1"]["checks"]["instruction"]["result"]["violation"] = {
                "category": "unmet_instruction", "candidate_path": "/text",
                "candidate_quote": payload["candidates"][0]["text"],
                "source_path": "/user_instruction", "source_quote": payload["user_instruction"],
            }
            return report

        self.assert_invalid_review_rejected(contradictory_check)

    def test_fabricated_candidate_or_source_quote_cannot_deliver(self):
        for field in ("candidate_quote", "source_quote", "source_path"):
            with self.subTest(field=field):
                def fabricated_quote(payload, report):
                    violation = {
                        "category": "unmet_instruction", "candidate_path": "/text",
                        "candidate_quote": payload["candidates"][0]["text"],
                        "source_path": "/user_instruction", "source_quote": payload["user_instruction"],
                    }
                    violation[field] = "/candidates/0/basis" if field == "source_path" else "实际字段中不存在的合成引文。"
                    report["reviews"]["candidate_1"]["checks"]["instruction"]["result"].update(
                        status="violation", violation=violation,
                    )
                    return report

                self.assert_invalid_review_rejected(fabricated_quote)

    def test_inaccurate_explanation_rejects_candidate_even_when_body_checks_pass(self):
        self.reply_model.review_verdicts = ["supported"] * 2
        self.reply_model.candidate_texts = [
            "这件事对我很重要，我想认真把自己的考虑说明白。等我说明之后，也想听听你怎么看，有哪些想法。",
            "这件事对我很重要，我想先把自己的考虑讲清楚，再听听你的看法。",
        ]
        self.reply_model.candidate_bases = ["原稿中的今晚没空已被删去。", "合成生成结果。"]

        def inaccurate_explanation(payload, report):
            report["reviews"]["candidate_1"]["checks"]["explanation"]["result"].update(status="violation", violation={
                "category": "inaccurate_explanation", "candidate_path": "/basis",
                "candidate_quote": "原稿中的今晚没空已被删去。",
                "source_path": "/draft_text", "source_quote": payload["draft_text"],
            })
            return report

        self.reply_model.review_transform = inaccurate_explanation
        status, result = self.backend.request("/api/reply/generate", self.body())
        self.assertEqual(status, 200, result)
        self.assertEqual([candidate["text"] for candidate in result["candidates"]], [
            "这件事对我很重要，我想先把自己的考虑讲清楚，再听听你的看法。",
        ])
        self.assertEqual(len(self.reply_model.seen_calls), 2)
        self.assertEqual(self.reply_model.review_calls, 1)
