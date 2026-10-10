"""预算与实际出站协议的回归：真实图、离线 SDK 与显式合成计量。"""

from __future__ import annotations

import copy
import json
import unittest
from dataclasses import replace
from typing import Any

from deepagents.backends.state import StateBackend
from deepagents.middleware.skills import SkillsMiddleware
from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.structured_output import ProviderStrategy, ToolStrategy
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_deepseek import ChatDeepSeek
from pydantic import Field

from notalone.reply.adapters.input_budget_middleware import InputBudgetMiddleware
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.input_budget import (
    InputBudgetDecision,
    InputBudgetExceededError,
    InputBudgetProfile,
    InputBudgetRequest,
    InputBudgetUnavailableError,
    InputComponent,
    InputTokenMeasurement,
    TokenMeasurementKind,
)
from notalone.retrieval import InMemoryRetrieval
from tests.input_budget_support import SyntheticBudgetModel, synthetic_budget_kwargs
from tests.unit.reply.test_input_budget_middleware import (
    OUTPUT_SCHEMA,
    SyntheticSkillState,
    synthetic_input,
    synthetic_output,
    synthetic_context,
)
from tests.unit.reply.test_input_budget_runtime import (
    SCOPE,
    prepared_context,
    reply_output,
)
from tests.unit.reply.test_langchain_vertical_slice import EmptySkillPort


SDK_MODEL_ID = "synthetic-offline-sdk-model-v1"
SDK_MEASUREMENT_ID = "synthetic-sdk-json-codepoint-framing-v1"


def protocol_count(payload: dict[str, Any]) -> int:
    """本夹具声明的 JSON 字符协议；不表示供应商 token 或其上界。"""

    return len(json.dumps(payload, ensure_ascii=False, separators=(",", ":"))) + 17


class OfflineDeepSeek(ChatDeepSeek):
    """复用锁定 SDK 的真实序列化，生成边界只读取合成响应，不调用 client。"""

    responses: list[AIMessage]
    seen_model_payloads: list[dict[str, Any]] = Field(default_factory=list)

    def _generate(
        self, messages: list[BaseMessage], stop=None, run_manager=None, **kwargs,
    ) -> ChatResult:
        self.seen_model_payloads.append(copy.deepcopy(self._get_request_payload(
            messages, stop=stop, **kwargs,
        )))
        return ChatResult(generations=[ChatGeneration(
            message=self.responses[len(self.seen_model_payloads) - 1],
        )])

    async def _agenerate(
        self, messages: list[BaseMessage], stop=None, run_manager=None, **kwargs,
    ) -> ChatResult:
        return self._generate(messages, stop, run_manager, **kwargs)


class OfflineSdkCounter:
    """只计量同一离线模型的完整 JSON 协议与 17 个 framing 单位。"""

    def __init__(self, model: OfflineDeepSeek) -> None:
        self._model = model
        self.seen_payloads: list[dict[str, Any]] = []

    def is_bound_to(self, model: object) -> bool:
        return model is self._model

    def measure(self, request: InputBudgetRequest) -> InputTokenMeasurement:
        settings = copy.deepcopy(dict(request.model_settings))
        tool_choice = settings.pop("tool_choice", None)
        bound = self._model.bind_tools(
            list(request.tool_schemas), tool_choice=tool_choice, **settings,
        )
        payload = self._model._get_request_payload([], **bound.kwargs)
        if request.response_schema is not None:
            # DTO 已保存实际 SDK 规范化的 schema，不重新当作用户 schema 绑定。
            payload["response_format"] = copy.deepcopy(dict(request.response_schema))
        payload["messages"] = copy.deepcopy(list(request.messages))
        if request.system_message is not None:
            payload["messages"].insert(0, copy.deepcopy(dict(request.system_message)))
        self.seen_payloads.append(copy.deepcopy(payload))
        return InputTokenMeasurement(
            model_id=self._model.model_name,
            input_tokens=protocol_count(payload),
            kind=TokenMeasurementKind.EXACT,
            measurement_id=SDK_MEASUREMENT_ID,
            covered_components=frozenset(InputComponent),
        )


def sdk_configuration(model: OfflineDeepSeek, capacity: int = 50000):
    counter = OfflineSdkCounter(model)
    return {
        "input_budget_profile": InputBudgetProfile(
            model_id=model.model_name,
            context_window_tokens=capacity,
            output_reserve_tokens=3000,
            warning_ratio=0.8,
            measurement_kind=TokenMeasurementKind.EXACT,
            measurement_id=SDK_MEASUREMENT_ID,
        ),
        "input_token_counter": counter,
    }


def sdk_model(responses: list[AIMessage]) -> OfflineDeepSeek:
    return OfflineDeepSeek(
        model=SDK_MODEL_ID, responses=responses, api_key="synthetic-unused-key",
        base_url="http://127.0.0.1:1/synthetic-offline", max_retries=0,
        use_responses_api=False, max_tokens=9000, temperature=0,
    )


class OverrideModelRoute(AgentMiddleware):
    async def awrap_model_call(self, request, handler):
        return await handler(request.override(model_settings={
            **request.model_settings, "model": "other-unverified-model",
        }))


def synthetic_graph(model, configuration, *, outer=None):
    strategy = ToolStrategy(OUTPUT_SCHEMA, handle_errors=False)
    budget = InputBudgetMiddleware(
        profile=configuration["input_budget_profile"],
        counter=configuration["input_token_counter"], response_format=strategy,
    )
    return create_agent(
        model=model, tools=[], response_format=strategy,
        middleware=[*(outer or []), budget], system_prompt="合成预算边界规则。",
    )


class InputBudgetProviderBoundaryTest(unittest.IsolatedAsyncioTestCase):
    async def test_nested_extra_body_cannot_override_actual_output_reserve(self):
        model = SyntheticBudgetModel(
            responses=[synthetic_output()],
            model_kwargs={"extra_body": {"max_tokens": 900}},
        )
        configuration = synthetic_budget_kwargs(model, output_reserve=100)

        with self.assertRaises(InputBudgetUnavailableError):
            await synthetic_graph(model, configuration).ainvoke({
                "messages": [{"role": "user", "content": "合成本轮要求。"}],
            })

        self.assertEqual(model.seen_model_payloads, [])

    async def test_top_level_model_override_is_rejected_before_actual_model_call(self):
        model = SyntheticBudgetModel(responses=[synthetic_output()])
        configuration = synthetic_budget_kwargs(model, output_reserve=100)

        with self.assertRaises(InputBudgetUnavailableError):
            await synthetic_graph(
                model, configuration, outer=[OverrideModelRoute()],
            ).ainvoke({
                "messages": [{"role": "user", "content": "合成模型路由要求。"}],
            })

        self.assertEqual(model.seen_model_payloads, [])

    async def test_sdk_dynamic_system_blocks_are_measured_in_actual_wire_shape(self):
        model = sdk_model([synthetic_output()])
        configuration = sdk_configuration(model)
        strategy = ToolStrategy(OUTPUT_SCHEMA, handle_errors=False)
        graph = create_agent(
            model=model, tools=[], state_schema=SyntheticSkillState,
            response_format=strategy, system_prompt="合成基础规则。",
            middleware=[
                SkillsMiddleware(
                    backend=StateBackend(), sources=["/synthetic-skills/"],
                    system_prompt=(
                        "合成动态策略：{skills_locations}"
                        "{skills_load_warnings}{skills_list}"
                    ),
                ),
                InputBudgetMiddleware(
                    profile=configuration["input_budget_profile"],
                    counter=configuration["input_token_counter"],
                    response_format=strategy,
                ),
            ],
        )

        result = await graph.ainvoke(synthetic_input())

        self.assertEqual(result["structured_response"], {"text": "合成候选。"})
        self.assertIsInstance(model.seen_model_payloads[0]["messages"][0]["content"], list)
        self.assertEqual(
            configuration["input_token_counter"].seen_payloads,
            model.seen_model_payloads,
        )

    async def test_sdk_invalid_tool_calls_remain_counted_before_second_model_round(self):
        context = prepared_context()
        context = replace(context, command=replace(
            context.command, content=replace(
                context.command.content, include_relationship_context=True,
            ),
        ))
        responses = [AIMessage(
            content="", tool_calls=[{
                "name": "conversation_search", "args": {"query": "合成历史", "top_k": 8},
                "id": "synthetic-valid-search",
            }], invalid_tool_calls=[{
                "name": "synthetic-invalid-search", "args": "合" * 1800,
                "id": "synthetic-invalid-call", "error": "合成无法解析参数。",
            }],
        ), reply_output()]

        def runtime(capacity):
            model = sdk_model(responses)
            configuration = sdk_configuration(model, capacity)
            decisions: list[InputBudgetDecision] = []
            return (
                LangChainReplyRuntime(
                    model=model, skill_port=EmptySkillPort(SCOPE, 0),
                    retrieval=InMemoryRetrieval(), on_input_budget=decisions.append,
                    **configuration,
                ), model, configuration["input_token_counter"], decisions,
            )

        baseline, baseline_model, baseline_counter, _ = runtime(50000)
        baseline.generate(context)
        actual_first_total = protocol_count(baseline_model.seen_model_payloads[0]) + 3000
        capacity = actual_first_total + 600
        current, model, counter, decisions = runtime(capacity)

        with self.assertRaises(InputBudgetExceededError):
            current.generate(context)

        self.assertEqual(len(model.seen_model_payloads), 1)
        self.assertEqual(len(counter.seen_payloads), 2)
        self.assertEqual(counter.seen_payloads[:1], model.seen_model_payloads)
        self.assertEqual(baseline_counter.seen_payloads, baseline_model.seen_model_payloads)
        self.assertGreater(decisions[1].total_tokens, capacity)
        calls = counter.seen_payloads[1]["messages"][-2]["tool_calls"]
        invalid = next(item for item in calls if item["id"] == "synthetic-invalid-call")
        self.assertEqual(invalid["function"]["arguments"], "合" * 1800)

    async def test_same_model_name_does_not_authorize_counter_for_different_defaults(self):
        other = SyntheticBudgetModel(responses=[synthetic_output()])
        actual = SyntheticBudgetModel(
            responses=[synthetic_output()],
            model_kwargs={"synthetic_protocol_default": "合成不同模型配置。" * 100},
        )
        configuration = synthetic_budget_kwargs(other, output_reserve=100)

        with self.assertRaises(InputBudgetUnavailableError):
            await synthetic_graph(actual, configuration).ainvoke({
                "messages": [{"role": "user", "content": "合成同名模型。"}],
            })

        self.assertEqual(actual.seen_model_payloads, [])
        self.assertEqual(configuration["input_token_counter"].seen_payloads, [])

    async def test_sdk_native_schema_and_effective_defaults_match_actual_payload(self):
        model = sdk_model([AIMessage(content='{"text":"合成原生候选。"}')])
        strategy = ProviderStrategy(OUTPUT_SCHEMA)
        configuration = sdk_configuration(model)
        graph = create_agent(
            model=model, tools=[synthetic_context], response_format=strategy,
            system_prompt="合成原生结构化输出。",
            middleware=[InputBudgetMiddleware(
                profile=configuration["input_budget_profile"],
                counter=configuration["input_token_counter"], response_format=strategy,
            )],
        )

        result = await graph.ainvoke({
            "messages": [{"role": "user", "content": "合成原生输出要求。"}],
        })

        self.assertEqual(result["structured_response"], {"text": "合成原生候选。"})
        self.assertEqual(
            configuration["input_token_counter"].seen_payloads,
            model.seen_model_payloads,
        )
        payload = model.seen_model_payloads[0]
        self.assertEqual(payload["response_format"]["type"], "json_schema")
        self.assertTrue(payload["tools"][0]["function"]["strict"])
        self.assertEqual(payload["max_tokens"], 3000)
        self.assertEqual(payload["temperature"], 0.0)
        self.assertIs(payload["stream"], False)

    async def test_unverified_generic_message_extensions_block_without_losing_them(self):
        messages = (
            AIMessage(content="", invalid_tool_calls=[{
                "name": "synthetic-invalid", "args": "合成旧讨论参数。" * 100,
                "id": "synthetic-old-invalid", "error": "合成无效参数。",
            }]),
            AIMessage(content="合成旧候选。", additional_kwargs={
                "synthetic_unverified_wire_field": "合成未核实的输入扩展。",
            }),
        )
        for previous in messages:
            with self.subTest(message_type=previous.type):
                model = SyntheticBudgetModel(responses=[synthetic_output()])
                configuration = synthetic_budget_kwargs(model, output_reserve=100)

                with self.assertRaises(InputBudgetUnavailableError):
                    await synthetic_graph(model, configuration).ainvoke({
                        "messages": [
                            {"role": "user", "content": "合成先前要求。"},
                            previous,
                            {"role": "user", "content": "合成当前要求。"},
                        ],
                    })

                self.assertEqual(model.seen_model_payloads, [])
                self.assertEqual(configuration["input_token_counter"].seen_payloads, [])


if __name__ == "__main__":
    unittest.main()
