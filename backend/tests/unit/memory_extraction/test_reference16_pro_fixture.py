"""原公开16窗Pro入口的冻结与独占执行离线控制。"""

from copy import deepcopy
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget


ROOT = Path(__file__).resolve().parents[4]


def fixture_module():
    path = ROOT / "desktop/tests/fixtures/reference21-v4-public.py"
    spec = importlib.util.spec_from_file_location("reference16_pro_fixture_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Reference16ProFixtureTest(unittest.TestCase):
    def test_prepare_freezes_original_sixteen_e2_contracts_without_budget_or_key(self):
        from notalone.memory_extraction.evaluation import build_window
        from notalone.memory_extraction.evaluation_ecnu import _PLAN_CASES
        from notalone.memory_extraction.evaluation_extraction import extraction_contract

        module = fixture_module()
        helper = module.helpers()

        def forbidden(*args, **kwargs):
            self.fail("准备和冻结验证不得领取预算或读取凭据")

        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}), \
                patch.object(EvaluationBudget, "create", side_effect=forbidden), \
                patch.object(module, "read_pro_credential", side_effect=forbidden):
            key = Path(temporary).resolve() / "absent-key.json"
            frozen = module.prepare(directory=Path(temporary) / "run", absolute_start=datetime.now(timezone.utc),
                                    profile="reference16-pro", credential_path=key)
            module.validate(frozen)
            self.assertFalse(key.exists())
            self.assertEqual(frozen["credential_path"], str(key))
            self.assertEqual(frozen["selection"], [{"case_id": f"A{index + 1:02d}", "gold_position": index}
                                                    for index in range(16)])
            self.assertEqual([row["case_name"] for row in frozen["plan"]], [case.name for case in _PLAN_CASES[:16]])
            expected = {"execution_plan": "reference16-pro-v1", "case_positions": list(range(16)),
                "case_set": "reference21", "reference_version": "source-fidelity-v2", "planned_windows": 16,
                "required_claims": 18, "optional_claims": 1, "provider_profile": "deepseek-pro-reference16-v1",
                "request_contract_version": 4, "request_model": "deepseek-v4-pro", "response_model": "deepseek-v4-pro",
                "request_limit": 32, "max_tokens": 8192, "request_timeout_seconds": 300, "max_retries": 0,
                "extraction_mode": "grounded-v2", "verification_mode": "legacy-v4", "extraction_tool_choice": "forced",
                "verification_tool_choice": "forced", "thinking_type": "disabled", "reasoning_effort": "none",
                "phase_wall_seconds": 600, "call_wall_seconds": 600, "batch_work_seconds": 14380,
                "outer_wall_seconds": 14400}
            self.assertEqual(frozen["fixed"], expected)
            self.assertNotIn("formal_sources", frozen)
            self.assertNotIn("phase_request_policy", frozen["fixed"])
            self.assertTrue({module.REFERENCE, module.ANNOTATION, "desktop/tests/fixtures/reference21-v4-public.py",
                "desktop/tests/fixtures/grounded_public21.py", "desktop/tests/fixtures/explicit_review_bridge.py"}
                <= set(frozen["source_hashes"]))
            for case, row in zip(_PLAN_CASES[:16], frozen["extraction_window_contracts"], strict=True):
                prompt, schema = extraction_contract("grounded-v2", build_window(case))
                self.assertEqual(row["prompt_sha256"], helper.digest(prompt))
                self.assertEqual(row["schema_sha256"], helper.digest(schema))

    def test_changed_counts_selection_contract_sources_and_gold_reject(self):
        module = fixture_module()
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}):
            frozen = module.prepare(directory=Path(temporary) / "run", absolute_start=datetime.now(timezone.utc),
                profile="reference16-pro", credential_path=Path(temporary).resolve() / "absent-key.json")
            for fault in ("planned_windows", "required_claims", "optional_claims", "request_limit", "gold", "selection",
                          "contract", "source", "source_closure", "credential"):
                changed = deepcopy(frozen)
                if fault in {"planned_windows", "required_claims", "optional_claims", "request_limit"}:
                    changed["fixed"][fault] += 1
                elif fault == "gold":
                    changed["reference_canonical_sha256"] = "a" * 64
                elif fault == "selection":
                    changed["selection"][-1]["gold_position"] = 16
                elif fault == "contract":
                    changed["extraction_window_contracts"][0]["prompt_sha256"] = "a" * 64
                elif fault == "source":
                    changed["source_hashes"][module.REFERENCE] = "a" * 64
                elif fault == "source_closure":
                    changed["source_hashes"].pop("desktop/tests/fixtures/reference21-v4-public.py")
                else:
                    changed["credential_path"] = "relative.json"
                with self.subTest(fault=fault), self.assertRaises(ValueError):
                    module.validate(changed)

    def test_owned_mock_worker_claims_before_key_and_closes_failed_request(self):
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
                profile="reference16-pro", credential_path=Path(temporary).resolve() / "synthetic-key.json")
            freeze_path = directory / "freeze.json"
            digest = helper.file_digest(freeze_path)
            approval_path = directory / "approval.json"
            helper.publish(approval_path, {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": digest})
            with patch.object(owned, "_launch_owned_public_worker", side_effect=synthetic_launch):
                finish = module.launch(freeze_path=freeze_path, expected_sha256=digest, approval_path=approval_path)
            self.assertEqual(finish["exit_code"], 0, {**finish, "worker_log": (directory / "worker.log").read_text() if (directory / "worker.log").exists() else "missing"})
            self.assertTrue(finish["worker_gone"], finish)
            self.assertTrue(finish["closed"], finish)
            self.assertFalse(finish["quality_certified"])
            self.assertEqual(helper.read_private(directory / "synthetic-control.json"),
                             {"requests": 1, "credentials_loaded": 1, "claimed_before_key": True})
            result = helper.read_private(directory / "result.json")
            self.assertIsNotNone(result["stopped_code"])
            self.assertEqual(result["receipt"]["budget"]["request_limit"], 32)
            self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 1)
            self.assertEqual(result["summary"]["unrun"], 15)
            self.assertFalse(Path(frozen["credential_path"]).exists())


def synthetic_owned_worker(freeze_path, digest, approval_path):
    """真实launcher与预算领取；SDK只接MockTransport，密钥仅为临时合成文件。"""
    import httpx

    module = fixture_module()
    helper = module.helpers()
    directory = freeze_path.parent
    frozen = helper.read_private(freeze_path)
    synthetic_home = directory / "synthetic-home"
    synthetic_home.mkdir(mode=0o700)
    counts = {"requests": 0, "credentials_loaded": 0, "claimed_before_key": False}

    def forbidden(*args, **kwargs):
        raise AssertionError("离线fixture不得访问真实HTTP或凭据")

    def credential():
        run = synthetic_home / ".notalone-memory-evaluations" / frozen["run_id"]
        if not (run / "claimed").is_file() or (run / "closed").exists():
            raise AssertionError("必须先领取仍有效的预算再读取合成凭据")
        config = helper.read_private(directory / "evaluation/manifest.json")["frozen_config"]
        if config["provider_profile"] != "deepseek-pro-reference16-v1" or config["request_contract_version"] != 4:
            raise AssertionError("凭据读取前必须冻结Pro16合同")
        counts["claimed_before_key"] = True
        counts["credentials_loaded"] += 1
        path = Path(frozen["credential_path"])
        helper.publish(path, {"api_key": "synthetic-only"})
        try:
            return module.read_pro_credential(path)
        finally:
            path.unlink()

    def respond(request):
        counts["requests"] += 1
        body = json.loads(request.content)
        if (counts["credentials_loaded"] != 1 or body["model"] != "deepseek-v4-pro"
                or body.get("max_tokens") != 8192 or body.get("thinking") != {"type": "disabled"}
                or body["tool_choice"] != {"type": "function", "function": {"name": "GroundedMemoryLabels"}}
                or "reasoning_effort" in body):
            raise AssertionError("实际首轮请求未遵循冻结合同")
        return httpx.Response(503, request=request, json={"error": {"message": "synthetic stop"}})

    with patch.object(Path, "home", return_value=synthetic_home), patch.object(module, "helpers", return_value=helper), \
            patch.object(helper, "read_credential", side_effect=forbidden), \
            patch.object(httpx.HTTPTransport, "handle_request", side_effect=forbidden), \
            patch.object(httpx.AsyncHTTPTransport, "handle_async_request", side_effect=forbidden):
        module.worker(freeze_path=freeze_path, expected_sha256=digest, approval=helper.read_private(approval_path),
            synthetic_transport=httpx.MockTransport(respond), credential_loader=credential)
    helper.publish(directory / "synthetic-control.json", counts)


if __name__ == "__main__":
    import sys
    if len(sys.argv) == 5 and sys.argv[1] == "worker":
        if sys.stdin.buffer.readline(7) != b"start\n":
            raise AssertionError("必须由生产launcher握手")
        try:
            synthetic_owned_worker(Path(sys.argv[2]), sys.argv[3], Path(sys.argv[4]))
        except Exception:
            import traceback
            (Path(sys.argv[2]).parent / "worker.log").write_text(traceback.format_exc())
            raise
    else:
        unittest.main()
