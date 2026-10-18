"""任务07的独立Pro16合同：双非思考、固定来源集合与严格失败闭环。"""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

import httpx

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudgetAbort
from tests.unit.memory_extraction import test_evaluation_provider_contract as base
from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget
from notalone.memory_extraction.evaluation_records import EvaluationRecordStore, canonical_sha256
from notalone.memory_extraction.evaluation_provider_contract import STRICT_RESPONSE_IDENTITY_POLICY


def registration():
    from notalone.memory_extraction.evaluation import build_window
    from notalone.memory_extraction.evaluation_ecnu import _PLAN_CASES
    from notalone.memory_extraction.evaluation_reference import public_window_projection, _PUBLIC_V2
    from notalone.memory_extraction.evaluation_offline import _frozen_config
    cases = _PLAN_CASES[:16]
    windows = tuple(build_window(case) for case in cases)
    plan = tuple({"case_position": i, "case_name": case.name,
                  "input_sha256": canonical_sha256(public_window_projection(window))}
                 for i, (case, window) in enumerate(zip(cases, windows)))
    config = _frozen_config(plan, windows=windows, extraction_mode="grounded-v2",
        verification_mode="legacy-v4", max_retries=0, request_timeout_seconds=300.0)
    config.update(mode="deepseek_bounded_reference16_pro", stage="reference16-pro",
        execution_plan="reference16-pro-v1", reference_version="source-fidelity-v2",
        provider_profile="deepseek-pro-reference16-v1", request_contract_version=4,
        base_url="https://api.deepseek.com", endpoint="https://api.deepseek.com/chat/completions",
        request_model="deepseek-v4-pro", max_tokens=8192, thinking={"type": "disabled"},
        reasoning_effort="none", selected_case_positions=list(range(16)), fallback=False,
        response_identity_policy=STRICT_RESPONSE_IDENTITY_POLICY, gold_sha256=_PUBLIC_V2.reference_sha256,
        tool_choice={"extraction": {"mode": "forced", "name": "GroundedMemoryLabels"},
                     "verification": {"mode": "forced", "name": "SourceVerificationOutput"}})
    return config, plan


class Reference16ProRegistrationTest(unittest.TestCase):
    def store(self, config, plan, cap=32):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        budget = EvaluationBudget.create(run_id=uuid4(), output_directory=Path(directory),
            request_limit=cap, allowed_endpoints=(config["endpoint"],), config_sha256=canonical_sha256(config))
        self.addCleanup(budget.close)
        return EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan)

    def test_exact_main16_registration_accepts(self):
        config, plan = registration()
        store = self.store(config, plan)
        self.assertEqual(store.execution_plan, "reference16-pro-v1")
        self.assertEqual(store.reference_version, "source-fidelity-v2")

    def test_recomputed_digest_does_not_authorize_configuration_drift(self):
        config, plan = registration()
        for changes in ({"provider_profile": "deepseek-pro-bounded-task-v1"},
                        {"request_model": "deepseek-flash"}, {"request_contract_version": 3},
                        {"max_tokens": 8191}, {"max_tokens": True}, {"thinking": {"type": "enabled"}},
                        {"reasoning_effort": "max"}, {"selected_case_positions": list(range(15))},
                        {"selected_case_positions": list(reversed(range(16)))},
                        {"gold_sha256": "0" * 64}, {"extraction_prompt_sha256": "0" * 64},
                        {"verification_schema_sha256": "0" * 64}, {"phase_request_version": 1},
                        {"bounded_inputs_sha256": "0" * 64}, {"extraction_mode": "grounded-v4"}):
            with self.subTest(changes=changes), self.assertRaises(EvaluationBudgetAbort):
                self.store({**config, **changes}, plan)
        with self.assertRaises(EvaluationBudgetAbort):
            self.store(config, plan, cap=30)


class Reference16ProProviderTest(unittest.TestCase):
    setUp = base.EvaluationProviderContractTest.setUp
    _contract = base.EvaluationProviderContractTest._contract

    def contract(self, **changes):
        return self._contract(**{"provider_profile": "deepseek-pro-reference16-v1",
            "execution_plan": "reference16-pro-v1", "extraction_mode": "grounded-v2",
            "verification_tool_choice": "forced", **changes})

    def test_both_phases_are_non_thinking_named_and_bounded(self):
        contract = self.contract()
        for name in ("GroundedMemoryLabels", "SourceVerificationOutput"):
            body = base._payload()
            body.update(model="deepseek-v4-pro", max_tokens=8192,
                        thinking={"type": "disabled"}, reasoning_effort="none")
            body["tools"][0]["function"]["name"] = name
            body["tool_choice"]["function"]["name"] = name
            with contract.expect_request(body):
                contract.check_request(httpx.Request("POST", "https://api.deepseek.com/chat/completions", json=body))
                changed = deepcopy(body)
                changed["messages"][0]["content"] += "漂移"
                with self.assertRaises(EvaluationBudgetAbort):
                    contract.check_request(httpx.Request("POST", "https://api.deepseek.com/chat/completions", json=changed))
            for fields in ({"model": "deepseek-flash"}, {"max_tokens": True}, {"max_tokens": 8191},
                           {"reasoning_effort": "max"}, {"thinking": {"type": "enabled"}},
                           {"tool_choice": "auto"}, {"max_completion_tokens": 8192}):
                with self.subTest(fields=fields), self.assertRaises(EvaluationBudgetAbort):
                    with contract.expect_request({**body, **fields}):
                        self.fail("错配不得到达发送")
        for change in ({"execution_plan": "original"}, {"execution_plan": "bounded-runtime15-v1"},
                       {"extraction_mode": "grounded-v4"}, {"verification_tool_choice": "omitted"},
                       {"provider_profile": "deepseek-flash-max"}):
            with self.subTest(change=change), self.assertRaises(EvaluationBudgetAbort):
                self.contract(**change)

    def test_identity_incomplete_and_multi_choice_fail_closed(self):
        self.contract().observe_response(httpx.Response(200, json=base._completion("deepseek-v4-pro")))
        for model in (None, "deepseek-flash", "deepseek-pro"):
            with self.subTest(model=model), self.assertRaises(EvaluationBudgetAbort):
                self.contract().observe_response(httpx.Response(200, json=base._completion(model)))
        for reason in ("length", "content_filter"):
            value = base._completion("deepseek-v4-pro")
            value["choices"][0]["finish_reason"] = reason
            with self.subTest(reason=reason), self.assertRaises(EvaluationBudgetAbort):
                self.contract().observe_response(httpx.Response(200, json=value))
        value = base._completion("deepseek-v4-pro")
        value["choices"].append({**deepcopy(value["choices"][0]), "index": 1})
        with self.assertRaises(EvaluationBudgetAbort):
            self.contract().observe_response(httpx.Response(200, json=value))
