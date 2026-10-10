"""回应、主动及已有候选继续的真实合成捕获；不代替B消息组与探索集成。"""

from __future__ import annotations

import json
import os
import time
import unittest
from pathlib import Path
from uuid import uuid4

from tests.fidelity_http_support import FidelityHttpFixture


class AuthenticExpressionScenarioTests(FidelityHttpFixture, unittest.TestCase):
    production_model_wiring = True

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.capture_rows = []
        cls.declared_capture_rows = []

    @classmethod
    def tearDownClass(cls):
        try:
            if path := os.environ.get("NOTALONE_COMBINED_FIDELITY_CAPTURE"):
                Path(path).write_text(json.dumps({
                    "data_kind": "synthetic", "data_version": "authentic-combination-http-v1",
                    "entry_point": "http", "rows": cls.capture_rows,
                }, ensure_ascii=False, indent=2) + "\n")
            if path := os.environ.get("NOTALONE_DECLARED_COMBINED_FIDELITY_CAPTURE"):
                Path(path).write_text(json.dumps({
                    "data_kind": "synthetic", "data_version": "authentic-combination-declared-http-v1",
                    "entry_point": "http", "rows": cls.declared_capture_rows,
                }, ensure_ascii=False, indent=2) + "\n")
        finally:
            super().tearDownClass()

    def test_response_current_intent_and_continuation_keep_sample_as_expression_only(self):
        self._exercise_scenario("response")

    def test_proactive_current_intent_and_continuation_keep_sample_as_expression_only(self):
        self._exercise_scenario("proactive")

    def test_response_declarations_sample_and_continuation_remain_once_only_and_are_erased(self):
        self._exercise_scenario("response", declared=True)

    def test_proactive_declarations_sample_and_continuation_remain_once_only_and_are_erased(self):
        self._exercise_scenario("proactive", declared=True)

    def _exercise_scenario(self, mode: str, *, declared: bool = False):
        contact, target, _ = self.prepare_contact(self.owner_id)
        status, saved_sample = self.backend.request(f"/api/contacts/{contact}/style-samples", {
            "idempotency_key": str(uuid4()), "text": "合成旧表达：我总是答应，明晚七点陪你去合成海边。",
            "origin": {"kind": "manual"},
        })
        self.assertEqual(status, 200, saved_sample)
        sample_id = saved_sample["sample"]["sample_id"]
        status, saved = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})
        self.assertEqual(status, 200, saved)
        path = f"/api/contacts/{contact}/assistant-sessions/{saved['session_id']}"
        stages = (
            ("current", "明确拒绝本次合成邀请，不增加约定。", "这次不参加，谢谢你邀请。", "保留本次拒绝，仅参考样本说法。"),
            ("continued", "仍然拒绝本次合成邀请，改成短句，不增加约定。", "这次不参加。", "继续保留当前拒绝，不沿旧表达增加承诺。"),
            ("unsupported", "仍然拒绝本次合成邀请，改成短句，不增加约定。", "好呀，明晚七点我陪你去合成海边。", "按旧样本中的邀约安排。"),
        )
        previous, current_version = None, None
        bodies, results = [], []
        for index, (label, intent, text, basis) in enumerate(stages):
            content = {"type": "reply_to_message", "target_message_id": target, "direction": intent} if mode == "response" else {
                "type": "initiate_conversation", "purpose": intent,
            }
            declarations = {"understanding_correction": "这只是合成邀约，不是已确认约定。",
                            "user_instruction": "仅表达拒绝，不新增感受。" if index == 0 else "改成短句，仍然拒绝，不新增感受。",
                            "clarification_answer": "不陪同，不承诺时间或地点。"} if declared else {}
            content.update(declarations)
            body = {"contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True, "content": content}
            if current_version is not None:
                body["expected_input_version_id"] = current_version
                body["continued_from_candidate_id"] = previous
            self.reply_model.plans.append({"text": text, "basis": basis})
            started = time.perf_counter()
            status, result = self.backend.request(path + "/replies", body)
            elapsed_ms = (time.perf_counter() - started) * 1000
            self.assertEqual(status, 200, result)
            payload = self.reply_model.payloads[-1]
            self.assertEqual(payload["fidelity_contract"]["current_intent"]["text"], intent)
            self.assertEqual([item["sample_id"] for item in payload["style_references"]], [sample_id])
            self.assertEqual(result["context_receipt"]["style_sample_ids"], [sample_id])
            self.assertNotIn(sample_id, result["context_receipt"]["evidence_ids"])
            self.assertEqual(result["candidates"][0]["text"], text)
            for name, value in declarations.items():
                self.assertEqual(payload[name], value)
            self.assertFalse(any(item["text"] in declarations.values() for item in payload["evidence"]))
            if previous is not None:
                self.assertTrue(any(item["kind"] == "continued_candidate" for item in payload["evidence"]))
            self.assertEqual(self._backend(self.owner_id).request(path + "/replies", body), (200, result))
            if declared:
                changed = {**body, "content": {**body["content"], "clarification_answer": "不同的合成本次回答。"}}
                self.assertEqual(self.backend.request(path + "/replies", changed)[0], 409)
            self.assertEqual(len(self.reply_model.payloads), index + 1)
            system = "\n".join(str(message.content) for message in self.reply_model.seen_calls[-1] if message.type == "system")
            captures = self.declared_capture_rows if declared else self.capture_rows
            case_id = f"{mode}-declared-style-{label}" if declared else f"{mode}-style-{label}"
            captures.append({"case_id": case_id, "owner_id": str(self.owner_id), "contact_id": contact,
                                      "payload": payload, "system_prompt": system, "output": result,
                                      "latency_ms": elapsed_ms, "call_count": 1})
            current_version, previous = result["input_version_id"], result["candidates"][0]["candidate_id"]
            bodies.append(body); results.append(result)

        if declared:
            saved = self._get(self._backend(self.owner_id), path)
            self.assertEqual(len(saved["turns"]), len(bodies))
            self.assertEqual([turn["input_version_id"] for turn in saved["turns"]],
                             [result["input_version_id"] for result in results])
            self.assertEqual([turn["reply"]["reply_request_id"] for turn in saved["turns"]],
                             [result["reply_request_id"] for result in results])
            for turn, body in zip(saved["turns"], bodies):
                for name in declarations:
                    self.assertEqual(turn["input"]["content"][name], body["content"][name])

        status, deleted = self.backend.request(f"/api/contacts/{contact}/style-samples/{sample_id}", method="DELETE")
        self.assertEqual(status, 200, deleted)
        recovered = self._get(self._backend(self.owner_id), path)
        self.assertEqual(len(recovered["turns"]), 3)
        self.assertTrue(all(turn["state"] == "redacted" and turn["input"] is None and turn["reply"] is None for turn in recovered["turns"]))
        for body, result in zip(bodies, results):
            self.assertNotEqual(self.backend.request(path + "/replies", body)[0], 200)
            self.assertNotEqual(self.backend.request(f"/api/contacts/{contact}/replies/{result['reply_request_id']}/evidence")[0], 200)
        self.assertNotEqual(self.backend.request(path + "/replies", {**bodies[-1], "idempotency_key": str(uuid4()),
                                                                   "continued_from_candidate_id": previous})[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 3)


if __name__ == "__main__":
    unittest.main()
