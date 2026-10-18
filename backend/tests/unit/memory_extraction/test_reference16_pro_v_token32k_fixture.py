"""第七版分阶段token合同的冻结、CLI及真实自有worker离线控制。"""

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

# 生产launcher只提供backend/src；合成子进程显式加载已审测试helper。
if __name__ == "__main__" and len(sys.argv) == 5 and sys.argv[1] == "worker":
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from tests.unit.memory_extraction.test_reference16_pro_fixture import fixture_module, ROOT
from tests.unit.memory_extraction.test_reference16_pro_v_thinking_fixture import synthetic_owned_v_thinking_worker


PROFILE = "reference16-pro-retention-v-token32k"
PLAN_PATH = ".scratch/memory-extraction-accuracy/reference-v-token32k-plan-20261018.md"
PHASE_POLICY = {
    "extraction": {"thinking_mode": "disabled", "reasoning_effort": "none", "tool_choice_mode": "forced", "max_tokens": 8192},
    "verification": {"thinking_mode": "enabled", "reasoning_effort": "max", "tool_choice_mode": "omitted", "max_tokens": 32768},
}


class Reference16ProVToken32kFixtureTest(unittest.TestCase):
    def test_prepare_freezes_phase_tokens_without_global_tokens_budget_or_credentials(self):
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
            previous = module.prepare(directory=Path(temporary) / "previous", absolute_start=datetime.now(timezone.utc),
                profile="reference16-pro-retention-v-thinking", credential_path=key)
            frozen = module.prepare(directory=Path(temporary) / "run", absolute_start=datetime.now(timezone.utc),
                profile=PROFILE, credential_path=key)
            module.validate(frozen)
            expected = {key: value for key, value in previous["fixed"].items() if key != "max_tokens"}
            expected.update(execution_plan="reference16-pro-retention-v-token32k-v1",
                provider_profile="deepseek-pro-reference16-v-token32k-v1", request_contract_version=7,
                phase_request_version="deepseek-reference16-v-token32k-v1", phase_request_policy=PHASE_POLICY)
            self.assertEqual(frozen["fixed"], expected)
            self.assertEqual(module.fixed_contract(frozen), expected)
            self.assertEqual(module.owned_kind(frozen), "reference16-pro-retention-v-token32k")
            self.assertFalse(key.exists())
            for field in ("selection", "plan", "reference_canonical_sha256", "extraction_window_contracts",
                          "verification_prompt_sha256", "verification_schema_sha256", "credential_path"):
                self.assertEqual(frozen[field], previous[field], field)
            self.assertEqual(set(frozen["source_hashes"]), {*previous["source_hashes"], PLAN_PATH})
            self.assertEqual(frozen["source_hashes"][PLAN_PATH], helper.file_digest(ROOT / PLAN_PATH))
            for field in ("max_tokens", "thinking_type", "reasoning_effort"):
                self.assertNotIn(field, frozen["fixed"])
            self.assertEqual(previous["fixed"]["max_tokens"], 8192)
            for phase in ("extraction", "verification"):
                self.assertIs(type(frozen["fixed"]["phase_request_policy"][phase]["max_tokens"]), int)

    def test_cli_freezes_version_seven_without_opening_absent_key(self):
        module = fixture_module()
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "run"
            key = Path(temporary).resolve() / "absent-key.json"
            process = subprocess.run([sys.executable, str(ROOT / "desktop/tests/fixtures/reference21-v4-public.py"),
                "prepare-reference16-pro-retention-v-token32k", str(directory), datetime.now(timezone.utc).isoformat(), str(key)],
                cwd=ROOT, env={"PATH": "/usr/bin:/bin", "NOTALONE_DISABLE_DOTENV": "1", "PYTHONPATH": str(ROOT / "backend/src")},
                capture_output=True, text=True, timeout=30, check=False)
            self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
            frozen = module.helpers().read_private(directory / "freeze.json")
            self.assertEqual(json.loads(process.stdout), {"run_id": frozen["run_id"],
                "freeze_sha256": module.helpers().file_digest(directory / "freeze.json")})
            self.assertEqual(module.fixed_contract(frozen)["request_contract_version"], 7)
            self.assertEqual(frozen["fixed"]["phase_request_policy"], PHASE_POLICY)
            self.assertEqual(frozen["credential_path"], str(key))
            self.assertFalse(key.exists())
            self.assertEqual(list((directory / "evaluation").iterdir()), [])
            self.assertEqual(list((directory / "audit").iterdir()), [])
            module.validate(frozen)

    def test_mixed_global_tokens_or_invalid_phase_tokens_and_cross_profile_reject(self):
        module = fixture_module()
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}):
            frozen = module.prepare(directory=Path(temporary) / "run", absolute_start=datetime.now(timezone.utc),
                profile=PROFILE, credential_path=Path(temporary).resolve() / "absent-key.json")
            for phase in ("extraction", "verification"):
                for value in (True, False, 8192.0, 32768.0, "32768", None, 0, 16384,
                              32768 if phase == "extraction" else 8192):
                    changed = deepcopy(frozen)
                    changed["fixed"]["phase_request_policy"][phase]["max_tokens"] = value
                    with self.subTest(phase=phase, value=value), self.assertRaises(ValueError):
                        module.validate(changed)
                changed = deepcopy(frozen)
                changed["fixed"]["phase_request_policy"][phase].pop("max_tokens")
                with self.subTest(phase=phase, fault="missing"), self.assertRaises(ValueError):
                    module.validate(changed)
            for field, value in (("max_tokens", 32768), ("thinking_type", "enabled"), ("reasoning_effort", "max"),
                    ("provider_profile", "deepseek-pro-reference16-v-thinking-v1"), ("request_contract_version", 6),
                    ("execution_plan", "reference16-pro-retention-v-thinking-v1"),
                    ("phase_request_version", "deepseek-reference16-v-thinking-v1")):
                changed = deepcopy(frozen)
                changed["fixed"][field] = value
                with self.subTest(field=field), self.assertRaises(ValueError):
                    module.validate(changed)
            for missing in (False, True):
                changed = deepcopy(frozen)
                if missing:
                    changed["source_hashes"].pop(PLAN_PATH)
                else:
                    changed["source_hashes"][PLAN_PATH] = "f" * 64
                with self.subTest(missing_source=missing), self.assertRaises(ValueError):
                    module.validate(changed)

    def test_owned_worker_sends_e8192_v32768_then_closes_and_cleans(self):
        from notalone.memory_extraction import evaluation_owned_process as owned

        module = fixture_module()
        helper = module.helpers()
        real_launch = owned._launch_owned_public_worker

        def synthetic_launch(**arguments):
            arguments["script"] = Path(__file__).resolve()
            return real_launch(**arguments)

        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}):
            directory = Path(temporary).resolve() / "run"
            frozen = module.prepare(directory=directory, absolute_start=datetime.now(timezone.utc),
                profile=PROFILE, credential_path=Path(temporary).resolve() / "synthetic-key.json")
            freeze_path = directory / "freeze.json"
            digest = helper.file_digest(freeze_path)
            approval_path = directory / "approval.json"
            helper.publish(approval_path, {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": digest})
            with patch.object(owned, "_launch_owned_public_worker", side_effect=synthetic_launch):
                finish = module.launch(freeze_path=freeze_path, expected_sha256=digest, approval_path=approval_path)
            log = directory / "worker.log"
            self.assertEqual(finish["exit_code"], 0, {**finish, "worker_log": log.read_text() if log.exists() else "missing"})
            self.assertTrue(finish["worker_gone"], finish)
            self.assertTrue(finish["closed"], finish)
            self.assertFalse(finish["quality_certified"])
            control = helper.read_private(directory / "synthetic-control.json")
            self.assertEqual(control["credentials_loaded"], 1)
            self.assertTrue(control["claimed_before_key"])
            self.assertFalse(control["closed_before_key"])
            self.assertEqual(control["reserved_before_key"], 0)
            self.assertEqual(control["order"], ["claimed", "key_loaded", "http:GroundedMemoryLabels", "http:SourceVerificationOutput"])
            self.assertEqual(control["config"], {"provider_profile": "deepseek-pro-reference16-v-token32k-v1",
                "request_contract_version": 7, "phase_request_version": "deepseek-reference16-v-token32k-v1",
                "phase_request_policy": PHASE_POLICY, "global_thinking_present": False, "global_effort_present": False})
            self.assertEqual(control["requests"], [
                {"tool": "GroundedMemoryLabels", "model": "deepseek-v4-pro", "thinking": {"type": "disabled"},
                 "reasoning_effort": "none", "max_tokens": 8192, "tool_choice_present": True,
                 "tool_choice": {"type": "function", "function": {"name": "GroundedMemoryLabels"}}},
                {"tool": "SourceVerificationOutput", "model": "deepseek-v4-pro", "thinking": {"type": "enabled"},
                 "reasoning_effort": "max", "max_tokens": 32768, "tool_choice_present": False, "tool_choice": None},
            ])
            config = helper.read_private(directory / "evaluation/manifest.json")["frozen_config"]
            for field in ("max_tokens", "thinking", "thinking_type", "reasoning_effort"):
                self.assertNotIn(field, config)
            result = helper.read_private(directory / "result.json")
            self.assertIsNotNone(result["stopped_code"])
            self.assertTrue(result["receipt"]["budget"]["closed"])
            self.assertEqual(result["receipt"]["budget"]["request_limit"], 32)
            self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 2)
            self.assertEqual(result["summary"]["unrun"], 15)
            self.assertFalse(result["summary"]["plan_complete"])
            self.assertFalse(Path(frozen["credential_path"]).exists())
            with self.assertRaises(ProcessLookupError):
                os.killpg(finish["process_group"], 0)


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "worker":
        if sys.stdin.buffer.readline(7) != b"start\n":
            raise AssertionError("必须由生产launcher握手")
        try:
            synthetic_owned_v_thinking_worker(Path(sys.argv[2]), sys.argv[3], Path(sys.argv[4]))
        except Exception:
            import traceback
            (Path(sys.argv[2]).parent / "worker.log").write_text(traceback.format_exc())
            raise
    else:
        unittest.main()
