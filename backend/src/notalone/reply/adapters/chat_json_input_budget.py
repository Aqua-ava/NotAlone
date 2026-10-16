"""已批准文字 Chat 请求的完整 JSON 估算；只处理调用前的内存数据。"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping

from langchain_deepseek import ChatDeepSeek

from notalone.reply.input_budget import (
    InputBudgetProfile, InputBudgetRequest, InputComponent, InputTokenMeasurement,
    TokenMeasurementKind,
)


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
            raise ValueError("文字估算不能接收未支持的消息扩展。")
        content = message.get("content")
        if content is None or isinstance(content, str):
            continue
        if not isinstance(content, list) or any(
            not isinstance(block, Mapping) or block.get("type") != "text"
            or not isinstance(block.get("text"), str)
            for block in content
        ):
            raise ValueError("输入估算仅支持文字消息。")


def _configuration(model: ChatDeepSeek, profile: InputBudgetProfile, base_url: str) -> tuple[object, ...]:
    """绑定实例的实际 SDK 接收地址与有效默认参数，避免同名模型错配。"""

    if type(model) is not ChatDeepSeek or model.model_name != profile.model_id:
        raise ValueError("输入估算仅支持已批准的模型适配器。")
    if (
        model.use_responses_api or model.streaming
        or (model.api_base is not None and str(model.api_base).rstrip("/") != base_url)
    ):
        raise ValueError("输入估算的配置接收地址不匹配。")
    roots = (model.root_client, model.root_async_client)
    endpoints = (model.client, model.async_client)
    if any(str(root.base_url).rstrip("/") != base_url for root in roots):
        raise ValueError("输入估算的实际 SDK 接收地址不匹配。")
    if any(endpoint._client is not root for endpoint, root in zip(endpoints, roots)):
        raise ValueError("输入估算未绑定实际 SDK 客户端。")
    # 只读 SDK 的请求默认字段；不使用 model_dump，避免把 API 凭据纳入计量。
    defaults = model._get_request_payload([])
    if not isinstance(defaults, Mapping) or set(defaults) - _REQUEST_FIELDS:
        raise ValueError("SDK 请求字段尚未纳入输入估算。")
    digest = hashlib.sha256(_json_bytes(defaults)).digest()
    return (*map(id, roots), *map(id, endpoints), digest)


class ChatJsonInputTokenCounter:
    """完整出站 JSON 的 UTF-8 字节估算；不是供应商 token 精度或上界。"""

    def __init__(self, model: ChatDeepSeek, *, profile: InputBudgetProfile, base_url: str) -> None:
        self._profile = profile
        self._base_url = base_url
        self._configuration = _configuration(model, profile, base_url)
        self._model = model

    def is_bound_to(self, model: object) -> bool:
        if model is not self._model:
            return False
        try:
            return _configuration(self._model, self._profile, self._base_url) == self._configuration
        except (TypeError, ValueError, AttributeError):
            return False

    def measure(self, request: InputBudgetRequest) -> InputTokenMeasurement:
        profile = self._profile
        if not self.is_bound_to(self._model) or request.model_id != profile.model_id:
            raise ValueError("输入估算的模型或配置已失效。")
        settings = dict(request.model_settings)
        reserve = profile.output_reserve_tokens
        if (
            set(settings) - (_REQUEST_FIELDS - {"model", "messages", "tools", "response_format"})
            or request.output_token_limit != reserve
            or any(settings.get(key, reserve) != reserve
                   for key in ("max_tokens", "max_completion_tokens", "max_output_tokens"))
        ):
            raise ValueError("输入估算的有效请求设置不匹配。")
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
            model_id=profile.model_id, input_tokens=len(_json_bytes(payload)) + _FRAMING_ESTIMATE,
            kind=TokenMeasurementKind.APPROXIMATE, measurement_id=profile.measurement_id,
            covered_components=frozenset(InputComponent),
        )
