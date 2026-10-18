"""记录器保留计划闭集；新V提示不得冒充原Pro16/教学计划。"""

import unittest

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudgetAbort
from notalone.memory_extraction.evaluation_offline import _verification_contract
from notalone.memory_extraction.evaluation_records import canonical_sha256
from tests.unit.memory_extraction import test_evaluation_reference16_pro_contract as pro_tests
from tests.unit.memory_extraction.test_evaluation_reference16_teaching_contract import teaching_registration


def retention_registration():
    config, plan = teaching_registration()
    prompt, schema = _verification_contract("legacy-v4", prompt_profile="reference-retention-v1")
    config.update(execution_plan="reference16-pro-retention-v1",
                  mode="deepseek_bounded_reference16_pro_retention", stage="reference16-pro-retention",
                  verification_prompt_profile="reference-retention-v1",
                  verification_prompt_sha256=canonical_sha256(prompt),
                  verification_schema_sha256=canonical_sha256(schema))
    return config, plan


class Reference16RetentionRecordsTest(unittest.TestCase):
    def test_exact_retention_registration_accepts_and_old_profiles_keep_their_contract(self):
        helper = pro_tests.Reference16ProRegistrationTest()
        self.addCleanup(helper.doCleanups)
        config, plan = retention_registration()
        store = helper.store(config, plan)
        self.assertEqual(store.execution_plan, "reference16-pro-retention-v1")
        self.assertEqual(store.extraction_prompt_profile, "reference-kind-teaching-v1")
        for build in (pro_tests.registration, teaching_registration):
            old_config, old_plan = build()
            helper.store(old_config, old_plan)
            self.assertNotIn("verification_prompt_profile", old_config)
            with self.assertRaises(EvaluationBudgetAbort):
                helper.store({**old_config, "verification_prompt_profile": "reference-retention-v1"}, old_plan)

    def test_recomputed_hash_cannot_authorize_cross_plan_or_prompt_drift(self):
        helper = pro_tests.Reference16ProRegistrationTest()
        self.addCleanup(helper.doCleanups)
        config, plan = retention_registration()
        old, _ = teaching_registration()
        for changes in (
            {"execution_plan": "reference16-pro-teaching-v1"},
            {"mode": "deepseek_bounded_reference16_pro_teaching"},
            {"stage": "reference16-pro-teaching"},
            {"extraction_prompt_profile": "default"},
            {"verification_prompt_profile": "default"},
            {"verification_prompt_profile": "reference-retention-v2"},
            {"verification_prompt_sha256": old["verification_prompt_sha256"]},
            {"verification_schema_sha256": "0" * 64},
        ):
            with self.subTest(changes=changes), self.assertRaises(EvaluationBudgetAbort):
                helper.store({**config, **changes}, plan)
        del config["verification_prompt_profile"]
        with self.assertRaises(EvaluationBudgetAbort):
            helper.store(config, plan)
