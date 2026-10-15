"""ECNU 评测入口的受守卫离线验收；只发送到 exact Mock。"""

from __future__ import annotations

import importlib
import hashlib
import json
import os
import socket
import tempfile
import unittest
from contextlib import ExitStack
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import httpx

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget, EvaluationBudgetAbort
from notalone.memory_extraction.evaluation_cases import CASES
from notalone.memory_extraction.evaluation import build_window
from notalone.memory_extraction.semantic_evaluation_cases import SEMANTIC_CASES


PLAN = tuple(case for case in CASES if case.dimension == "reference") + tuple(
    case for case in SEMANTIC_CASES if case.dimension == "reference"
) + tuple(case for case in SEMANTIC_CASES if case.name in {
    "严格：报价判断与条件咨询", "严格：第三人历史经历与当前未知",
})


class EvaluationECNUTest(unittest.TestCase):
    def test_explicit_v3_freezes_dynamic_contract_and_records_program_without_changing_default(self):
        def respond(request):
            body = json.loads(request.content)
            function = body["tools"][0]["function"]
            self.assertEqual(function["name"], "GroundedMemoryLabelsV3")
            names = function["parameters"]["properties"]["units"]["required"]
            label = {"kind": "not_memory", "subject": "contact", "topic": "other",
                     "dependency": None, "unresolved": False, "confidence": 0.9,
                     "sensitivity": "none", "ambiguity_codes": []}
            return self.response(request, arguments={"units": {name: dict(label) for name in names}})

        result = self.run_ready(extraction_mode="grounded-v3", case_positions=(7, 0),
                                transport=httpx.MockTransport(respond))

        self.assertEqual(result["extraction_mode"], "grounded-v3")
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(self.audits[0]["extraction_program"][0], {
            "extraction_mode": "grounded-v3", "status": "compiled", "facts": [],
        })
        config = json.loads((self.output / "manifest.json").read_text())["frozen_config"]
        self.assertEqual(config["extraction_mode"], "grounded-v3")
        self.assertEqual(config["request_contract_version"], 2)
        self.assertEqual(len(config["extraction_window_contracts"]), 2)
        self.assertFalse(result["quality_certified"])

    def test_v3_dynamic_prompt_drift_stops_before_second_dispatch(self):
        from notalone.memory_extraction import grounded_adapter

        original = grounded_adapter.GROUNDED_V3_PROMPT

        def respond(request):
            body = json.loads(request.content)
            names = body["tools"][0]["function"]["parameters"]["properties"]["units"]["required"]
            label = {"kind": "not_memory", "subject": "contact", "topic": "other",
                     "dependency": None, "unresolved": False, "confidence": 0.9,
                     "sensitivity": "none", "ambiguity_codes": []}
            grounded_adapter.GROUNDED_V3_PROMPT += "合成提示漂移。"
            return self.response(request, arguments={"units": {name: dict(label) for name in names}})

        try:
            result = self.run_ready(extraction_mode="grounded-v3", case_positions=(7, 0),
                                    transport=httpx.MockTransport(respond))
        finally:
            grounded_adapter.GROUNDED_V3_PROMPT = original

        self.assertEqual(len(self.requests), 1)
        self.assertEqual(result["stopped_code"], "ecnu_hard_stop")
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 1)


    def test_remaining8_rejects_any_changed_selection_budget_mode_or_protocol_before_claim(self):
        fixed = {"provider_profile": "deepseek-flash-max", "request_timeout_seconds": 300,
            "max_retries": 0, "verification_mode": "nullable-proof-v1", "verification_tool_choice": "omitted",
            "extraction_mode": "grounded-v2", "execution_plan": "reference21-remaining8-v1",
            "case_positions": (19, 20, 13, 14, 15, 16, 17, 18), "request_limit": 16}
        variants = [{"case_positions": None}, {"case_positions": (19, 20)},
            {"case_positions": (20, 19, 13, 14, 15, 16, 17, 18)}, {"case_positions": tuple(range(13, 21))},
            {"request_limit": 15}, {"request_limit": 17}, {"request_limit": 16.0}, {"execution_plan": "remaining8"},
            {"provider_profile": "ecnu"}, {"case_set": "full140"}, {"verification_mode": "legacy-v4"},
            {"extraction_mode": "legacy-e14"}, {"extraction_mode": "grounded-v3"},
            {"verification_tool_choice": "forced"},
            {"max_retries": 1}, {"request_timeout_seconds": 600}]
        for variant in variants:
            with self.subTest(variant=variant), self.assertRaises(EvaluationBudgetAbort):
                self.run_ready(**{**fixed, **variant})
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_remaining8_real_sdk_e_and_v_keep16_and_stop_before_next_window_on_safety(self):
        def respond(request):
            body = json.loads(request.content)
            function = body["tools"][0]["function"]
            if function["name"] == "GroundedMemoryLabels":
                label = {"kind": "state", "subject": "self", "topic": "study", "dependency": None,
                         "unresolved": True, "confidence": 0.9, "sensitivity": "none"}
                args = {"units": {slot: dict(label) for slot in function["parameters"]["properties"]["units"]["required"]}}
            else:
                candidates = json.loads(body["messages"][1]["content"])["candidates"]
                args = {"results": [{"candidate_index": index, "verdict": "uncertain",
                    "issues": ["insufficient_evidence"], "evidence": [], "proof": None} for index in range(len(candidates))]}
            self.assertNotIn("tool_choice", body)
            return self.response(request, arguments=args, reported_model="deepseek-flash")
        result = self.run_ready(provider_profile="deepseek-flash-max", request_timeout_seconds=300,
            max_retries=0, verification_mode="nullable-proof-v1", verification_tool_choice="omitted",
            extraction_mode="grounded-v2", execution_plan="reference21-remaining8-v1",
            case_positions=(19, 20, 13, 14, 15, 16, 17, 18), request_limit=16,
            audit=lambda bundle: self.audit(bundle, "safety_error", "false_fact"), transport=httpx.MockTransport(respond))
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(result["stopped_code"], "case_semantic_audit_safety_error")
        self.assertEqual(result["summary"]["unrun"], 7)
        self.assertEqual(result["receipt"]["budget"]["request_limit"], 16)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 2)
        self.assertTrue(result["receipt"]["budget"]["closed"])

    def test_live_remaining8_requires_owned_deadline_before_budget_or_credential(self):
        from notalone.memory_extraction.evaluation_ecnu import run_ecnu_evaluation
        hashes, gold = self.preparation(nullable=True)
        with self.assertRaisesRegex(EvaluationBudgetAbort, "remaining8_owned_deadline_required"):
            run_ecnu_evaluation(output_directory=self.output, run_id=uuid4(),
                deadline=datetime.now(timezone.utc) + timedelta(minutes=10), repo_root=self.repo,
                source_hashes=hashes, frozen_gold=gold, credential_loader=self.credential,
                audit_case=self.audit, provider_profile="deepseek-flash-max", request_timeout_seconds=300,
                max_retries=0, verification_mode="nullable-proof-v1", verification_tool_choice="omitted",
                extraction_mode="grounded-v2", execution_plan="reference21-remaining8-v1",
                case_positions=(19, 20, 13, 14, 15, 16, 17, 18), request_limit=16)
        self.assertEqual(self.credentials, [])
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_official_remaining8_has_fixed_core_first_order_and_separate16_budget(self):
        def respond(request):
            body = json.loads(request.content)
            self.assertEqual(str(request.url), "https://api.deepseek.com/chat/completions")
            self.assertEqual(body["model"], "deepseek-flash")
            self.assertEqual(body["reasoning_effort"], "max")
            self.assertNotIn("tool_choice", body)
            slots = body["tools"][0]["function"]["parameters"]["properties"]["units"]["required"]
            label = {"kind": "not_memory", "subject": "contact", "topic": "other", "dependency": None,
                     "unresolved": False, "confidence": 0.9, "sensitivity": "none"}
            return self.response(request, reported_model="deepseek-flash", arguments={
                "units": {slot: dict(label) for slot in slots},
            })

        result = self.run_ready(provider_profile="deepseek-flash-max", request_timeout_seconds=300,
            max_retries=0, verification_mode="nullable-proof-v1", verification_tool_choice="omitted",
            extraction_mode="grounded-v2", execution_plan="reference21-remaining8-v1",
            case_positions=(19, 20, 13, 14, 15, 16, 17, 18), request_limit=16,
            transport=httpx.MockTransport(respond))
        self.assertEqual(len(self.requests), 8)
        self.assertEqual([row["case_name"] for row in result["outcomes"]],
                         [PLAN[index].name for index in (19, 20, 13, 14, 15, 16, 17, 18)])
        self.assertTrue(result["receipt"]["budget"]["closed"])
        self.assertEqual(result["receipt"]["budget"]["request_limit"], 16)
        config = json.loads((self.output / "manifest.json").read_text())["frozen_config"]
        self.assertEqual(config["mode"], "deepseek_bounded_remaining8")
        self.assertEqual(config["stage"], "remaining8")
        self.assertEqual(config["selected_case_positions"], [19, 20, 13, 14, 15, 16, 17, 18])

    def test_official_reference21_uses_fixed42_and_max_without_tool_choice(self):
        def respond(request):
            body = json.loads(request.content)
            self.assertEqual(str(request.url), "https://api.deepseek.com/chat/completions")
            self.assertEqual(body["model"], "deepseek-flash")
            self.assertEqual(body["reasoning_effort"], "max")
            self.assertEqual(body["thinking"], {"type": "enabled"})
            self.assertNotIn("tool_choice", body)
            function = body["tools"][0]["function"]
            self.assertEqual(function["name"], "GroundedMemoryLabels")
            slots = function["parameters"]["properties"]["units"]["required"]
            label = {"kind": "not_memory", "subject": "contact", "topic": "other", "dependency": None,
                     "unresolved": False, "confidence": 0.9, "sensitivity": "none"}
            return self.response(request, reported_model="deepseek-flash", arguments={
                "units": {slot: dict(label) for slot in slots},
            })

        result = self.run_ready(
            provider_profile="deepseek-flash-max", case_set="reference21", request_limit=42,
            request_timeout_seconds=300, max_retries=0, verification_mode="nullable-proof-v1",
            verification_tool_choice="omitted", extraction_mode="grounded-v2", transport=httpx.MockTransport(respond),
        )
        self.assertEqual(len(self.requests), 21)
        self.assertTrue(result["summary"]["plan_complete"])
        self.assertEqual(result["receipt"]["budget"]["request_limit"], 42)
        config = json.loads((self.output / "manifest.json").read_text())["frozen_config"]
        self.assertEqual(config["mode"], "deepseek_bounded_evaluation")
        self.assertEqual(config["response_identity_policy"], "first_valid_completion_observation_stop_on_change")

    def test_official_reference21_rejects_subset_and_any_non42_budget_before_credential(self):
        variants = [{"case_positions": (0,)}, {"case_positions": tuple(range(21))}]
        variants += [{"request_limit": value} for value in (0, 1, 41, 43, 280, 42.0, True)]
        for variant in variants:
            with self.subTest(variant=variant), self.assertRaises(EvaluationBudgetAbort):
                self.run_ready(provider_profile="deepseek-flash-max", request_timeout_seconds=300,
                    max_retries=0, verification_mode="nullable-proof-v1", verification_tool_choice="omitted", **variant)
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_official_reference21_default42_reaches_v_and_rejects_ecnu_response_alias(self):
        def respond(request):
            body = json.loads(request.content)
            self.assertEqual(body["reasoning_effort"], "max")
            self.assertNotIn("tool_choice", body)
            if not self.requests:
                self.assertEqual(body["tools"][0]["function"]["name"], "GroundedMemoryLabels")
                label = {"kind": "state", "subject": "contact", "topic": "work", "dependency": None,
                         "unresolved": True, "confidence": 0.9, "sensitivity": "none"}
                args = {"units": {"0:0": dict(label), "0:1": dict(label)}}
                identity = "deepseek-flash"
            else:
                self.assertEqual(body["tools"][0]["function"]["name"], "SourceVerificationOutput")
                candidates = json.loads(body["messages"][1]["content"])["candidates"]
                args = {"results": [{"candidate_index": index, "verdict": "uncertain",
                    "issues": ["insufficient_evidence"], "evidence": [], "proof": None}
                    for index, _ in enumerate(candidates)]}
                identity = "deepseek-v4-flash"
            return self.response(request, arguments=args, reported_model=identity)

        result = self.run_ready(provider_profile="deepseek-flash-max", request_timeout_seconds=300,
            max_retries=0, verification_mode="nullable-proof-v1", verification_tool_choice="omitted",
            extraction_mode="grounded-v2", transport=httpx.MockTransport(respond))
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(result["stopped_code"], "deepseek_hard_stop")
        self.assertEqual(result["summary"]["unrun"], 20)
        self.assertEqual(result["receipt"]["budget"]["request_limit"], 42)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 2)
        self.assertEqual(self.audits, [])

    def test_grounded_actual_e_compile_v_and_phased_unknown_do_not_certify_quality(self):
        self._assert_grounded_actual_e_compile_v_and_phased_unknown("grounded-v2")

    def test_v3_actual_e_compile_v_and_sealed_phased_unknown_do_not_certify_quality(self):
        self._assert_grounded_actual_e_compile_v_and_phased_unknown("grounded-v3")

    def _assert_grounded_actual_e_compile_v_and_phased_unknown(self, mode):
        from notalone.memory_extraction.evaluation_phased_audit import PhasedEvaluationAudit
        from notalone.memory_extraction.evaluation_records import canonical_sha256

        root = Path(__file__).resolve().parents[4]
        reference = json.loads((root / ".scratch/unfinished-work/memory-gold-reference-20261012.json").read_bytes())
        hashes, gold = self.preparation()
        observed = []

        def raw(view):
            observed.append(view)
            return {
                "reviewer": "合成未决审核者", "case_id": view["case_id"],
                "reference_sha256": view["reference_sha256"],
                "raw_evidence_sha256": view["raw_evidence_sha256"],
                "e_rows": [{
                    "raw_index": item["index"], "payload_sha256": item["payload_sha256"],
                    "fields": {field: "unresolved" for field in view["e_fields"]},
                    "meaning": "unresolved", "inclusion": "unresolved", "safety": "unresolved",
                    "classification": "required", "basis": "合成审核没有语义证明。",
                } for item in view["extraction"]],
                "claims": [{"claim_id": claim["id"], "groups": []}
                           for claim in view["reference_case"]["claims"]],
                "window_checks": {"inclusion": "unresolved", "forbidden_meanings": "unresolved"},
            }

        def full(view):
            observed.append(view)
            answer = deepcopy(view["sealed_raw_review"])
            answer.pop("raw_evidence_sha256")
            packet = view["packet"]
            answer.update(evidence_sha256=packet["evidence_sha256"],
                          run_status=packet["evidence"]["run_status"])
            for row in answer["e_rows"]:
                row["lineage"] = {"v_input_indices": [], "final_indices": [], "status": "unresolved"}
            answer["v_rows"] = [{
                "result_index": item["index"], "payload_sha256": item["payload_sha256"],
                "fields": {field: "unresolved" for field in reference["v_fields"]},
                "semantic": "unresolved", "e_indices": [], "lineage": "unresolved",
                "basis": "合成审核没有来源语义证明。",
            } for item in packet["layers"]["verification"]]
            answer["window_checks"]["lineage"] = "unresolved"
            return answer

        audit = PhasedEvaluationAudit(
            reference=reference, expected_reference_sha256=canonical_sha256(reference),
            annotation_sha256=reference["annotation_sha256"], criteria_sha256=gold["criteria_sha256"],
            raw_reviewer=raw, full_reviewer=full, case_positions=(7, 0), extraction_mode=mode,
        )
        label = {"kind": "event", "subject": "contact", "topic": "study", "dependency": None,
                 "unresolved": False, "confidence": 0.9, "sensitivity": "none"}
        draft = {"units": {"1:0": {**label, "kind": "prefix"}, "1:1": label}}
        if mode == "grounded-v3":
            for item in draft["units"].values():
                item["ambiguity_codes"] = []
        tool_name = "GroundedMemoryLabelsV3" if mode == "grounded-v3" else "GroundedMemoryLabels"
        window = build_window(PLAN[7])

        def respond(request):
            body = json.loads(request.content)
            args = draft if body["tools"][0]["function"]["name"] == tool_name else {
                "results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
                             "evidence": [{"message_id": str(window.target_message_ids[0]),
                                           "quote": "《活着》，我刚看完。"}]}],
            }
            return self.response(request, arguments=args)

        result = self.run_ready(
            hashes=hashes, gold=gold, audit=audit, extraction_mode=mode,
            case_positions=(7, 0), transport=httpx.MockTransport(respond),
        )
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(result["stopped_code"], "case_semantic_audit_unknown")
        self.assertEqual(result["outcomes"][1]["status"], "unrun")
        self.assertFalse(result["summary"]["semantic_audit"]["quality_certified"])
        self.assertEqual(observed[0]["extraction_protocol"]["model_labels"], draft)
        self.assertIn("《活着》", observed[0]["extraction"][0]["payload"]["text"])
        self.assertEqual(observed[1]["packet"]["evidence"]["verification"][0]["verdict"], "supported")
        phases = [event["payload"] for event in result["events"]
                  if event["kind"] == "semantic_audit" and "phase" in event["payload"]]
        self.assertEqual([phase["phase"] for phase in phases], ["raw", "final"])
        self.assertTrue(all(phase["extraction_protocol"]["e14_origin"] == "grounded_compiler" for phase in phases))

    def test_grounded_mode_cannot_reinterpret_a_default_legacy_phased_audit(self):
        from notalone.memory_extraction.evaluation_phased_audit import PhasedEvaluationAudit
        from notalone.memory_extraction.evaluation_records import canonical_sha256

        root = Path(__file__).resolve().parents[4]
        reference = json.loads((root / ".scratch/unfinished-work/memory-gold-reference-20261012.json").read_bytes())
        audit = PhasedEvaluationAudit(
            reference=reference, expected_reference_sha256=canonical_sha256(reference),
            annotation_sha256=reference["annotation_sha256"], criteria_sha256="a" * 64,
            raw_reviewer=lambda view: {}, full_reviewer=lambda view: {},
        )
        with self.assertRaises(EvaluationBudgetAbort):
            self.run_ready(audit=audit, extraction_mode="grounded-v2")
        self.assertEqual(self.requests, [])
        self.assertEqual(self.credentials, [])

    def test_grounded_dynamic_requests_are_explicitly_frozen_and_still_use_original_audit(self):
        def respond(request):
            body = json.loads(request.content)
            function = body["tools"][0]["function"]
            self.assertEqual(function["name"], "GroundedMemoryLabels")
            names = function["parameters"]["properties"]["units"]["required"]
            label = {
                "kind": "not_memory", "subject": "contact", "topic": "other",
                "dependency": None, "unresolved": False, "confidence": 0.9,
                "sensitivity": "none",
            }
            return self.response(request, arguments={"units": {name: dict(label) for name in names}})

        result = self.run_ready(
            extraction_mode="grounded-v2", case_positions=(7, 0),
            transport=httpx.MockTransport(respond),
        )
        self.assertEqual(result["extraction_mode"], "grounded-v2")
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(len(self.audits), 2)
        self.assertEqual(self.audits[0]["extraction_mode"], "grounded-v2")
        self.assertEqual(self.audits[0]["extraction_program"][0]["facts"], [])
        config = json.loads((self.output / "manifest.json").read_text())["frozen_config"]
        self.assertEqual(config["extraction_mode"], "grounded-v2")
        contracts = config["extraction_window_contracts"]
        self.assertEqual(len(contracts), 2)
        self.assertNotEqual(contracts[0]["schema_sha256"], contracts[1]["schema_sha256"])
        self.assertFalse(result["quality_certified"])

    def test_grounded_official_max_keeps_omitted_tools_and_fixed_budget(self):
        self._assert_grounded_official_max_keeps_omitted_tools_and_fixed_budget("grounded-v2")

    def test_v3_official_max_keeps_omitted_tools_and_fixed_budget(self):
        self._assert_grounded_official_max_keeps_omitted_tools_and_fixed_budget("grounded-v3")

    def _assert_grounded_official_max_keeps_omitted_tools_and_fixed_budget(self, mode):
        hashes, gold, _ = self.full_preparation(nullable=True)

        def respond(request):
            body = json.loads(request.content)
            self.assertEqual(body["reasoning_effort"], "max")
            self.assertNotIn("tool_choice", body)
            function = body["tools"][0]["function"]
            self.assertEqual(function["name"], "GroundedMemoryLabelsV3" if mode == "grounded-v3" else "GroundedMemoryLabels")
            names = function["parameters"]["properties"]["units"]["required"]
            label = {"kind": "not_memory", "subject": "contact", "topic": "other",
                     "dependency": None, "unresolved": False, "confidence": 0.9, "sensitivity": "none"}
            if mode == "grounded-v3":
                label["ambiguity_codes"] = []
            return self.response(request, reported_model="deepseek-flash", arguments={
                "units": {name: dict(label) for name in names},
            })

        result = self.run_ready(
            hashes=hashes, gold=gold, case_set="full140", provider_profile="deepseek-flash-max",
            request_timeout_seconds=300, max_retries=0, verification_mode="nullable-proof-v1",
            verification_tool_choice="omitted", request_limit=1, extraction_mode=mode,
            transport=httpx.MockTransport(respond),
            audit=lambda bundle: self.audit(bundle, "unknown", "audit_unresolved"),
        )
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(result["stopped_code"], "case_semantic_audit_unknown")
        self.assertEqual(result["summary"]["unrun"], 139)
        self.assertEqual(result["receipt"]["budget"]["request_limit"], 1)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 1)

    def test_grounded_dynamic_schema_change_stops_before_second_dispatch(self):
        from notalone.memory_extraction import grounded_adapter

        original = deepcopy(grounded_adapter.GROUNDED_SCHEMA)

        def respond(request):
            body = json.loads(request.content)
            names = body["tools"][0]["function"]["parameters"]["properties"]["units"]["required"]
            label = {"kind": "not_memory", "subject": "contact", "topic": "other",
                     "dependency": None, "unresolved": False, "confidence": 0.9, "sensitivity": "none"}
            grounded_adapter.GROUNDED_SCHEMA["properties"]["units"]["items"]["properties"]["confidence"]["description"] = "合成schema漂移"
            return self.response(request, arguments={"units": {name: dict(label) for name in names}})

        try:
            result = self.run_ready(
                extraction_mode="grounded-v2", case_positions=(7, 0),
                transport=httpx.MockTransport(respond),
            )
        finally:
            grounded_adapter.GROUNDED_SCHEMA.clear()
            grounded_adapter.GROUNDED_SCHEMA.update(original)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(result["stopped_code"], "ecnu_hard_stop")
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 1)
        self.assertEqual(result["outcomes"][1]["status"], "unknown")

    def test_grounded_never_falls_back_to_an_old_e14_tool_response(self):
        def respond(request):
            body = self.response(request).json()
            body["choices"][0]["message"]["tool_calls"][0]["function"]["name"] = "MemoryExtractionOutput"
            return httpx.Response(200, request=request, json=body)

        result = self.run_ready(extraction_mode="grounded-v2", case_positions=(7, 0),
                                transport=httpx.MockTransport(respond))
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(result["stopped_code"], "case_contract_or_runtime_failed")
        self.assertEqual(result["outcomes"][1]["status"], "unrun")
        self.assertEqual(self.audits, [])
        self.assertFalse(any(event["kind"] == "extraction_program" and
                             event["payload"].get("status") == "compiled"
                             for event in result["events"]))

    def test_official_remaining_budget_cannot_exceed_full_round(self):
        for limit in (0, 281, True):
            with self.subTest(limit=limit), self.assertRaises(EvaluationBudgetAbort):
                self.run_ready(provider_profile="deepseek-flash-max", case_set="full140",
                               verification_tool_choice="omitted", request_limit=limit)
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])

    def test_official_flash_max_reaches_both_sdk_requests_and_stops_on_safety(self):
        hashes, gold, _ = self.full_preparation(nullable=True)
        window = build_window(PLAN[0])
        source = str(window.target_message_ids[0])
        fact = {
            "text": "未知第三人不是仓库管理员，在采购部。",
            "category": "relationship_note", "subject": "contact", "topic": "work",
            "source_message_ids": [source], "confidence": 0.9, "risk_flags": [],
            "valid_at": None, "invalid_at": None, "speech_act": "report",
            "assertion_status": "reported", "figurative_type": "literal",
            "alternatives": ["第三人身份未知。"], "interpretation_reason": "来源明确说明部门。",
        }

        def respond(request):
            self.assertEqual(str(request.url), "https://api.deepseek.com/chat/completions")
            body = json.loads(request.content)
            self.assertEqual(body["model"], "deepseek-flash")
            self.assertEqual(body["thinking"], {"type": "enabled"})
            self.assertEqual(body["reasoning_effort"], "max")
            self.assertNotIn("tool_choice", body)
            extraction = body["tools"][0]["function"]["name"] == "MemoryExtractionOutput"
            args = {"facts": [fact]} if extraction else {"results": [{
                "candidate_index": 0, "verdict": "supported", "issues": [],
                "evidence": [{"message_id": source, "quote": window.messages[0].text}],
            }]}
            return self.response(request, arguments=args, reported_model="deepseek-flash")

        result = self.run_ready(
            hashes=hashes, gold=gold, case_set="full140", provider_profile="deepseek-flash-max",
            request_timeout_seconds=300, max_retries=0, transport=httpx.MockTransport(respond),
            verification_mode="nullable-proof-v1", verification_tool_choice="omitted", request_limit=279,
            audit=lambda bundle: self.audit(bundle, "safety_error", "false_fact"),
        )
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(result["stopped_code"], "case_semantic_audit_safety_error")
        self.assertEqual(result["summary"]["unrun"], 139)
        self.assertEqual(result["receipt"]["budget"]["request_limit"], 279)
        self.assertTrue(result["receipt"]["budget"]["closed"])
        config = json.loads((self.output / "manifest.json").read_text())["frozen_config"]
        self.assertEqual(config["reasoning_effort"], "max")
        self.assertNotIn("reasoning_effort", config["omitted_parameters"])

    def setUp(self) -> None:
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(os, "environ", {}))
        for module_name in ("httpx", "httpx2", "httpx._client", "httpx2._client"):
            module = importlib.import_module(module_name)
            for name in ("HTTPTransport", "AsyncHTTPTransport"):
                self.stack.enter_context(patch.object(
                    module, name,
                    side_effect=AssertionError("禁止真实 network transport"),
                ))
        for name in ("connect", "connect_ex"):
            self.stack.enter_context(patch.object(
                socket.socket, name,
                side_effect=AssertionError("禁止真实 socket 连接"),
            ))
        self.stack.enter_context(patch.object(
            socket, "getaddrinfo", side_effect=AssertionError("禁止真实 DNS 查询"),
        ))
        self.home = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(patch.object(Path, "home", return_value=self.home))
        self.output = self.home / "output"
        self.output.mkdir(mode=0o700)
        self.repo = self.home / "repo"
        self.repo.mkdir()
        self.requests = []
        self.credentials = []
        self.audits = []

    def preparation(self, *, nullable=False):
        actual_repo = Path(__file__).resolve().parents[4]
        relatives = [str(path.relative_to(actual_repo)) for path in
                     (actual_repo / "backend/src/notalone/memory_extraction").rglob("*.py")]
        relatives += [
            "backend/pyproject.toml", "backend/src/notalone/__init__.py",
            "backend/src/notalone/scopes.py",
            *(f"backend/src/notalone/memory/{name}.py" for name in
              ("__init__", "adapters", "models", "ports", "timing")),
            *(f"backend/src/notalone/memory_trace/{name}.py" for name in
              ("__init__", "context", "ports", "transport")),
            *(f"backend/src/notalone/ledger/{name}.py" for name in
              ("__init__", "models", "ports")),
            ".scratch/unfinished-work/memory-gold-agent-annotations-20261012.md",
        ]
        if nullable:
            relatives += [f"backend/src/notalone/memory/{name}.py" for name in (
                "dimension_evidence", "evidence_binding", "pragmatics",
            )]
        hashes = {}
        for relative in relatives:
            path = self.repo / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("合成冻结资料。\n", encoding="utf-8")
            hashes[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        criterion = ".scratch/unfinished-work/memory-gold-agent-annotations-20261012.md"
        return hashes, {
            "status": "frozen_agent_review", "case_names": [case.name for case in PLAN],
            "criteria_sha256": hashes[criterion],
        }

    def credential(self):
        self.credentials.append("loaded")
        return "synthetic-not-a-real-key"

    def full_preparation(self, *, change=None, nullable=False):
        from tests.unit.memory_extraction.test_evaluation_reference import full_reference_fixture
        from notalone.memory_extraction.evaluation_reference import (
            FULL_ANNOTATION_PATH, FULL_REFERENCE_PATH, PUBLIC_REFERENCE_PATH,
        )

        hashes, _ = self.preparation(nullable=nullable)
        reference = full_reference_fixture()
        if change is not None:
            change(reference)
        root = Path(__file__).resolve().parents[4]
        sources = {
            FULL_REFERENCE_PATH: json.dumps(reference, ensure_ascii=False).encode(),
            FULL_ANNOTATION_PATH: "合成协议判据。".encode(),
            PUBLIC_REFERENCE_PATH: (root / PUBLIC_REFERENCE_PATH).read_bytes(),
            ".scratch/unfinished-work/memory-gold-agent-annotations-20261012.md": (
                root / ".scratch/unfinished-work/memory-gold-agent-annotations-20261012.md"
            ).read_bytes(),
        }
        for relative, content in sources.items():
            path = self.repo / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            hashes[relative] = hashlib.sha256(content).hexdigest()
        gold = {
            "status": "frozen_agent_review",
            "case_names": [case.name for case in (*CASES, *SEMANTIC_CASES)],
            "criteria_path": FULL_REFERENCE_PATH,
            "criteria_sha256": hashes[FULL_REFERENCE_PATH],
        }
        return hashes, gold, reference

    def audit(self, bundle, decision="general_error", reason="coverage_miss"):
        self.audits.append(bundle)
        return {
            "case_position": bundle["case_position"], "decision": decision,
            "reason_code": reason,
            "criteria_sha256": bundle["gold_reference"]["criteria_sha256"],
        }

    def response(self, request, *, arguments=None, reported_model="synthetic-reported-model"):
        payload = json.loads(request.content)
        self.requests.append(payload)
        return httpx.Response(200, request=request, json={
            "id": "synthetic-completion", "object": "chat.completion", "created": 1,
            "model": reported_model,
            "choices": [{"index": 0, "message": {
                "role": "assistant", "content": None, "tool_calls": [{
                    "id": "synthetic-call", "type": "function", "function": {
                        "name": payload["tools"][0]["function"]["name"],
                        "arguments": json.dumps({"facts": []} if arguments is None else arguments),
                    },
                }],
            }, "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        })

    def run_ready(self, *, transport=None, audit=None, gold=None, hashes=None,
                  credential=None, run_id=None, **request_parameters):
        from notalone.memory_extraction.evaluation_ecnu import run_ecnu_evaluation

        if hashes is None or gold is None:
            prepared_hashes, prepared_gold = self.preparation(
                nullable=request_parameters.get("verification_mode") == "nullable-proof-v1",
            )
            hashes = prepared_hashes if hashes is None else hashes
            gold = prepared_gold if gold is None else gold
        return run_ecnu_evaluation(
            output_directory=self.output, run_id=run_id or uuid4(),
            deadline=datetime.now(timezone.utc) + timedelta(minutes=10),
            repo_root=self.repo, source_hashes=hashes, frozen_gold=gold,
            credential_loader=credential or self.credential, audit_case=audit or self.audit,
            synthetic_transport=transport or httpx.MockTransport(self.response),
            **request_parameters,
        )

    def test_explicit_timeout_and_zero_retries_match_frozen_E_and_V_requests(
        self,
    ):
        window = build_window(PLAN[0])
        source = str(window.target_message_ids[0])
        fact = {
            "text": "未知第三人不是仓库管理员，在采购部。",
            "category": "relationship_note", "subject": "contact", "topic": "work",
            "source_message_ids": [source], "confidence": 0.9,
            "risk_flags": [], "valid_at": None, "invalid_at": None,
            "speech_act": "report", "assertion_status": "reported",
            "figurative_type": "literal", "alternatives": ["第三人身份未知。"],
            "interpretation_reason": "合成第三人原话。",
        }
        timeouts = []

        def response(request):
            timeouts.append(request.extensions["timeout"])
            payload = json.loads(request.content)
            if payload["tool_choice"]["function"]["name"] == "MemoryExtractionOutput":
                return self.response(request, arguments={"facts": [fact]})
            self.requests.append(payload)
            raise httpx.ReadTimeout("合成V读取超时。", request=request)

        result = self.run_ready(
            transport=httpx.MockTransport(response),
            request_timeout_seconds=180, max_retries=0,
        )

        self.assertEqual(len(self.requests), 2)
        self.assertEqual(
            timeouts,
            [dict.fromkeys(("connect", "read", "write", "pool"), 180.0)] * 2,
        )
        manifest = json.loads((self.output / "manifest.json").read_text())
        self.assertEqual(manifest["frozen_config"]["timeout"], 180.0)
        self.assertEqual(manifest["frozen_config"]["max_retries"], 0)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 2)
        self.assertEqual(result["summary"]["unknown"], 1)
        self.assertEqual(result["summary"]["unrun"], 20)
        self.assertFalse(result["receipt"]["quality_certified"])

    def test_nullable_mode_runs_actual_adapter_and_preserves_model_and_program_separately(self):
        window = build_window(PLAN[7])
        source = str(window.target_message_ids[0])
        fact = {
            "text": "联系人刚读完《活着》。", "category": "common_fact",
            "subject": "contact", "topic": "study", "source_message_ids": [source],
            "confidence": 0.99, "risk_flags": [], "valid_at": None, "invalid_at": None,
            "speech_act": "assertion", "assertion_status": "asserted", "figurative_type": "literal",
            "alternatives": [], "interpretation_reason": "合成直接阅读状态。",
        }
        raw_v = {"candidate_index": 0, "verdict": "supported", "issues": [],
                 "evidence": [{"message_id": source, "quote": window.messages[1].text}],
                 "proof": None}

        def response(request):
            body = json.loads(request.content)
            name = body["tool_choice"]["function"]["name"]
            return self.response(request, arguments={"facts": [fact]} if
                                 name == "MemoryExtractionOutput" else {"results": [raw_v]})

        result = self.run_ready(
            transport=httpx.MockTransport(response), case_positions=(7,),
            request_timeout_seconds=300, max_retries=0,
            verification_mode="nullable-proof-v1",
            audit=lambda bundle: self.audit(bundle, "unknown", "audit_unresolved"),
        )
        self.assertEqual(len(self.requests), 2)
        manifest = json.loads((self.output / "manifest.json").read_text())
        self.assertEqual(manifest["frozen_config"]["verification_mode"], "nullable-proof-v1")
        v_request = self.requests[1]
        self.assertIn("nullable-proof-v1", v_request["messages"][0]["content"])
        self.assertIn("proof", v_request["tools"][0]["function"]["parameters"]
                      ["properties"]["results"]["items"]["properties"])
        self.assertEqual(self.audits[0]["verification_mode"], "nullable-proof-v1")
        self.assertEqual(self.audits[0]["adapter_outputs"][1]["tool_calls"][0]
                         ["args"]["results"], [raw_v])
        program = self.audits[0]["verification_program"][0]["results"][0]
        self.assertEqual(program["model_verdict"], "supported")
        self.assertEqual(program["model_issues"], [])
        self.assertEqual(program["proof_verification"]["status"], "UNKNOWN")
        final = result["outcomes"][0]["result"]["facts"][0]
        # 原评分保留ADR-036的理想去向，不代签空放行表下的实际产品采纳。
        self.assertEqual(final["destination"], "auto")
        self.assertEqual(final["dimension_evidence"]["version"], 2)
        self.assertFalse(final["dimension_evidence"]["source_bound"])
        self.assertIsNone(final["dimension_evidence"]["semantic_basis"])
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 2)
        self.assertFalse(result["quality_certified"])

    def test_omitted_verification_preserves_wire_capture_and_known_ecnu_labels(self):
        window = build_window(PLAN[7])
        source = str(window.target_message_ids[0])
        fact = {
            "text": "联系人刚读完《活着》。", "category": "common_fact", "subject": "contact",
            "topic": "study", "source_message_ids": [source], "confidence": 0.99,
            "risk_flags": [], "valid_at": None, "invalid_at": None,
            "speech_act": "assertion", "assertion_status": "asserted", "figurative_type": "literal",
            "alternatives": [], "interpretation_reason": "合成阅读完成状态。",
        }
        raw_v = {"candidate_index": 0, "verdict": "supported", "issues": [],
                 "evidence": [{"message_id": source, "quote": window.messages[1].text}], "proof": None}

        def response(request):
            body = json.loads(request.content)
            self.requests.append(body)
            name = body["tools"][0]["function"]["name"]
            recorded = [json.loads(path.read_text()) for path in self.output.glob("event-*.json")]
            saved = next(event["payload"] for event in recorded if event["kind"] == "provider_request"
                         and event["request_sequence"] == len(self.requests))
            self.assertEqual(saved["body"], body)
            self.assertEqual(saved["capture_layer"], "sdk_http_body")
            self.assertEqual(saved["original_bytes_sha256"], hashlib.sha256(request.content).hexdigest())
            self.assertEqual(saved["original_bytes_length"], len(request.content))
            self.assertEqual(request.extensions["timeout"],
                             dict.fromkeys(("connect", "read", "write", "pool"), 300.0))
            return httpx.Response(200, request=request, json={
                "id": "synthetic-completion", "object": "chat.completion", "created": 1,
                "model": "deepseek-v4-flash" if name == "MemoryExtractionOutput" else "deepseek-flash",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": None,
                    "tool_calls": [{"id": "synthetic-call", "type": "function", "function": {
                        "name": name, "arguments": json.dumps({"facts": [fact]} if
                         name == "MemoryExtractionOutput" else {"results": [raw_v]})}}]},
                    "finish_reason": "tool_calls"}],
            })

        result = self.run_ready(
            transport=httpx.MockTransport(response), case_positions=(7,),
            request_timeout_seconds=300, max_retries=0, verification_mode="nullable-proof-v1",
            verification_tool_choice="omitted", response_identity_policy="ecnu_configured_route_known_labels_v1",
            audit=lambda bundle: self.audit(bundle, "unknown", "audit_unresolved"),
        )
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(set(self.requests[0]), {"model", "temperature", "stream", "thinking", "messages", "tools", "tool_choice"})
        self.assertEqual(set(self.requests[1]), set(self.requests[0]) - {"tool_choice"})
        candidate = json.loads(self.requests[1]["messages"][1]["content"])["candidates"][0]
        self.assertEqual(candidate, {"candidate_index": 0, **{key: fact[key] for key in (
            "text", "subject", "category", "topic", "source_message_ids", "valid_at", "invalid_at",
            "speech_act", "assertion_status", "figurative_type")}})
        self.assertEqual(self.audits[0]["verification_tool_choice"], "omitted")
        self.assertEqual(self.audits[0]["adapter_outputs"][1]["tool_calls"][0]["args"]["results"], [raw_v])
        self.assertEqual([item["body"]["model"] for item in self.audits[0]["provider_responses"]],
                         ["deepseek-v4-flash", "deepseek-flash"])
        config = json.loads((self.output / "manifest.json").read_text())["frozen_config"]
        self.assertEqual(config["tool_choice"]["verification"]["mode"], "omitted")
        self.assertEqual(config["response_identity_policy"]["known_labels"], ["deepseek-flash", "deepseek-v4-flash"])
        self.assertFalse(config["response_identity_policy"]["weights_identity_verified"])
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 2)
        self.assertFalse(result["quality_certified"])

    def test_unknown_wire_and_route_policy_reject_before_registration_and_key(self):
        from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget

        for policy in ({"verification_tool_choice": "auto"},
                       {"response_identity_policy": "accept_every_label"},
                       {"verification_tool_choice": "omitted"}):
            with self.subTest(policy=policy), patch.object(EvaluationBudget, "create") as create:
                with self.assertRaises(EvaluationBudgetAbort):
                    self.run_ready(**policy)
                create.assert_not_called()
        self.assertEqual(self.requests, [])
        self.assertEqual(self.credentials, [])

    def test_late_claimed_budget_stops_before_credentials(self):
        from notalone.memory_extraction.evaluation_provider_contract import ECNUEvaluationContract
        from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget

        create_budget = EvaluationBudget.create
        now = [datetime.now(timezone.utc)]
        deadline = []

        def contract(**parameters):
            deadline.append(parameters["deadline"])
            return ECNUEvaluationContract(**parameters, clock=lambda: now[0])

        def create(**parameters):
            budget = create_budget(**parameters)
            now[0] = deadline[0]
            return budget

        with patch("notalone.memory_extraction.evaluation_provider_contract.ECNUEvaluationContract", side_effect=contract), \
                patch.object(EvaluationBudget, "create", side_effect=create):
            result = self.run_ready(verification_mode="nullable-proof-v1", verification_tool_choice="omitted",
                                    response_identity_policy="ecnu_configured_route_known_labels_v1",
                                    request_timeout_seconds=300, max_retries=0)
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 0)
        self.assertTrue(result["receipt"]["budget"]["closed"])

    def test_omitted_policy_with_unknown_or_missing_label_stops_and_closes(self):
        for label in ("unapproved-label", None):
            with self.subTest(label=label):
                self.output = self.home / ("output-unknown" if label else "output-missing")
                self.output.mkdir(mode=0o700)
                def response(request):
                    result = self.response(request, reported_model=label)
                    value = json.loads(result.content)
                    if label is None:
                        del value["model"]
                    return httpx.Response(200, request=request, json=value)
                result = self.run_ready(
                    transport=httpx.MockTransport(response), case_positions=(7,),
                    verification_mode="nullable-proof-v1", verification_tool_choice="omitted",
                    response_identity_policy="ecnu_configured_route_known_labels_v1",
                    request_timeout_seconds=300, max_retries=0,
                )
                self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 1)
                self.assertTrue(result["receipt"]["budget"]["closed"])
                self.assertFalse(result["quality_certified"])
                self.assertEqual(self.audits, [])

    def test_new_policy_external_trace_is_rejected_before_registration(self):
        with patch("langsmith.get_tracing_context", return_value={"enabled": True}), \
                patch.object(EvaluationBudget, "create") as create:
            with self.assertRaises(EvaluationBudgetAbort):
                self.run_ready(verification_mode="nullable-proof-v1", verification_tool_choice="omitted",
                               response_identity_policy="ecnu_configured_route_known_labels_v1",
                               request_timeout_seconds=300, max_retries=0)
            create.assert_not_called()
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])

    def test_new_policy_actual_request_model_change_reserves_zero(self):
        from langchain_deepseek import ChatDeepSeek
        original_payload = ChatDeepSeek._get_request_payload

        def changed_payload(model, *args, **kwargs):
            value = original_payload(model, *args, **kwargs)
            value["model"] = "different-model"
            return value

        with patch.object(ChatDeepSeek, "_get_request_payload", changed_payload):
            result = self.run_ready(verification_mode="nullable-proof-v1", verification_tool_choice="omitted",
                                   response_identity_policy="ecnu_configured_route_known_labels_v1",
                                   request_timeout_seconds=300, max_retries=0)
        self.assertEqual(self.requests, [])
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 0)
        self.assertTrue(result["receipt"]["budget"]["closed"])

    def test_new_policy_source_changes_after_claim_before_key_are_rejected(self):
        create_budget = EvaluationBudget.create

        def create(**parameters):
            budget = create_budget(**parameters)
            source = self.repo / "backend/src/notalone/memory/evidence_binding.py"
            source.write_text("变更的合成源码。")
            return budget

        with patch.object(EvaluationBudget, "create", side_effect=create):
            result = self.run_ready(verification_mode="nullable-proof-v1", verification_tool_choice="omitted",
                                   response_identity_policy="ecnu_configured_route_known_labels_v1",
                                   request_timeout_seconds=300, max_retries=0)
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 0)
        self.assertTrue(result["receipt"]["budget"]["closed"])

    def test_phased_omitted_policy_mismatch_rejects_before_registration(self):
        from notalone.memory_extraction.evaluation_phased_audit import PhasedEvaluationAudit
        from notalone.memory_extraction.evaluation_reference import PUBLIC_REFERENCE_PATH

        root = Path(__file__).resolve().parents[4]
        raw_reference = (root / PUBLIC_REFERENCE_PATH).read_bytes()
        reference = json.loads(raw_reference)
        audit = PhasedEvaluationAudit(
            reference=reference, expected_reference_sha256="5fb8d53b90a1a96c5987ac7b825bb233cc3e9f196f976e4851c40b0243b77b32",
            annotation_sha256=reference["annotation_sha256"], criteria_sha256=hashlib.sha256(raw_reference).hexdigest(),
            raw_reviewer=lambda view: {}, full_reviewer=lambda view: {},
            verification_mode="nullable-proof-v1", verification_tool_choice="omitted",
        )
        with patch.object(EvaluationBudget, "create") as create:
            with self.assertRaises(EvaluationBudgetAbort):
                self.run_ready(verification_mode="nullable-proof-v1", audit=audit,
                               request_timeout_seconds=300, max_retries=0)
            create.assert_not_called()
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])

    def test_invalid_or_mismatched_verification_mode_stops_before_registration(self):
        from notalone.memory_extraction.evaluation_ecnu import run_ecnu_evaluation
        from notalone.memory_extraction.evaluation_phased_audit import PhasedEvaluationAudit
        from notalone.memory_extraction.evaluation_reference import PUBLIC_REFERENCE_PATH

        hashes, gold = self.preparation()
        root = Path(__file__).resolve().parents[4]
        content = (root / PUBLIC_REFERENCE_PATH).read_bytes()
        reference = json.loads(content)
        criterion = hashlib.sha256(content).hexdigest()
        hashes[PUBLIC_REFERENCE_PATH] = criterion
        gold.update(criteria_path=PUBLIC_REFERENCE_PATH, criteria_sha256=criterion)
        audit = PhasedEvaluationAudit(
            reference=reference,
            expected_reference_sha256="5fb8d53b90a1a96c5987ac7b825bb233cc3e9f196f976e4851c40b0243b77b32",
            annotation_sha256=reference["annotation_sha256"], criteria_sha256=criterion,
            raw_reviewer=lambda view: {}, full_reviewer=lambda view: {},
        )
        with patch.object(EvaluationBudget, "create", side_effect=AssertionError("不得登记预算。")):
            protocols = ((None, None), (True, None), ("unknown", None),
                         ("nullable-proof-v1", None),
                         ("nullable-proof-v1", httpx.MockTransport(self.response)))
            for mode, transport in protocols:
                with self.subTest(mode=mode, synthetic=transport is not None), self.assertRaisesRegex(
                    EvaluationBudgetAbort, "ecnu_(invalid_verification_mode|phased_verification_mode_mismatch)",
                ):
                    run_ecnu_evaluation(
                        output_directory=self.output, run_id=uuid4(),
                        deadline=datetime.now(timezone.utc) + timedelta(minutes=10),
                        repo_root=root, source_hashes=hashes, frozen_gold=gold,
                        credential_loader=self.credential, audit_case=audit,
                        verification_mode=mode,
                        request_timeout_seconds=300, max_retries=0,
                        synthetic_transport=transport,
                    )
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])

    def test_nullable_live_contract_drift_stops_before_first_mock_http(self):
        from notalone.memory_extraction import verification_adapters

        for mutation in ("schema", "prompt"):
            with self.subTest(mutation=mutation):
                self.output = self.home / ("proof-drift-" + mutation)
                self.output.mkdir(mode=0o700)
                original_schema = deepcopy(verification_adapters.SOURCE_VERIFICATION_PROOF_SCHEMA)
                original_prompt = verification_adapters.SOURCE_PROOF_PROMPT

                def credential():
                    if mutation == "schema":
                        verification_adapters.SOURCE_VERIFICATION_PROOF_SCHEMA["description"] = "合成漂移。"
                    else:
                        verification_adapters.SOURCE_PROOF_PROMPT += "合成漂移。"
                    return self.credential()

                try:
                    result = self.run_ready(
                        credential=credential, verification_mode="nullable-proof-v1",
                        request_timeout_seconds=300, max_retries=0,
                    )
                finally:
                    verification_adapters.SOURCE_VERIFICATION_PROOF_SCHEMA.clear()
                    verification_adapters.SOURCE_VERIFICATION_PROOF_SCHEMA.update(original_schema)
                    verification_adapters.SOURCE_PROOF_PROMPT = original_prompt
                self.assertEqual(self.requests, [])
                self.assertEqual(self.audits, [])
                self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 0)
                self.assertEqual(result["stopped_code"], "ecnu_hard_stop")

    def test_nullable_mode_keeps_fixed_300_seconds_and_zero_retries_before_registration(self):
        with patch.object(EvaluationBudget, "create", side_effect=AssertionError("不得登记预算。")):
            for parameters in ({}, {"request_timeout_seconds": 180, "max_retries": 0},
                               {"request_timeout_seconds": 300, "max_retries": 1}):
                with self.subTest(parameters=parameters), self.assertRaisesRegex(
                    EvaluationBudgetAbort, "ecnu_nullable_fixed_request_limits",
                ):
                    self.run_ready(verification_mode="nullable-proof-v1", **parameters)
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])

    def test_nullable_requires_all_actual_semantic_dependencies_before_registration(self):
        hashes, gold = self.preparation(nullable=True)
        required = (
            "backend/src/notalone/memory/dimension_evidence.py",
            "backend/src/notalone/memory/evidence_binding.py",
            "backend/src/notalone/memory/pragmatics.py",
            "backend/src/notalone/memory_extraction/source_proof.py",
            "backend/src/notalone/memory_extraction/pragmatics.py",
        )
        with patch.object(EvaluationBudget, "create", side_effect=AssertionError("缺源码不得登记。")):
            for missing in required:
                with self.subTest(missing=missing), self.assertRaisesRegex(
                    EvaluationBudgetAbort, "ecnu_source_freeze_incomplete",
                ):
                    self.run_ready(
                        hashes={path: digest for path, digest in hashes.items() if path != missing},
                        gold=gold, case_positions=(0,), verification_mode="nullable-proof-v1",
                        request_timeout_seconds=300, max_retries=0,
                    )
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])
        self.assertEqual(tuple(self.output.iterdir()), ())

    def test_nullable_semantic_source_drift_stops_before_first_mock_http(self):
        for name in ("dimension_evidence", "evidence_binding", "pragmatics"):
            with self.subTest(source=name):
                self.output = self.home / ("semantic-source-drift-" + name)
                self.output.mkdir(mode=0o700)
                hashes, gold = self.preparation(nullable=True)
                path = self.repo / f"backend/src/notalone/memory/{name}.py"

                def credential():
                    path.write_text("合成源码在冻结后发生变化。\n", encoding="utf-8")
                    return self.credential()

                result = self.run_ready(
                    hashes=hashes, gold=gold, credential=credential,
                    case_positions=(0,), verification_mode="nullable-proof-v1",
                    request_timeout_seconds=300, max_retries=0,
                )
                self.assertEqual(self.requests, [])
                self.assertEqual(self.audits, [])
                self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 0)
                self.assertEqual(result["stopped_code"], "ecnu_hard_stop")
        self.assertEqual(self.credentials, ["loaded"] * 3)

    def test_legacy_admission_keeps_original_source_set_without_nullable_dependencies(self):
        hashes, gold = self.preparation()
        self.assertFalse(any(f"backend/src/notalone/memory/{name}.py" in hashes
                             for name in ("dimension_evidence", "evidence_binding", "pragmatics")))
        result = self.run_ready(
            hashes=hashes, gold=gold, case_positions=(0,),
            request_timeout_seconds=300, max_retries=0,
            audit=lambda bundle: self.audit(bundle, "unknown", "audit_unresolved"),
        )
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.credentials, ["loaded"])
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 1)
        manifest = json.loads((self.output / "manifest.json").read_text())
        self.assertEqual(manifest["frozen_config"]["verification_mode"], "legacy-v4")

    def test_nullable_phased_audit_seals_actual_sdk_proof_and_program_receipts(self):
        self._exercise_nullable_phased_audit(verification_tool_choice="forced")

    def test_omitted_actual_sdk_phased_audit_keeps_raw_full_and_original_gold(self):
        self._exercise_nullable_phased_audit(verification_tool_choice="omitted")

    def _exercise_nullable_phased_audit(self, *, verification_tool_choice):
        from tests.unit.memory_extraction.test_evaluation_phased_audit import EvaluationPhasedAuditTest
        from notalone.memory_extraction.evaluation_reference import PUBLIC_REFERENCE_PATH

        phase = EvaluationPhasedAuditTest()
        phase.setUp()
        self.addCleanup(phase.doCleanups)
        phase.bundle["case_position"] = 0
        raw_v = deepcopy(phase.bundle["adapter_outputs"][1]["tool_calls"][0]["args"]["results"][0])
        raw_v["proof"] = None
        hashes, gold = self.preparation(nullable=True)
        content = (phase.root / PUBLIC_REFERENCE_PATH).read_bytes()
        copied = self.repo / PUBLIC_REFERENCE_PATH
        copied.parent.mkdir(parents=True, exist_ok=True)
        copied.write_bytes(content)
        hashes[PUBLIC_REFERENCE_PATH] = hashlib.sha256(content).hexdigest()
        gold.update(criteria_path=PUBLIC_REFERENCE_PATH, criteria_sha256=hashes[PUBLIC_REFERENCE_PATH])

        def response(request):
            name = json.loads(request.content)["tools"][0]["function"]["name"]
            return self.response(request, arguments={"facts": [phase.fact]} if
                                 name == "MemoryExtractionOutput" else {"results": [raw_v]})

        def full_review(view):
            phase.order.append("full")
            receipt = view["raw_receipt"]
            saved = json.loads((self.output / f"event-{receipt['event_sequence']:06d}.json").read_text())
            self.assertEqual(saved["payload"]["review"], view["sealed_raw_review"])
            packet = view["packet"]
            answer = deepcopy(view["sealed_raw_review"])
            answer.pop("raw_evidence_sha256")
            answer.update(evidence_sha256=packet["evidence_sha256"],
                          run_status=packet["evidence"]["run_status"])
            for row in answer["e_rows"]:
                row["lineage"] = {"v_input_indices": [0], "final_indices": [0], "status": "pass"}
            for claim in answer["claims"]:
                for group in claim["groups"]:
                    group.update(final_indices=[0], lineage="pass", destination="pass")
            answer["v_rows"] = [{
                "result_index": 0, "payload_sha256": packet["layers"]["verification"][0]["payload_sha256"],
                "fields": {field: "pass" for field in ("candidate_index", "verdict", "issues", "evidence")},
                "semantic": "pass", "e_indices": [0], "lineage": "pass", "basis": "合成阅读状态核对。",
            }]
            answer["window_checks"]["lineage"] = "pass"
            return answer

        result = self.run_ready(
            hashes=hashes, gold=gold, transport=httpx.MockTransport(response),
            audit=phase.audit(full=full_review, case_positions=(7,), verification_mode="nullable-proof-v1",
                              verification_tool_choice=verification_tool_choice),
            case_positions=(7,), verification_mode="nullable-proof-v1",
            verification_tool_choice=verification_tool_choice,
            request_timeout_seconds=300, max_retries=0,
        )
        self.assertEqual(result["summary"]["completed"], 1)
        self.assertEqual(result["audits"][0]["decision"], "safe")
        self.assertEqual(phase.order, ["raw", "full"])
        events = [event for event in result["events"] if event["kind"] == "semantic_audit"]
        self.assertEqual([event["payload"].get("phase") for event in events], ["raw", "final", None])
        protocol = events[1]["payload"]["verification_protocol"]
        self.assertEqual(protocol["model_results"], [raw_v])
        program = next(event for event in result["events"] if event["kind"] == "verification_program")
        self.assertEqual(protocol["program_results"], [program["payload"]])
        self.assertEqual(protocol["final_dimension_evidence"][0]["dimension_evidence"]["version"], 2)
        self.assertLess(program["event_sequence"], events[0]["event_sequence"])
        self.assertLess(events[0]["event_sequence"], events[1]["event_sequence"])
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 2)
        self.assertFalse(result["quality_certified"])

    def test_nullable_missing_and_null_proof_are_bounded_but_malformed_proof_stops(self):
        window = build_window(PLAN[7])
        source = str(window.target_message_ids[0])
        fact = {
            "text": "联系人刚读完《活着》。", "category": "common_fact",
            "subject": "contact", "topic": "study", "source_message_ids": [source],
            "confidence": 0.99, "risk_flags": [], "valid_at": None, "invalid_at": None,
            "speech_act": "assertion", "assertion_status": "asserted", "figurative_type": "literal",
            "alternatives": [], "interpretation_reason": "合成直接阅读状态。",
        }
        for tool_choice, mode in (("forced", "missing"), ("forced", "null"), ("forced", "malformed"),
                                  ("omitted", "missing"), ("omitted", "null"),
                                  ("omitted", "malformed"), ("omitted", "plain")):
            with self.subTest(proof=mode, tool_choice=tool_choice):
                self.output = self.home / ("proof-shape-" + tool_choice + "-" + mode)
                self.output.mkdir(mode=0o700)
                self.requests.clear()
                self.audits.clear()
                raw_v = {"candidate_index": 0, "verdict": "supported", "issues": [],
                         "evidence": [{"message_id": source, "quote": window.messages[1].text}]}
                if mode != "missing":
                    raw_v["proof"] = None if mode == "null" else {
                        "version": 1, "atom_links": None, "reference": None,
                        "reported": None, "valid": True,
                    }

                def response(request):
                    name = json.loads(request.content)["tools"][0]["function"]["name"]
                    if mode == "plain" and name == "SourceVerificationOutput":
                        self.requests.append(json.loads(request.content))
                        return httpx.Response(200, request=request, json={
                            "id": "synthetic-completion", "object": "chat.completion", "created": 1,
                            "model": "synthetic-reported-model", "choices": [{"index": 0,
                            "message": {"role": "assistant", "content": "合成普通文字未按工具返回。"},
                            "finish_reason": "stop"}],
                        })
                    return self.response(request, arguments={"facts": [fact]} if
                                         name == "MemoryExtractionOutput" else {"results": [raw_v]})

                result = self.run_ready(
                    transport=httpx.MockTransport(response), case_positions=(7, 4),
                    verification_mode="nullable-proof-v1", request_timeout_seconds=300, max_retries=0,
                    verification_tool_choice=tool_choice,
                    audit=lambda bundle: self.audit(bundle, "unknown", "audit_unresolved"),
                )
                self.assertEqual(len(self.requests), 2)
                self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 2)
                self.assertEqual(result["summary"]["unrun"], 1)
                v_output = [event for event in result["events"] if event["kind"] == "adapter_output"][1]
                if mode != "plain":
                    self.assertEqual(v_output["payload"]["tool_calls"][0]["args"]["results"], [raw_v])
                else:
                    self.assertEqual(v_output["payload"]["tool_calls"], [])
                program = [event for event in result["events"] if event["kind"] == "verification_program"]
                if mode in {"malformed", "plain"}:
                    self.assertEqual(result["outcomes"][0]["status"], "failed")
                    self.assertEqual(self.audits, [])
                    self.assertEqual(program, [])
                else:
                    self.assertEqual(program[0]["payload"]["results"][0]["proof_verification"]["status"], "UNKNOWN")
                    self.assertEqual(self.audits[0]["adapter_outputs"][1]["tool_calls"][0]
                                     ["args"]["results"], [raw_v])

    def test_invalid_request_limits_are_rejected_before_budget_or_credentials(
        self,
    ):
        invalid = (
            {"request_timeout_seconds": value} for value in (
                0, -1, 301, 10 ** 1000, True, "180", None,
                float("nan"), float("inf"), -float("inf"),
            )
        )
        retry_limits = ({"max_retries": value} for value in (
            -1, 3, True, 0.0, "0", None, float("nan"),
        ))
        with patch.object(
            EvaluationBudget, "create",
            side_effect=AssertionError("无效参数不得建预算。"),
        ):
            for position, parameters in enumerate((*invalid, *retry_limits)):
                with self.subTest(position=position):
                    with self.assertRaisesRegex(
                        EvaluationBudgetAbort, "ecnu_invalid_request_limits",
                    ):
                        self.run_ready(**parameters)
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])
        self.assertEqual(tuple(self.output.iterdir()), ())

    def test_unfrozen_gold_is_rejected_before_credentials_or_dispatch(self) -> None:
        from notalone.memory_extraction.evaluation_ecnu import run_ecnu_evaluation

        calls = []
        with self.assertRaises(EvaluationBudgetAbort):
            run_ecnu_evaluation(
                output_directory=self.output, run_id=uuid4(),
                deadline=datetime.now(timezone.utc) + timedelta(minutes=10),
                repo_root=self.home, source_hashes={},
                frozen_gold={"status": "pending"},
                credential_loader=lambda: calls.append("credential"),
                audit_case=lambda bundle: calls.append("audit"),
                synthetic_transport=httpx.MockTransport(
                    lambda request: calls.append("dispatch"),
                ),
            )
        self.assertEqual(calls, [])
        self.assertEqual(tuple(self.output.iterdir()), ())

    def test_invalid_fixed_case_set_or_full_subset_never_creates_budget(self):
        with patch.object(EvaluationBudget, "create",
                          side_effect=AssertionError("非法集合不能创建预算。")):
            for parameters in ({"case_set": True}, {"case_set": "other"},
                               {"case_set": "full140", "case_positions": (0,)},
                               {"case_set": "full140"}):
                with self.subTest(parameters=parameters):
                    with self.assertRaises(EvaluationBudgetAbort):
                        self.run_ready(**parameters)
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])
        self.assertEqual(tuple(self.output.iterdir()), ())

    def test_full140_mock_has_exact_original_order_cap_and_frozen_mapping(self):
        from notalone.memory_extraction.evaluation_records import canonical_sha256

        hashes, gold, reference = self.full_preparation()
        timeouts = []

        def response(request):
            timeouts.append(request.extensions["timeout"])
            return self.response(request)

        result = self.run_ready(
            hashes=hashes, gold=gold, case_set="full140",
            request_timeout_seconds=300, max_retries=0,
            transport=httpx.MockTransport(response),
        )
        cases = (*CASES, *SEMANTIC_CASES)
        self.assertEqual(len(self.requests), 140)
        self.assertEqual(len(self.audits), 140)
        self.assertEqual([outcome["case_name"] for outcome in result["outcomes"]],
                         [case.name for case in cases])
        self.assertEqual([canonical_sha256(bundle["window"]) for bundle in self.audits],
                         [canonical_sha256(build_window(case)) for case in cases])
        self.assertEqual(result["receipt"]["budget"]["request_limit"], 280)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 140)
        self.assertTrue(result["summary"]["plan_complete"])
        self.assertFalse(result["quality_certified"])

        self.assertEqual(timeouts,
                         [dict.fromkeys(("connect", "read", "write", "pool"), 300.0)] * 140)
        manifest = json.loads((self.output / "manifest.json").read_text())
        config = manifest["frozen_config"]
        self.assertEqual(config["mode"], "ecnu_bounded_full140")
        self.assertEqual(config["stage"], "full140")
        self.assertEqual(config["max_retries"], 0)
        self.assertEqual(config["public_cases_sha256"], canonical_sha256(cases))
        self.assertEqual(config["selected_case_positions"],
                         reference["provenance"]["local_to_reference_positions"])
        self.assertEqual([item["case_position"] for item in manifest["plan"]], list(range(140)))

    def test_fixed_21_plan_keeps_original_input_hashes_and_runtime_metadata(self):
        from notalone.memory_extraction.evaluation_records import canonical_sha256

        root = Path(__file__).resolve().parents[4]
        reference = json.loads((root /
            ".scratch/unfinished-work/memory-gold-reference-20261012.json").read_bytes())
        result = self.run_ready(request_timeout_seconds=300, max_retries=0)
        expected = tuple({"case_position": index, "case_name": item["case_name"],
                          "input_sha256": item["input_sha256"]}
                         for index, item in enumerate(reference["windows"]))
        self.assertEqual(result["receipt"]["plan_sha256"], canonical_sha256(expected))
        self.assertEqual(len(self.audits), 21)
        self.assertTrue(all(message["message_type"] == "unknown" and
                            message["text_representation"] == "unknown"
                            for audit in self.audits for message in audit["window"]["messages"]))
        self.assertFalse(result["quality_certified"])

    def test_nondefault_public_metadata_is_rejected_before_budget_or_credentials(self):
        from dataclasses import replace
        from notalone.memory_extraction import evaluation_ecnu

        original = build_window(PLAN[0])
        for field, value in (("message_type", "image"),
                             ("text_representation", "processed_text")):
            window = replace(original, messages=(replace(original.messages[0], **{field: value}),
                                                *original.messages[1:]))
            with self.subTest(field=field), patch.object(
                evaluation_ecnu, "build_window", return_value=window,
            ), patch.object(EvaluationBudget, "create", side_effect=AssertionError(
                "非默认元数据不能先创建预算。",
            )) as create, self.assertRaises(ValueError):
                self.run_ready()
            create.assert_not_called()
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])

    def test_full_phased_scopes_are_sealed_and_unresolved_stops_without_losing_140(self):
        from notalone.memory_extraction.evaluation_phased_audit import PhasedEvaluationAudit
        from notalone.memory_extraction.evaluation_records import canonical_sha256

        hashes, gold, reference = self.full_preparation()
        seen = []
        parent = reference["provenance"]["parent21"]["reference"]

        def raw_review(view):
            position = view["case_position"]
            seen.append(position)
            scope = parent if position == 0 else reference
            self.assertEqual(view["reference_sha256"], canonical_sha256(scope))
            self.assertEqual(view["common_rules"], scope["common_rules"])
            self.assertEqual(view["extraction"], [])
            self.assertNotIn("verification", view)
            self.assertEqual(view["case_id"], ("A01", "R001", "R002")[position])
            return {
                "reviewer": "合成分范围raw协议控制", "case_id": view["case_id"],
                "reference_sha256": view["reference_sha256"],
                "raw_evidence_sha256": view["raw_evidence_sha256"], "e_rows": [],
                "claims": [{"claim_id": claim["id"], "groups": []}
                           for claim in view["reference_case"]["claims"]],
                "window_checks": {"inclusion": ("fail", "pass", "unresolved")[position],
                                  "forbidden_meanings": "pass"},
            }

        def full_review(view):
            packet = view["packet"]
            position = len(seen) - 1
            scope = parent if position == 0 else reference
            self.assertEqual(packet["reference"], scope)
            self.assertEqual(packet["reference_sha256"], canonical_sha256(scope))
            self.assertEqual(view["raw_receipt"]["purpose"], "case")
            answer = deepcopy(view["sealed_raw_review"])
            answer.pop("raw_evidence_sha256")
            answer.update(run_status="empty", evidence_sha256=packet["evidence_sha256"],
                          v_rows=[])
            answer["window_checks"]["lineage"] = "pass"
            return answer

        audit = PhasedEvaluationAudit(
            reference=reference, expected_reference_sha256=canonical_sha256(reference),
            annotation_sha256=reference["annotation_sha256"],
            criteria_sha256=gold["criteria_sha256"], raw_reviewer=raw_review,
            full_reviewer=full_review, case_set="full140",
        )
        result = self.run_ready(hashes=hashes, gold=gold, audit=audit, case_set="full140",
                                request_timeout_seconds=300, max_retries=0)
        self.assertEqual(seen, [0, 1, 2])
        self.assertEqual(len(self.requests), 3)
        self.assertEqual([item["decision"] for item in result["audits"]],
                         ["general_error", "safe", "unknown"])
        self.assertEqual(result["summary"]["planned"], 140)
        self.assertEqual(result["summary"]["unrun"], 137)
        self.assertEqual(result["receipt"]["budget"]["request_limit"], 280)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 3)
        self.assertFalse(result["receipt"]["plan_complete"])
        self.assertEqual(result["receipt"]["capture_gaps"], [])
        phases = [event["payload"].get("phase") for event in result["events"]
                  if event["kind"] == "semantic_audit"]
        self.assertEqual(phases, ["raw", "final", None] * 3)

    def test_incomplete_full_reference_is_rejected_before_budget_credentials_and_sends(self):
        def impossible_interval(reference, end):
            claim = next(window["claims"][0] for window in reference["windows"][21:]
                         if window["claims"])
            claim["variants"][0].update(valid_at="2026-09-15T08:00:00+08:00", invalid_at=end)

        changes = (
            lambda reference: reference["provenance"].update(reference_complete=False),
            lambda reference: reference["provenance"].update(unresolved_cases=["R057"]),
            lambda reference: reference["windows"].pop(),
            lambda reference: reference["windows"][21].update(input_sha256="f" * 64),
            lambda reference: reference["provenance"].update(
                local_to_reference_positions=list(range(140)),
            ),
            lambda reference: reference["provenance"]["parent21"]["reference"][
                "windows"
            ][0].update(inclusion="none"),
            lambda reference: impossible_interval(reference, "2026-09-15T00:00:00+00:00"),
            lambda reference: impossible_interval(reference, "2026-09-14T23:59:59+00:00"),
            lambda reference: reference["windows"][0]["claims"][0]["variants"][0][
                "source_choices"
            ][0]["indices"].__setitem__(0, False),
            lambda reference: reference["windows"][0]["claims"][0]["variants"][0][
                "source_choices"
            ][0]["indices"].__setitem__(0, 0.0),
        )
        with patch.object(EvaluationBudget, "create",
                          side_effect=AssertionError("未完整参考不能创建预算。")):
            for position, change in enumerate(changes):
                hashes, gold, _ = self.full_preparation(change=change)
                with self.subTest(position=position):
                    with self.assertRaisesRegex(EvaluationBudgetAbort, "ecnu_full_reference_invalid"):
                        self.run_ready(
                            hashes=hashes, gold=gold, case_set="full140",
                            request_timeout_seconds=300, max_retries=0,
                        )
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])
        self.assertEqual(tuple(self.output.iterdir()), ())

    def test_full_requires_all_sources_frozen_and_exact_limits_before_budget(self):
        from notalone.memory_extraction.evaluation_reference import FULL_ANNOTATION_PATH

        with patch.object(EvaluationBudget, "create",
                          side_effect=AssertionError("错误full冻结不能创建预算。")):
            for fault in ("annotation", "changed_source", "timeout", "retry"):
                hashes, gold, _ = self.full_preparation()
                parameters = {"request_timeout_seconds": 300, "max_retries": 0}
                if fault == "annotation":
                    del hashes[FULL_ANNOTATION_PATH]
                elif fault == "changed_source":
                    (self.repo / "backend/src/notalone/memory_extraction/flow.py").write_text(
                        "合成冻结后变化。", encoding="utf-8",
                    )
                elif fault == "timeout":
                    parameters["request_timeout_seconds"] = 180
                else:
                    parameters["max_retries"] = 1
                with self.subTest(fault=fault), self.assertRaises(EvaluationBudgetAbort):
                    self.run_ready(hashes=hashes, gold=gold, case_set="full140", **parameters)
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])
        self.assertEqual(tuple(self.output.iterdir()), ())

    def test_fixed_plan_runs_empty_extraction_with_durable_independent_audits(self):
        result = self.run_ready()
        self.assertEqual(self.credentials, ["loaded"])
        self.assertEqual(len(self.requests), 21)
        self.assertEqual(len(self.audits), 21)
        self.assertEqual([item["case_name"] for item in result["outcomes"]],
                         [case.name for case in PLAN])
        self.assertTrue(result["summary"]["plan_complete"])
        self.assertEqual(result["summary"]["empty"], 21)
        self.assertEqual(result["summary"]["semantic_audit"]["general_error"], 21)
        self.assertFalse(result["quality_certified"])
        self.assertEqual(result["receipt"]["budget"]["request_limit"], 42)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 21)
        config = json.loads((self.output / "manifest.json").read_text())["frozen_config"]
        self.assertEqual(config["timeout"], 60.0)
        self.assertEqual(config["max_retries"], 2)
        self.assertNotIn("selected_case_positions", config)
        audits = [event for event in result["events"] if event["kind"] == "semantic_audit"]
        self.assertEqual(len(audits), 21)
        for bundle in self.audits:
            self.assertEqual(len(bundle["adapter_outputs"]), 1)
            self.assertEqual(bundle["adapter_outputs"][0]["tool_calls"][0]["args"],
                             {"facts": []})
            self.assertIn("original_result", bundle)
        for request in self.requests:
            self.assertEqual(set(request), {
                "model", "temperature", "stream", "thinking", "messages", "tools",
                "tool_choice",
            })
            self.assertEqual(request["model"], "ecnu-max")
            self.assertEqual(request["thinking"], {"type": "enabled"})

    def test_four_selected_cases_have_exact_eight_attempt_cap_and_original_inputs(self):
        positions = (0, 1, 3, 4)
        timeouts = []

        def selected_response(request):
            timeouts.append(request.extensions["timeout"])
            payload = json.loads(request.content)
            position = len(self.audits)
            window = build_window(PLAN[positions[position]])
            source = str(window.target_message_ids[0])
            if payload["tool_choice"]["function"]["name"] == "MemoryExtractionOutput":
                fact = {
                    "text": "联系人陈述一条公开合成关系主张。", "subject": "contact",
                    "category": "relationship_note", "topic": "other",
                    "source_message_ids": [source], "confidence": 0.9, "risk_flags": [],
                    "valid_at": None, "invalid_at": None, "speech_act": "report",
                    "assertion_status": "reported", "figurative_type": "literal",
                    "alternatives": [], "interpretation_reason": "只核SDK接线，不签语义。",
                }
                return self.response(request, arguments={"facts": [fact]})
            target = next(message for message in window.messages
                          if str(message.message_id) == source)
            return self.response(request, arguments={"results": [{
                "candidate_index": 0, "verdict": "supported", "issues": [],
                "evidence": [{"message_id": source, "quote": target.text}],
            }]})

        result = self.run_ready(
            case_positions=positions, request_timeout_seconds=300, max_retries=0,
            transport=httpx.MockTransport(selected_response),
        )
        self.assertEqual(len(self.requests), 8)
        self.assertEqual(result["receipt"]["budget"]["request_limit"], 8)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 8)
        self.assertEqual(result["summary"]["planned"], 4)
        self.assertEqual([item["case_name"] for item in result["outcomes"]],
                         [PLAN[position].name for position in positions])
        self.assertEqual([item["case_position"] for item in result["outcomes"]], list(range(4)))
        from notalone.memory_extraction.evaluation_records import canonical_sha256

        self.assertEqual([canonical_sha256(item["window"]) for item in self.audits],
                         [canonical_sha256(build_window(PLAN[position]))
                          for position in positions])
        self.assertEqual(timeouts,
                         [dict.fromkeys(("connect", "read", "write", "pool"), 300.0)] * 8)
        manifest = json.loads((self.output / "manifest.json").read_text())
        config = manifest["frozen_config"]
        self.assertEqual(config["selected_case_positions"], list(positions))
        self.assertEqual(len(manifest["plan"]), 4)
        self.assertEqual(config["public_cases_sha256"], canonical_sha256(PLAN))
        self.assertFalse(result["quality_certified"])

    def test_invalid_selected_positions_fail_before_budget_or_credentials(self):
        with patch.object(EvaluationBudget, "create",
                          side_effect=AssertionError("错误选择不能创建预算。")):
            for positions in ((), [0], (True,), (0, 0), (-1,), (21,), ("0",),
                              (0, 1, 2, 3, 4)):
                with self.subTest(positions=positions):
                    with self.assertRaisesRegex(EvaluationBudgetAbort,
                                                "ecnu_invalid_case_positions"):
                        self.run_ready(case_positions=positions)
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])
        self.assertEqual(tuple(self.output.iterdir()), ())

    def test_live_selection_and_phased_mapping_mismatch_before_budget(self):
        from notalone.memory_extraction.evaluation_ecnu import run_ecnu_evaluation
        from notalone.memory_extraction.evaluation_phased_audit import PhasedEvaluationAudit
        from notalone.memory_extraction.evaluation_records import canonical_sha256

        root = Path(__file__).resolve().parents[4]
        criterion = ".scratch/unfinished-work/memory-gold-reference-20261012.json"
        reference_path = root / criterion
        reference = json.loads(reference_path.read_text())
        hashes, gold = self.preparation()
        hashes[criterion] = hashlib.sha256(reference_path.read_bytes()).hexdigest()
        gold.update(criteria_path=criterion, criteria_sha256=hashes[criterion])
        with patch.object(EvaluationBudget, "create",
                          side_effect=AssertionError("错审核位置不能创建预算。")):
            for selected, reviewed in ((None, (0, 1, 3, 4)),
                                       ((0, 1, 3, 4), None),
                                       ((0, 1, 3, 4), (0, 1, 4, 3))):
                with self.subTest(selected=selected, reviewed=reviewed):
                    audit = PhasedEvaluationAudit(
                        reference=reference,
                        expected_reference_sha256=canonical_sha256(reference),
                        annotation_sha256=reference["annotation_sha256"],
                        criteria_sha256=hashes[criterion], case_positions=reviewed,
                        raw_reviewer=lambda view: self.fail("错绑不能揭raw。"),
                        full_reviewer=lambda view: self.fail("错绑不能揭full。"),
                    )
                    with self.assertRaisesRegex(
                        EvaluationBudgetAbort, "ecnu_phased_case_positions_mismatch",
                    ):
                        run_ecnu_evaluation(
                            output_directory=self.output, run_id=uuid4(),
                            deadline=datetime.now(timezone.utc) + timedelta(minutes=10),
                            repo_root=self.repo, source_hashes=hashes, frozen_gold=gold,
                            credential_loader=self.credential, audit_case=audit,
                            case_positions=selected,
                        )
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])
        self.assertEqual(tuple(self.output.iterdir()), ())

    def test_opaque_http500_stops_once_with_incomplete_terminal_receipt(self):
        def opaque_error(request):
            self.requests.append(json.loads(request.content))
            return httpx.Response(500, content=b"synthetic-opaque-500!", request=request)

        result = self.run_ready(transport=httpx.MockTransport(opaque_error))
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.audits, [])
        self.assertEqual(result["stopped_code"], "ecnu_hard_stop")
        self.assertEqual(result["summary"]["unknown"], 1)
        self.assertEqual(result["summary"]["unrun"], 20)
        self.assertIsNotNone(result["receipt"])
        self.assertIsNone(result["receipt_error_code"])
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 1)
        self.assertFalse(result["receipt"]["plan_complete"])
        self.assertFalse(result["receipt"]["quality_certified"])
        self.assertEqual(len(result["receipt"]["capture_gaps"]), 1)
        gap = result["receipt"]["capture_gaps"][0]
        self.assertEqual(gap["kind"], "provider_response")
        self.assertEqual(gap["status_code"], 500)
        self.assertEqual(gap["original_bytes_length"], 21)
        self.assertNotIn("synthetic-opaque-500!", json.dumps(result))
        self.assertEqual(result["cleanup_error_codes"], ())
        self.assertIsNone(result["records_error_code"])

    def test_audit_cannot_reassign_current_position_by_mutating_its_bundle(self):
        def reassigned(bundle):
            bundle["case_position"] = 99
            return self.audit(bundle, decision="safe", reason="supported")

        result = self.run_ready(audit=reassigned)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(result["outcomes"][0]["status"], "unknown")
        self.assertEqual(result["summary"]["unrun"], 20)
        self.assertEqual(result["stopped_code"], "ecnu_hard_stop")
        self.assertEqual([event for event in result["events"]
                          if event["kind"] == "semantic_audit"], [])

    def test_bad_output_permissions_rejects_before_credential_loader(self):
        self.output.chmod(0o755)
        with self.assertRaises(EvaluationBudgetAbort):
            self.run_ready()
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])

    def test_credential_failure_durably_closes_original_run_without_sends(self):
        run_id = uuid4()

        def unavailable():
            self.credentials.append("loaded")
            raise RuntimeError("合成凭据入口失败，不保存错误文字。")

        result = self.run_ready(credential=unavailable, run_id=run_id)
        self.assertEqual(self.credentials, ["loaded"])
        self.assertEqual(self.requests, [])
        self.assertTrue((self.output / "manifest.json").exists())
        self.assertEqual(result["stopped_code"], "ecnu_credential_unavailable")
        self.assertEqual(result["summary"]["unrun"], 21)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 0)
        with self.assertRaises(EvaluationBudgetAbort):
            EvaluationBudget.open(run_id=run_id)

    def test_credential_failure_cannot_reopen_run_even_when_close_storage_fails(self):
        run_id = uuid4()

        def unavailable():
            raise RuntimeError("合成凭据入口失败。")

        with patch.object(EvaluationBudget, "close", side_effect=EvaluationBudgetAbort(
            "synthetic_close_storage_failed",
        )):
            result = self.run_ready(credential=unavailable, run_id=run_id)
        self.assertEqual(self.requests, [])
        self.assertEqual(result["stopped_code"], "ecnu_credential_unavailable")
        self.assertIsNone(result["receipt"])
        with self.assertRaises(EvaluationBudgetAbort):
            EvaluationBudget.open(run_id=run_id)

    def test_underfrozen_sources_or_changed_gold_plan_never_load_credentials(self):
        for mutation in ("missing_source", "reordered_cases", "criterion_digest", "changed_file"):
            with self.subTest(mutation=mutation):
                hashes, gold = self.preparation()
                if mutation == "missing_source":
                    del hashes["backend/src/notalone/memory_extraction/verification_adapters.py"]
                elif mutation == "reordered_cases":
                    gold["case_names"].reverse()
                elif mutation == "criterion_digest":
                    gold["criteria_sha256"] = "f" * 64
                else:
                    (self.repo / "backend/src/notalone/memory_extraction/flow.py").write_text(
                        "合成冻结后文件变化。", encoding="utf-8",
                    )
                with self.assertRaises(EvaluationBudgetAbort):
                    self.run_ready(hashes=hashes, gold=gold)
                self.assertEqual(self.credentials, [])
                self.assertEqual(self.requests, [])

    def test_freeze_includes_dependencies_imported_by_memory_package_initializer(self):
        hashes, gold = self.preparation()
        del hashes["backend/src/notalone/memory/adapters.py"]
        with self.assertRaises(EvaluationBudgetAbort):
            self.run_ready(hashes=hashes, gold=gold)
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])

    def test_semantic_safety_or_unknown_stops_before_next_case_and_preserves_denominator(self):
        for decision, reason in (("safety_error", "false_fact"), ("unknown", "audit_unresolved")):
            with self.subTest(decision=decision):
                self.output = self.home / decision
                self.output.mkdir(mode=0o700)
                self.requests.clear()
                result = self.run_ready(audit=lambda bundle: self.audit(
                    bundle, decision=decision, reason=reason,
                ))
                self.assertEqual(len(self.requests), 1)
                self.assertEqual(result["stopped_code"], "case_semantic_audit_" + decision)
                self.assertEqual(result["summary"]["planned"], 21)
                self.assertEqual(result["summary"]["unrun"], 20)
                self.assertFalse(result["receipt"]["plan_complete"])
                audit = next(event for event in result["events"]
                             if event["kind"] == "semantic_audit")
                self.assertEqual(audit["payload"]["decision"], decision)

    def test_response_identity_drift_is_stored_before_stopping_original_plan(self):
        def changed_model(request):
            model = "first-model" if not self.requests else "changed-model"
            return self.response(request, reported_model=model)

        result = self.run_ready(transport=httpx.MockTransport(changed_model))
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(result["summary"]["empty"], 1)
        self.assertEqual(result["summary"]["unknown"], 1)
        self.assertEqual(result["summary"]["unrun"], 19)
        responses = [event for event in result["events"] if event["kind"] == "provider_response"]
        self.assertEqual([event["payload"]["body"]["model"] for event in responses],
                         ["first-model", "changed-model"])
        self.assertEqual(len(self.audits), 1)

    def test_legacy_matcher_difference_is_retained_and_independent_safe_audit_can_continue(self):
        case = PLAN[5]
        window = build_window(case)
        sources = [str(message.message_id) for message in window.messages]
        shared = {
            "subject": "contact", "topic": "travel", "confidence": 0.99,
            "risk_flags": [], "speech_act": "assertion", "assertion_status": "asserted",
            "figurative_type": "literal", "alternatives": [],
            "interpretation_reason": "合成来源直接表达完成和等待状态。",
        }
        facts = [{**shared, "text": "联系人已经到机场。", "category": "common_fact",
                  "source_message_ids": sources, "valid_at": None, "invalid_at": None},
                 {**shared, "text": "2026-09-15来源时点联系人正在等行李。",
                  "category": "recent_state", "source_message_ids": [sources[1]],
                  "valid_at": "2026-09-15T00:01:00+00:00",
                  "invalid_at": "2026-09-16T00:00:00+00:00"}]

        def synthetic(request):
            body = json.loads(request.content)
            name = body["tool_choice"]["function"]["name"]
            if len(self.audits) != 5:
                return self.response(request)
            if name == "MemoryExtractionOutput":
                return self.response(request, arguments={"facts": facts})
            return self.response(request, arguments={"results": [{
                "candidate_index": index, "verdict": "supported", "issues": [],
                "evidence": [{"message_id": sources[1], "quote": window.messages[1].text}],
            } for index in range(2)]})

        def audit(bundle):
            if bundle["case_position"] == 5:
                return self.audit(bundle, decision="safe", reason="supported")
            return self.audit(bundle)

        result = self.run_ready(transport=httpx.MockTransport(synthetic), audit=audit)
        self.assertEqual(len(self.requests), 22)
        self.assertTrue(result["summary"]["plan_complete"])
        self.assertGreater(result["outcomes"][5]["result"]["false_fact_count"], 0)
        self.assertEqual(result["audits"][5]["decision"], "safe")
        self.assertEqual([request["tool_choice"]["function"]["name"]
                          for request in self.requests[5:7]],
                         ["MemoryExtractionOutput", "SourceVerificationOutput"])
        self.assertEqual(len(self.audits[5]["adapter_outputs"]), 2)
        self.assertFalse(result["quality_certified"])

    def test_sdk_retries_share_42_attempt_cap_and_cannot_fill_final_verification(self):
        attempts = {}

        def retry(request):
            body = json.loads(request.content)
            position = len(self.audits)
            attempts[position] = attempts.get(position, 0) + 1
            if attempts[position] == 1:
                self.requests.append(body)
                return httpx.Response(429, request=request,
                                      headers={"retry-after-ms": "1"},
                                      json={"error": {"message": "合成429错误"}})
            if position != 20:
                return self.response(request)
            window = build_window(PLAN[20])
            fact = {
                "text": "2026-09-15来源时点联系人不知道表弟当前做什么工作。",
                "category": "recent_state", "subject": "contact", "topic": "work",
                "source_message_ids": [str(window.target_message_ids[-1])],
                "confidence": 0.99, "risk_flags": [],
                "valid_at": "2026-09-15T00:02:00+00:00", "invalid_at": None,
                "speech_act": "assertion", "assertion_status": "asserted",
                "figurative_type": "literal", "alternatives": [],
                "interpretation_reason": "合成直接知识状态。",
            }
            return self.response(request, arguments={"facts": [fact]})

        result = self.run_ready(transport=httpx.MockTransport(retry))
        self.assertEqual(len(self.requests), 42)
        for position in range(21):
            self.assertEqual(self.requests[2 * position], self.requests[2 * position + 1])
        self.assertEqual(result["summary"]["completed"], 20)
        self.assertEqual(result["summary"]["unknown"], 1)
        self.assertEqual(result["summary"]["unrun"], 0)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 42)
        self.assertFalse(result["receipt"]["plan_complete"])
        self.assertEqual(len(self.audits), 20)

    def test_duplicate_run_is_rejected_without_a_second_credential_read(self):
        run_id = uuid4()
        self.run_ready(run_id=run_id, audit=lambda bundle: self.audit(
            bundle, decision="unknown", reason="audit_unresolved",
        ))
        with self.assertRaises(EvaluationBudgetAbort):
            self.run_ready(run_id=run_id)
        self.assertEqual(self.credentials, ["loaded"])
        self.assertEqual(len(self.requests), 1)

    def test_invalid_or_throwing_audit_is_not_silently_safe_or_saved_as_error_text(self):
        for mode in ("incomplete", "wrong_criterion", "throws"):
            with self.subTest(mode=mode):
                self.output = self.home / mode
                self.output.mkdir(mode=0o700)
                self.requests.clear()

                def invalid(bundle):
                    if mode == "incomplete":
                        return {"decision": "safe"}
                    if mode == "throws":
                        raise RuntimeError("synthetic-secret-never-record")
                    answer = self.audit(bundle)
                    answer["criteria_sha256"] = "f" * 64
                    return answer

                result = self.run_ready(audit=invalid)
                self.assertEqual(len(self.requests), 1)
                self.assertEqual(result["summary"]["unknown"], 1)
                self.assertEqual(result["summary"]["unrun"], 20)
                self.assertEqual(result["audits"], ())
                self.assertNotIn("synthetic-secret-never-record", json.dumps(result))

    def test_in_memory_prompt_or_schema_drift_cannot_redefine_frozen_request(self):
        from notalone.memory_extraction import adapters

        for mutation in ("schema", "prompt"):
            with self.subTest(mutation=mutation):
                self.output = self.home / mutation
                self.output.mkdir(mode=0o700)
                self.requests.clear()
                self.audits.clear()
                original_schema = deepcopy(adapters.EXTRACTION_SCHEMA)
                original_prompt = adapters.EXTRACTION_SYSTEM_PROMPT

                def changed(bundle):
                    if mutation == "schema":
                        adapters.EXTRACTION_SCHEMA["description"] = "合成内存契约漂移。"
                    else:
                        adapters.EXTRACTION_SYSTEM_PROMPT += "合成内存提示漂移。"
                    return self.audit(bundle)

                try:
                    result = self.run_ready(audit=changed)
                finally:
                    adapters.EXTRACTION_SCHEMA.clear()
                    adapters.EXTRACTION_SCHEMA.update(original_schema)
                    adapters.EXTRACTION_SYSTEM_PROMPT = original_prompt
                self.assertEqual(len(self.requests), 1)
                self.assertEqual(result["outcomes"][0]["status"], "empty")
                self.assertEqual(result["summary"]["unknown"], 1)
                self.assertEqual(len(result["audits"]), 1)

    def test_phased_audit_uses_actual_store_receipts_before_the_final_decision(self):
        from notalone.memory_extraction.evaluation_phased_audit import PhasedEvaluationAudit

        actual_repo = Path(__file__).resolve().parents[4]
        criterion = ".scratch/unfinished-work/memory-gold-reference-20261012.json"
        content = (actual_repo / criterion).read_bytes()
        reference = json.loads(content)
        criteria_sha = hashlib.sha256(content).hexdigest()
        hashes, gold = self.preparation()
        copied = self.repo / criterion
        copied.parent.mkdir(parents=True, exist_ok=True)
        copied.write_bytes(content)
        hashes[criterion] = criteria_sha
        gold.update(criteria_path=criterion, criteria_sha256=criteria_sha)

        def raw_review(view):
            self.assertEqual(view["extraction"], [])
            self.assertNotIn("packet", view)
            self.assertNotIn("original_result", view)
            return {
                "reviewer": "synthetic-raw-reviewer", "case_id": view["case_id"],
                "reference_sha256": view["reference_sha256"],
                "raw_evidence_sha256": view["raw_evidence_sha256"], "e_rows": [],
                "claims": [{"claim_id": claim["id"], "groups": []}
                           for claim in view["reference_case"]["claims"]],
                "window_checks": {"inclusion": "unresolved", "forbidden_meanings": "pass"},
            }

        def full_review(view):
            packet = view["packet"]
            sealed = view["sealed_raw_review"]
            return {
                "reviewer": "synthetic-full-reviewer", "case_id": packet["case_id"],
                "reference_sha256": packet["reference_sha256"],
                "evidence_sha256": packet["evidence_sha256"],
                "run_status": packet["evidence"]["run_status"], "e_rows": [], "v_rows": [],
                "claims": sealed["claims"],
                "window_checks": {**sealed["window_checks"], "lineage": "pass"},
            }

        audit = PhasedEvaluationAudit(
            reference=reference,
            expected_reference_sha256="5fb8d53b90a1a96c5987ac7b825bb233cc3e9f196f976e4851c40b0243b77b32",
            annotation_sha256=reference["annotation_sha256"], criteria_sha256=criteria_sha,
            raw_reviewer=raw_review, full_reviewer=full_review,
        )
        result = self.run_ready(hashes=hashes, gold=gold, audit=audit)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(result["audits"][0]["decision"], "unknown")
        events = [event for event in result["events"] if event["kind"] == "semantic_audit"]
        self.assertEqual(len(events), 3)
        self.assertEqual([event["payload"].get("phase") for event in events],
                         ["raw", "final", None])
        self.assertLess(events[0]["event_sequence"], events[1]["event_sequence"])
        self.assertLess(events[1]["event_sequence"], events[2]["event_sequence"])

    def test_audit_persist_is_attributed_and_expires_after_the_current_callback(self):
        receipts = []
        capability = []

        def persist_and_stop(bundle):
            capability.append(bundle["persist_audit"])
            receipts.append(capability[0]({"phase": "raw", "review": {
                "synthetic_status": "unresolved",
            }}))
            return self.audit(bundle, "unknown", "audit_unresolved")

        result = self.run_ready(audit=persist_and_stop)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(len(receipts), 1)
        receipt = receipts[0]
        self.assertEqual(receipt["case_position"], 0)
        self.assertEqual(receipt["purpose"], "case")
        self.assertEqual(receipt["kind"], "semantic_audit")
        self.assertEqual(receipt["payload"]["phase"], "raw")
        with self.assertRaises(EvaluationBudgetAbort):
            capability[0]({"phase": "final", "review": {}, "report": {},
                           "raw_receipt": {}})
        self.assertEqual(result["summary"]["semantic_audit"]["audited"], 1)

    def test_audit_persist_refuses_overridden_position_and_state(self):
        capabilities = []

        def refuse_override(bundle):
            capability = bundle["persist_audit"]
            capabilities.append(capability)
            with self.assertRaises(TypeError):
                capability({"phase": "raw", "review": {}}, case_position=1,
                           state={"active": True, "phase": None})
            return self.audit(bundle, "unknown", "audit_unresolved")

        result = self.run_ready(audit=refuse_override)
        self.assertEqual(result["summary"]["semantic_audit"]["audited"], 1)
        with self.assertRaises(TypeError):
            capabilities[0]({"phase": "raw", "review": {}}, case_position=1,
                            state={"active": True, "phase": None})
        with self.assertRaises(EvaluationBudgetAbort):
            capabilities[0]({"phase": "raw", "review": {}})
        audit_events = [event for event in result["events"]
                        if event["kind"] == "semantic_audit"]
        self.assertEqual(len(audit_events), 1)
        self.assertEqual(audit_events[0]["case_position"], 0)

    def test_real_mode_rejects_unsealed_legacy_audit_before_credential_loading(self):
        from notalone.memory_extraction.evaluation_ecnu import run_ecnu_evaluation

        actual_repo = Path(__file__).resolve().parents[4]
        hashes, gold = self.preparation()
        hashes = {relative: hashlib.sha256((actual_repo / relative).read_bytes()).hexdigest()
                  for relative in hashes}
        gold["criteria_sha256"] = hashes[
            ".scratch/unfinished-work/memory-gold-agent-annotations-20261012.md"]

        def forbidden_credential():
            self.credentials.append("unexpected")
            raise RuntimeError("合成真实模式门测试，不允许读取凭据。")

        with self.assertRaises(EvaluationBudgetAbort):
            run_ecnu_evaluation(
                output_directory=self.output, run_id=uuid4(),
                deadline=datetime.now(timezone.utc) + timedelta(minutes=10),
                repo_root=actual_repo, source_hashes=hashes, frozen_gold=gold,
                credential_loader=forbidden_credential, audit_case=self.audit,
            )
        self.assertEqual(self.credentials, [])
        self.assertEqual(self.requests, [])

    def test_audit_receives_saved_requests_for_actual_verification_input(self):
        window = build_window(PLAN[0])
        source = str(window.target_message_ids[0])
        fact = {
            "text": "未知第三人不是仓库管理员，在采购部。",
            "category": "relationship_note", "subject": "contact", "topic": "work",
            "source_message_ids": [source], "confidence": 0.9,
            "risk_flags": [], "valid_at": None, "invalid_at": None,
            "speech_act": "report", "assertion_status": "reported",
            "figurative_type": "literal", "alternatives": ["第三人身份未知。"],
            "interpretation_reason": "合成第三人原话。",
        }

        def response(request):
            name = json.loads(request.content)["tool_choice"]["function"]["name"]
            arguments = {"facts": [fact]} if name == "MemoryExtractionOutput" else {
                "results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
                             "evidence": [{"message_id": source,
                                           "quote": window.messages[0].text}]}],
            }
            return self.response(request, arguments=arguments)

        result = self.run_ready(
            transport=httpx.MockTransport(response),
            audit=lambda bundle: self.audit(bundle, "unknown", "audit_unresolved"),
        )
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(len(self.audits), 1)
        requests = self.audits[0]["provider_requests"]
        saved = tuple(event["payload"] for event in result["events"]
                      if event["kind"] == "provider_request")
        self.assertEqual(requests, saved)
        self.assertEqual(len(requests), 2)
        self.assertNotIn("authorization", json.dumps(requests).lower())
        self.assertNotIn("synthetic-not-a-real-key", json.dumps(requests))
        self.assertIn("candidate_index", json.dumps(requests))

    def test_confidence_boolean_or_string_is_saved_then_rejected_before_verification(self):
        window = build_window(PLAN[0])
        source = str(window.target_message_ids[0])
        for confidence in (True, "0.99"):
            with self.subTest(confidence=confidence):
                self.output = self.home / f"confidence-{type(confidence).__name__}"
                self.output.mkdir(mode=0o700)
                self.requests.clear()
                self.audits.clear()
                fact = {
                    "text": "未知第三人不是仓库管理员，在采购部。",
                    "category": "relationship_note", "subject": "contact", "topic": "work",
                    "source_message_ids": [source], "confidence": confidence,
                    "risk_flags": [], "valid_at": None, "invalid_at": None,
                    "speech_act": "report", "assertion_status": "reported",
                    "figurative_type": "literal", "alternatives": [],
                    "interpretation_reason": "合成第三人原话。",
                }

                def invalid_number(request):
                    name = json.loads(request.content)["tool_choice"]["function"]["name"]
                    arguments = {"facts": [fact]} if name == "MemoryExtractionOutput" else {
                        "results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
                                     "evidence": [{"message_id": source,
                                                   "quote": window.messages[0].text}]}],
                    }
                    return self.response(request, arguments=arguments)

                result = self.run_ready(transport=httpx.MockTransport(invalid_number))
                self.assertEqual(len(self.requests), 1)
                self.assertEqual(result["outcomes"][0]["status"], "failed")
                self.assertEqual(result["summary"]["unrun"], 20)
                self.assertEqual(result["audits"], ())
                adapter = next(event for event in result["events"]
                               if event["kind"] == "adapter_output")
                self.assertEqual(adapter["payload"]["tool_calls"][0]["args"]["facts"][0]
                                 ["confidence"], confidence)


if __name__ == "__main__":
    unittest.main()
