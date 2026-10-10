"""合成模型的显式预算协议；不适用于任何真实供应商模型。"""

from __future__ import annotations

import asyncio
import copy
import json
from typing import Any, Sequence

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import BaseMessage, convert_to_openai_messages
from langchain_core.utils.function_calling import convert_to_openai_tool
from pydantic import Field

from notalone.reply.input_budget import (
    InputBudgetProfile,
    InputBudgetRequest,
    InputComponent,
    InputTokenMeasurement,
    TokenMeasurementKind,
)


SYNTHETIC_MEASUREMENT_ID = "synthetic-json-codepoint-framing-v1"


class SyntheticBudgetModel(FakeMessagesListChatModel):
    """完整 JSON 每个 Unicode 字符为一 token，另加 17 个 framing token。

    这是测试模型明确声明的协议，不是真实供应商 tokenizer 或字符上界。
    _generate 保留实际绑定参数，供测试与计量请求逐项比较。
    """

    model_name: str = "synthetic-json-model-v1"
    max_tokens: int = 8192
    model_kwargs: dict[str, Any] = Field(default_factory=dict)
    extra_body: dict[str, Any] | None = None
    seen_model_payloads: list[dict[str, Any]] = Field(default_factory=list)

    def bind_tools(
        self, tools: Sequence[Any], *, tool_choice: str | None = None,
        **kwargs: Any,
    ):
        return self.bind(
            tools=[convert_to_openai_tool(item) for item in tools],
            tool_choice=tool_choice,
            **kwargs,
        )

    def record_model_payload(
        self, messages: list[BaseMessage], settings: dict[str, Any],
    ) -> None:
        self.seen_model_payloads.append(_model_payload(
            self, convert_to_openai_messages(messages), settings,
        ))

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.record_model_payload(messages, kwargs)
        return super()._generate(messages, stop, run_manager, **kwargs)

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        return await asyncio.to_thread(
            self._generate, messages, stop, run_manager, **kwargs,
        )


def _model_payload(
    model: SyntheticBudgetModel,
    messages: list[dict[str, Any]],
    settings: dict[str, Any],
) -> dict[str, Any]:
    payload = {
        "model": model.model_name,
        "messages": copy.deepcopy(messages),
        "max_tokens": model.max_tokens,
        **copy.deepcopy(model.model_kwargs),
        **copy.deepcopy(settings),
    }
    payload.update(payload.pop("extra_body", model.extra_body or {}))
    return payload


class SyntheticModelCounter:
    """只计量同一已声明协议模型，包含其构造默认参数与最终出站 framing。"""

    def __init__(self, model: SyntheticBudgetModel) -> None:
        if not isinstance(model, SyntheticBudgetModel):
            raise TypeError("未声明合成协议的模型不能使用该计量配置。")
        self._model = model
        self.seen_payloads: list[dict[str, Any]] = []

    def is_bound_to(self, model: object) -> bool:
        return model is self._model

    def measure(self, request: InputBudgetRequest) -> InputTokenMeasurement:
        if request.model_id != self._model.model_name:
            raise ValueError("合成模型与预算配置不一致。")
        messages = [dict(item) for item in request.messages]
        if request.system_message is not None:
            messages.insert(0, dict(request.system_message))
        settings = {"tools": list(request.tool_schemas), **request.model_settings}
        if request.response_schema is not None:
            settings["response_format"] = dict(request.response_schema)
        payload = _model_payload(self._model, messages, settings)
        self.seen_payloads.append(copy.deepcopy(payload))
        input_tokens = len(json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"),
        )) + 17
        return InputTokenMeasurement(
            model_id=self._model.model_name,
            input_tokens=input_tokens,
            kind=TokenMeasurementKind.EXACT,
            measurement_id=SYNTHETIC_MEASUREMENT_ID,
            covered_components=frozenset(InputComponent),
        )


def synthetic_budget_kwargs(
    model: SyntheticBudgetModel,
    *, capacity: int = 100000,
    output_reserve: int = 4096,
) -> dict[str, Any]:
    """构造明确测试能力配置；调用方须在正式装配时显式传入。"""

    counter = SyntheticModelCounter(model)
    return {
        "input_budget_profile": InputBudgetProfile(
            model_id=model.model_name,
            context_window_tokens=capacity,
            output_reserve_tokens=output_reserve,
            warning_ratio=0.8,
            measurement_kind=TokenMeasurementKind.EXACT,
            measurement_id=SYNTHETIC_MEASUREMENT_ID,
        ),
        "input_token_counter": counter,
    }
