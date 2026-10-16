"""DeepSeek 模型的构造入口；凭据只经环境变量或显式参数提供。"""

from __future__ import annotations

import os
from typing import Any

import httpx
from langchain_core.language_models import BaseChatModel
from langchain_deepseek import ChatDeepSeek

DEFAULT_DEEPSEEK_MODEL = "deepseek-flash"
DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com"
_OFFICIAL_BASE_URLS = frozenset({DEFAULT_DEEPSEEK_BASE_URL, DEFAULT_DEEPSEEK_BASE_URL + "/v1"})
DEFAULT_DEEPSEEK_TIMEOUT_SECONDS = 60.0
# 结构化输出场景使用最低温度，降低候选回复格式漂移概率。
DEFAULT_DEEPSEEK_TEMPERATURE = 0.0
_API_KEY_ENV_VAR = "NOTALONE_DEEPSEEK_API_KEY"
_MODEL_ENV_VAR = "NOTALONE_DEEPSEEK_MODEL"
_BASE_URL_ENV_VAR = "NOTALONE_DEEPSEEK_BASE_URL"


def is_official_deepseek_flash(model: object) -> bool:
    """只认精确 SDK 类型、Flash 模型名和已核实官方路由。"""

    return (
        type(model) is ChatDeepSeek
        and model.model_name == "deepseek-flash"
        and str(model.root_client.base_url).rstrip("/") in _OFFICIAL_BASE_URLS
    )


def build_deepseek_model(
    *,
    api_key: str | None = None,
    model_name: str | None = None,
    timeout_seconds: float | None = None,
    base_url: str | None = None,
    extra_body: dict[str, Any] | None = None,
    http_client: httpx.Client | None = None,
    http_async_client: httpx.AsyncClient | None = None,
) -> BaseChatModel:
    """构造 DeepSeek 模型；默认采用官方 Flash 的工具结构化输出。"""

    resolved_key = api_key if api_key is not None else os.environ.get(_API_KEY_ENV_VAR)
    if not isinstance(resolved_key, str) or not resolved_key.strip():
        raise ValueError(
            f"未配置 {_API_KEY_ENV_VAR}：接入真实模型前必须以环境变量提供"
            " DeepSeek 凭据，凭据不得写入仓库或命令行参数。"
        )

    resolved_model = (
        model_name
        if model_name is not None
        else (os.environ.get(_MODEL_ENV_VAR) or DEFAULT_DEEPSEEK_MODEL)
    )
    if not isinstance(resolved_model, str) or not resolved_model.strip():
        raise ValueError("DeepSeek 模型名不能为空。")

    resolved_timeout = (
        timeout_seconds
        if timeout_seconds is not None
        else DEFAULT_DEEPSEEK_TIMEOUT_SECONDS
    )
    if not isinstance(resolved_timeout, (int, float)) or resolved_timeout <= 0:
        raise ValueError("DeepSeek 调用超时必须是正数秒。")

    resolved_base_url = (
        base_url if base_url is not None else os.environ.get(_BASE_URL_ENV_VAR, DEFAULT_DEEPSEEK_BASE_URL)
    )
    if resolved_base_url is not None and (
        not isinstance(resolved_base_url, str) or not resolved_base_url.strip()
    ):
        raise ValueError("DeepSeek API 地址不能为空字符串。")

    if extra_body is not None and not isinstance(extra_body, dict):
        raise ValueError("extra_body 必须是字典或 None。")

    options: dict[str, Any] = {
        "model": resolved_model,
        "api_key": resolved_key,
        "timeout": float(resolved_timeout),
        "max_retries": 2,
        "temperature": DEFAULT_DEEPSEEK_TEMPERATURE,
    }
    if resolved_base_url is not None:
        options["base_url"] = resolved_base_url
    if extra_body is not None:
        options["extra_body"] = extra_body
    if http_client is not None:
        options["http_client"] = http_client
    if http_async_client is not None:
        options["http_async_client"] = http_async_client
    model = ChatDeepSeek(**options)
    if is_official_deepseek_flash(model) and not (
        extra_body and {"thinking", "reasoning_effort"} & extra_body.keys()
    ):
        # 官方默认思考模式拒绝强制输出 Tool；显式思考配置仍由调用者控制。
        model.reasoning_effort = "none"
    return model
