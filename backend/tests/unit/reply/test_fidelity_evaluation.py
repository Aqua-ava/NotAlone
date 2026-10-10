"""公开离线评测入口保留失败和未知，不冒充语义审查。"""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class OfflineFidelityReportTest(unittest.TestCase):
    def test_paired_fixture_keeps_same_message_and_different_preceding_context(self) -> None:
        fixtures = Path(__file__).resolve().parents[2] / "fixtures" / "fidelity"
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "report.json"
            result = subprocess.run([
                sys.executable, "-m", "notalone.reply.fidelity_evaluation",
                "--dataset", str(fixtures / "synthetic-v1.json"),
                "--run", str(fixtures / "controlled-v1.json"), "--output", str(output),
            ], capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            rows = json.loads(output.read_text())["cases"]
        pair = [row["generation_input"] for row in rows if row["case_id"].startswith("paired-")]
        self.assertEqual(pair[0]["current_message"], "那周六怎么样？")
        self.assertEqual(pair[0]["current_message"], pair[1]["current_message"])
        self.assertNotEqual(pair[0]["recent_context"], pair[1]["recent_context"])

    def test_cli_rejects_untraceable_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "dataset.json").write_text(json.dumps({"version": "v1", "cases": []}))
            (root / "run.json").write_text(json.dumps({"config": {}}))
            result = subprocess.run([
                sys.executable, "-m", "notalone.reply.fidelity_evaluation",
                "--dataset", str(root / "dataset.json"), "--run", str(root / "run.json"),
                "--output", str(root / "report.json"),
            ], capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 2)
            self.assertFalse((root / "report.json").exists())

    def test_report_keeps_wrong_missing_and_timeout_outputs(self) -> None:
        cases = [{
            "case_id": str(index), "split": "holdout", "tags": ["intent"],
            "current_intent": "婉拒邀请", "available_facts": [],
            "unknowns": ["对方动机"], "allowed_changes": ["润色"],
            "forbidden_additions": ["承诺参加"], "expected_answer": "拒绝",
        } for index in range(1, 5)]
        dataset = {"version": "synthetic-v1", "cases": cases}
        run = {
            "config": {"model": "controlled", "prompt_version": "v1"},
            "attempts": [
                {"case_id": "1", "status": "ok", "output": {"candidates": [{
                    "text": "我一定去", "basis": "你的意愿", "citation_ids": [],
                }]}, "elapsed_ms": 12, "call_count": 1},
                {"case_id": "2", "status": "ok", "output": {"candidates": [{
                    "text": "这次不参加", "basis": "本次意愿", "citation_ids": [],
                }]}, "elapsed_ms": 8, "call_count": 1},
                {"case_id": "3", "status": "timeout", "output": None,
                 "elapsed_ms": 1500, "call_count": 1},
            ],
            "reviews": [{"case_id": "1", "reviewer": "合成标注夹具",
                "basis": "用户说婉拒，候选承诺参加", "status": "unreviewed", "intent": "fail",
                "unsupported_content": "pass", "naturalness": "unknown",
                "relationship_fit": "unknown", "user_similarity": "unknown"}],
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, value in (("dataset", dataset), ("run", run)):
                (root / f"{name}.json").write_text(json.dumps(value), encoding="utf-8")
            result = subprocess.run([
                sys.executable, "-m", "notalone.reply.fidelity_evaluation",
                "--dataset", str(root / "dataset.json"), "--run", str(root / "run.json"),
                "--output", str(root / "report.json"),
            ], capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads((root / "report.json").read_text(encoding="utf-8"))
        self.assertEqual({key: report["summary"][key] for key in (
            "denominator", "contract_failed", "semantic_reviewed", "fidelity_failed",
            "unreviewed", "known_call_count", "known_elapsed_ms", "unknown_cost_count",
            "total_call_count", "total_elapsed_ms", "quality_verified",
        )}, {
            "denominator": 4, "contract_failed": 2, "semantic_reviewed": 1,
            "fidelity_failed": 1, "unreviewed": 3, "known_call_count": 3,
            "known_elapsed_ms": 1520, "unknown_cost_count": 1,
            "total_call_count": None, "total_elapsed_ms": None, "quality_verified": False,
        })
        self.assertEqual(report["summary"]["by_split"]["holdout"]["denominator"], 4)
        self.assertEqual(report["summary"]["by_split"]["development"]["denominator"], 0)
        self.assertEqual(report["summary"]["dimensions"]["intent"], {
            "denominator": 4, "evaluated_denominator": 1, "pass": 0, "fail": 1,
            "unknown": 0, "unreviewed": 3,
        })
        self.assertEqual(report["summary"]["dimensions"]["naturalness"]["unknown"], 1)
        self.assertEqual(report["summary"]["dimensions"]["naturalness"]["evaluated_denominator"], 0)
        self.assertEqual(report["cases"][0]["output"]["candidates"][0]["text"], "我一定去")
        self.assertEqual(report["cases"][1]["semantic_review"]["status"], "unreviewed")
        self.assertEqual(report["cases"][2]["status"], "timeout")
        self.assertEqual(report["cases"][3]["status"], "missing")
        generation_input = report["cases"][0]["generation_input"]
        self.assertNotIn("expected_answer", generation_input)
        self.assertNotIn("tags", generation_input)
        self.assertNotIn("forbidden_additions", generation_input)


if __name__ == "__main__":
    unittest.main()
