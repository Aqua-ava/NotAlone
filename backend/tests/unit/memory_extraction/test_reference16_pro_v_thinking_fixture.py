"""第六版分阶段思考合同的准备控制；只生成临时冻结文件。"""

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
# 生产launcher只提供backend/src；合成子进程显式加载同仓测试helper。
if __name__ == "__main__" and len(sys.argv) == 5 and sys.argv[1] == "worker":
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from tests.unit.memory_extraction.test_reference16_pro_fixture import fixture_module, ROOT


THINKING_PLAN = ".scratch/memory-extraction-accuracy/reference-v-thinking-plan-20261018.md"
PROFILE = "reference16-pro-retention-v-thinking"
PHASE_POLICY = {
    "extraction": {"thinking_mode": "disabled", "reasoning_effort": "none", "tool_choice_mode": "forced"},
    "verification": {"thinking_mode": "enabled", "reasoning_effort": "max", "tool_choice_mode": "omitted"},
}


class Reference16ProVThinkingFixtureTest(unittest.TestCase):
    def test_prepare_freezes_phase_split_version_six_without_budget_or_credentials(self):
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
            retention = module.prepare(directory=Path(temporary) / "retention", absolute_start=datetime.now(timezone.utc),
                                      profile="reference16-pro-retention", credential_path=key)
            thinking = module.prepare(directory=Path(temporary) / "thinking", absolute_start=datetime.now(timezone.utc),
                                      profile=PROFILE, credential_path=key)
            module.validate(thinking)
            self.assertFalse(key.exists())
            expected = {key: value for key, value in retention["fixed"].items()
                        if key not in {"thinking_type", "reasoning_effort"}}
            expected.update(execution_plan="reference16-pro-retention-v-thinking-v1",
                provider_profile="deepseek-pro-reference16-v-thinking-v1", request_contract_version=6,
                verification_tool_choice="omitted", phase_request_version="deepseek-reference16-v-thinking-v1",
                phase_request_policy=PHASE_POLICY)
            self.assertEqual(thinking["fixed"], expected)
            self.assertEqual(module.fixed_contract(thinking), expected)
            self.assertEqual(module.owned_kind(thinking), "reference16-pro-retention-v-thinking")
            for field in ("selection", "plan", "reference_canonical_sha256", "extraction_window_contracts",
                          "verification_prompt_sha256", "verification_schema_sha256", "credential_path"):
                self.assertEqual(thinking[field], retention[field], field)
            self.assertEqual(set(thinking["source_hashes"]), {*retention["source_hashes"], THINKING_PLAN})
            self.assertEqual(thinking["source_hashes"][THINKING_PLAN], helper.file_digest(ROOT / THINKING_PLAN))
            self.assertNotIn("formal_sources", thinking)

    def test_cli_freezes_version_six_without_opening_absent_key(self):
        module = fixture_module()
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / "run"
            key = Path(temporary).resolve() / "absent-key.json"
            process = subprocess.run([sys.executable, str(ROOT / "desktop/tests/fixtures/reference21-v4-public.py"),
                "prepare-reference16-pro-retention-v-thinking", str(directory), datetime.now(timezone.utc).isoformat(), str(key)],
                cwd=ROOT, env={"PATH": "/usr/bin:/bin", "NOTALONE_DISABLE_DOTENV": "1", "PYTHONPATH": str(ROOT / "backend/src")},
                capture_output=True, text=True, timeout=30, check=False)
            self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
            frozen = module.helpers().read_private(directory / "freeze.json")
            self.assertEqual(json.loads(process.stdout), {"run_id": frozen["run_id"],
                "freeze_sha256": module.helpers().file_digest(directory / "freeze.json")})
            fixed = module.fixed_contract(frozen)
            self.assertEqual(fixed["execution_plan"], "reference16-pro-retention-v-thinking-v1")
            self.assertEqual(fixed["request_contract_version"], 6)
            self.assertEqual(fixed["phase_request_policy"], PHASE_POLICY)
            self.assertNotIn("thinking_type", fixed)
            self.assertNotIn("reasoning_effort", fixed)
            self.assertEqual(frozen["credential_path"], str(key))
            self.assertFalse(key.exists())
            self.assertEqual(list((directory / "evaluation").iterdir()), [])
            self.assertEqual(list((directory / "audit").iterdir()), [])
            module.validate(frozen)

    def test_cross_provider_phase_version_policy_and_source_changes_reject(self):
        module = fixture_module()
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}):
            frozen = module.prepare(directory=Path(temporary) / "run", absolute_start=datetime.now(timezone.utc),
                profile=PROFILE, credential_path=Path(temporary).resolve() / "absent-key.json")
            changes = (
                ("old_provider", lambda row: row["fixed"].update(provider_profile="deepseek-pro-reference16-v1")),
                ("old_plan", lambda row: row["fixed"].update(execution_plan="reference16-pro-retention-v1")),
                ("contract_five", lambda row: row["fixed"].update(request_contract_version=5)),
                ("legacy_phase_version", lambda row: row["fixed"].update(phase_request_version="deepseek-phase-split-v1")),
                ("missing_policy", lambda row: row["fixed"].pop("phase_request_policy")),
                ("v_off", lambda row: row["fixed"]["phase_request_policy"]["verification"].update(thinking_mode="disabled")),
                ("v_none", lambda row: row["fixed"]["phase_request_policy"]["verification"].update(reasoning_effort="none")),
                ("v_forced_policy", lambda row: row["fixed"]["phase_request_policy"]["verification"].update(tool_choice_mode="forced")),
                ("v_forced", lambda row: row["fixed"].update(verification_tool_choice="forced")),
                ("e_thinking", lambda row: row["fixed"]["phase_request_policy"]["extraction"].update(thinking_mode="enabled")),
                ("e_omitted", lambda row: row["fixed"].update(extraction_tool_choice="omitted")),
                ("mixed_global_thinking", lambda row: row["fixed"].update(thinking_type="enabled")),
                ("mixed_global_effort", lambda row: row["fixed"].update(reasoning_effort="max")),
                ("missing_source", lambda row: row["source_hashes"].pop(THINKING_PLAN)),
                ("source_drift", lambda row: row["source_hashes"].update({THINKING_PLAN: "f" * 64})),
            )
            for fault, mutate in changes:
                changed = deepcopy(frozen)
                mutate(changed)
                with self.subTest(fault=fault), self.assertRaises(ValueError):
                    module.validate(changed)

    def test_owned_worker_dispatches_both_phases_and_closes_after_v_http_failure(self):
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
            self.assertEqual(control["config"], {"provider_profile": "deepseek-pro-reference16-v-thinking-v1",
                "request_contract_version": 6, "phase_request_version": "deepseek-reference16-v-thinking-v1",
                "phase_request_policy": PHASE_POLICY, "global_thinking_present": False, "global_effort_present": False})
            self.assertEqual(control["requests"], [
                {"tool": "GroundedMemoryLabels", "model": "deepseek-v4-pro", "thinking": {"type": "disabled"},
                 "reasoning_effort": "none", "max_tokens": 8192, "tool_choice_present": True,
                 "tool_choice": {"type": "function", "function": {"name": "GroundedMemoryLabels"}}},
                {"tool": "SourceVerificationOutput", "model": "deepseek-v4-pro", "thinking": {"type": "enabled"},
                 "reasoning_effort": "max", "max_tokens": 8192, "tool_choice_present": False, "tool_choice": None},
            ])
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


def synthetic_owned_v_thinking_worker(freeze_path, digest, approval_path):
    """记录实际边界值，交由父进程断言；不在会被硬停捕获的HTTP回调内断言。"""
    import sqlite3
    import httpx

    module = fixture_module()
    helper = module.helpers()
    directory = freeze_path.parent
    frozen = helper.read_private(freeze_path)
    synthetic_home = directory / "synthetic-home"
    synthetic_home.mkdir(mode=0o700)
    control = {"credentials_loaded": 0, "claimed_before_key": False, "closed_before_key": None,
               "reserved_before_key": None, "order": [], "config": {}, "requests": []}

    def forbidden(*args, **kwargs):
        raise AssertionError("离线fixture不得访问真实HTTP或凭据")

    def credential():
        run = synthetic_home / ".notalone-memory-evaluations" / frozen["run_id"]
        control["claimed_before_key"] = (run / "claimed").is_file()
        control["closed_before_key"] = (run / "closed").exists()
        with sqlite3.connect((run / "budget.sqlite3").as_uri() + "?mode=ro", uri=True) as connection:
            control["reserved_before_key"] = connection.execute("SELECT count(*) FROM requests").fetchone()[0]
        config = helper.read_private(directory / "evaluation/manifest.json")["frozen_config"]
        control["config"] = {key: config.get(key) for key in (
            "provider_profile", "request_contract_version", "phase_request_version", "phase_request_policy")}
        control["config"].update(global_thinking_present="thinking" in config or "thinking_type" in config,
                                 global_effort_present="reasoning_effort" in config)
        control["order"].append("claimed")
        path = Path(frozen["credential_path"])
        helper.publish(path, {"api_key": "synthetic-only"})
        try:
            key = module.read_pro_credential(path)
            control["credentials_loaded"] += 1
            control["order"].append("key_loaded")
            return key
        finally:
            path.unlink()

    def respond(request):
        body = json.loads(request.content)
        function = body["tools"][0]["function"]
        name = function["name"]
        control["requests"].append({"tool": name, "model": body.get("model"), "thinking": body.get("thinking"),
            "reasoning_effort": body.get("reasoning_effort"), "max_tokens": body.get("max_tokens"),
            "tool_choice_present": "tool_choice" in body, "tool_choice": body.get("tool_choice")})
        control["order"].append("http:" + name)
        if len(control["requests"]) != 1 or name != "GroundedMemoryLabels":
            return httpx.Response(503, request=request, json={"error": {"message": "synthetic verification stop"}})
        label = {"kind": "state", "subject": "self", "topic": "work", "dependency": None,
                 "unresolved": True, "confidence": 0.9, "sensitivity": "none"}
        arguments = {"units": {slot: dict(label) for slot in function["parameters"]["properties"]["units"]["required"]}}
        return httpx.Response(200, request=request, json={
            "id": "synthetic-extraction", "object": "chat.completion", "created": 1, "model": "deepseek-v4-pro",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": None, "tool_calls": [{
                "id": "synthetic-call", "type": "function", "function": {
                    "name": name, "arguments": json.dumps(arguments)}}]}, "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})

    with patch.object(Path, "home", return_value=synthetic_home), patch.object(module, "helpers", return_value=helper), \
            patch.object(helper, "read_credential", side_effect=forbidden), \
            patch.object(httpx.HTTPTransport, "handle_request", side_effect=forbidden), \
            patch.object(httpx.AsyncHTTPTransport, "handle_async_request", side_effect=forbidden):
        module.worker(freeze_path=freeze_path, expected_sha256=digest, approval=helper.read_private(approval_path),
            synthetic_transport=httpx.MockTransport(respond), credential_loader=credential)
    helper.publish(directory / "synthetic-control.json", control)


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
