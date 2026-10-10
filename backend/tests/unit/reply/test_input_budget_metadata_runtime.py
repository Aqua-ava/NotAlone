"""预算回执来自每次真实模型调用的局部守卫，不来自模型输出或共享状态。"""

from __future__ import annotations

import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.errors import ReplyInvariantError
from notalone.reply.input_budget import InputBudgetDecision
from notalone.retrieval import InMemoryRetrieval
from tests.input_budget_support import synthetic_budget_kwargs
from tests.integration.server.core_business_flow_support import ScriptedCoreModel, tool_response
from tests.unit.reply.test_input_budget_runtime import SCOPE, prepared_context, reply_output
from tests.unit.reply.test_input_budget_runtime_limits import runtime_fixture
from tests.unit.reply.test_langchain_vertical_slice import EmptySkillPort


class ConcurrentReceiptModel(ScriptedCoreModel):
    """外部模型边界强制两次调用重叠，正文与计量仍走完整生产图。"""

    entered: object = None
    gate: object = None

    def __init__(self) -> None:
        super().__init__()
        self.entered = threading.Event()
        self.gate = threading.Barrier(2)
        self.responses = [reply_output(), reply_output()]

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.entered.set()
        self.gate.wait(timeout=5)
        return super()._generate(messages, stop, run_manager, **kwargs)


class InputBudgetMetadataRuntimeTest(unittest.TestCase):
    def test_success_returns_the_trusted_final_decision(self):
        runtime, model, _, decisions = runtime_fixture()

        result = runtime.generate(prepared_context())

        self.assertEqual(len(model.seen_calls), 1)
        self.assertIsInstance(result.input_budget, InputBudgetDecision)
        self.assertEqual(result.input_budget, decisions[-1])

    def test_tool_round_receipt_uses_final_complete_request(self):
        prepared = prepared_context()
        prepared = replace(prepared, command=replace(
            prepared.command, content=replace(
                prepared.command.content, include_relationship_context=True,
            ),
        ))
        runtime, model, _, decisions = runtime_fixture(
            retrieval=InMemoryRetrieval(), responses=[
                tool_response("conversation_search", {"query": "合成历史", "top_k": 8}),
                reply_output(),
            ],
        )

        result = runtime.generate(prepared)

        self.assertEqual(len(model.seen_calls), 2)
        self.assertGreater(decisions[-1].total_tokens, decisions[0].total_tokens)
        self.assertEqual(result.input_budget, decisions[-1])

    def test_same_runtime_concurrent_calls_keep_their_own_receipt(self):
        model = ConcurrentReceiptModel()
        decisions: list[InputBudgetDecision] = []
        runtime = LangChainReplyRuntime(
            model=model, skill_port=EmptySkillPort(SCOPE, 0),
            on_input_budget=decisions.append,
            **synthetic_budget_kwargs(model, output_reserve=100),
        )
        short = prepared_context()
        text = short.current_text + "合成长讨论要求。" * 100
        long = replace(
            short, current_text=text,
            command=replace(short.command, content=replace(short.command.content, draft_text=text)),
            evidence=(replace(short.evidence[0], text=text),),
        )
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(runtime.generate, long)
            self.assertTrue(model.entered.wait(5))
            second = pool.submit(runtime.generate, short)
            first_result, second_result = first.result(10), second.result(10)

        self.assertEqual(len(model.seen_calls), 2)
        self.assertGreater(decisions[0].total_tokens, decisions[1].total_tokens)
        self.assertEqual(first_result.input_budget, decisions[0])
        self.assertEqual(second_result.input_budget, decisions[1])

    def test_model_cannot_forge_a_budget_field_or_expand_the_output_schema(self):
        forged = reply_output()
        forged.tool_calls[0]["args"]["input_budget"] = {"state": "ready", "input_tokens": 0}
        runtime, model, _, _ = runtime_fixture(responses=[forged])

        with self.assertRaises(ReplyInvariantError):
            runtime.generate(prepared_context())

        self.assertEqual(len(model.seen_calls), 1)
        schema = next(item["function"]["parameters"] for item in model.seen_model_payloads[0]["tools"]
                      if item["function"]["name"] == "ReplyRuntimeOutput")
        self.assertNotIn("input_budget", schema["properties"])


if __name__ == "__main__":
    unittest.main()
