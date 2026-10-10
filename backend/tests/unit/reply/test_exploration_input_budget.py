"""方向探索的实际模型调用也受共同完整请求预算约束。"""

import json
import unittest
from dataclasses import replace
from uuid import uuid4

from notalone.reply.adapters.exploration_runtime import LangChainExplorationRuntime
from notalone.reply.input_budget import BudgetState, InputBudgetExceededError, InputBudgetUnavailableError
from tests.input_budget_support import synthetic_budget_kwargs
from tests.unit.reply.test_exploration_runtime import RecordingLedger, context, model, output


class ExplorationInputBudgetTest(unittest.TestCase):
    def test_unknown_capability_blocks_actual_exploration_and_outbound_record(self):
        fake, ledger = model(output()), RecordingLedger()

        with self.assertRaises(InputBudgetUnavailableError):
            LangChainExplorationRuntime(model=fake, ledger=ledger).explore(context())

        self.assertEqual(fake.seen_calls, [])
        self.assertEqual(ledger.entries, [])

    def test_complete_request_equals_actual_call_and_keeps_full_static_skill(self):
        fake, ledger = model(output()), RecordingLedger()
        configuration = synthetic_budget_kwargs(fake, output_reserve=100)
        decisions = []
        skill = {"version_id": str(uuid4()), "name": "synthetic-budget-skill", "content": "合成完整策略正文。" * 3500}
        prepared = replace(context(), skill=skill)

        result = LangChainExplorationRuntime(model=fake, ledger=ledger,
                                            on_input_budget=decisions.append, **configuration).explore(prepared)

        self.assertEqual(result, output())
        counter = configuration["input_token_counter"]
        self.assertEqual(counter.seen_payloads, fake.seen_model_payloads)
        actual = fake.seen_model_payloads[0]
        self.assertEqual(actual["max_tokens"], 100)
        self.assertEqual(actual["tool_choice"], "ExplorationOutput")
        self.assertEqual([tool["function"]["name"] for tool in actual["tools"]], ["ExplorationOutput"])
        payload = json.loads(actual["messages"][1]["content"])
        self.assertEqual(payload["skill"], skill)
        self.assertNotIn("style_references", payload)
        self.assertIn("回答不等于确认意愿", actual["messages"][0]["content"])
        self.assertEqual(decisions[0].state, BudgetState.READY)
        self.assertEqual(len(ledger.entries), 1)
        self.assertNotIn(skill["content"], repr(decisions[0].to_payload()))

    def test_warning_allows_same_request_and_changed_input_is_rechecked_before_call(self):
        fake, ledger, prepared = model(output()), RecordingLedger(), context()
        configuration = synthetic_budget_kwargs(fake, output_reserve=100)
        baseline = []
        LangChainExplorationRuntime(model=fake, ledger=ledger, on_input_budget=baseline.append,
                                    **configuration).explore(prepared)
        configuration["input_budget_profile"] = replace(configuration["input_budget_profile"],
                                                        context_window_tokens=baseline[0].total_tokens + 1)
        decisions = []
        runtime = LangChainExplorationRuntime(model=fake, ledger=ledger,
                                              on_input_budget=decisions.append, **configuration)
        runtime.explore(prepared)
        self.assertEqual(decisions[0].state, BudgetState.WARNING)
        with self.assertRaises(InputBudgetExceededError):
            runtime.explore(replace(prepared, input=replace(prepared.input, requirements="合成新增要求。" * 100)))
        self.assertEqual(decisions[-1].state, BudgetState.EXCEEDED)
        self.assertEqual(len(fake.seen_calls), 2)
        self.assertEqual(len(ledger.entries), 2)

    def test_counter_bound_to_another_model_cannot_allow_exploration(self):
        fake, other, ledger = model(output()), model(output()), RecordingLedger()
        configuration = synthetic_budget_kwargs(other)
        with self.assertRaises(InputBudgetUnavailableError):
            LangChainExplorationRuntime(model=fake, ledger=ledger, **configuration).explore(context())
        self.assertEqual(fake.seen_calls, [])
        self.assertEqual(ledger.entries, [])

    def test_unverified_parameter_override_cannot_bypass_complete_request(self):
        for override in ({"messages": [{"role": "user", "content": "合成绕过参数"}]}, {"max_tokens": 999}):
            with self.subTest(override=override):
                fake, ledger = model(output()), RecordingLedger()
                fake.extra_body = override
                with self.assertRaises(InputBudgetUnavailableError):
                    LangChainExplorationRuntime(model=fake, ledger=ledger,
                                                **synthetic_budget_kwargs(fake)).explore(context())
                self.assertEqual(fake.seen_calls, [])
                self.assertEqual(ledger.entries, [])
