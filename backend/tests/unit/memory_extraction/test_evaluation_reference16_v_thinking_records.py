"""V独立思考档须绑定新版本、双阶段策略及原16窗。"""

from copy import deepcopy
import unittest

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudgetAbort
from tests.unit.memory_extraction import test_evaluation_reference16_pro_contract as pro_tests
from tests.unit.memory_extraction.test_evaluation_reference16_retention_records import retention_registration


PLAN = "reference16-pro-retention-v-thinking-v1"
KIND = "reference16-pro-retention-v-thinking"
POLICY = {
    "extraction": {"thinking_mode": "disabled", "reasoning_effort": "none", "tool_choice_mode": "forced"},
    "verification": {"thinking_mode": "enabled", "reasoning_effort": "max", "tool_choice_mode": "omitted"},
}


def v_thinking_registration():
    config, plan = retention_registration()
    config.pop("thinking")
    config.pop("reasoning_effort")
    config.update(execution_plan=PLAN, mode="deepseek_bounded_reference16_pro_retention_v_thinking", stage=KIND,
                  provider_profile="deepseek-pro-reference16-v-thinking-v1", request_contract_version=6,
                  phase_request_version="deepseek-reference16-v-thinking-v1", phase_request_policy=deepcopy(POLICY))
    config["tool_choice"]["verification"]["mode"] = "omitted"
    return config, plan


class Reference16VThinkingRecordsTest(unittest.TestCase):
    def test_exact_split_phase_registers_without_changing_prior_retention_contract(self):
        helper = pro_tests.Reference16ProRegistrationTest()
        self.addCleanup(helper.doCleanups)
        config, plan = v_thinking_registration()
        self.assertEqual(helper.store(config, plan).execution_plan, PLAN)
        old, old_plan = retention_registration()
        self.assertEqual(helper.store(old, old_plan).execution_plan, "reference16-pro-retention-v1")
        self.assertNotIn("phase_request_policy", old)

    def test_rehash_cannot_authorize_cross_profile_phase_or_prompt_changes(self):
        helper = pro_tests.Reference16ProRegistrationTest()
        self.addCleanup(helper.doCleanups)
        config, plan = v_thinking_registration()
        bad_e = deepcopy(POLICY)
        bad_e["extraction"]["reasoning_effort"] = "max"
        bad_v = deepcopy(POLICY)
        bad_v["verification"]["tool_choice_mode"] = "forced"
        changes = (
            {"provider_profile": "deepseek-pro-reference16-v1"},
            {"execution_plan": "reference16-pro-retention-v1"},
            {"mode": "deepseek_bounded_reference16_pro_retention"},
            {"stage": "reference16-pro-retention"}, {"request_contract_version": 4},
            {"phase_request_version": "deepseek-reference16-v-thinking-v2"},
            {"phase_request_policy": bad_e}, {"phase_request_policy": bad_v},
            {"phase_request_policy": {**POLICY, "extra": {}}},
            {"thinking": {"type": "enabled"}}, {"reasoning_effort": "max"},
            {"verification_prompt_profile": "default"}, {"verification_prompt_sha256": "0" * 64},
            {"extraction_prompt_sha256": "0" * 64}, {"max_tokens": 8193},
            {"gold_sha256": "0" * 64}, {"selected_case_positions": list(range(15))},
        )
        for change in changes:
            with self.subTest(change=change), self.assertRaises(EvaluationBudgetAbort):
                helper.store({**config, **change}, plan)
        old, old_plan = retention_registration()
        for field in ("phase_request_version", "phase_request_policy"):
            with self.subTest(old_added=field), self.assertRaises(EvaluationBudgetAbort):
                helper.store({**old, field: config[field]}, old_plan)
            removed = deepcopy(config)
            del removed[field]
            with self.subTest(missing=field), self.assertRaises(EvaluationBudgetAbort):
                helper.store(removed, plan)
