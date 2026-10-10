"""捕获入口必须如实区分直接 HTTP、页面与未知计时范围。"""

import unittest

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
