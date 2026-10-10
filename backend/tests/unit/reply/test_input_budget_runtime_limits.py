"""正式运行时的临界预算与补入资料；不压缩原请求，不改取数预算。"""

from __future__ import annotations

import json
import unittest
from dataclasses import replace
from uuid import UUID

from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.input_budget import (
    BudgetState,
    InputBudgetDecision,
    InputBudgetExceededError,
    InputBudgetUnavailableError,
)
from notalone.reply.style_reference import StyleReference
from notalone.retrieval import InMemoryRetrieval, RetrievedMessage
from tests.input_budget_support import synthetic_budget_kwargs
from tests.integration.server.core_business_flow_support import (
    ScriptedCoreModel,
    tool_response,
)
from tests.unit.reply.test_input_budget_runtime import (
    SCOPE,
    prepared_context,
    reply_output,
)
from tests.unit.reply.test_langchain_vertical_slice import EmptySkillPort


def runtime_fixture(capacity: int = 100000, *, responses=None, retrieval=None):
    model = ScriptedCoreModel()
    model.responses = responses if responses is not None else [reply_output()]
    configuration = synthetic_budget_kwargs(
        model, capacity=capacity, output_reserve=100,
    )
    decisions: list[InputBudgetDecision] = []
    runtime = LangChainReplyRuntime(
        model=model, skill_port=EmptySkillPort(SCOPE, 0), retrieval=retrieval,
        on_input_budget=decisions.append, **configuration,
    )
    return runtime, model, configuration["input_token_counter"], decisions


class InputBudgetRuntimeLimitTest(unittest.TestCase):
    def test_threshold_warning_allows_call_and_one_token_over_blocks_it(self):
        prepared = prepared_context()
        baseline, _, _, decisions = runtime_fixture()
        baseline.generate(prepared)
        total = decisions[0].total_tokens
        self.assertIsInstance(total, int)

        near, near_model, near_counter, near_decisions = runtime_fixture(total + 1)
        result = near.generate(prepared)

        self.assertEqual(len(result.candidates), 1)
        self.assertEqual(len(near_model.seen_calls), 1)
        self.assertEqual(near_counter.seen_payloads, near_model.seen_model_payloads)
        self.assertEqual(near_decisions[0].state, BudgetState.WARNING)
        self.assertEqual(near_decisions[0].total_tokens, total)

        over, over_model, _, over_decisions = runtime_fixture(total - 1)
        with self.assertRaises(InputBudgetExceededError):
            over.generate(prepared)

        self.assertEqual(over_model.seen_calls, [])
        self.assertEqual(over_decisions[0].state, BudgetState.EXCEEDED)
        self.assertEqual(over_decisions[0].total_tokens, total)

    def test_tool_material_rechecks_full_original_request_before_next_round(self):
        prepared = prepared_context()
        prepared = replace(prepared, command=replace(
            prepared.command,
            content=replace(
                prepared.command.content, include_relationship_context=True,
            ),
        ))
        history_text = "合成预算资料：过去说明的重要要求，不要丢弃。" * 140
        retrieval = InMemoryRetrieval(messages=(RetrievedMessage(
            message_id=UUID("00000000-0000-0000-0000-000000000020"),
            scope=SCOPE, text=history_text,
            source_ids=(UUID("00000000-0000-0000-0000-000000000021"),),
            session_id=UUID("00000000-0000-0000-0000-000000000022"),
            role="contact",
        ),))
        responses = [tool_response(
            "conversation_search", {"query": "合成预算资料", "top_k": 8},
        ), reply_output()]
        baseline, _, _, decisions = runtime_fixture(
            responses=responses, retrieval=retrieval,
        )
        baseline.generate(prepared)
        initial_total = decisions[0].total_tokens
        self.assertGreater(decisions[1].total_tokens, initial_total + 100)

        runtime, model, counter, current = runtime_fixture(
            initial_total + 100, responses=responses, retrieval=retrieval,
        )
        with self.assertRaises(InputBudgetExceededError):
            runtime.generate(prepared)

        self.assertEqual(len(model.seen_calls), 1)
        self.assertEqual(len(counter.seen_payloads), 2)
        self.assertEqual(counter.seen_payloads[:1], model.seen_model_payloads)
        self.assertTrue(current[0].allowed)
        self.assertEqual(current[1].state, BudgetState.EXCEEDED)
        initial_messages = counter.seen_payloads[0]["messages"]
        final_messages = counter.seen_payloads[1]["messages"]
        self.assertEqual(final_messages[:len(initial_messages)], initial_messages)
        original = json.loads(final_messages[1]["content"])
        self.assertEqual(original["draft_text"], prepared.command.content.draft_text)
        self.assertIn("fidelity_contract", original)
        tool_result = json.loads(final_messages[-1]["content"])
        self.assertEqual(tool_result["status"], "ok")
        self.assertLessEqual(len(tool_result["messages"]), 8)
        self.assertIn(history_text, final_messages[-1]["content"])

    def test_full_style_reference_can_cross_total_limit_without_model_call(self):
        prepared = prepared_context()
        prepared = replace(prepared, command=replace(
            prepared.command,
            content=replace(
                prepared.command.content, include_relationship_context=True,
            ),
        ))
        baseline, _, _, decisions = runtime_fixture()
        baseline.generate(prepared)
        total = decisions[0].total_tokens
        sample_text = "合成表达样本：可以简短温和，但不提供本次事实。" * 8
        reference = StyleReference(
            sample_id=UUID("00000000-0000-0000-0000-000000000030"),
            scope=SCOPE, text=sample_text,
        )
        styled = replace(prepared, style_references=(reference,))
        runtime, model, counter, decisions = runtime_fixture(total + 1)

        with self.assertRaises(InputBudgetExceededError):
            runtime.generate(styled)

        self.assertEqual(model.seen_calls, [])
        self.assertEqual(decisions[0].state, BudgetState.EXCEEDED)
        payload = json.loads(counter.seen_payloads[0]["messages"][1]["content"])
        self.assertEqual(payload["style_references"], [{
            "sample_id": str(reference.sample_id), "text": sample_text,
            "factual_role": "expression_reference", "weight": "low",
        }])
        self.assertNotIn("messages", decisions[0].to_payload())
        self.assertNotIn(sample_text, str(decisions[0].to_payload()))

    def test_explicit_unknown_model_profile_never_reaches_model_or_counter(self):
        model = ScriptedCoreModel()
        model.responses = [reply_output()]
        original = synthetic_budget_kwargs(model)
        for change in (
            {"context_window_tokens": None},
            {"measurement_kind": None},
            {"model_id": "unverified-model"},
        ):
            with self.subTest(change=change):
                configuration = dict(original)
                configuration["input_budget_profile"] = replace(
                    original["input_budget_profile"], **change,
                )
                runtime = LangChainReplyRuntime(
                    model=model, skill_port=EmptySkillPort(SCOPE, 0), **configuration,
                )

                with self.assertRaises(InputBudgetUnavailableError) as caught:
                    runtime.generate(prepared_context())

                self.assertIsNone(caught.exception.decision.input_tokens)
                self.assertEqual(model.seen_calls, [])
                self.assertEqual(original["input_token_counter"].seen_payloads, [])


if __name__ == "__main__":
    unittest.main()
