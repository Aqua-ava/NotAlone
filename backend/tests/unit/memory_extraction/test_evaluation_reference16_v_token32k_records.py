"""V32K只扩大V阶段token；旧v6字节合同与原16窗不变。"""

from copy import deepcopy
import unittest

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudgetAbort
from tests.unit.memory_extraction import test_evaluation_reference16_pro_contract as pro_tests
from tests.unit.memory_extraction.test_evaluation_reference16_v_thinking_records import (
    v_thinking_registration, POLICY as OLD_POLICY,
)


PLAN = "reference16-pro-retention-v-token32k-v1"
KIND = "reference16-pro-retention-v-token32k"
PLAN_SOURCE = ".scratch/memory-extraction-accuracy/reference-v-token32k-plan-20261018.md"
POLICY = {
    "extraction": {"thinking_mode": "disabled", "reasoning_effort": "none", "tool_choice_mode": "forced", "max_tokens": 8192},
    "verification": {"thinking_mode": "enabled", "reasoning_effort": "max", "tool_choice_mode": "omitted", "max_tokens": 32768},
}


def v_token32k_registration():
    config, plan = v_thinking_registration()
    config.pop("max_tokens")
    config.update(execution_plan=PLAN, mode="deepseek_bounded_reference16_pro_retention_v_token32k", stage=KIND,
                  provider_profile="deepseek-pro-reference16-v-token32k-v1", request_contract_version=7,
                  phase_request_version="deepseek-reference16-v-token32k-v1", phase_request_policy=deepcopy(POLICY))
    return config, plan


class Reference16VToken32kRecordsTest(unittest.TestCase):
    def test_phase_token_plan_registers_and_v6_contract_stays_exact(self):
        helper = pro_tests.Reference16ProRegistrationTest()
        self.addCleanup(helper.doCleanups)
        config, plan = v_token32k_registration()
        self.assertEqual(helper.store(config, plan).execution_plan, PLAN)
        old, old_plan = v_thinking_registration()
        helper.store(old, old_plan)
        self.assertEqual(old["max_tokens"], 8192)
        self.assertEqual(old["phase_request_policy"], OLD_POLICY)

    def test_rehashed_token_type_swap_global_or_old_profile_cannot_register(self):
        helper = pro_tests.Reference16ProRegistrationTest()
        self.addCleanup(helper.doCleanups)
        config, plan = v_token32k_registration()
        changes = [
            {"max_tokens": 32768}, {"max_tokens": None}, {"thinking": {"type": "enabled"}},
            {"reasoning_effort": "max"}, {"request_contract_version": 6},
            {"provider_profile": "deepseek-pro-reference16-v-thinking-v1"},
            {"execution_plan": "reference16-pro-retention-v-thinking-v1"},
            {"phase_request_version": "deepseek-reference16-v-thinking-v1"},
            {"phase_request_policy": deepcopy(OLD_POLICY)}, {"verification_prompt_sha256": "0" * 64},
        ]
        swapped = deepcopy(POLICY)
        swapped["extraction"]["max_tokens"], swapped["verification"]["max_tokens"] = 32768, 8192
        changes.append({"phase_request_policy": swapped})
        for phase in ("extraction", "verification"):
            for value in (True, float(POLICY[phase]["max_tokens"]), "8192", None):
                changed = deepcopy(POLICY)
                changed[phase]["max_tokens"] = value
                changes.append({"phase_request_policy": changed})
        for change in changes:
            with self.subTest(change=change), self.assertRaises(EvaluationBudgetAbort):
                helper.store({**config, **change}, plan)
        old, old_plan = v_thinking_registration()
        with self.assertRaises(EvaluationBudgetAbort):
            helper.store({**old, "phase_request_policy": POLICY}, old_plan)
        for field in ("phase_request_version", "phase_request_policy"):
            removed = deepcopy(config)
            del removed[field]
            with self.subTest(missing=field), self.assertRaises(EvaluationBudgetAbort):
                helper.store(removed, plan)
