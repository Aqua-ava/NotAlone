"""真实 create_agent 边界的预算验证；只替换合成模型。"""

from __future__ import annotations

import copy
import json
import unittest
from dataclasses import replace
from typing import Any, NotRequired

from deepagents.backends.state import StateBackend
from deepagents.backends.utils import create_file_data
from deepagents.middleware.skills import SkillsMiddleware
from langchain.agents import create_agent
from langchain.agents.middleware import AgentState
from langchain.agents.structured_output import ProviderStrategy, ToolStrategy
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    convert_to_openai_messages,
)
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool
from langchain_core.utils.function_calling import convert_to_openai_tool
from pydantic import Field

from notalone.reply.adapters.input_budget_middleware import InputBudgetMiddleware
from notalone.reply.input_budget import (
    BudgetState,
    InputBudgetDecision,
    InputBudgetExceededError,
    InputBudgetProfile,
    InputBudgetRequest,
    InputBudgetUnavailableError,
    InputComponent,
    InputTokenMeasurement,
    TokenMeasurementKind,
)


MODEL_ID = "synthetic-framed-model-v1"
MEASUREMENT_ID = "synthetic-codepoint-protocol-v1"
OUTPUT_SCHEMA = {
    "title": "SyntheticBudgetOutput",
    "description": "合成模型的结构化输出工具。",
    "type": "object",
    "properties": {"text": {"type": "string"}},
    "required": ["text"],
}


class SyntheticSkillState(AgentState):
    files: NotRequired[dict[str, Any]]


def synthetic_input() -> dict[str, Any]:
    return {
        "messages": [
            {"role": "user", "content": "合成先前要求：保持简短。"},
            {"role": "assistant", "content": "合成已保存旧候选。"},
            {"role": "user", "content": "合成当前要求与联系人检索依据。"},
        ],
        "files": {
            "/synthetic-skills/warm-synthetic/SKILL.md": create_file_data(
                "---\nname: warm-synthetic\n"
                "description: 合成动态策略目录。\n---\n合成策略正文。"
            ),
        },
    }


def synthetic_output() -> AIMessage:
    return AIMessage(content="", tool_calls=[{
        "name": "SyntheticBudgetOutput",
        "args": {"text": "合成候选。"},
        "id": "synthetic-output-id",
    }])


def make_profile(capacity: int = 20000) -> InputBudgetProfile:
    return InputBudgetProfile(
        model_id=MODEL_ID,
        context_window_tokens=capacity,
        output_reserve_tokens=100,
        warning_ratio=0.8,
        measurement_kind=TokenMeasurementKind.EXACT,
        measurement_id=MEASUREMENT_ID,
    )


class ControlledBudgetModel(BaseChatModel):
    """模型边界夹具：每个 JSON Unicode 字符是一 token，另有 17 framing token。

    这是合成协议的精确计量约定，不是任何真实供应商的字节上界或 tokenizer。
    """

    model_name: str = MODEL_ID
    responses: list[AIMessage]
    seen_calls: list[dict[str, Any]] = Field(default_factory=list)
    max_tokens: int = 700
    model_kwargs: dict[str, Any] = Field(default_factory=dict)
    extra_body: dict[str, Any] | None = None

    @property
    def _llm_type(self) -> str:
        return "controlled-budget-model"

    def bind_tools(self, tools, *, tool_choice=None, **kwargs):
        return self.bind(
            tools=[convert_to_openai_tool(item) for item in tools],
            tool_choice=tool_choice,
            **kwargs,
        )

    def _generate(
        self,
        messages: list[BaseMessage],
        stop=None,
        run_manager=None,
        **kwargs,
    ) -> ChatResult:
        payload = {
            "model": self.model_name,
            "messages": convert_to_openai_messages(messages),
            "max_tokens": self.max_tokens,
            **self.model_kwargs,
            **kwargs,
        }
        if "max_completion_tokens" in payload:
            payload["max_tokens"] = payload.pop("max_completion_tokens")
        payload.update(payload.pop("extra_body", self.extra_body or {}))
        self.seen_calls.append(copy.deepcopy(payload))
        index = len(self.seen_calls) - 1
        return ChatResult(generations=[ChatGeneration(message=self.responses[index])])


class SyntheticProtocolCounter:
    """计量受控模型的完整协议请求；不是 guard 或业务模块的替身。"""

    def __init__(self, model: ControlledBudgetModel | None = None) -> None:
        self._model = model
        self.seen_payloads: list[dict[str, Any]] = []

    def is_bound_to(self, model: object) -> bool:
        return model is self._model

    def measure(self, request: InputBudgetRequest) -> InputTokenMeasurement:
        messages = list(request.messages)
        if request.system_message is not None:
            messages.insert(0, dict(request.system_message))
        payload = {
            "model": request.model_id,
            "messages": messages,
            "tools": list(request.tool_schemas),
            **request.model_settings,
        }
        if request.response_schema is not None:
            payload["response_format"] = dict(request.response_schema)
        self.seen_payloads.append(copy.deepcopy(payload))
        count = len(json.dumps(payload, ensure_ascii=False, separators=(",", ":"))) + 17
        return InputTokenMeasurement(
            model_id=MODEL_ID,
            input_tokens=count,
            kind=TokenMeasurementKind.EXACT,
            measurement_id=MEASUREMENT_ID,
            covered_components=frozenset(InputComponent),
        )


@tool
def synthetic_context() -> str:
    """读取合成联系人的有限上下文。"""

    return "合成工具补入的联系人资料。"


def make_graph(
    model: ControlledBudgetModel,
    middleware: InputBudgetMiddleware,
    *,
    schema: dict[str, Any] = OUTPUT_SCHEMA,
    tools: list[Any] | None = None,
    skills_prompt: str = (
        "合成动态策略目录：\n{skills_locations}{skills_load_warnings}{skills_list}"
    ),
):
    return create_agent(
        model=model,
        state_schema=SyntheticSkillState,
        system_prompt="合成基础系统规则。",
        tools=tools if tools is not None else [synthetic_context],
        middleware=[
            SkillsMiddleware(
                backend=StateBackend(),
                sources=["/synthetic-skills/"],
                system_prompt=skills_prompt,
            ),
            middleware,
        ],
        response_format=ToolStrategy(schema, handle_errors=False),
    )


class InputBudgetMiddlewareTest(unittest.IsolatedAsyncioTestCase):
    async def test_final_request_matches_actual_model_payload_and_output_limit(self):
        model = ControlledBudgetModel(responses=[synthetic_output()])
        counter = SyntheticProtocolCounter(model)
        decisions: list[InputBudgetDecision] = []
        middleware = InputBudgetMiddleware(
            profile=make_profile(), counter=counter, on_decision=decisions.append,
            response_format=ToolStrategy(OUTPUT_SCHEMA, handle_errors=False),
        )

        result = await make_graph(model, middleware).ainvoke(synthetic_input())

        self.assertEqual(result["structured_response"], {"text": "合成候选。"})
        self.assertEqual(len(model.seen_calls), 1)
        self.assertEqual(counter.seen_payloads, model.seen_calls)
        payload = model.seen_calls[0]
        self.assertEqual(payload["max_tokens"], 100)
        self.assertIn("warm-synthetic", payload["messages"][0]["content"])
        self.assertEqual(payload["messages"][1]["content"], "合成先前要求：保持简短。")
        names = {item["function"]["name"] for item in payload["tools"]}
        self.assertEqual(names, {"synthetic_context", "SyntheticBudgetOutput"})
        self.assertEqual(len(decisions), 1)
        self.assertTrue(decisions[0].allowed)

    async def test_dynamic_system_over_capacity_blocks_first_model_call(self):
        model = ControlledBudgetModel(responses=[synthetic_output()])
        counter = SyntheticProtocolCounter(model)
        decisions: list[InputBudgetDecision] = []
        middleware = InputBudgetMiddleware(
            profile=make_profile(1000),
            counter=counter,
            response_format=ToolStrategy(OUTPUT_SCHEMA, handle_errors=False),
            on_decision=decisions.append,
        )
        prompt = (
            "合成超长动态系统指令。" * 1000
            + "{skills_locations}{skills_load_warnings}{skills_list}"
        )

        with self.assertRaises(InputBudgetExceededError):
            await make_graph(model, middleware, skills_prompt=prompt).ainvoke(
                synthetic_input(),
            )

        self.assertEqual(model.seen_calls, [])
        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].state, BudgetState.EXCEEDED)
        self.assertIn("合成超长动态系统指令", counter.seen_payloads[0]["messages"][0]["content"])

    async def test_output_tool_schema_alone_can_exceed_capacity(self):
        schema = copy.deepcopy(OUTPUT_SCHEMA)
        schema["properties"]["text"]["description"] = "合成超长输出约束。" * 1000
        model = ControlledBudgetModel(responses=[synthetic_output()])
        counter = SyntheticProtocolCounter(model)
        middleware = InputBudgetMiddleware(
            profile=make_profile(2000), counter=counter,
            response_format=ToolStrategy(schema, handle_errors=False),
        )

        with self.assertRaises(InputBudgetExceededError):
            await make_graph(model, middleware, schema=schema).ainvoke(
                synthetic_input(),
            )

        self.assertEqual(model.seen_calls, [])
        output_tool = next(
            item for item in counter.seen_payloads[0]["tools"]
            if item["function"]["name"] == "SyntheticBudgetOutput"
        )
        self.assertIn("合成超长输出约束", str(output_tool))

    async def test_tool_material_rechecks_budget_before_second_model_call(self):
        @tool("large_synthetic_context")
        def large_context() -> str:
            """读取合成联系人的大段已授权资料。"""

            return "合成补入历史与Skill资料。" * 1000

        model = ControlledBudgetModel(responses=[
            AIMessage(content="", tool_calls=[{
                "name": "large_synthetic_context", "args": {},
                "id": "synthetic-context-call",
            }]),
            synthetic_output(),
        ])
        counter = SyntheticProtocolCounter(model)
        decisions: list[InputBudgetDecision] = []
        middleware = InputBudgetMiddleware(
            profile=make_profile(2000), counter=counter,
            response_format=ToolStrategy(OUTPUT_SCHEMA, handle_errors=False),
            on_decision=decisions.append,
        )

        with self.assertRaises(InputBudgetExceededError):
            await make_graph(model, middleware, tools=[large_context]).ainvoke(
                synthetic_input(),
            )

        self.assertEqual(len(model.seen_calls), 1)
        self.assertEqual(len(counter.seen_payloads), 2)
        self.assertTrue(decisions[0].allowed)
        self.assertEqual(decisions[1].state, BudgetState.EXCEEDED)
        second = counter.seen_payloads[1]["messages"]
        self.assertEqual(second[1]["content"], "合成先前要求：保持简短。")
        self.assertEqual(second[-1]["role"], "tool")
        self.assertIn("合成补入历史与Skill资料", second[-1]["content"])

    async def test_unknown_profile_or_counter_blocks_actual_graph_call(self):
        cases = (
            (make_profile(), None),
            (
                replace(make_profile(), measurement_kind=None),
                SyntheticProtocolCounter(),
            ),
            (
                replace(make_profile(), context_window_tokens=None),
                SyntheticProtocolCounter(),
            ),
            (
                replace(make_profile(), model_id="deepseek-chat"),
                SyntheticProtocolCounter(),
            ),
        )
        for profile, counter in cases:
            with self.subTest(profile=profile):
                model = ControlledBudgetModel(responses=[synthetic_output()])
                middleware = InputBudgetMiddleware(
                    profile=profile, counter=counter,
                    response_format=ToolStrategy(OUTPUT_SCHEMA, handle_errors=False),
                )

                with self.assertRaises(InputBudgetUnavailableError):
                    await make_graph(model, middleware).ainvoke(synthetic_input())

                self.assertEqual(model.seen_calls, [])

    async def test_native_response_schema_matches_actual_model_payload(self):
        strategy = ProviderStrategy(OUTPUT_SCHEMA)
        model = ControlledBudgetModel(responses=[
            AIMessage(content=json.dumps({"text": "合成候选。"}, ensure_ascii=False)),
        ])
        counter = SyntheticProtocolCounter(model)
        middleware = InputBudgetMiddleware(
            profile=make_profile(), counter=counter,
            response_format=strategy,
        )
        graph = create_agent(
            model=model, tools=[synthetic_context], middleware=[middleware],
            response_format=strategy, system_prompt="合成原生输出约束。",
        )

        result = await graph.ainvoke({
            "messages": [{"role": "user", "content": "合成目的。"}],
        })

        self.assertEqual(result["structured_response"], {"text": "合成候选。"})
        self.assertEqual(counter.seen_payloads, model.seen_calls)
        self.assertEqual(model.seen_calls[0]["response_format"]["type"], "json_schema")

    async def test_nested_output_override_cannot_exceed_bound_reserve(self):
        for options in (
            {"model_kwargs": {"max_completion_tokens": 900}},
            {"extra_body": {"max_tokens": 900}},
        ):
            with self.subTest(options=options):
                model = ControlledBudgetModel(responses=[synthetic_output()], **options)
                counter = SyntheticProtocolCounter(model)
                middleware = InputBudgetMiddleware(
                    profile=make_profile(), counter=counter,
                    response_format=ToolStrategy(OUTPUT_SCHEMA, handle_errors=False),
                )

                with self.assertRaises(InputBudgetUnavailableError):
                    await make_graph(model, middleware).ainvoke(synthetic_input())

                self.assertEqual(model.seen_calls, [])
                self.assertEqual(counter.seen_payloads, [])

    async def test_bad_counter_result_blocks_actual_model_call(self):
        class UntrustedCounter(SyntheticProtocolCounter):
            def __init__(self, model, changes: dict[str, Any]) -> None:
                super().__init__(model)
                self.changes = changes

            def measure(self, request: InputBudgetRequest) -> InputTokenMeasurement:
                return replace(super().measure(request), **self.changes)

        cases = (
            {"input_tokens": True},
            {"input_tokens": -1},
            {"input_tokens": float("nan")},
            {"input_tokens": float("inf")},
            {"covered_components": frozenset({InputComponent.MESSAGES})},
        )
        for changes in cases:
            with self.subTest(changes=changes):
                model = ControlledBudgetModel(responses=[synthetic_output()])
                middleware = InputBudgetMiddleware(
                    profile=make_profile(), counter=UntrustedCounter(model, changes),
                    response_format=ToolStrategy(OUTPUT_SCHEMA, handle_errors=False),
                )

                with self.assertRaises(InputBudgetUnavailableError) as caught:
                    await make_graph(model, middleware).ainvoke(synthetic_input())

                self.assertEqual(model.seen_calls, [])
                self.assertIsNone(caught.exception.decision.input_tokens)

    async def test_output_schema_registration_mismatch_blocks_before_counter(self):
        registered = copy.deepcopy(OUTPUT_SCHEMA)
        registered["properties"]["text"]["description"] = "合成不一致注册约束。"
        model = ControlledBudgetModel(responses=[synthetic_output()])
        counter = SyntheticProtocolCounter(model)
        middleware = InputBudgetMiddleware(
            profile=make_profile(), counter=counter,
            response_format=ToolStrategy(registered, handle_errors=False),
        )

        with self.assertRaises(InputBudgetUnavailableError):
            await make_graph(model, middleware).ainvoke(synthetic_input())

        self.assertEqual(model.seen_calls, [])
        self.assertEqual(counter.seen_payloads, [])


if __name__ == "__main__":
    unittest.main()
