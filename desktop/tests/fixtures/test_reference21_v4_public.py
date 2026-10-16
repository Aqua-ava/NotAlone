"""原21固定v4基线；仅临时home、合成审核与真实SDK的精确Mock。"""
from datetime import datetime, timedelta, timezone
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import httpx


def load_file(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


original = load_file("reference21_test_controls", "test_full140_v4_public.py")


class Reference21V4PublicTest(unittest.TestCase):
    def setUp(self):
        original.Full140V4PublicTest.setUp(self)
        self.empty_positions = (11, 13)

    def prepared(self, name="run", *, profile="baseline"):
        runner = load_file("reference21_v4_public", "reference21-v4-public.py")
        options = {} if profile == "baseline" else {"profile": profile}
        frozen = runner.prepare(directory=self.home / name, absolute_start=datetime.now(timezone.utc), **options)
        path = Path(frozen["directory"]) / "freeze.json"
        digest = runner.helpers().file_digest(path)
        return runner, frozen, path, digest, {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": digest}

    def test_prepare_keeps_original21_and_public_v2_only_without_home_or_budget(self):
        with patch.object(Path, "home", side_effect=AssertionError("prepare不得读取registry或凭据")):
            runner, frozen, _, _, _ = self.prepared()
        self.assertEqual(frozen["fixed"]["request_limit"], 42)
        self.assertIsNone(frozen["fixed"]["case_positions"])
        self.assertEqual((frozen["fixed"]["planned_windows"], frozen["fixed"]["required_claims"],
                          frozen["fixed"]["optional_claims"]), (21, 28, 1))
        self.assertEqual([item["case_id"] for item in frozen["selection"]],
                         [f"A{i:02}" for i in range(1, 20)] + ["B01", "B02"])
        self.assertEqual([item["gold_position"] for item in frozen["selection"]], list(range(21)))
        self.assertEqual([item["case_position"] for item in frozen["plan"]], list(range(21)))
        self.assertEqual((frozen["fixed"]["batch_work_seconds"], frozen["fixed"]["outer_wall_seconds"]), (14380, 14400))
        self.assertEqual(runner.validate(frozen)[1] - datetime.fromisoformat(frozen["absolute_start"]), timedelta(seconds=14400))
        self.assertIn(".scratch/unfinished-work/memory-gold-reference-v2-20261016.json", frozen["source_hashes"])
        self.assertNotIn(".scratch/unfinished-work/memory-gold-full140-reference-v2-20261016.json", frozen["source_hashes"])
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())
        self.assertFalse(frozen["quality_certified"])

    def test_semantic4_complete_mock_reaches_b02_with_strict_four_slots_and_no_typed_credit(self):
        runner, frozen, path, expected, approval = self.prepared("semantic4", profile="semantic4")
        self.semantic4 = True
        bridge = original.SyntheticBridge()
        result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
            synthetic_transport=httpx.MockTransport(self.respond), credential_loader=lambda: "synthetic-key", bridge=bridge)
        self.assertIsNone(result["stopped_code"], str(result["outcomes"][0]))
        self.assertEqual(self.extraction_positions, list(range(21)))
        self.assertEqual(len(self.requests), 40)
        self.assertEqual(result["outcomes"][-1]["case_position"], 20)
        self.assertEqual((result["receipt"]["budget"]["request_limit"], result["receipt"]["budget"]["reserved_requests"]), (42, 40))
        self.assertTrue(result["receipt"]["budget"]["closed"])
        self.assertEqual(bridge.phases[-2:], [("B02", "raw"), ("B02", "full")])
        self.assertFalse(result["typed_evaluated"])
        self.assertFalse(result["typed_credit"])
        self.assertFalse(any(event["kind"] == "verification_program" for event in result["events"]))
        self.assertEqual(frozen["fixed"]["verification_mode"], "legacy-v4")
        self.assertEqual(frozen["fixed"]["prompt_profile"], "public-author-quote-v1")

    def test_semantic4_prepare_freezes_exact_public_contract_without_registry_budget_or_key(self):
        from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget
        with patch.object(Path, "home", side_effect=AssertionError("prepare不得访问registry或key")), \
                patch.object(EvaluationBudget, "create", side_effect=AssertionError("prepare不得建预算")):
            runner, frozen, path, _, _ = self.prepared("semantic4-prepare", profile="semantic4")
            runner.validate(frozen)
        self.assertEqual(frozen["fixed"]["execution_plan"], "reference21-grounded-v4-source-v2-semantic4-v-off-forced")
        self.assertEqual((frozen["fixed"]["planned_windows"], frozen["fixed"]["required_claims"],
                          frozen["fixed"]["optional_claims"], frozen["fixed"]["request_limit"]), (21, 28, 1, 42))
        self.assertIn(".scratch/grounded-v4-matter-reference/spec.md", frozen["source_hashes"])
        self.assertIn(".scratch/grounded-evaluation/reference21-semantic4-plan-20261016.md", frozen["source_hashes"])
        self.assertEqual(set(frozen["source_hashes"]), set(runner._source_names(frozen["fixed"])))
        self.assertFalse((path.parent / "evaluation/budget.sqlite3").exists())


    def test_semantic4_extra_proof_is_saved_then_stops_without_audit_retry_or_next_window(self):
        for index, proof in enumerate((None, {"version": 1, "atom_links": [], "reference": None, "reported": None})):
            with self.subTest(proof=proof):
                self.requests, self.extraction_positions, self.semantic4 = [], [], True
                runner, _, path, expected, approval = self.prepared(f"proof-{index}", profile="semantic4")
                bridge = original.SyntheticBridge()
                def respond(request):
                    response = self.respond(request)
                    body = response.json()
                    if json.loads(request.content)["tools"][0]["function"]["name"] == "SourceVerificationOutput":
                        function = body["choices"][0]["message"]["tool_calls"][0]["function"]
                        arguments = json.loads(function["arguments"])
                        arguments["results"][0]["proof"] = proof
                        function["arguments"] = json.dumps(arguments)
                    return httpx.Response(200, request=request, json=body)
                result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                    synthetic_transport=httpx.MockTransport(respond), credential_loader=lambda: "synthetic-key", bridge=bridge)
                self.assertEqual(result["stopped_code"], "case_contract_or_runtime_failed")
                self.assertEqual((len(self.requests), self.extraction_positions), (2, [0]))
                self.assertEqual(bridge.phases, [])
                self.assertTrue(result["receipt"]["budget"]["closed"])
                self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 2)
                self.assertTrue(all(row["status"] == "unrun" for row in result["outcomes"][1:]))
                saved = next(event for event in result["events"] if event["kind"] == "adapter_output" and event["purpose"] == "verification")
                self.assertIn("proof", saved["payload"]["tool_calls"][0]["args"]["results"][0])
                self.assertEqual(saved["payload"]["tool_calls"][0]["args"]["results"][0]["proof"], proof)
                self.assertFalse(any(event["kind"] == "verification_program" for event in result["events"]))

    def test_semantic4_source_snapshot_or_known_type_is_rejected_before_budget_or_key(self):
        from dataclasses import replace
        from notalone.memory_extraction import evaluation_ecnu
        from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget, EvaluationBudgetAbort
        base_build = evaluation_ecnu.build_window
        for index, changes in enumerate(({"source_snapshots": ({"synthetic": "untrusted"},)},
                                        {"message_snapshot": {"synthetic": True}},
                                        {"message_type": "text"}, {"text_representation": "text"})):
            with self.subTest(changes=changes):
                runner, _, path, expected, approval = self.prepared(f"source-{index}", profile="semantic4")
                def changed(case):
                    window = base_build(case)
                    return replace(window, messages=(replace(window.messages[0], **changes), *window.messages[1:]))
                with patch.object(evaluation_ecnu, "build_window", side_effect=changed), \
                        patch.object(EvaluationBudget, "create", side_effect=AssertionError("错误来源不得领取预算")), \
                        self.assertRaisesRegex(EvaluationBudgetAbort, "semantic4_public_sources_required"):
                    runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                        synthetic_transport=httpx.MockTransport(lambda _: self.fail("不得发送")),
                        credential_loader=lambda: self.fail("不得读key"), bridge=original.SyntheticBridge())

    def test_semantic4_unknown_and_safety_keep_existing_hard_stop(self):
        for decision in ("unknown", "safety_error"):
            with self.subTest(decision=decision):
                self.requests, self.extraction_positions, self.semantic4 = [], [], True
                runner, _, path, expected, approval = self.prepared(decision, profile="semantic4")
                result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                    synthetic_transport=httpx.MockTransport(self.respond), credential_loader=lambda: "synthetic-key",
                    bridge=original.SyntheticBridge(stop=decision))
                self.assertEqual(result["stopped_code"], "case_semantic_audit_" + decision)
                self.assertEqual(len(self.requests), 2)
                self.assertTrue(result["receipt"]["budget"]["closed"])
                self.assertTrue(all(row["status"] == "unrun" for row in result["outcomes"][1:]))

    def respond(self, request):
        from langchain_core.utils.function_calling import convert_to_openai_tool
        from notalone.memory_extraction.evaluation import build_window
        from notalone.memory_extraction.evaluation_ecnu import _PLAN_CASES
        from notalone.memory_extraction.evaluation_extraction import extraction_contract
        from notalone.memory_extraction.evaluation_offline import _verification_contract

        body = json.loads(request.content)
        self.requests.append(body)
        self.assertEqual(str(request.url), "https://api.deepseek.com/chat/completions")
        self.assertEqual(body["model"], "deepseek-flash")
        self.assertEqual(request.extensions["timeout"]["read"], 300.0)
        self.assertEqual((body["temperature"], body["stream"]), (0.0, False))
        function = body["tools"][0]["function"]
        if function["name"] == "GroundedMemoryLabelsV4":
            self.assertEqual(body["thinking"], {"type": "enabled"})
            self.assertEqual(body["reasoning_effort"], "max")
            self.assertNotIn("tool_choice", body)
            position = len(self.extraction_positions)
            self.extraction_positions.append(position)
            prompt, schema = extraction_contract("grounded-v4", build_window(_PLAN_CASES[position]))
            self.assertEqual(body["messages"][0]["content"], prompt)
            self.assertEqual(function, convert_to_openai_tool(schema)["function"])
            self.assertIn("stable_fact", function["parameters"]["properties"]["units"]["properties"][
                function["parameters"]["properties"]["units"]["required"][0]]["properties"]["kind"]["enum"])
            self.assertIn("continuation", function["parameters"]["properties"]["units"]["properties"][
                function["parameters"]["properties"]["units"]["required"][0]]["properties"]["kind"]["enum"])
            label = {"kind": "not_memory" if position in self.empty_positions else "unknown", "subject": "contact",
                "topic": "other", "dependency": None, "unresolved": True, "confidence": 0.9,
                "sensitivity": "none", "ambiguity_codes": ["other_unresolved"]}
            args = {"units": {slot: dict(label) for slot in function["parameters"]["properties"]["units"]["required"]}}
        else:
            self.assertEqual(function["name"], "SourceVerificationOutput")
            self.assertEqual(body["thinking"], {"type": "disabled"})
            self.assertEqual(body["reasoning_effort"], "none")
            self.assertEqual(body["tool_choice"], {"type": "function", "function": {"name": "SourceVerificationOutput"}})
            semantic4 = getattr(self, "semantic4", False)
            prompt, schema = _verification_contract("legacy-v4", prompt_profile="public-author-quote-v1") if semantic4 else _verification_contract("nullable-proof-v1")
            self.assertEqual(body["messages"][0]["content"], prompt)
            self.assertEqual(function, convert_to_openai_tool(schema)["function"])
            candidates = json.loads(body["messages"][1]["content"])["candidates"]
            args = {"results": [{"candidate_index": index, "verdict": "uncertain", "issues": ["insufficient_evidence"],
                "evidence": [], **({} if semantic4 else {"proof": None})} for index in range(len(candidates))]}
        return httpx.Response(200, request=request, json={"id": "synthetic", "object": "chat.completion", "created": 1,
            "model": "deepseek-flash", "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": None, "tool_calls": [{"id": "synthetic", "type": "function",
                "function": {"name": function["name"], "arguments": json.dumps(args)}}]}}]})

    def test_actual_sdk_pair_claims_once_and_unknown_stops_before_second_window(self):
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
        self.assertEqual(result["stopped_code"], "case_semantic_audit_unknown")
        self.assertEqual((result["receipt"]["budget"]["reserved_requests"], result["receipt"]["budget"]["request_limit"]), (2, 42))
        self.assertTrue(result["receipt"]["budget"]["closed"])
        self.assertEqual(bridge.phases, [("A01", "raw"), ("A01", "full")])
        self.assertEqual(len(result["outcomes"]), 21)
        self.assertTrue(all(item["status"] == "unrun" for item in result["outcomes"][1:]))
        self.assertFalse(result["quality_certified"])

    def test_complete_mock_reaches_b02_with_only_a12_a14_empty_and_closed40_of42(self):
        runner, frozen, path, expected, approval = self.prepared()
        bridge = original.SyntheticBridge()
        result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
            synthetic_transport=httpx.MockTransport(self.respond), credential_loader=lambda: "synthetic-key", bridge=bridge)
        self.assertIsNone(result["stopped_code"], str(result["outcomes"][0]))
        self.assertEqual(self.extraction_positions, list(range(21)))
        self.assertEqual(len(self.requests), 40)
        self.assertEqual(sum(body["tools"][0]["function"]["name"] == "SourceVerificationOutput" for body in self.requests), 19)
        self.assertEqual((result["summary"]["completed"], result["summary"]["empty"]), (21, 2))
        self.assertEqual(result["outcomes"][-1]["case_position"], 20)
        self.assertEqual((result["receipt"]["budget"]["request_limit"], result["receipt"]["budget"]["reserved_requests"]), (42, 40))
        self.assertTrue(result["receipt"]["budget"]["closed"])
        self.assertEqual(bridge.phases, [(item["case_id"], phase) for item in frozen["selection"] for phase in ("raw", "full")])
        config = runner.helpers().read_private(path.parent / "evaluation/manifest.json")["frozen_config"]
        self.assertEqual((config["mode"], config["stage"], config["execution_plan"]),
                         ("deepseek_bounded_reference21_v4_source_v2_v_off_forced", "reference21-v4-source-v2-v-off-forced",
                          "reference21-grounded-v4-source-v2-v-off-forced"))
        self.assertEqual(config["selected_case_positions"], list(range(21)))
        self.assertEqual(config["source_hashes"], frozen["source_hashes"])
        self.assertFalse(result["quality_certified"])

    def test_changed_freeze_authorization_or_expiry_never_claims_or_reads_credentials(self):
        from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget
        changes = ("cap", "phase", "plan_position", "gold_position", "source", "prompt", "reference", "authorization")
        for index, change in enumerate(changes):
            with self.subTest(change=change):
                runner, frozen, path, _, approval = self.prepared(str(index))
                if change == "cap":
                    frozen["fixed"]["request_limit"] = 42.0
                elif change == "phase":
                    frozen["fixed"]["phase_request_policy"]["verification"]["thinking_mode"] = "enabled"
                elif change == "plan_position":
                    frozen["plan"][0]["case_position"] = False
                    frozen["plan_sha256"] = runner.helpers().digest(frozen["plan"])
                elif change == "gold_position":
                    frozen["selection"][0]["gold_position"] = 0.0
                elif change == "source":
                    frozen["source_hashes"].pop("desktop/tests/fixtures/reference21-v4-public.py")
                elif change == "prompt":
                    frozen["extraction_window_contracts"][0]["prompt_sha256"] = "0" * 64
                elif change == "reference":
                    frozen["reference_canonical_sha256"] = "0" * 64
                else:
                    approval["user_authorized"] = 1
                path.write_text(json.dumps(frozen), encoding="utf-8")
                expected = runner.helpers().file_digest(path)
                approval["freeze_sha256"] = expected
                with patch.object(EvaluationBudget, "create", side_effect=AssertionError("错误冻结不得领取")), \
                        self.assertRaises(ValueError):
                    runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                        synthetic_transport=httpx.MockTransport(lambda _: self.fail("不得请求")),
                        credential_loader=lambda: self.fail("不得读凭据"))
        runner, frozen, _, _, _ = self.prepared("expired")
        with patch.object(runner, "now", return_value=datetime.fromisoformat(frozen["work_end"])), self.assertRaises(ValueError):
            runner.validate(frozen)
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_old_full140_variants_and_new21_freezes_cannot_cross(self):
        runner, frozen, path, expected, approval = self.prepared()
        for index, filename in enumerate(("full140-v4-public.py", "full140-mixed-v-off-public.py")):
            old = load_file(f"old_variant_{index}", filename)
            with self.assertRaises(ValueError):
                old.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                    synthetic_transport=httpx.MockTransport(lambda _: self.fail("混版不得请求")), credential_loader=lambda: self.fail("不得读凭据"))
            old_freeze = old.prepare(directory=self.home / f"old-{index}", absolute_start=datetime.now(timezone.utc))
            old_path = Path(old_freeze["directory"]) / "freeze.json"
            old_sha = old.helpers().file_digest(old_path)
            with self.assertRaises(ValueError):
                runner.worker(freeze_path=old_path, expected_sha256=old_sha,
                    approval={"user_authorized": True, "run_id": old_freeze["run_id"], "freeze_sha256": old_sha},
                    synthetic_transport=httpx.MockTransport(lambda _: self.fail("混版不得请求")), credential_loader=lambda: self.fail("不得读凭据"))
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_safety_technical_and_full_raw_tamper_stop_without_next_window_or_retry(self):
        for failure in ("safety_error", "missing", "timeout", "nonfinite", "raw_tamper"):
            with self.subTest(failure=failure):
                self.requests, self.extraction_positions = [], []
                runner, _, path, expected, approval = self.prepared(failure)
                outer = self
                class Bridge(original.SyntheticBridge):
                    def review(self, phase, view):
                        if phase == "raw":
                            for key in ("packet", "verification", "verification_inputs", "final_facts"):
                                outer.assertNotIn(key, view)
                        answer = super().review(phase, view)
                        if phase == "full" and failure == "raw_tamper":
                            answer["e_rows"][0]["basis"] = "试图替换已封存RAW依据"
                        return answer
                def respond(request):
                    response = self.respond(request)
                    if json.loads(request.content)["tools"][0]["function"]["name"] == "SourceVerificationOutput":
                        if failure == "timeout":
                            raise httpx.ReadTimeout("合成超时", request=request)
                        body = response.json()
                        if failure == "missing":
                            body["choices"][0]["message"]["tool_calls"] = []
                        elif failure == "nonfinite":
                            body["usage"] = {"total_tokens": float("nan")}
                        return httpx.Response(200, request=request, content=json.dumps(body).encode())
                    return response
                result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                    synthetic_transport=httpx.MockTransport(respond), credential_loader=lambda: "synthetic-key",
                    bridge=Bridge(stop="safety_error" if failure == "safety_error" else None))
                self.assertEqual(len(self.requests), 2)
                self.assertEqual(self.extraction_positions, [0])
                self.assertIsNotNone(result["stopped_code"])
                self.assertTrue(result["receipt"]["budget"]["closed"])
                self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 2)
                self.assertTrue(all(item["status"] == "unrun" for item in result["outcomes"][1:]))


if __name__ == "__main__":
    unittest.main()
