"""E2 全140封闭身份：实际 SDK 仅走精确 Mock，不认证质量。"""
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import unittest
from copy import deepcopy
from unittest.mock import patch

import httpx

from test_full140_mixed_v_off_public import load_file


original = load_file("e2_original_tests", "test_full140_v4_public.py")
mixed = load_file("e2_mixed_tests", "test_full140_mixed_v_off_public.py")
PLAN = "full140-grounded-v2-source-v2-v-off-forced"


class Full140E2PublicTest(unittest.TestCase):
    def setUp(self):
        original.Full140V4PublicTest.setUp(self)
        import notalone.memory_extraction.evaluation_ecnu as loaded
        assert Path(loaded.__file__).resolve() == Path(__file__).resolve().parents[3] / "backend/src/notalone/memory_extraction/evaluation_ecnu.py"
    test_missing_tool_timeout_or_response_capture_gap_stop_without_retry = mixed.Full140MixedPublicTest.test_missing_tool_timeout_or_response_capture_gap_stop_without_retry

    def test_full_mock_reaches_last_window_with_actual_v_count_and_fixed_closed280(self):
        self.captured_result = None
        real_worker = None
        # 共用同一完整SDK断言，再核本身份的分组报告与不可续跑。
        prepared = self.prepared

        def capture(*args, **kwargs):
            runner, frozen, path, expected, approval = prepared(*args, **kwargs)
            nonlocal real_worker
            real_worker = runner.worker

            def worker(**options):
                result = real_worker(**options)
                self.captured_result = result
                runner.verify_claim = lambda _: self.fail("已关闭不得再次读凭据")
                with self.assertRaises(FileExistsError):
                    real_worker(**options)
                return result

            runner.worker = worker
            return runner, frozen, path, expected, approval

        self.prepared = capture
        mixed.Full140MixedPublicTest.test_full_mock_reaches_last_window_with_actual_v_count_and_fixed_closed280(self)
        cohorts = self.captured_result["summary"]["reference_cohorts"]
        self.assertEqual({name: row["planned"] for name, row in cohorts.items()}, {"main16": 16, "supplement3": 3})
        for row in cohorts.values():
            self.assertEqual(row["completed"], row["planned"])
            self.assertEqual(row["semantic_audit"]["audited"], row["planned"])
            self.assertEqual(row["semantic_audit"]["general_error"], row["planned"])
            self.assertEqual(len(set(row["gold_positions"])), row["planned"])

    def prepared(self, name="run"):
        runner = load_file("full140_e2_public", "full140-e2-v-off-public.py")
        frozen = runner.prepare(directory=self.home / name, absolute_start=datetime.now(timezone.utc))
        path = Path(frozen["directory"]) / "freeze.json"
        expected = runner.helpers().file_digest(path)
        return runner, frozen, path, expected, {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": expected}

    def respond(self, request):
        from langchain_core.utils.function_calling import convert_to_openai_tool
        from notalone.memory_extraction.evaluation import build_window
        from notalone.memory_extraction.evaluation_ecnu import _FULL_CASES
        from notalone.memory_extraction.evaluation_extraction import extraction_contract
        from notalone.memory_extraction.evaluation_offline import _verification_contract
        body = json.loads(request.content)
        self.requests.append(body)
        self.assertEqual(str(request.url), "https://api.deepseek.com/chat/completions")
        self.assertEqual(body["model"], "deepseek-flash")
        self.assertEqual(request.extensions["timeout"]["read"], 300.0)
        self.assertEqual(body["temperature"], 0.0)
        self.assertIs(body["stream"], False)
        function = body["tools"][0]["function"]
        if function["name"] == "GroundedMemoryLabels":
            self.assertEqual(body["thinking"], {"type": "enabled"})
            self.assertEqual(body["reasoning_effort"], "max")
            self.assertNotIn("tool_choice", body)
            position = len(self.extraction_positions)
            self.extraction_positions.append(position)
            prompt, schema = extraction_contract("grounded-v2", build_window(_FULL_CASES[position]))
            label = {"kind": "not_memory" if position in self.empty_positions else "unknown", "subject": "contact",
                "topic": "other", "dependency": None, "unresolved": True, "confidence": 0.9, "sensitivity": "none"}
            args = {"units": {slot: dict(label) for slot in function["parameters"]["properties"]["units"]["required"]}}
        else:
            self.assertEqual(function["name"], "SourceVerificationOutput")
            self.assertEqual(body["thinking"], {"type": "disabled"})
            self.assertEqual(body["reasoning_effort"], "none")
            self.assertEqual(body["tool_choice"], {"type": "function", "function": {"name": "SourceVerificationOutput"}})
            prompt, schema = _verification_contract("legacy-v4")
            candidates = json.loads(body["messages"][1]["content"])["candidates"]
            args = {"results": [{"candidate_index": index, "verdict": "uncertain", "issues": ["insufficient_evidence"],
                "evidence": []} for index in range(len(candidates))]}
        self.assertEqual(body["messages"][0]["content"], prompt)
        self.assertEqual(function, convert_to_openai_tool(schema)["function"])
        return httpx.Response(200, request=request, json={"id": "synthetic", "object": "chat.completion", "created": 1,
            "model": "deepseek-flash", "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": None, "tool_calls": [{"id": "synthetic", "type": "function",
                "function": {"name": function["name"], "arguments": json.dumps(args)}}]}}]})

    def test_prepare_has_exact_new_contract_and_cannot_borrow_old_identity(self):
        with patch.object(Path, "home", side_effect=AssertionError("不得读home")):
            runner, frozen, path, expected, approval = self.prepared()
        self.assertEqual(frozen["fixed"]["execution_plan"], PLAN)
        self.assertEqual(frozen["fixed"]["extraction_mode"], "grounded-v2")
        self.assertEqual(frozen["fixed"]["verification_mode"], "legacy-v4")
        for filename in ("full140-v4-public.py", "full140-mixed-v-off-public.py"):
            old = load_file("e2_old_" + filename, filename)
            with self.assertRaises(ValueError):
                old.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                    synthetic_transport=httpx.MockTransport(lambda _: self.fail("不得请求")),
                    credential_loader=lambda: self.fail("不得读凭据"))
            old_freeze = old.prepare(directory=self.home / filename, absolute_start=datetime.now(timezone.utc))
            old_path = Path(old_freeze["directory"]) / "freeze.json"
            old_sha = old.helpers().file_digest(old_path)
            with self.assertRaises(ValueError):
                runner.worker(freeze_path=old_path, expected_sha256=old_sha,
                    approval={"user_authorized": True, "run_id": old_freeze["run_id"], "freeze_sha256": old_sha},
                    synthetic_transport=httpx.MockTransport(lambda _: self.fail("不得请求")),
                    credential_loader=lambda: self.fail("不得读凭据"))
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_any_fixed_freeze_mutation_rejects_before_claim_or_credential(self):
        mutations = ({"execution_plan": "full140-grounded-v4-source-v2-v-off-forced"},
            {"extraction_mode": "grounded-v4"}, {"verification_mode": "nullable-proof-v1"},
            {"provider_profile": "deepseek-flash-max"}, {"verification_tool_choice": "omitted"},
            {"extraction_tool_choice": "forced"}, {"request_limit": 281}, {"request_limit": 280.0},
            {"max_retries": 1}, {"request_timeout_seconds": 300.0}, {"call_wall_seconds": 601},
            {"batch_work_seconds": 86381}, {"outer_wall_seconds": 86401}, {"case_set": "reference21"},
            {"case_positions": list(range(140))}, {"reference_version": "legacy-v1"},
            {"phase_request_version": "other"}, {"phase_request_policy": {}}, {"planned_windows": 139})
        runner, original_freeze, _, _, _ = self.prepared()
        for change in mutations:
            with self.subTest(change=change):
                frozen = deepcopy(original_freeze)
                frozen["fixed"].update(change)
                with self.assertRaises(ValueError):
                    runner.validate(frozen)
        for key in ("verification_prompt_sha256", "verification_schema_sha256"):
            frozen = deepcopy(original_freeze)
            frozen[key] = "0" * 64
            with self.subTest(key=key), self.assertRaises(ValueError):
                runner.validate(frozen)
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_actual_sdk_first_claim_is_exact(self):
        self.empty_positions = ()
        runner, frozen, path, expected, approval = self.prepared()
        loaded = []

        def loader():
            runner.verify_claim(frozen)
            loaded.append(True)
            return "synthetic-key"

        result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
            synthetic_transport=httpx.MockTransport(self.respond), credential_loader=loader,
            bridge=original.SyntheticBridge(stop="unknown"))
        self.assertEqual(loaded, [True])
        self.assertEqual(len(self.requests), 2)
        config = runner.helpers().read_private(path.parent / "evaluation/manifest.json")["frozen_config"]
        self.assertEqual(config["execution_plan"], PLAN)
        self.assertEqual(config["extraction_mode"], "grounded-v2")
        self.assertEqual(config["verification_mode"], "legacy-v4")
        self.assertEqual(config["phase_request_policy"], frozen["fixed"]["phase_request_policy"])
        self.assertTrue(result["receipt"]["budget"]["closed"])

    def test_dynamic_default_e2_prompt_drift_stops_before_v(self):
        from notalone.memory_extraction import grounded_adapter
        runner, _, path, expected, approval = self.prepared()
        self.empty_positions = ()
        prompt = grounded_adapter.GROUNDED_V2_PROMPT

        def drift(request):
            response = self.respond(request)
            grounded_adapter.GROUNDED_V2_PROMPT = prompt + "\n合成漂移。"
            return response

        try:
            result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                synthetic_transport=httpx.MockTransport(drift), credential_loader=lambda: "synthetic-key",
                bridge=original.SyntheticBridge())
        finally:
            grounded_adapter.GROUNDED_V2_PROMPT = prompt
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(result["stopped_code"], "deepseek_hard_stop")
        self.assertEqual(result["summary"]["unrun"], 139)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 1)
        self.assertTrue(result["receipt"]["budget"]["closed"])

    def test_foreign_claim_cannot_borrow_e2_mode_cap_or_contract(self):
        from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget
        from notalone.memory_extraction.evaluation_provider_contract import (
            FULL140_E2_MODE, FULL140_E2_STAGE, MIXED_REQUEST_VERSION, mixed_phase_policy,
        )
        from uuid import UUID
        changes = ({"extraction_mode": "grounded-v4"}, {"verification_mode": "nullable-proof-v1"},
            {"execution_plan": "full140-grounded-v4-source-v2-v-off-forced"},
            {"verification_prompt_sha256": "0" * 64}, {"verification_schema_sha256": "0" * 64},
            {"phase_request_policy": {}}, {"selected_case_positions": list(range(139))})
        for index, change in enumerate(changes):
            runner, frozen, path, _, _ = self.prepared(str(index))
            config = {"mode": FULL140_E2_MODE, "stage": FULL140_E2_STAGE,
                "execution_plan": PLAN, "reference_version": "source-fidelity-v2",
                "extraction_mode": "grounded-v2", "verification_mode": "legacy-v4",
                "phase_request_version": MIXED_REQUEST_VERSION, "phase_request_policy": mixed_phase_policy(),
                "selected_case_positions": list(range(140)), "source_hashes": frozen["source_hashes"],
                "tool_choice": {"extraction": {"mode": "omitted", "name": "GroundedMemoryLabels"},
                                "verification": {"mode": "forced", "name": "SourceVerificationOutput"}},
                "extraction_window_contracts": frozen["extraction_window_contracts"],
                "verification_prompt_sha256": frozen["verification_prompt_sha256"],
                "verification_schema_sha256": frozen["verification_schema_sha256"], **change}
            runner.helpers().publish(path.parent / "evaluation/manifest.json", {"frozen_config": config})
            budget = EvaluationBudget.create(run_id=UUID(frozen["run_id"]), output_directory=path.parent / "evaluation",
                request_limit=280, allowed_endpoints=("https://api.deepseek.com/chat/completions",),
                config_sha256=runner.helpers().digest(config))
            with self.subTest(change=change), budget.batch(), self.assertRaisesRegex(ValueError, "claim_manifest_changed"):
                runner.verify_claim(frozen)

    def test_public_closure_rejects_real_helper_entry_or_contract_byte_drift_before_claim(self):
        from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget
        runner = load_file("e2_closure_byte_control", "full140-e2-v-off-public.py")
        clone = self.home / "public-closure"
        clone.mkdir(mode=0o700)
        # 仅复制注册的公开源码闭包，绝不复制工作区、home或历史运行目录。
        names = runner.shared._source_names(PLAN)
        for name in names:
            target = clone / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(runner.shared.ROOT / name, target)
        changed_names = (
            "desktop/tests/fixtures/full140-e2-v-off-public.py",
            "backend/src/notalone/memory_extraction/evaluation_provider_contract.py",
            "desktop/artifacts/grounded-public21-prepare-20261015/grounded_public21.py",
            "desktop/artifacts/grounded-public21-prepare-20261015/explicit_review_bridge.py",
        )
        with patch.object(runner.shared, "ROOT", clone), patch.object(runner.shared, "LEGACY", clone / changed_names[2]):
            for index, name in enumerate(changed_names):
                self.assertIn(name, names)
                frozen = runner.prepare(directory=self.home / f"byte-{index}", absolute_start=datetime.now(timezone.utc))
                path = Path(frozen["directory"]) / "freeze.json"
                expected = runner.helpers().file_digest(path)
                target = clone / name
                original_bytes = target.read_bytes()
                target.write_bytes(original_bytes + b"\n")
                try:
                    with self.subTest(name=name), patch.object(EvaluationBudget, "create", side_effect=AssertionError("不得领取")):
                        with self.assertRaisesRegex(ValueError, "source_drift"):
                            runner.worker(freeze_path=path, expected_sha256=expected,
                                approval={"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": expected},
                                synthetic_transport=httpx.MockTransport(lambda _: self.fail("不得发送")),
                                credential_loader=lambda: self.fail("不得读凭据"))
                finally:
                    target.write_bytes(original_bytes)
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())
