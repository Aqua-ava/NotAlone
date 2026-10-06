"""稳定性实验的公开命令边界；只用合成模型响应，不联网。"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

RUNNER = Path(__file__).resolve().parents[3] / ".scratch/memory-accuracy-next/repair-eval/run_truth_intent_repeatability.py"

class SyntheticModel:
    model_name = "ecnu-max"
    def __init__(self, unsafe=False, fail=False):
        self.calls = 0
        self.unsafe = unsafe
        self.fail = fail
        self.stage = ""
    def bind_tools(self, tools, **kwargs):
        self.stage = tools[0]["title"]
        return self
    def invoke(self, messages):
        self.calls += 1
        if self.fail:
            raise RuntimeError("synthetic-secret-must-not-be-logged")
        args = {"facts": []}
        if self.unsafe and self.calls == 4:
            source = re.search(r"message_id=([^\]]+)", messages[1]["content"])[1]
            self.source = source
            args = {"facts": [{"text": "联系人拥有一座城堡。", "category": "common_fact",
                "subject": "contact", "topic": "other", "source_message_ids": [source],
                "confidence": 0.95, "risk_flags": [], "valid_at": None, "invalid_at": None,
                "speech_act": "assertion", "assertion_status": "asserted",
                "figurative_type": "literal", "alternatives": [], "interpretation_reason": "合成测试"}]}
        elif self.unsafe and self.calls == 5:
            args = {"results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
                "evidence": [{"message_id": self.source, "quote": "我同事真讨厌，气死我了。"}]}]}
        return SimpleNamespace(tool_calls=[{"name": self.stage, "args": args}], invalid_tool_calls=[])

@unittest.skipUnless(RUNNER.is_file(), "实验脚本未分发")
class RepeatabilityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("repeat_runner", RUNNER)
        cls.runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.runner)

    def run_command(self, model, budget=40):
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder)/"run"
            with patch.dict(os.environ, {"NOTALONE_EVALUATION_API_KEY": "synthetic"}, clear=True), patch.object(self.runner, "build_evaluation_model", return_value=model), contextlib.redirect_stdout(io.StringIO()):
                self.runner.main(["--output-dir", str(out), "--budget", str(budget)])
            rows = [json.loads(x) for x in (out/"repeatability-results.jsonl").read_text().splitlines()]
            summary = json.loads((out/"repeatability-summary.json").read_text())
            calls = [json.loads(x) for x in (out/"calls.jsonl").read_text().splitlines()]
            manifest = json.loads((out/"manifest.json").read_text())
            self.assertEqual(out.stat().st_mode & 0o777, 0o700)
            for item in out.iterdir():
                self.assertEqual(item.stat().st_mode & 0o777, 0o600)
            return rows, summary, calls, manifest

    def test_two_rounds_reverse_order_and_keep_full_results(self):
        rows, summary, calls, manifest = self.run_command(SyntheticModel())
        self.assertEqual(len(rows), 20)
        self.assertEqual([r["case"] for r in rows[10:]], list(reversed([r["case"] for r in rows[:10]])))
        self.assertEqual(summary["calls_used"], 20)
        self.assertEqual(summary["unrun_positions"], 0)
        self.assertIn("failure_reason", rows[0])
        self.assertIn("facts", rows[0])
        self.assertEqual(manifest["case_names"][0], "明确事实")
        self.assertIn("prompt_sha256", manifest)
        self.assertEqual(len([x for x in calls if x["event"] == "reserved"]), 20)

    def test_false_fact_stops_before_next_position(self):
        model = SyntheticModel(unsafe=True)
        rows, summary, calls, manifest = self.run_command(model)
        self.assertEqual(len(rows), 4)
        self.assertEqual(model.calls, 5)
        self.assertEqual(summary["stopped"], "safety_error")
        self.assertEqual(rows[-1]["false_fact_count"], 1)

    def test_budget_stops_before_another_external_call(self):
        model = SyntheticModel()
        rows, summary, calls, manifest = self.run_command(model, budget=1)
        self.assertEqual(model.calls, 1)
        self.assertEqual(summary["stopped"], "budget_exhausted")
        self.assertEqual(summary["unrun_positions"], 19)

    def test_failures_keep_denominator_and_do_not_expose_exception_text(self):
        rows, summary, calls, manifest = self.run_command(SyntheticModel(fail=True))
        self.assertEqual(len(rows), 20)
        self.assertTrue(all(not row["passed"] and row["failure_reason"] for row in rows))
        self.assertNotIn("synthetic-secret", json.dumps((rows,summary,calls)))
        self.assertEqual(summary["call_failures"], 20)

    def test_invalid_budget_is_rejected_before_model_build(self):
        for budget in (0, -1, 41):
            with self.subTest(budget=budget), tempfile.TemporaryDirectory() as folder, patch.object(self.runner, "build_evaluation_model") as model:
                with self.assertRaises(SystemExit):
                    self.runner.main(["--output-dir", folder, "--budget", str(budget)])
                model.assert_not_called()
