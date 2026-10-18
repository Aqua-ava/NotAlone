"""教学计划实际SDK请求、原Gold与unknown闭账边界。"""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4
from contextlib import nullcontext
from unittest.mock import patch

import httpx

from notalone.memory_extraction.evaluation_ecnu import run_ecnu_evaluation
from notalone.memory_extraction.evaluation_http_budget import EvaluationBudgetAbort


class Reference16TeachingSDKTest(unittest.TestCase):
    def test_actual_sdk_uses_pro_disabled_thinking_and_forced_tools_in_both_phases(self):
        self._exercise_sdk()

    def test_unknown_at_last_window_is_not_a_complete_receipt(self):
        result = self._exercise_sdk(unknown_at_last=True)
        self.assertEqual(result["stopped_code"], "case_semantic_audit_unknown")
        self.assertEqual(result["outcomes"][-1]["status"], "unknown")
        self.assertEqual(result["summary"]["unknown"], 1)
        self.assertEqual(result["summary"]["unrun"], 0)
        self.assertFalse(result["summary"]["plan_complete"])
        self.assertFalse(result["receipt"]["plan_complete"])
        self.assertTrue(result["receipt"]["budget"]["closed"])
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 16)

    def _exercise_sdk(self, *, unknown_at_last=False, execution_plan="reference16-pro-teaching-v1",
                      verification_profile="default", source_drift=False, verification_fault=None):
        import hashlib
        import json
        from tests.integration.memory_extraction.test_evaluation_ecnu import EvaluationECNUTest
        from notalone.memory_extraction.evaluation_ecnu import _REFERENCE16_PRO_TEACHING_REQUIRED_SOURCES, _PLAN_CASES
        v_thinking = execution_plan == "reference16-pro-retention-v-thinking-v1"
        sources = _REFERENCE16_PRO_TEACHING_REQUIRED_SOURCES
        if v_thinking:
            from notalone.memory_extraction.evaluation_ecnu import _REFERENCE16_PRO_RETENTION_V_THINKING_REQUIRED_SOURCES
            sources = _REFERENCE16_PRO_RETENTION_V_THINKING_REQUIRED_SOURCES
        if execution_plan == "reference16-pro-retention-v1":
            from notalone.memory_extraction.evaluation_ecnu import _REFERENCE16_PRO_RETENTION_REQUIRED_SOURCES
            sources = _REFERENCE16_PRO_RETENTION_REQUIRED_SOURCES
        from notalone.memory_extraction.evaluation_phased_audit import PhasedEvaluationAudit
        from notalone.memory_extraction.evaluation_records import canonical_sha256
        from notalone.memory_extraction.evaluation_reference import PUBLIC_REFERENCE_V2_PATH, PUBLIC_ANNOTATION_V2_PATH
        helper = EvaluationECNUTest()
        helper.setUp()
        self.addCleanup(helper.doCleanups)
        actual = Path(__file__).resolve().parents[4]
        hashes = {}
        for relative in sources:
            content = (actual / relative).read_bytes()
            destination = helper.repo / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
            hashes[relative] = hashlib.sha256(content).hexdigest()
        reference = json.loads((actual / PUBLIC_REFERENCE_V2_PATH).read_bytes())
        seen = []
        def raw(view):
            seen.append(view)
            raise EvaluationBudgetAbort("synthetic_raw_review_stop")
        audit = PhasedEvaluationAudit(reference=reference, expected_reference_sha256=canonical_sha256(reference),
            annotation_sha256=hashes[PUBLIC_ANNOTATION_V2_PATH], criteria_sha256=hashes[PUBLIC_REFERENCE_V2_PATH],
            raw_reviewer=raw, full_reviewer=lambda _: self.fail("RAW未封存不得进入FULL"),
            extraction_mode="grounded-v2", verification_mode="legacy-v4", verification_tool_choice="omitted" if v_thinking else "forced", case_set="reference21",
            case_positions=tuple(range(16)), reference_version="source-fidelity-v2", execution_plan=execution_plan, extraction_prompt_profile="reference-kind-teaching-v1", verification_prompt_profile=verification_profile)
        def respond(request):
            body = json.loads(request.content)
            function = body["tools"][0]["function"]
            if function["name"] == "GroundedMemoryLabels":
                label = {"kind": "state", "subject": "self", "topic": "work", "dependency": None,
                         "unresolved": True, "confidence": 0.9, "sensitivity": "none"}
                if unknown_at_last:
                    label.update(kind="not_memory", unresolved=False)
                arguments = {"units": {slot: dict(label) for slot in function["parameters"]["properties"]["units"]["required"]}}
            else:
                candidates = json.loads(body["messages"][1]["content"])["candidates"]
                arguments = {"results": [{"candidate_index": index, "verdict": "uncertain",
                    "issues": ["insufficient_evidence"], "evidence": []} for index in range(len(candidates))]}
            self.assertEqual(request.extensions["timeout"], dict.fromkeys(("connect", "read", "write", "pool"), 300.0))
            if source_drift and function["name"] == "GroundedMemoryLabels":
                source = helper.repo / "backend/src/notalone/memory_extraction/verification_adapters.py"
                source.write_bytes(source.read_bytes() + b"\n# synthetic frozen source drift\n")
            response = helper.response(request, arguments=arguments, reported_model="deepseek-v4-pro")
            if verification_fault and function["name"] == "SourceVerificationOutput":
                payload = response.json()
                choice = payload["choices"][0]
                if verification_fault == "missing_tool":
                    choice["message"]["tool_calls"] = []
                    choice["finish_reason"] = "stop"
                elif verification_fault == "multiple_tools":
                    choice["message"]["tool_calls"] *= 2
                elif verification_fault in {"length", "content_filter"}:
                    choice["finish_reason"] = verification_fault
                elif verification_fault == "model_identity":
                    payload["model"] = "deepseek-v4-flash"
                elif verification_fault == "nested_json_invalid":
                    choice["message"]["tool_calls"][0]["function"]["arguments"] = '{"results":'
                else:
                    self.fail("未知合成故障")
                response = httpx.Response(200, request=request, json=payload)
            return response
        # 只注入审核终态，不把全not_memory合成响应冒充正确语义；测试批次闭账边界。
        injected = patch.object(PhasedEvaluationAudit, "__call__", autospec=True,
            side_effect=lambda _, bundle: {"case_position": bundle["case_position"],
                "decision": "unknown" if bundle["case_position"] == 15 else "safe",
                "reason_code": "audit_unresolved" if bundle["case_position"] == 15 else "supported",
                "criteria_sha256": hashes[PUBLIC_REFERENCE_V2_PATH]})
        with injected if unknown_at_last else nullcontext():
            result = run_ecnu_evaluation(output_directory=helper.output, run_id=uuid4(),
                deadline=datetime.now(timezone.utc) + timedelta(hours=4), repo_root=helper.repo,
                source_hashes=hashes, frozen_gold={"status": "frozen_agent_review", "case_names": [case.name for case in _PLAN_CASES],
                    "criteria_path": PUBLIC_REFERENCE_V2_PATH, "criteria_sha256": hashes[PUBLIC_REFERENCE_V2_PATH]},
                credential_loader=helper.credential, audit_case=audit, synthetic_transport=httpx.MockTransport(respond),
                provider_profile="deepseek-pro-reference16-v-thinking-v1" if v_thinking else "deepseek-pro-reference16-v1", execution_plan=execution_plan, extraction_prompt_profile="reference-kind-teaching-v1", verification_prompt_profile=verification_profile,
                extraction_mode="grounded-v2", verification_mode="legacy-v4", verification_tool_choice="omitted" if v_thinking else "forced",
                case_set="reference21", case_positions=tuple(range(16)), reference_version="source-fidelity-v2",
                request_limit=32, request_timeout_seconds=300, max_retries=0)
        if verification_fault:
            self.assertEqual(len(helper.requests), 2, result)
            self.assertEqual(seen, [])
            self.assertEqual(result["outcomes"][0]["status"], "failed" if verification_fault in {"missing_tool", "multiple_tools"} else "unknown")
            self.assertEqual(result["summary"]["unrun"], 15)
            self.assertFalse(result["summary"]["plan_complete"])
            self.assertTrue(result["receipt"]["budget"]["closed"])
            self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 2)
            self.assertNotIn("tool_choice", helper.requests[-1])
            return result
        if source_drift:
            self.assertEqual(len(helper.requests), 1)
            self.assertEqual(seen, [])
            self.assertEqual(result["summary"]["unknown"], 1)
            self.assertEqual(result["summary"]["unrun"], 15)
            self.assertTrue(result["receipt"]["budget"]["closed"])
            return result
        if unknown_at_last:
            return result
        self.assertEqual(len(helper.requests), 2, result)
        for body in helper.requests:
            self.assertEqual(body["model"], "deepseek-v4-pro")
            thinking_v = v_thinking and body["tools"][0]["function"]["name"] == "SourceVerificationOutput"
            self.assertEqual(body["thinking"], {"type": "enabled" if thinking_v else "disabled"})
            self.assertEqual(body["reasoning_effort"], "max" if thinking_v else "none")
            self.assertEqual(body["max_tokens"], 8192)
            if thinking_v:
                self.assertNotIn("tool_choice", body)
            else:
                self.assertEqual(body["tool_choice"], {"type": "function", "function": {"name": body["tools"][0]["function"]["name"]}})
        self.assertEqual(len(seen), 1, result.get("stopped_code"))
        self.assertNotIn("verification", seen[0])
        self.assertEqual(result["summary"]["unrun"], 15)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 2)
        self.assertTrue(result["receipt"]["budget"]["closed"])
        config = json.loads((helper.output / "manifest.json").read_text())["frozen_config"]
        self.assertEqual(config["selected_case_positions"], list(range(16)))
        self.assertEqual(config["execution_plan"], execution_plan)
        self.assertEqual(config["extraction_prompt_profile"], "reference-kind-teaching-v1")
        from notalone.memory_extraction.grounded_adapter import grounded_v2_prompt
        from notalone.memory_extraction.evaluation_offline import _verification_contract
        self.assertEqual(helper.requests[0]["messages"][0]["content"], grounded_v2_prompt("reference-kind-teaching-v1"))
        self.assertNotEqual(helper.requests[0]["messages"][0]["content"], grounded_v2_prompt("default"))
        self.assertEqual(helper.requests[1]["messages"][0]["content"], _verification_contract("legacy-v4", prompt_profile=verification_profile)[0])
        if verification_profile != "default":
            self.assertEqual(config["verification_prompt_profile"], verification_profile)
            self.assertEqual(config["verification_prompt_sha256"], canonical_sha256(helper.requests[1]["messages"][0]["content"]))
            self.assertNotEqual(helper.requests[1]["messages"][0]["content"], _verification_contract("legacy-v4")[0])
        else:
            self.assertNotIn("verification_prompt_profile", config)
        self.assertEqual(config["extraction_prompt_sha256"], canonical_sha256(helper.requests[0]["messages"][0]["content"]))
        if v_thinking:
            self.assertEqual(config["request_contract_version"], 6)
            self.assertEqual(config["provider_profile"], "deepseek-pro-reference16-v-thinking-v1")
            self.assertNotIn("thinking", config)
            self.assertNotIn("reasoning_effort", config)
            self.assertEqual(config["phase_request_version"], "deepseek-reference16-v-thinking-v1")
            self.assertEqual(config["phase_request_policy"], {
                "extraction": {"thinking_mode":"disabled", "reasoning_effort":"none", "tool_choice_mode":"forced"},
                "verification": {"thinking_mode":"enabled", "reasoning_effort":"max", "tool_choice_mode":"omitted"}})
            return result
        self.assertEqual(config["request_contract_version"], 4)
        self.assertEqual(config["provider_profile"], "deepseek-pro-reference16-v1")
        self.assertNotIn("phase_request_policy", config)
        self.assertNotIn("phase_request_version", config)
        self.assertNotIn("max_tokens", config["omitted_parameters"])
