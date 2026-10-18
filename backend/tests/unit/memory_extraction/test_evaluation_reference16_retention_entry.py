"""保留型V必须与第三个Pro16固定计划精确配对。"""
import unittest
from notalone.memory_extraction.evaluation_http_budget import EvaluationBudgetAbort
from tests.unit.memory_extraction import test_evaluation_provider_contract as provider_tests


class Reference16RetentionProviderTest(unittest.TestCase):
    setUp = provider_tests.EvaluationProviderContractTest.setUp
    _contract = provider_tests.EvaluationProviderContractTest._contract

    def test_retention_requires_exact_plan_and_cannot_change_old_v_default(self):
        fixed = dict(provider_profile="deepseek-pro-reference16-v1", execution_plan="reference16-pro-retention-v1",
            extraction_mode="grounded-v2", extraction_prompt_profile="reference-kind-teaching-v1",
            verification_prompt_profile="reference-retention-v1", verification_tool_choice="forced")
        self._contract(**fixed)
        for change in ({"execution_plan": "reference16-pro-teaching-v1"}, {"execution_plan": "reference16-pro-v1"},
                       {"verification_prompt_profile": "default"}, {"verification_prompt_profile": "reference-retention-v2"},
                       {"extraction_prompt_profile": "default"}, {"provider_profile": "deepseek-flash-max"}):
            with self.subTest(change=change), self.assertRaises(EvaluationBudgetAbort):
                self._contract(**{**fixed, **change})

    def test_request_expectation_cannot_freeze_an_old_v_prompt_under_retention_identity(self):
        from notalone.memory_extraction.verification_adapters import source_verification_contract
        contract = self._contract(provider_profile="deepseek-pro-reference16-v1", execution_plan="reference16-pro-retention-v1",
            extraction_mode="grounded-v2", extraction_prompt_profile="reference-kind-teaching-v1",
            verification_prompt_profile="reference-retention-v1", verification_tool_choice="forced")
        body = provider_tests._payload()
        body.update(model="deepseek-v4-pro", max_tokens=8192, thinking={"type": "disabled"}, reasoning_effort="none")
        body["tools"][0]["function"]["name"] = "SourceVerificationOutput"
        body["tool_choice"]["function"]["name"] = "SourceVerificationOutput"
        body["messages"][0]["content"] = source_verification_contract("legacy-v4", prompt_profile="reference-retention-v1")[0]
        with contract.expect_request(body):
            pass
        body["messages"][0]["content"] = source_verification_contract("legacy-v4")[0]
        with self.assertRaisesRegex(EvaluationBudgetAbort, "evaluation_verification_prompt_changed"):
            with contract.expect_request(body):
                self.fail("旧V正文不得登记为新保留提示")


class Reference16RetentionAuditTest(unittest.TestCase):
    def test_v_profile_is_bound_before_raw_and_does_not_change_raw_full_order(self):
        from tests.unit.memory_extraction.test_evaluation_reference16_pro_audit import Reference16ProAuditTest
        helper = Reference16ProAuditTest()
        helper.setUp()
        self.addCleanup(helper.doCleanups)
        helper.bundle.update(execution_plan="reference16-pro-retention-v1",
            extraction_prompt_profile="reference-kind-teaching-v1", verification_prompt_profile="reference-retention-v1")
        audit = helper.audit(execution_plan="reference16-pro-retention-v1",
            extraction_prompt_profile="reference-kind-teaching-v1", verification_prompt_profile="reference-retention-v1")
        for change in ({"verification_prompt_profile": "default"}, {"verification_prompt_profile": "reference-retention-v2"},
                       {"execution_plan": "reference16-pro-teaching-v1"}):
            with self.subTest(change=change), self.assertRaises(EvaluationBudgetAbort):
                audit({**helper.bundle, **change})
        self.assertEqual(helper.order, [])
        self.assertEqual(audit(helper.bundle)["decision"], "safe")
        self.assertEqual(helper.order[:4], ["raw", "persist:raw", "full", "persist:final"])


class Reference16RetentionOwnedTest(unittest.TestCase):
    def test_retention_worker_does_not_accept_teaching_result_identity(self):
        from tests.unit.memory_extraction.test_evaluation_owned_process import OwnedPublicProcessTest
        helper = OwnedPublicProcessTest()
        for plan in ("reference16-pro-retention-v1", "reference16-pro-teaching-v1"):
            with self.subTest(plan=plan):
                result = helper.launch(kind="reference16-pro-retention", windows=16, script_body=f'''
value={{"worker_pid":os.getpid(),"execution_plan":{plan!r},"receipt":{{"budget":{{
    "run_id":run_id,"closed":True,"request_limit":32,"reserved_requests":0}}}}}}
(directory/"result.json").write_text(json.dumps(value))
''')
                self.assertEqual(result["closed"], plan == "reference16-pro-retention-v1")
                self.assertEqual((result["planned_windows"], result["required_claims"], result["optional_claims"]), (16, 18, 1))
