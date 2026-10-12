"""ECNU 估算真实 SDK 边界回归；显式离线传输，禁止外部模型网络。"""

from __future__ import annotations

import asyncio
import json
import unittest
from dataclasses import replace

import httpx
from langchain_core.messages import AIMessage
from langchain_deepseek import ChatDeepSeek

from notalone.reply.adapters.ecnu_input_budget import build_ecnu_input_budget
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.adapters.exploration_runtime import LangChainExplorationRuntime
from notalone.reply.input_budget import (
    InputBudgetExceededError, InputBudgetRequest, InputBudgetUnavailableError,
    InputComponent, TokenMeasurementKind,
)
from notalone.retrieval import InMemoryRetrieval
from tests.unit.reply.test_input_budget_runtime import SCOPE, prepared_context, reply_output
from tests.unit.reply.test_langchain_vertical_slice import EmptySkillPort
from tests.unit.reply.test_exploration_runtime import RecordingLedger, context, output


ECNU_URL = "https://chat.ecnu.edu.cn/open/api/v1"


class EcnuInputBudgetTest(unittest.TestCase):
    def model(self, responses=None, **overrides):
        payloads: list[bytes] = []
        scripted = list(responses or [reply_output()])

        def respond(request):
            payloads.append(request.content)
            output = scripted.pop(0)
            message = {"role": "assistant", "content": output.content}
            if output.tool_calls:
                message["tool_calls"] = [{
                    "id": call["id"], "type": "function",
                    "function": {"name": call["name"], "arguments": json.dumps(call["args"])},
                } for call in output.tool_calls]
            return httpx.Response(200, json={
                "id": "synthetic-sdk-output", "object": "chat.completion", "created": 0,
                "model": "ecnu-max", "choices": [{"index": 0, "message": message,
                    "finish_reason": "tool_calls" if output.tool_calls else "stop"}],
                "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30},
            })

        sync_client = httpx.Client(transport=httpx.MockTransport(respond))
        async_client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        self.addCleanup(sync_client.close)
        self.addCleanup(lambda: asyncio.run(async_client.aclose()))
        model = ChatDeepSeek(**{
            "model": "ecnu-max", "base_url": ECNU_URL, "api_key": "synthetic-unused-key",
            "temperature": 0, "max_retries": 0, "use_responses_api": False,
            "http_client": sync_client, "http_async_client": async_client,
            **overrides,
        })
        return model, payloads

    def runtime(self, model, *, capacity=None, decisions=None, history=False):
        configuration = build_ecnu_input_budget(model)
        self.assertIsNotNone(configuration)
        profile, counter = configuration
        if capacity is not None:
            profile = replace(profile, context_window_tokens=capacity)
        return LangChainReplyRuntime(
            model=model, skill_port=EmptySkillPort(SCOPE, 0),
            retrieval=InMemoryRetrieval() if history else None,
            input_budget_profile=profile, input_token_counter=counter,
            on_input_budget=decisions.append if decisions is not None else None,
        )

    def test_complete_sdk_request_is_estimated_and_binds_the_output_reserve(self):
        model, payloads = self.model()
        result = self.runtime(model).generate(prepared_context())
        self.assertEqual(len(payloads), 1)
        self.assertEqual(result.input_budget.input_tokens, len(payloads[0]) + 4096)
        self.assertEqual(result.input_budget.measurement_kind, TokenMeasurementKind.APPROXIMATE)
        self.assertEqual(result.input_budget.safety_margin_tokens, 65536)
        self.assertEqual(json.loads(payloads[0])["max_tokens"], 4096)
        self.assertNotIn("api_key", json.loads(payloads[0]))

    def test_non_text_content_does_not_receive_the_text_only_counter(self):
        model, _ = self.model()
        _, counter = build_ecnu_input_budget(model)
        request = InputBudgetRequest(
            model_id="ecnu-max", system_message=None,
            messages=({"role": "user", "content": [{"type": "image_url",
                       "image_url": {"url": "data:image/png;base64,synthetic"}}]},),
            tool_schemas=(), response_schema=None,
            model_settings={"max_tokens": 4096}, output_token_limit=4096,
        )
        with self.assertRaises(ValueError):
            counter.measure(request)

    def test_unknown_model_or_endpoint_keeps_capability_unknown(self):
        for overrides in ({"model": "unverified-model"},
                          {"base_url": "https://chat.ecnu.edu.cn.example.test/open/api/v1"},
                          {"base_url": ECNU_URL + "?different-route=1"},
                          {"streaming": True}, {"use_responses_api": True}):
            with self.subTest(overrides=overrides):
                model, payloads = self.model(**overrides)
                self.assertIsNone(build_ecnu_input_budget(model))
                with self.assertRaises(InputBudgetUnavailableError):
                    LangChainReplyRuntime(model=model, skill_port=EmptySkillPort(SCOPE, 0)).generate(prepared_context())
                self.assertEqual(payloads, [])

    def test_same_name_other_instance_or_changed_sdk_endpoint_cannot_reuse_counter(self):
        model, payloads = self.model()
        other, _ = self.model()
        profile, counter = build_ecnu_input_budget(model)
        self.assertFalse(counter.is_bound_to(other))
        model.root_async_client.base_url = "http://127.0.0.1:1/unapproved"
        with self.assertRaises(InputBudgetUnavailableError):
            LangChainReplyRuntime(
                model=model, skill_port=EmptySkillPort(SCOPE, 0),
                input_budget_profile=profile, input_token_counter=counter,
            ).generate(prepared_context())
        self.assertEqual(payloads, [])

    def test_changed_effective_defaults_or_unpriced_auth_fields_are_rejected(self):
        model, payloads = self.model()
        runtime = self.runtime(model)
        model.temperature = 0.5
        with self.assertRaises(InputBudgetUnavailableError):
            runtime.generate(prepared_context())
        self.assertEqual(payloads, [])
        unpriced, _ = self.model()
        unpriced.model_kwargs = {"api_key": "synthetic-not-a-request-field"}
        self.assertIsNone(build_ecnu_input_budget(unpriced))

    def test_later_tool_round_is_rechecked_and_preserves_complete_history(self):
        prepared = prepared_context()
        prepared = replace(prepared, command=replace(
            prepared.command, content=replace(prepared.command.content, include_relationship_context=True),
        ))
        baseline, _ = self.model()
        first = self.runtime(baseline, history=True).generate(prepared)
        model, payloads = self.model(responses=[AIMessage(content="", tool_calls=[{
            "id": "synthetic-history-call", "name": "conversation_search",
            "args": {"query": "合成历史", "top_k": 8},
        }]), reply_output()])
        decisions = []
        with self.assertRaises(InputBudgetExceededError):
            self.runtime(model, history=True, capacity=first.input_budget.total_tokens + 100,
                         decisions=decisions).generate(prepared)
        self.assertEqual(len(payloads), 1)
        self.assertEqual(len(decisions), 2)
        self.assertTrue(decisions[0].allowed)
        self.assertFalse(decisions[1].allowed)
        self.assertIn(prepared.current_text, json.loads(payloads[0])["messages"][-1]["content"])

    def test_guard_rejects_full_long_context_without_truncation_or_model_call(self):
        model, payloads = self.model()
        original = prepared_context()
        long_text = "合成完整资料。" * 30000
        prepared = replace(original, current_text=long_text,
                           evidence=(replace(original.evidence[0], text=long_text),))
        with self.assertRaises(InputBudgetExceededError) as caught:
            self.runtime(model).generate(prepared)
        self.assertGreater(caught.exception.decision.total_tokens, 512000)
        self.assertEqual(prepared.current_text, long_text)
        self.assertEqual(payloads, [])

    def test_reply_and_exploration_share_one_real_sdk_counter(self):
        model, payloads = self.model(responses=[reply_output(), AIMessage(content="", tool_calls=[{
            "id": "synthetic-exploration-call", "name": "ExplorationOutput", "args": output(),
        }])])
        profile, counter = build_ecnu_input_budget(model)
        decisions = []
        LangChainReplyRuntime(
            model=model, skill_port=EmptySkillPort(SCOPE, 0),
            input_budget_profile=profile, input_token_counter=counter,
            on_input_budget=decisions.append,
        ).generate(prepared_context())
        ledger = RecordingLedger()
        explored = LangChainExplorationRuntime(
            model=model, ledger=ledger, input_budget_profile=profile,
            input_token_counter=counter, on_input_budget=decisions.append,
        ).explore(context())
        self.assertEqual(explored, output())
        self.assertEqual(len(payloads), 2)
        self.assertEqual(len(ledger.entries), 1)
        for decision, payload in zip(decisions, payloads):
            self.assertEqual(decision.measurement_kind, TokenMeasurementKind.APPROXIMATE)
            self.assertEqual(decision.input_tokens, len(payload) + 4096)
            self.assertEqual(decision.safety_margin_tokens, 65536)
            self.assertEqual(json.loads(payload)["max_tokens"], 4096)


if __name__ == "__main__":
    unittest.main()
