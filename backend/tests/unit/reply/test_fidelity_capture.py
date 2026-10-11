"""捕获入口必须如实区分直接 HTTP、页面与未知计时范围。"""

import unittest
from copy import deepcopy

from tests.fidelity_capture import capture_report


class FidelityCaptureTests(unittest.TestCase):
    def fixture(self):
        return ({"data_kind": "synthetic", "data_version": "capture-test", "rows": [{
            "case_id": "single", "owner_id": "synthetic-owner", "contact_id": "synthetic-contact",
            "payload": {"draft_text": "本次拒绝。", "evidence": [{"evidence_id": "draft",
                "kind": "user_draft", "text": "本次拒绝。", "status": "user_input",
                "factual_role": "current_user_statement"}],
                "fidelity_contract": {"current_intent": {"text": "本次拒绝。"}, "instruction_scope": "expression_only"}},
            "system_prompt": "合成提示", "output": {"candidates": [{"text": "本次拒绝。",
                "basis": "本次声明", "citation_ids": ["draft"], "risk_notes": []}]},
            "latency_ms": 12, "call_count": 1,
        }]}, {"data_kind": "synthetic", "config": {"model": "controlled", "prompt_version": "v1"},
               "cases": [{"case_id": "single", "split": "development", "labels": [], "expectation": {}}],
               "reviews": []})

    def test_elapsed_scope_and_current_statement_are_not_falsely_upgraded(self):
        for entry, description in (("http", "直接 HTTP 请求"), ("page", "页面操作"),
                                   (None, "起止范围未知")):
            with self.subTest(entry=entry):
                capture, specification = self.fixture()
                if entry is not None:
                    capture["entry_point"] = entry
                report = capture_report(capture, specification)
                self.assertIn(description, report["protocol"]["capture_elapsed_scope"])
                self.assertEqual(report["cases"][0]["generation_input"]["available_facts"], [])
                self.assertEqual(report["cases"][0]["generation_input"]["current_intent"], "本次拒绝。")
                self.assertEqual(report["summary"]["unreviewed"], 1)
                self.assertEqual(report["summary"]["human_fidelity_pass"], 0)

    def test_unrecognized_capture_entry_is_rejected(self):
        capture, specification = self.fixture()
        capture["entry_point"] = "claimed_native_acceptance"
        with self.assertRaises(ValueError):
            capture_report(capture, specification)

    def test_all_actual_tool_and_generation_inputs_and_public_ui_evidence_are_retained(self):
        capture, specification = self.fixture()
        row = capture["rows"][0]
        first = deepcopy(row["payload"])
        first["tool_messages"] = [{"role": "tool", "content": "合成历史工具原话。"}]
        row["model_inputs"] = [first, deepcopy(row["payload"])]
        row["call_count"] = 2
        capture["ui_edits"] = [{"mode": "proactive", "final_unsaved_draft": ["本次拒绝。"]}]
        capture["coverage"] = {"continuation": "仅普通重新生成", "real_model_quality": "unknown"}

        report = capture_report(capture, specification)

        self.assertEqual(report["cases"][0]["actual_capture"]["model_inputs"], row["model_inputs"])
        self.assertEqual(report["public_ui_observations"], capture["ui_edits"])
        self.assertEqual(report["protocol"]["capture_coverage"], capture["coverage"])
        self.assertEqual(report["summary"]["known_call_count"], 2)
        self.assertEqual(report["summary"]["human_fidelity_pass"], 0)

    def test_every_model_input_rejects_review_leak_and_incomplete_call_capture(self):
        for invalid in ("first_review", "count", "last_input", "empty", "untyped", "boolean_count"):
            with self.subTest(invalid=invalid):
                capture, specification = self.fixture()
                row = capture["rows"][0]
                row["model_inputs"] = [deepcopy(row["payload"]), deepcopy(row["payload"])]
                row["call_count"] = 2
                if invalid == "first_review":
                    row["model_inputs"][0]["tool_messages"] = [{"content": {"expected_answer": "合成标签。"}}]
                elif invalid == "count":
                    row["call_count"] = 3
                elif invalid == "last_input":
                    row["model_inputs"][-1]["draft_text"] = "与实际最终捕获不同。"
                elif invalid == "empty":
                    row["model_inputs"] = []
                elif invalid == "untyped":
                    row["model_inputs"][0] = "合成非结构输入"
                else:
                    row["call_count"] = True
                with self.assertRaises(ValueError):
                    capture_report(capture, specification)
