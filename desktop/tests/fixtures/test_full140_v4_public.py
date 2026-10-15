"""完整140窗v4固定fixture；临时home、精确Mock与合成自有进程。"""
from contextlib import ExitStack
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

import httpx


def load_runner():
    spec = importlib.util.spec_from_file_location("full140_v4_public", Path(__file__).with_name("full140-v4-public.py"))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SyntheticBridge:
    """仅给控制链预置审核，不认证语义、模型分类或质量。"""
    def __init__(self, *, stop=None):
        self.phases = []
        self.stop = stop

    def review(self, phase, view):
        case = view["case_id"] if phase == "raw" else view["packet"]["case_id"]
        self.phases.append((case, phase))
        if phase == "raw":
            return {"reviewer": "合成传输控制，不认证语义", "case_id": case,
                "reference_sha256": view["reference_sha256"], "raw_evidence_sha256": view["raw_evidence_sha256"],
                "e_rows": [{"raw_index": item["index"], "payload_sha256": item["payload_sha256"],
                    "fields": {field: "pass" for field in view["e_fields"]}, "meaning": "pass",
                    "inclusion": "pass", "safety": "false_fact" if self.stop == "safety_error" else "safe",
                    "classification": "extra", "basis": "仅核合成控制。"} for item in view["extraction"]],
                "claims": [{"claim_id": item["id"], "groups": []} for item in view["reference_case"]["claims"]],
                "window_checks": {"inclusion": "fail", "forbidden_meanings": "pass"}}
        answer = deepcopy(view["sealed_raw_review"])
        answer.pop("raw_evidence_sha256")
        packet = view["packet"]
        answer.update(run_status=packet["evidence"]["run_status"], evidence_sha256=packet["evidence_sha256"])
        for index, item in enumerate(answer["e_rows"]):
            item["lineage"] = {"v_input_indices": [index], "final_indices": [index], "status": "pass"}
        answer["v_rows"] = [{"result_index": item["index"], "payload_sha256": item["payload_sha256"],
            "fields": {field: "pass" for field in ("candidate_index", "verdict", "issues", "evidence")},
            "semantic": "pass", "e_indices": [item["index"]], "lineage": "pass", "basis": "仅核合成控制。"}
            for item in packet["layers"]["verification"]]
        answer["window_checks"]["lineage"] = "unresolved" if self.stop == "unknown" else "pass"
        return answer


class Full140V4PublicTest(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.home = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.stack.enter_context(patch.object(os, "environ", {"NOTALONE_DISABLE_DOTENV": "1"}))
        self.stack.enter_context(patch.object(Path, "home", return_value=self.home))
        for owner, names in ((socket.socket, ("connect", "connect_ex")), (socket, ("getaddrinfo",))):
            for name in names:
                self.stack.enter_context(patch.object(owner, name, side_effect=AssertionError("禁止真实网络")))
        self.requests, self.extraction_positions = [], []
        self.empty_positions = (0, 1)

    def prepared(self, name="run"):
        runner = load_runner()
        frozen = runner.prepare(directory=self.home / name, absolute_start=datetime.now(timezone.utc))
        path = Path(frozen["directory"]) / "freeze.json"
        expected = runner.helpers().file_digest(path)
        approval = {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": expected}
        return runner, frozen, path, expected, approval

    def respond(self, request):
        from notalone.memory_extraction.evaluation import build_window
        from notalone.memory_extraction.evaluation_ecnu import _FULL_CASES
        from notalone.memory_extraction.evaluation_extraction import extraction_contract
        from langchain_core.utils.function_calling import convert_to_openai_tool

        body = json.loads(request.content)
        self.requests.append(body)
        self.assertEqual(str(request.url), "https://api.deepseek.com/chat/completions")
        self.assertEqual(body["model"], "deepseek-flash")
        self.assertEqual(body["reasoning_effort"], "max")
        self.assertEqual(body["thinking"], {"type": "enabled"})
        self.assertNotIn("tool_choice", body)
        self.assertEqual(request.extensions["timeout"]["read"], 300.0)
        function = body["tools"][0]["function"]
        if function["name"] == "GroundedMemoryLabelsV4":
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
            candidates = json.loads(body["messages"][1]["content"])["candidates"]
            args = {"results": [{"candidate_index": index, "verdict": "uncertain", "issues": ["insufficient_evidence"],
                                 "evidence": [], "proof": None} for index in range(len(candidates))]}
        return httpx.Response(200, request=request, json={"id": "synthetic", "object": "chat.completion", "created": 1,
            "model": "deepseek-flash", "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": None, "tool_calls": [{"id": "synthetic", "type": "function",
                "function": {"name": function["name"], "arguments": json.dumps(args)}}]}}]})

    def test_prepare_preserves_full140_input_order_and_gold_mapping_without_home(self):
        from notalone.memory_extraction.evaluation_reference import full_case_reference_positions

        with patch.object(Path, "home", side_effect=AssertionError("禁止home与registry")):
            runner, frozen, _, _, _ = self.prepared()
        self.assertIsNone(frozen["fixed"]["case_positions"])
        self.assertEqual(frozen["fixed"]["request_limit"], 280)
        self.assertEqual(frozen["fixed"]["reference_version"], "source-fidelity-v2")
        self.assertEqual(frozen["fixed"]["batch_work_seconds"], 86380)
        self.assertEqual(frozen["fixed"]["outer_wall_seconds"], 86400)
        self.assertEqual(len(frozen["plan"]), 140)
        self.assertEqual([row["case_position"] for row in frozen["plan"]], list(range(140)))
        self.assertEqual([row["gold_position"] for row in frozen["selection"]], list(full_case_reference_positions()))
        self.assertNotEqual([row["gold_position"] for row in frozen["selection"]], list(range(140)))
        self.assertIn(runner.PLAN, frozen["source_hashes"])
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_actual_sdk_full140_uses_fresh280_claim_and_same_version_phased_reference(self):
        runner, frozen, path, expected, approval = self.prepared()
        bridge, loaded = SyntheticBridge(), []

        def loader():
            loaded.append(True)
            runner.verify_claim(frozen)
            return "synthetic-key"

        result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
            synthetic_transport=httpx.MockTransport(self.respond), credential_loader=loader, bridge=bridge)
        self.assertEqual(loaded, [True])
        self.assertIsNone(result["stopped_code"], str(result["outcomes"][0]))
        self.assertEqual(self.extraction_positions, list(range(140)))
        self.assertEqual(len(self.requests), 278)
        self.assertEqual(bridge.phases, [(item["case_id"], phase) for item in frozen["selection"] for phase in ("raw", "full")])
        self.assertEqual(result["summary"]["completed"], 140)
        self.assertEqual(result["summary"]["empty"], 2)
        self.assertEqual(result["receipt"]["budget"]["request_limit"], 280)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 278)
        self.assertTrue(result["receipt"]["budget"]["closed"])
        self.assertFalse(result["quality_certified"])
        config = runner.helpers().read_private(path.parent / "evaluation/manifest.json")["frozen_config"]
        self.assertEqual(config["mode"], "deepseek_bounded_full140_v4_source_v2")
        self.assertEqual(config["stage"], "full140-v4-source-v2")
        self.assertEqual(config["reference_version"], "source-fidelity-v2")
        self.assertEqual(config["execution_plan"], "full140-grounded-v4-source-v2")
        self.assertEqual(config["selected_case_positions"], list(range(140)))
        self.assertEqual(config["extraction_window_contracts"], frozen["extraction_window_contracts"])

    def test_returned_fixed_contract_and_boolean_authorization_cannot_be_mutated_into_acceptance(self):
        runner, frozen, path, expected, approval = self.prepared()
        frozen["fixed"]["request_limit"] = 281
        self.assertEqual(runner.FIXED["request_limit"], 280)
        with self.assertRaisesRegex(ValueError, "fixed_window"):
            runner.validate(frozen)
        with self.assertRaisesRegex(ValueError, "bound_authorization"):
            runner.worker(freeze_path=path, expected_sha256=expected,
                          approval={**approval, "user_authorized": 1}, credential_loader=lambda: "forbidden")
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_changed_fixed_scope_closure_prompt_selection_and_expiry_fail_before_claim(self):
        runner, frozen, _, _, _ = self.prepared()
        for field, value in (("case_positions", list(range(140))), ("request_limit", 280.0),
                             ("reference_version", "legacy-v1"), ("execution_plan", "original")):
            with self.subTest(field=field):
                wrong = deepcopy(frozen)
                wrong["fixed"][field] = value
                with self.assertRaisesRegex(ValueError, "fixed_window"):
                    runner.validate(wrong)
        for key in (runner.PLAN, runner.REFERENCE, runner.ANNOTATION, runner.LEGACY.relative_to(runner.ROOT).as_posix()):
            wrong = deepcopy(frozen)
            del wrong["source_hashes"][key]
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "source_closure"):
                runner.validate(wrong)
        wrong = deepcopy(frozen)
        wrong["extraction_window_contracts"][-1]["prompt_sha256"] = "f" * 64
        with self.assertRaisesRegex(ValueError, "contract_drift"):
            runner.validate(wrong)
        wrong = deepcopy(frozen)
        wrong["selection"] = list(reversed(wrong["selection"]))
        with self.assertRaisesRegex(ValueError, "reference_drift"):
            runner.validate(wrong)
        with patch.object(runner, "now", return_value=datetime.fromisoformat(frozen["work_end"])), \
                self.assertRaisesRegex(ValueError, "fixed_window"):
            runner.validate(frozen)
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_foreign_claim_profile_cap_version_or_gold_positions_cannot_authorize_new_worker(self):
        from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget
        from notalone.memory_extraction.evaluation_reference import full_case_reference_positions
        from uuid import UUID

        for index, (limit, changes) in enumerate(((16, {}), (280, {"mode": "deepseek_bounded_main16_v3"}),
                (280, {"reference_version": "legacy-v1"}),
                (280, {"selected_case_positions": list(full_case_reference_positions())}))):
            runner, frozen, path, _, _ = self.prepared(f"claim-{index}")
            config = {"mode": "deepseek_bounded_full140_v4_source_v2", "stage": "full140-v4-source-v2",
                "execution_plan": "full140-grounded-v4-source-v2", "reference_version": "source-fidelity-v2",
                "selected_case_positions": list(range(140)), "source_hashes": frozen["source_hashes"],
                "extraction_window_contracts": frozen["extraction_window_contracts"], **changes}
            runner.helpers().publish(path.parent / "evaluation/manifest.json", {"frozen_config": config})
            budget = EvaluationBudget.create(run_id=UUID(frozen["run_id"]), output_directory=path.parent / "evaluation",
                request_limit=limit, allowed_endpoints=("https://api.deepseek.com/chat/completions",),
                config_sha256=runner.helpers().digest(config))
            with budget.batch(), self.assertRaisesRegex(ValueError, "claim_manifest_changed"):
                runner.verify_claim(frozen)

    def test_content_without_tool_and_remote_unknown_each_stop_once_without_refund(self):
        for index, content in enumerate((True, False)):
            runner, _, path, expected, approval = self.prepared(f"failure-{index}")
            requests, bridge = [], SyntheticBridge()

            def fail(request):
                requests.append(request)
                if not content:
                    raise httpx.ReadTimeout("合成远端未知", request=request)
                return httpx.Response(200, request=request, json={"id": "synthetic", "object": "chat.completion",
                    "created": 1, "model": "deepseek-flash", "choices": [{"index": 0, "finish_reason": "stop",
                    "message": {"role": "assistant", "content": "<tool_call>普通正文不能补工具</tool_call>"}}]})

            result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                synthetic_transport=httpx.MockTransport(fail), credential_loader=lambda: "synthetic-key", bridge=bridge)
            self.assertEqual(len(requests), 1)
            self.assertEqual(bridge.phases, [])
            self.assertEqual(result["summary"]["unrun"], 139)
            self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 1)
            self.assertTrue(result["receipt"]["budget"]["closed"])

    def test_safety_and_unknown_audit_stop_before_next_window(self):
        self.empty_positions = ()
        for decision in ("safety_error", "unknown"):
            runner, _, path, expected, approval = self.prepared(decision)
            self.requests.clear(); self.extraction_positions.clear()
            bridge = SyntheticBridge(stop=decision)
            result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                synthetic_transport=httpx.MockTransport(self.respond), credential_loader=lambda: "synthetic-key", bridge=bridge)
            self.assertEqual(result["stopped_code"], "case_semantic_audit_" + decision)
            self.assertEqual(len(self.requests), 2)
            self.assertEqual(len(bridge.phases), 2)
            self.assertEqual(result["summary"]["unrun"], 139)
            self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 2)
            self.assertTrue(result["receipt"]["budget"]["closed"])

    def test_review_bridge_keeps_600s_phase_and_earlier_work_deadline(self):
        runner, frozen, _, _, _ = self.prepared()
        for index, phase in enumerate(("raw", "full")):
            directory = self.home / f"phase-{index}"
            directory.mkdir(mode=0o700)
            start = datetime.now(timezone.utc)
            ticks, wall = [0.0], [start]

            def step(_):
                ticks[0] = 600 if phase == "raw" else 1
                wall[0] = start + timedelta(seconds=ticks[0])

            bridge = runner.helpers().ExplicitReviewBridge(directory=directory, run_id=frozen["run_id"],
                deadline=start + timedelta(seconds=1000 if phase == "raw" else 1),
                monotonic=lambda: ticks[0], clock=lambda: wall[0], sleeper=step)
            with self.assertRaisesRegex(ValueError, "explicit_review_timeout"):
                bridge.review(phase, {"case_id": "A01"} if phase == "raw" else {"packet": {"case_id": "A01"}})
            self.assertEqual(runner.helpers().read_private(directory / f"A01-{phase}-view.json")["phase_seconds"], 600)

    def test_dynamic_v4_prompt_drift_stops_before_v_or_next_window(self):
        from notalone.memory_extraction import grounded_adapter

        runner, _, path, expected, approval = self.prepared()
        self.empty_positions = ()
        original = grounded_adapter.GROUNDED_V4_PROMPT

        def drift(request):
            answer = self.respond(request)
            grounded_adapter.GROUNDED_V4_PROMPT = original + "\n合成漂移。"
            return answer

        try:
            result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                synthetic_transport=httpx.MockTransport(drift), credential_loader=lambda: "synthetic-key", bridge=SyntheticBridge())
        finally:
            grounded_adapter.GROUNDED_V4_PROMPT = original
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(result["stopped_code"], "deepseek_hard_stop")
        self.assertEqual(result["summary"]["unrun"], 139)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 1)
        self.assertTrue(result["receipt"]["budget"]["closed"])
