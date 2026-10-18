"""原16窗教学计划只接受显式E提示，保留旧Pro16合同。"""
import unittest

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudgetAbort
from tests.unit.memory_extraction import test_evaluation_provider_contract as provider_tests


class Reference16TeachingProviderTest(unittest.TestCase):
    setUp = provider_tests.EvaluationProviderContractTest.setUp
    _contract = provider_tests.EvaluationProviderContractTest._contract

    def test_teaching_profile_requires_its_exact_plan_and_keeps_old_default(self):
        fixed = dict(provider_profile="deepseek-pro-reference16-v1",
            execution_plan="reference16-pro-teaching-v1", extraction_mode="grounded-v2",
            extraction_prompt_profile="reference-kind-teaching-v1", verification_tool_choice="forced")
        self._contract(**fixed)
        self._contract(**{**fixed, "execution_plan": "reference16-pro-v1", "extraction_prompt_profile": "default"})
        for change in ({"execution_plan": "reference16-pro-v1"}, {"execution_plan": "reference16-pro-teaching-v2"},
                       {"extraction_prompt_profile": "default"}, {"extraction_prompt_profile": "reference-kind-teaching-v2"},
                       {"extraction_mode": "grounded-v4"}, {"provider_profile": "deepseek-phase-split-v1"}):
            with self.subTest(change=change), self.assertRaises(EvaluationBudgetAbort):
                self._contract(**{**fixed, **change})


class Reference16TeachingAuditTest(unittest.TestCase):
    def test_teaching_plan_preserves_raw_full_order_and_rejects_profile_drift(self):
        from tests.unit.memory_extraction.test_evaluation_reference16_pro_audit import Reference16ProAuditTest
        helper = Reference16ProAuditTest()
        helper.setUp()
        self.addCleanup(helper.doCleanups)
        helper.bundle.update(execution_plan="reference16-pro-teaching-v1",
                             extraction_prompt_profile="reference-kind-teaching-v1")
        audit = helper.audit(execution_plan="reference16-pro-teaching-v1",
                             extraction_prompt_profile="reference-kind-teaching-v1")
        for change in ({"extraction_prompt_profile": "default"}, {"execution_plan": "reference16-pro-v1"}):
            with self.subTest(change=change), self.assertRaises(EvaluationBudgetAbort):
                audit({**helper.bundle, **change})
        self.assertEqual(helper.order, [])
        result = audit(helper.bundle)
        self.assertEqual(result["decision"], "safe")
        self.assertEqual(helper.order[:4], ["raw", "persist:raw", "full", "persist:final"])


def teaching_registration():
    from notalone.memory_extraction.evaluation import build_window
    from notalone.memory_extraction.evaluation_ecnu import _PLAN_CASES
    from notalone.memory_extraction.evaluation_offline import _frozen_config
    from tests.unit.memory_extraction.test_evaluation_reference16_pro_contract import registration
    config, plan = registration()
    teaching = _frozen_config(plan, windows=tuple(build_window(case) for case in _PLAN_CASES[:16]),
        extraction_mode="grounded-v2", verification_mode="legacy-v4", max_retries=0,
        request_timeout_seconds=300.0, extraction_prompt_profile="reference-kind-teaching-v1")
    config.update({key: value for key, value in teaching.items() if key.startswith("extraction_")})
    config.update(mode="deepseek_bounded_reference16_pro_teaching", stage="reference16-pro-teaching",
                  execution_plan="reference16-pro-teaching-v1")
    return config, plan


class Reference16TeachingRegistrationTest(unittest.TestCase):
    def test_freeze_requires_exact_teaching_prompt_and_rejects_old_plan_relabel(self):
        from tests.unit.memory_extraction.test_evaluation_reference16_pro_contract import Reference16ProRegistrationTest, registration
        helper = Reference16ProRegistrationTest()
        self.addCleanup(helper.doCleanups)
        config, plan = teaching_registration()
        store = helper.store(config, plan)
        self.assertEqual(store.execution_plan, "reference16-pro-teaching-v1")
        self.assertEqual(store.extraction_prompt_profile, "reference-kind-teaching-v1")
        old_config, old_plan = registration()
        helper.store(old_config, old_plan)
        self.assertNotIn("extraction_prompt_profile", old_config)
        for changed in ({"execution_plan": "reference16-pro-v1"}, {"extraction_prompt_profile": "default"},
                        {"extraction_prompt_sha256": old_config["extraction_prompt_sha256"]},
                        {"extraction_window_contracts": old_config["extraction_window_contracts"]},
                        {"verification_prompt_profile": "reference-kind-teaching-v1"},
                        {"mode": "deepseek_bounded_reference16_pro"}, {"stage": "reference16-pro"}):
            with self.subTest(changed=changed), self.assertRaises(EvaluationBudgetAbort):
                helper.store({**config, **changed}, plan)
