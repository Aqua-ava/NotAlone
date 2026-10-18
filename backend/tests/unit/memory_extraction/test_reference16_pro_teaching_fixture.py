"""独立教学提示档的公开16窗准备与CLI冻结控制；不访问真实模型或凭据。"""

from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget
from tests.unit.memory_extraction.test_reference16_pro_fixture import fixture_module, ROOT


TEACHING_PLAN = ".scratch/memory-extraction-accuracy/reference-kind-teaching-plan-20261018.md"


class Reference16ProTeachingFixtureTest(unittest.TestCase):
    def test_prepare_freezes_distinct_teaching_contract_without_budget_or_credentials(self):
        module = fixture_module()
        helper = module.helpers()

        def forbidden(*args, **kwargs):
            self.fail("教学准备不得领取预算或读取凭据")

        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}), \
                patch.object(EvaluationBudget, "create", side_effect=forbidden), \
                patch.object(module, "read_pro_credential", side_effect=forbidden):
            key = Path(temporary).resolve() / "absent-key.json"
            original = module.prepare(directory=Path(temporary) / "original", absolute_start=datetime.now(timezone.utc),
                                      profile="reference16-pro", credential_path=key)
            teaching = module.prepare(directory=Path(temporary) / "teaching", absolute_start=datetime.now(timezone.utc),
                                      profile="reference16-pro-teaching", credential_path=key)
            module.validate(teaching)
            self.assertFalse(key.exists())
            expected = {**original["fixed"], "execution_plan": "reference16-pro-teaching-v1",
                        "extraction_prompt_profile": "reference-kind-teaching-v1"}
            self.assertEqual(teaching["fixed"], expected)
            self.assertEqual(module.fixed_contract(teaching), expected)
            self.assertEqual(module.owned_kind(teaching), "reference16-pro-teaching")
            self.assertEqual(teaching["selection"], original["selection"])
            self.assertEqual(teaching["plan"], original["plan"])
            self.assertEqual(teaching["reference_canonical_sha256"], original["reference_canonical_sha256"])
            self.assertEqual(teaching["verification_prompt_sha256"], original["verification_prompt_sha256"])
            self.assertEqual(teaching["verification_schema_sha256"], original["verification_schema_sha256"])
            self.assertEqual(set(teaching["source_hashes"]), {*original["source_hashes"], TEACHING_PLAN})
            self.assertEqual(teaching["source_hashes"][TEACHING_PLAN], helper.file_digest(ROOT / TEACHING_PLAN))
            self.assertEqual(teaching["credential_path"], str(key))
            self.assertNotIn("extraction_prompt_profile", original["fixed"])
            self.assertNotIn("formal_sources", teaching)
            for old, new in zip(original["extraction_window_contracts"], teaching["extraction_window_contracts"], strict=True):
                self.assertNotEqual(new["prompt_sha256"], old["prompt_sha256"])
                self.assertEqual(new["schema_sha256"], old["schema_sha256"])
                self.assertEqual(new["input_sha256"], old["input_sha256"])

    def test_cli_creates_teaching_freeze_with_explicit_absent_key(self):
        module = fixture_module()
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "run"
            key = Path(temporary).resolve() / "absent-key.json"
            process = subprocess.run([sys.executable, str(ROOT / "desktop/tests/fixtures/reference21-v4-public.py"),
                "prepare-reference16-pro-teaching", str(directory), datetime.now(timezone.utc).isoformat(), str(key)],
                cwd=ROOT, env={"PATH": "/usr/bin:/bin", "NOTALONE_DISABLE_DOTENV": "1", "PYTHONPATH": str(ROOT / "backend/src")},
                capture_output=True, text=True, timeout=30, check=False)
            self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
            receipt = json.loads(process.stdout)
            frozen = module.helpers().read_private(directory / "freeze.json")
            self.assertEqual(receipt, {"run_id": frozen["run_id"],
                "freeze_sha256": module.helpers().file_digest(directory / "freeze.json")})
            self.assertEqual(module.fixed_contract(frozen)["execution_plan"], "reference16-pro-teaching-v1")
            self.assertEqual(frozen["fixed"]["extraction_prompt_profile"], "reference-kind-teaching-v1")
            self.assertEqual(frozen["credential_path"], str(key))
            self.assertFalse(key.exists())
            self.assertEqual(list((directory / "evaluation").iterdir()), [])
            self.assertEqual(list((directory / "audit").iterdir()), [])
            module.validate(frozen)

    def test_teaching_prompt_plan_and_source_mismatch_reject_before_execution(self):
        module = fixture_module()
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}):
            frozen = module.prepare(directory=Path(temporary) / "run", absolute_start=datetime.now(timezone.utc),
                profile="reference16-pro-teaching", credential_path=Path(temporary).resolve() / "absent-key.json")
            for fault in ("missing_profile", "default_profile", "old_plan", "missing_source", "source_drift"):
                changed = deepcopy(frozen)
                if fault == "missing_profile":
                    changed["fixed"].pop("extraction_prompt_profile")
                elif fault == "default_profile":
                    changed["fixed"]["extraction_prompt_profile"] = "default"
                elif fault == "old_plan":
                    changed["fixed"]["execution_plan"] = "reference16-pro-v1"
                elif fault == "missing_source":
                    changed["source_hashes"].pop(TEACHING_PLAN)
                else:
                    changed["source_hashes"][TEACHING_PLAN] = "f" * 64
                with self.subTest(fault=fault), self.assertRaises(ValueError):
                    module.validate(changed)
