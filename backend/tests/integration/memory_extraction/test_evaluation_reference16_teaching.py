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

    def _exercise_sdk(self, *, unknown_at_last=False):
        import hashlib
        import json
        from tests.integration.memory_extraction.test_evaluation_ecnu import EvaluationECNUTest
        from notalone.memory_extraction.evaluation_ecnu import _REFERENCE16_PRO_TEACHING_REQUIRED_SOURCES, _PLAN_CASES
        from notalone.memory_extraction.evaluation_phased_audit import PhasedEvaluationAudit
        from notalone.memory_extraction.evaluation_records import canonical_sha256
        from notalone.memory_extraction.evaluation_reference import PUBLIC_REFERENCE_V2_PATH, PUBLIC_ANNOTATION_V2_PATH
        helper = EvaluationECNUTest()
        helper.setUp()
        self.addCleanup(helper.doCleanups)
        actual = Path(__file__).resolve().parents[4]
        hashes = {}
        for relative in _REFERENCE16_PRO_TEACHING_REQUIRED_SOURCES:
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
            extraction_mode="grounded-v2", verification_mode="legacy-v4", case_set="reference21",
            case_positions=tuple(range(16)), reference_version="source-fidelity-v2", execution_plan="reference16-pro-teaching-v1", extraction_prompt_profile="reference-kind-teaching-v1")
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
            return helper.response(request, arguments=arguments, reported_model="deepseek-v4-pro")
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
                provider_profile="deepseek-pro-reference16-v1", execution_plan="reference16-pro-teaching-v1", extraction_prompt_profile="reference-kind-teaching-v1",
                extraction_mode="grounded-v2", verification_mode="legacy-v4", verification_tool_choice="forced",
                case_set="reference21", case_positions=tuple(range(16)), reference_version="source-fidelity-v2",
                request_limit=32, request_timeout_seconds=300, max_retries=0)
        if unknown_at_last:
            return result
        self.assertEqual(len(helper.requests), 2, result)
        for body in helper.requests:
            self.assertEqual(body["model"], "deepseek-v4-pro")
            self.assertEqual(body["thinking"], {"type": "disabled"})
            self.assertEqual(body["reasoning_effort"], "none")
            self.assertEqual(body["max_tokens"], 8192)
            self.assertEqual(body["tool_choice"], {"type": "function", "function": {"name": body["tools"][0]["function"]["name"]}})
        self.assertEqual(len(seen), 1, result.get("stopped_code"))
        self.assertNotIn("verification", seen[0])
        self.assertEqual(result["summary"]["unrun"], 15)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 2)
        self.assertTrue(result["receipt"]["budget"]["closed"])
        config = json.loads((helper.output / "manifest.json").read_text())["frozen_config"]
        self.assertEqual(config["selected_case_positions"], list(range(16)))
        self.assertEqual(config["execution_plan"], "reference16-pro-teaching-v1")
        self.assertEqual(config["extraction_prompt_profile"], "reference-kind-teaching-v1")
        from notalone.memory_extraction.grounded_adapter import grounded_v2_prompt
        from notalone.memory_extraction.evaluation_offline import _verification_contract
        self.assertEqual(helper.requests[0]["messages"][0]["content"], grounded_v2_prompt("reference-kind-teaching-v1"))
        self.assertNotEqual(helper.requests[0]["messages"][0]["content"], grounded_v2_prompt("default"))
        self.assertEqual(helper.requests[1]["messages"][0]["content"], _verification_contract("legacy-v4")[0])
        self.assertEqual(config["extraction_prompt_sha256"], canonical_sha256(helper.requests[0]["messages"][0]["content"]))
        self.assertEqual(config["request_contract_version"], 4)
        self.assertEqual(config["provider_profile"], "deepseek-pro-reference16-v1")
        self.assertNotIn("phase_request_policy", config)
        self.assertNotIn("phase_request_version", config)
        self.assertNotIn("max_tokens", config["omitted_parameters"])
