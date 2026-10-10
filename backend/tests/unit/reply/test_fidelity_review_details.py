"""同一E01入口保留逐维依据和实际捕获，不把合成审阅冒充真人。"""

import unittest

from notalone.reply.fidelity_evaluation import build_report, generation_input


class FidelityReviewDetailsTests(unittest.TestCase):
    def test_review_labels_cannot_leak_inside_whitelisted_input(self):
        for field in ("expectation", "expected_answer", "expected_intent", "dimensions", "details"):
            with self.subTest(field=field):
                case = {"current_intent": "只问近况。", "available_facts": [
                    {"text": "合成来源陈述", field: "评价资料不能进入输入"},
                ], "unknowns": [], "allowed_changes": ["润色"]}
                with self.assertRaises(ValueError):
                    generation_input(case)

    def test_actual_input_and_hard_dimension_reasons_are_retained(self):
        actual = {"owner_id": "synthetic-owner", "contact_id": "synthetic-contact",
                  "payload": {"input_mode": "rewrite_draft", "draft_text": "今天不参加。"},
                  "system_prompt": "合成捕获系统提示"}
        detail = {"intent": {"status": "pass", "basis": "仍拒绝今天参加。"},
                  "unsupported_facts": {"status": "pass", "basis": "没有新增既往经历。"},
                  "unsupported_commitments": {"status": "fail", "basis": "新增明天见面的承诺。"},
                  "psychological_attribution": {"status": "pass", "basis": "没有归因联系人动机。"}}
        report = build_report({"version": "synthetic-details-v1", "cases": [{
            "case_id": "promise", "split": "development", "current_intent": "今天不参加。",
            "available_facts": [], "unknowns": ["未来安排"], "allowed_changes": ["润色"],
            "allowed_citations": [], "actual_capture": actual,
            "forbidden_additions": ["明天一定见面"],
        }]}, {"config": {"model": "controlled", "prompt_version": "v1"}, "attempts": [{
            "case_id": "promise", "status": "ok", "elapsed_ms": 5, "call_count": 1,
            "output": {"candidates": [{"text": "今天不参加，明天一定见面。",
                                       "basis": "合成新增承诺反例", "citation_ids": []}]},
        }], "reviews": [{
            "case_id": "promise", "reviewer_kind": "synthetic_fixture", "reviewer": "独立合成标注",
            "basis": "当前拒绝未变，但新增未来承诺。", "intent": "pass", "unsupported_content": "fail",
            "naturalness": "unknown", "relationship_fit": "unknown", "user_similarity": "unknown",
            "details": detail,
        }]})
        self.assertEqual(report["cases"][0]["actual_capture"], actual)
        self.assertEqual(report["cases"][0]["semantic_review"]["details"], detail)
        self.assertEqual(report["summary"]["human_fidelity_pass"], 0)
        self.assertEqual(report["summary"]["fidelity_failed"], 1)
        self.assertFalse(report["summary"]["quality_verified"])
