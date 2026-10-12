"""已批准 ECNU 文字请求的完整 JSON 输入估算；不调用模型或保存正文。"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping

from langchain_deepseek import ChatDeepSeek

from notalone.reply.input_budget import (
    InputBudgetProfile, InputBudgetRequest, InputComponent, InputTokenMeasurement,
    TokenMeasurementKind,
)


ECNU_BASE_URL = "https://chat.ecnu.edu.cn/open/api/v1"
ECNU_MODEL = "ecnu-max"
ECNU_OUTPUT_RESERVE = 4096
ECNU_MEASUREMENT_ID = "ecnu-max-chat-json-utf8-framing-estimate-v1"
_FRAMING_ESTIMATE = 4096
_REQUEST_FIELDS = frozenset({
    "model", "messages", "tools", "response_format", "max_tokens",
    "max_completion_tokens", "max_output_tokens", "temperature", "top_p",
    "frequency_penalty", "presence_penalty", "seed", "stop", "stream",
    "stream_options", "parallel_tool_calls", "tool_choice", "n", "logprobs",
    "top_logprobs", "reasoning_effort",
})


def _json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _validate_text_messages(messages: list[Mapping[str, object]]) -> None:
    for message in messages:
        if set(message) - {"role", "content", "name", "tool_call_id", "tool_calls",
                           "reasoning_content", "refusal"}:
            raise ValueError("ECNU 文字估算不能接收未支持的消息扩展。")
        content = message.get("content")
        if content is None or isinstance(content, str):
            continue
        if not isinstance(content, list) or any(
            not isinstance(block, Mapping) or block.get("type") != "text"
            or not isinstance(block.get("text"), str)
            for block in content
        ):
            raise ValueError("ECNU 输入估算仅支持文字消息。")


def _configuration(model: ChatDeepSeek) -> tuple[object, ...]:
    """绑定实例的实际 SDK 接收地址与有效默认参数，避免同名模型错配。"""

    if type(model) is not ChatDeepSeek or model.model_name != ECNU_MODEL:
        raise ValueError("ECNU 输入估算仅支持已批准的模型适配器。")
    if (
        model.use_responses_api or model.streaming
        or str(model.api_base).rstrip("/") != ECNU_BASE_URL
    ):
        raise ValueError("ECNU 输入估算的配置接收地址不匹配。")
    roots = (model.root_client, model.root_async_client)
    endpoints = (model.client, model.async_client)
    if any(str(root.base_url).rstrip("/") != ECNU_BASE_URL for root in roots):
        raise ValueError("ECNU 输入估算的实际 SDK 接收地址不匹配。")
    if any(endpoint._client is not root for endpoint, root in zip(endpoints, roots)):
        raise ValueError("ECNU 输入估算未绑定实际 SDK 客户端。")
    # 只读 SDK 的请求默认字段；不使用 model_dump，避免把 API 凭据纳入计量。
    defaults = model._get_request_payload([])
    if not isinstance(defaults, Mapping) or set(defaults) - _REQUEST_FIELDS:
        raise ValueError("ECNU SDK 请求字段尚未纳入输入估算。")
    digest = hashlib.sha256(_json_bytes(defaults)).digest()
    return (*map(id, roots), *map(id, endpoints), digest)


class EcnuInputTokenCounter:
    """完整出站 JSON 的 UTF-8 字节估算；不是供应商 token 精度或上界。"""

    def __init__(self, model: ChatDeepSeek) -> None:
        self._configuration = _configuration(model)
        self._model = model

    def is_bound_to(self, model: object) -> bool:
        if model is not self._model:
            return False
        try:
            return _configuration(self._model) == self._configuration
        except (TypeError, ValueError, AttributeError):
            return False

    def measure(self, request: InputBudgetRequest) -> InputTokenMeasurement:
        if not self.is_bound_to(self._model) or request.model_id != ECNU_MODEL:
            raise ValueError("ECNU 输入估算的模型或配置已失效。")
        settings = dict(request.model_settings)
        if (
            set(settings) - (_REQUEST_FIELDS - {"model", "messages", "tools", "response_format"})
            or request.output_token_limit != ECNU_OUTPUT_RESERVE
            or any(settings.get(key, ECNU_OUTPUT_RESERVE) != ECNU_OUTPUT_RESERVE
                   for key in ("max_tokens", "max_completion_tokens", "max_output_tokens"))
        ):
            raise ValueError("ECNU 输入估算的有效请求设置不匹配。")
        messages = list(request.messages)
        if request.system_message is not None:
            messages.insert(0, request.system_message)
        _validate_text_messages(messages)
        payload = {**settings, "model": request.model_id, "messages": messages}
        if request.tool_schemas:
            payload["tools"] = list(request.tool_schemas)
        if request.response_schema is not None:
            payload["response_format"] = dict(request.response_schema)
        return InputTokenMeasurement(
            model_id=ECNU_MODEL, input_tokens=len(_json_bytes(payload)) + _FRAMING_ESTIMATE,
            kind=TokenMeasurementKind.APPROXIMATE, measurement_id=ECNU_MEASUREMENT_ID,
            covered_components=frozenset(InputComponent),
        )


def build_ecnu_input_budget(model: object) -> tuple[InputBudgetProfile, EcnuInputTokenCounter] | None:
    """只有已批准接收地址与模型才自动装配；其他配置保持能力未知。"""

    if not isinstance(model, ChatDeepSeek):
        return None
    try:
        counter = EcnuInputTokenCounter(model)
    except (TypeError, ValueError, AttributeError):
        return None
    return InputBudgetProfile(
        model_id=ECNU_MODEL, context_window_tokens=512000,
        output_reserve_tokens=ECNU_OUTPUT_RESERVE, warning_ratio=0.8,
        measurement_kind=TokenMeasurementKind.APPROXIMATE,
        measurement_id=ECNU_MEASUREMENT_ID, safety_margin_tokens=65536,
    ), counter
