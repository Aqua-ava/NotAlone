"""固定混合140：实际SDK仅经Mock，审核为合成控制，不认证质量。"""
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import unittest
from copy import deepcopy
from unittest.mock import patch

import httpx


def load_file(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


original = load_file("mixed_test_original", "test_full140_v4_public.py")


class Full140MixedPublicTest(unittest.TestCase):
    setUp = original.Full140V4PublicTest.setUp

    def prepared(self, name="run"):
        runner = load_file("full140_mixed_public", "full140-mixed-v-off-public.py")
        frozen = runner.prepare(directory=self.home / name, absolute_start=datetime.now(timezone.utc))
        path = Path(frozen["directory"]) / "freeze.json"
        expected = runner.helpers().file_digest(path)
        approval = {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": expected}
        return runner, frozen, path, expected, approval

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
        if function["name"] == "GroundedMemoryLabelsV4":
            self.assertEqual(body["thinking"], {"type": "enabled"})
            self.assertEqual(body["reasoning_effort"], "max")
            self.assertNotIn("tool_choice", body)
            position = len(self.extraction_positions)
            self.extraction_positions.append(position)
            prompt, schema = extraction_contract("grounded-v4", build_window(_FULL_CASES[position]))
            self.assertEqual(body["messages"][0]["content"], prompt)
            self.assertEqual(function, convert_to_openai_tool(schema)["function"])
            label = {"kind": "not_memory" if position in self.empty_positions else "unknown", "subject": "contact",
                "topic": "other", "dependency": None, "unresolved": True, "confidence": 0.9,
                "sensitivity": "none", "ambiguity_codes": ["other_unresolved"]}
            args = {"units": {slot: dict(label) for slot in function["parameters"]["properties"]["units"]["required"]}}
        else:
            self.assertEqual(function["name"], "SourceVerificationOutput")
            self.assertEqual(body["thinking"], {"type": "disabled"})
            self.assertEqual(body["reasoning_effort"], "none")
            self.assertEqual(body["tool_choice"], {"type": "function", "function": {"name": "SourceVerificationOutput"}})
            prompt, schema = _verification_contract("nullable-proof-v1")
            self.assertEqual(body["messages"][0]["content"], prompt)
            self.assertEqual(function, convert_to_openai_tool(schema)["function"])
            candidates = json.loads(body["messages"][1]["content"])["candidates"]
            args = {"results": [{"candidate_index": index, "verdict": "uncertain", "issues": ["insufficient_evidence"],
                "evidence": [], "proof": None} for index in range(len(candidates))]}
        return httpx.Response(200, request=request, json={"id": "synthetic", "object": "chat.completion", "created": 1,
            "model": "deepseek-flash", "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": None, "tool_calls": [{"id": "synthetic", "type": "function",
                "function": {"name": function["name"], "arguments": json.dumps(args)}}]}}]})

    def test_actual_sdk_first_e_and_v_share_claim_and_stop_on_independent_unknown(self):
        self.empty_positions = ()
        runner, frozen, path, expected, approval = self.prepared()
        loaded = []

        def loader():
            runner.verify_claim(frozen)
            loaded.append(True)
            return "synthetic-key"

        bridge = original.SyntheticBridge(stop="unknown")
        result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
            synthetic_transport=httpx.MockTransport(self.respond), credential_loader=loader, bridge=bridge)
        self.assertEqual(loaded, [True])
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(self.extraction_positions, [0])
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 2)
        self.assertTrue(result["receipt"]["budget"]["closed"])
        self.assertFalse(result["quality_certified"])
        config = runner.helpers().read_private(path.parent / "evaluation/manifest.json")["frozen_config"]
        self.assertEqual(config["execution_plan"], "full140-grounded-v4-source-v2-v-off-forced")
        self.assertEqual(config["phase_request_version"], "deepseek-phase-split-v1")
        self.assertEqual(config["phase_request_policy"], frozen["fixed"]["phase_request_policy"])
        self.assertEqual([phase for _, phase in bridge.phases], ["raw", "full"])

    def test_full_mock_reaches_last_window_with_actual_v_count_and_fixed_closed280(self):
        runner, frozen, path, expected, approval = self.prepared()
        bridge = original.SyntheticBridge()
        result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
            synthetic_transport=httpx.MockTransport(self.respond), credential_loader=lambda: "synthetic-key", bridge=bridge)
        self.assertIsNone(result["stopped_code"])
        self.assertEqual(self.extraction_positions, list(range(140)))
        self.assertEqual(len(self.requests), 278)
        self.assertEqual(sum(body["tools"][0]["function"]["name"] == "SourceVerificationOutput" for body in self.requests), 138)
        self.assertEqual(result["summary"]["completed"], 140)
        self.assertEqual(result["summary"]["empty"], 2)
        self.assertEqual(result["outcomes"][-1]["case_position"], 139)
        self.assertEqual(result["receipt"]["budget"]["request_limit"], 280)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 278)
        self.assertTrue(result["receipt"]["budget"]["closed"])
        self.assertEqual(bridge.phases, [(row["case_id"], phase) for row in frozen["selection"] for phase in ("raw", "full")])
        self.assertFalse(result["quality_certified"])

    def test_prepare_is_public_only_and_versions_do_not_cross_claim(self):
        from notalone.memory_extraction.evaluation_reference import full_case_reference_positions
        with patch.object(Path, "home", side_effect=AssertionError("不得读home")):
            runner, frozen, path, expected, approval = self.prepared()
        self.assertEqual([row["gold_position"] for row in frozen["selection"]], list(full_case_reference_positions()))
        self.assertEqual(len(frozen["plan"]), 140)
        self.assertEqual(frozen["fixed"]["required_claims"], 138)
        self.assertEqual(frozen["fixed"]["optional_claims"], 1)
        self.assertIn(".scratch/grounded-evaluation/full140-mixed-v-off-plan-20261016.md", frozen["source_hashes"])
        old = original.load_runner()
        with self.assertRaises(ValueError):
            old.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                synthetic_transport=httpx.MockTransport(lambda _: self.fail("混版不得请求")),
                credential_loader=lambda: self.fail("混版不得读凭据"))
        old_freeze = old.prepare(directory=self.home / "old", absolute_start=datetime.now(timezone.utc))
        old_path = Path(old_freeze["directory"]) / "freeze.json"
        old_sha = old.helpers().file_digest(old_path)
        with self.assertRaises(ValueError):
            runner.worker(freeze_path=old_path, expected_sha256=old_sha,
                approval={"user_authorized": True, "run_id": old_freeze["run_id"], "freeze_sha256": old_sha},
                synthetic_transport=httpx.MockTransport(lambda _: self.fail("混版不得请求")),
                credential_loader=lambda: self.fail("混版不得读凭据"))
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_fixed_phase_or_source_drift_rejects_before_claim_or_credential(self):
        for index, change in enumerate(("phase", "version", "cap", "source", "authorization", "position")):
            with self.subTest(change=change):
                runner, frozen, path, expected, approval = self.prepared(str(index))
                if change == "phase":
                    frozen["fixed"]["phase_request_policy"]["verification"]["thinking_mode"] = "enabled"
                elif change == "version":
                    frozen["fixed"]["phase_request_version"] = "other"
                elif change == "cap":
                    frozen["fixed"]["request_limit"] = 280.0
                elif change == "source":
                    frozen["source_hashes"].pop("desktop/tests/fixtures/full140-mixed-v-off-public.py")
                elif change == "authorization":
                    approval["user_authorized"] = 1
                else:
                    frozen["plan"][0]["case_position"] = False
                if change != "authorization":
                    path.write_text(json.dumps(frozen), encoding="utf-8")
                    expected = runner.helpers().file_digest(path)
                    approval["freeze_sha256"] = expected
                with self.assertRaises(ValueError):
                    runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                        synthetic_transport=httpx.MockTransport(lambda _: self.fail("不得请求")),
                        credential_loader=lambda: self.fail("不得读凭据"))
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_missing_tool_timeout_or_response_capture_gap_stop_without_retry(self):
        for kind in ("missing", "timeout", "nonfinite"):
            with self.subTest(kind=kind):
                self.requests, self.extraction_positions, self.empty_positions = [], [], ()
                runner, _, path, expected, approval = self.prepared(kind)

                def respond(request):
                    response = self.respond(request)
                    if json.loads(request.content)["tools"][0]["function"]["name"] == "SourceVerificationOutput":
                        if kind == "timeout":
                            raise httpx.ReadTimeout("合成超时", request=request)
                        body = response.json()
                        if kind == "missing":
                            body["choices"][0]["message"]["tool_calls"] = []
                            body["choices"][0]["message"]["content"] = "<tool_calls>"
                        else:
                            body["usage"] = {"total_tokens": float("nan")}
                        return httpx.Response(200, content=json.dumps(body).encode(), request=request)
                    return response

                result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                    synthetic_transport=httpx.MockTransport(respond), credential_loader=lambda: "synthetic-key",
                    bridge=original.SyntheticBridge())
                self.assertEqual(len(self.requests), 2)
                self.assertEqual(self.extraction_positions, [0])
                self.assertTrue(result["receipt"]["budget"]["closed"])
                self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 2)
                self.assertTrue(all(row["status"] == "unrun" for row in result["outcomes"][1:]))
