"""保留原文验证提示档的公开16窗准备控制；只生成临时冻结文件。"""

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


RETENTION_PLAN = ".scratch/memory-extraction-accuracy/reference-verification-retention-plan-20261018.md"


class Reference16ProRetentionFixtureTest(unittest.TestCase):
    def test_prepare_changes_only_verification_prompt_and_retention_source_without_key_or_budget(self):
        module = fixture_module()
        helper = module.helpers()

        def forbidden(*args, **kwargs):
            self.fail("准备及验证冻结不得领取预算或读取凭据")

        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}), \
                patch.object(EvaluationBudget, "create", side_effect=forbidden), \
                patch.object(module, "helpers", return_value=helper), \
                patch.object(helper, "read_credential", side_effect=forbidden), \
                patch.object(module, "read_pro_credential", side_effect=forbidden):
            key = Path(temporary).resolve() / "absent-key.json"
            teaching = module.prepare(directory=Path(temporary) / "teaching", absolute_start=datetime.now(timezone.utc),
                                      profile="reference16-pro-teaching", credential_path=key)
            retention = module.prepare(directory=Path(temporary) / "retention", absolute_start=datetime.now(timezone.utc),
                                       profile="reference16-pro-retention", credential_path=key)
            module.validate(retention)
            self.assertFalse(key.exists())
            expected = {**teaching["fixed"], "execution_plan": "reference16-pro-retention-v1",
                        "prompt_profile": "reference-retention-v1"}
            self.assertEqual(retention["fixed"], expected)
            self.assertEqual(module.fixed_contract(retention), expected)
            self.assertEqual(module.owned_kind(retention), "reference16-pro-retention")
            for field in ("selection", "plan", "reference_canonical_sha256", "extraction_window_contracts",
                          "verification_schema_sha256", "credential_path"):
                self.assertEqual(retention[field], teaching[field], field)
            self.assertNotEqual(retention["verification_prompt_sha256"], teaching["verification_prompt_sha256"])
            self.assertEqual(set(retention["source_hashes"]), {*teaching["source_hashes"], RETENTION_PLAN})
            self.assertEqual(retention["source_hashes"][RETENTION_PLAN], helper.file_digest(ROOT / RETENTION_PLAN))
            self.assertNotIn("prompt_profile", teaching["fixed"])
            self.assertNotIn("formal_sources", retention)

    def test_cli_freezes_retention_profile_without_opening_absent_key(self):
        module = fixture_module()
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "run"
            key = Path(temporary).resolve() / "absent-key.json"
            process = subprocess.run([sys.executable, str(ROOT / "desktop/tests/fixtures/reference21-v4-public.py"),
                "prepare-reference16-pro-retention", str(directory), datetime.now(timezone.utc).isoformat(), str(key)],
                cwd=ROOT, env={"PATH": "/usr/bin:/bin", "NOTALONE_DISABLE_DOTENV": "1", "PYTHONPATH": str(ROOT / "backend/src")},
                capture_output=True, text=True, timeout=30, check=False)
            self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
            frozen = module.helpers().read_private(directory / "freeze.json")
            self.assertEqual(json.loads(process.stdout), {"run_id": frozen["run_id"],
                "freeze_sha256": module.helpers().file_digest(directory / "freeze.json")})
            self.assertEqual(module.fixed_contract(frozen)["execution_plan"], "reference16-pro-retention-v1")
            self.assertEqual(frozen["fixed"]["extraction_prompt_profile"], "reference-kind-teaching-v1")
            self.assertEqual(frozen["fixed"]["prompt_profile"], "reference-retention-v1")
            self.assertEqual(frozen["credential_path"], str(key))
            self.assertFalse(key.exists())
            self.assertEqual(list((directory / "evaluation").iterdir()), [])
            self.assertEqual(list((directory / "audit").iterdir()), [])
            module.validate(frozen)

    def test_cross_profile_prompt_hash_and_source_changes_reject(self):
        module = fixture_module()
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}):
            key = Path(temporary).resolve() / "absent-key.json"
            teaching = module.prepare(directory=Path(temporary) / "teaching", absolute_start=datetime.now(timezone.utc),
                profile="reference16-pro-teaching", credential_path=key)
            retention = module.prepare(directory=Path(temporary) / "retention", absolute_start=datetime.now(timezone.utc),
                profile="reference16-pro-retention", credential_path=key)
            changes = (
                ("missing_v", retention, lambda row: row["fixed"].pop("prompt_profile")),
                ("default_v", retention, lambda row: row["fixed"].update(prompt_profile="default")),
                ("teaching_plan", retention, lambda row: row["fixed"].update(execution_plan="reference16-pro-teaching-v1")),
                ("original_plan", retention, lambda row: row["fixed"].update(execution_plan="reference16-pro-v1")),
                ("wrong_e", retention, lambda row: row["fixed"].update(extraction_prompt_profile="default")),
                ("default_v_hash", retention, lambda row: row.update(verification_prompt_sha256=teaching["verification_prompt_sha256"])),
                ("missing_source", retention, lambda row: row["source_hashes"].pop(RETENTION_PLAN)),
                ("source_drift", retention, lambda row: row["source_hashes"].update({RETENTION_PLAN: "f" * 64})),
                ("old_plan_with_retention_v", teaching, lambda row: row["fixed"].update(prompt_profile="reference-retention-v1")),
            )
            for fault, original, mutate in changes:
                changed = deepcopy(original)
                mutate(changed)
                with self.subTest(fault=fault), self.assertRaises(ValueError):
                    module.validate(changed)
