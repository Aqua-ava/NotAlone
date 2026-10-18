"""独立V推理合同拒绝跨计划或阶段策略漂移。"""
import unittest
from copy import deepcopy
from notalone.memory_extraction.evaluation_http_budget import EvaluationBudgetAbort
from tests.unit.memory_extraction import test_evaluation_provider_contract as provider_tests

class Reference16VToken32kProviderTest(unittest.TestCase):
    setUp = provider_tests.EvaluationProviderContractTest.setUp
    _contract = provider_tests.EvaluationProviderContractTest._contract

    def test_new_provider_accepts_only_new_plan_and_exact_phase_requests(self):
        from notalone.memory_extraction.verification_adapters import source_verification_contract
        from notalone.memory_extraction.grounded_adapter import grounded_v2_prompt
        fixed = dict(provider_profile="deepseek-pro-reference16-v-token32k-v1",
            execution_plan="reference16-pro-retention-v-token32k-v1", extraction_mode="grounded-v2",
            extraction_prompt_profile="reference-kind-teaching-v1", verification_prompt_profile="reference-retention-v1",
            verification_tool_choice="omitted")
        contract = self._contract(**fixed)
        for change in ({"provider_profile":"deepseek-pro-reference16-v1"},
                       {"execution_plan":"reference16-pro-retention-v1"}, {"execution_plan":"reference16-pro-retention-v-thinking-v1"}, {"provider_profile":"deepseek-pro-reference16-v-thinking-v1"},
                       {"execution_plan":"bounded-runtime-v1"}, {"verification_tool_choice":"forced"},
                       {"extraction_prompt_profile":"default"}, {"verification_prompt_profile":"default"}):
            with self.subTest(change=change), self.assertRaises(EvaluationBudgetAbort):
                self._contract(**{**fixed, **change})
        for verification in (False, True):
            body = provider_tests._payload()
            name = "SourceVerificationOutput" if verification else "GroundedMemoryLabels"
            body.update(model="deepseek-v4-pro", max_tokens=32768 if verification else 8192,
                thinking={"type":"enabled" if verification else "disabled"},
                reasoning_effort="max" if verification else "none")
            body["tools"][0]["function"]["name"] = name
            body["messages"][0]["content"] = (source_verification_contract("legacy-v4", prompt_profile="reference-retention-v1")[0]
                if verification else grounded_v2_prompt("reference-kind-teaching-v1"))
            if verification:
                del body["tool_choice"]
            else:
                body["tool_choice"]["function"]["name"] = name
            with contract.expect_request(body):
                pass
            for change in ({"thinking":{"type":"disabled" if verification else "enabled"}},
                           {"reasoning_effort":"none" if verification else "max"}, {"max_tokens":8192 if verification else 32768}, {"max_tokens":True}, {"max_tokens":32768.0 if verification else 8192.0},
                           {"tool_choice":{"type":"function","function":{"name":name}}} if verification else {"tool_choice":None}):
                with self.subTest(verification=verification, change=change), self.assertRaises(EvaluationBudgetAbort):
                    with contract.expect_request({**deepcopy(body), **change}):
                        self.fail("阶段策略漂移必须拒绝")

class Reference16VToken32kAuditTest(unittest.TestCase):
    def test_exact_phase_identity_precedes_raw_and_full(self):
        from tests.unit.memory_extraction.test_evaluation_reference16_pro_audit import Reference16ProAuditTest
        helper = Reference16ProAuditTest()
        helper.setUp()
        self.addCleanup(helper.doCleanups)
        identity = dict(execution_plan="reference16-pro-retention-v-token32k-v1",
            extraction_prompt_profile="reference-kind-teaching-v1", verification_prompt_profile="reference-retention-v1",
            verification_tool_choice="omitted")
        helper.bundle.update(**identity, phase_request_version="deepseek-reference16-v-token32k-v1",
            phase_request_policy={
                "extraction":{"thinking_mode":"disabled", "reasoning_effort":"none", "tool_choice_mode":"forced", "max_tokens":8192},
                "verification":{"thinking_mode":"enabled", "reasoning_effort":"max", "tool_choice_mode":"omitted", "max_tokens":32768}})
        helper.bundle["provider_requests"][1]["body"].pop("tool_choice")
        audit = helper.audit(**identity)
        for change in ({"phase_request_version":"deepseek-phase-split-v1"}, {"phase_request_policy":{}},
                       {"verification_tool_choice":"forced"}, {"execution_plan":"reference16-pro-retention-v1"}):
            with self.subTest(change=change), self.assertRaises(EvaluationBudgetAbort):
                audit({**helper.bundle, **change})
        for phase in ("extraction", "verification"):
            for value in (True, 8192.0 if phase == "extraction" else 32768.0, None):
                policy = deepcopy(helper.bundle["phase_request_policy"])
                policy[phase]["max_tokens"] = value
                with self.subTest(phase=phase, value=value), self.assertRaises(EvaluationBudgetAbort):
                    audit({**helper.bundle, "phase_request_policy": policy})
        self.assertEqual(helper.order, [])
        self.assertEqual(audit(helper.bundle)["decision"], "safe")
        self.assertEqual(helper.order, ["raw", "persist:raw", "full", "persist:final"])
