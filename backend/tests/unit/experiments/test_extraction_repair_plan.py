"""修复复测只允许原公开窗口，准备阶段不发出模型请求。"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[4]
SPEC = importlib.util.spec_from_file_location(
    "extraction_comparison", ROOT / "scripts/compare_tencent_extraction.py",
)
assert SPEC is not None and SPEC.loader is not None
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class RepairPlanTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        upstream = self.root / "prompt.ts"
        upstream.write_text("export const EXTRACT_MEMORIES_SYSTEM_PROMPT = `合成提示`;", encoding="utf-8")
        self.baseline = self.root / "baseline"
        RUNNER.prepare(self.baseline, upstream)
        plan = json.loads((self.baseline / "plan.json").read_text())
        jobs = [job for job in plan["jobs"] if job["arm"] == "notalone"]
        for job in jobs:
            del job["request"]["tool_choice"]
            job["request"]["messages"][0]["content"] = "合成旧提示"
        plan.update(cap=6, jobs=jobs)
        self.plan = plan
        self._write_baseline()

    def _write_baseline(self) -> None:
        (self.baseline / "plan.json").write_text(json.dumps(self.plan), encoding="utf-8")

    def test_preparation_preserves_inputs_and_protocol_without_calling_model(self) -> None:
        output = self.root / "repair"
        RUNNER.prepare_repair(output, self.baseline)
        prepared = json.loads((output / "plan.json").read_text())
        self.assertEqual(prepared["cap"], 6)
        self.assertEqual(prepared["reference"], self.plan["reference"])
        for before, after in zip(self.plan["jobs"], prepared["jobs"]):
            expected = json.loads(json.dumps(before["request"]))
            expected["messages"][0]["content"] = RUNNER.EXTRACTION_SYSTEM_PROMPT
            self.assertEqual(after["request"], expected)
        self.assertEqual([p.name for p in output.iterdir()], ["plan.json"])

    def test_modified_source_or_protocol_cannot_be_replayed(self) -> None:
        for field in ("source", "protocol", "gold", "schema"):
            with self.subTest(field=field):
                original = json.loads(json.dumps(self.plan))
                if field == "source":
                    self.plan["jobs"][0]["request"]["messages"][1]["content"] = "非原窗口"
                elif field == "protocol":
                    self.plan["jobs"][0]["request"]["temperature"] = 0.9
                elif field == "schema":
                    self.plan["jobs"][0]["request"]["tools"][0]["function"]["parameters"]["required"] = []
                else:
                    self.plan["reference_sha256"] = "0" * 64
                self._write_baseline()
                with self.assertRaises(ValueError):
                    RUNNER.prepare_repair(self.root / field, self.baseline)
                self.assertFalse((self.root / field).exists())
                self.plan = original

    def test_field_descriptions_can_change_without_changing_schema_contract(self) -> None:
        old_tools = self.plan["jobs"][0]["request"]["tools"]
        old_tools[0]["function"]["parameters"]["properties"]["facts"]["description"] = "合成旧字段说明"
        self._write_baseline()
        output = self.root / "updated-descriptions"
        RUNNER.prepare_repair(output, self.baseline)
        prepared = json.loads((output / "plan.json").read_text())
        new_tools = prepared["jobs"][0]["request"]["tools"]
        self.assertNotEqual(new_tools, old_tools)
        self.assertEqual(RUNNER._without_descriptions(new_tools), RUNNER._without_descriptions(old_tools))
