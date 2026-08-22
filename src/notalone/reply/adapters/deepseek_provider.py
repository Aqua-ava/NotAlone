"""DeepSeek 模型的构造入口；凭据只经环境变量或显式参数提供。"""

from __future__ import annotations

import os
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_deepseek import ChatDeepSeek


DEFAULT_DEEPSEEK_MODEL = "deepseek-chat"
DEFAULT_DEEPSEEK_TIMEOUT_SECONDS = 60.0
_API_KEY_ENV_VAR = "NOTALONE_DEEPSEEK_API_KEY"
_MODEL_ENV_VAR = "NOTALONE_DEEPSEEK_MODEL"


def build_deepseek_model(
    *,
    api_key: str | None = None,
    model_name: str | None = None,
    timeout_seconds: float | None = None,
) -> BaseChatModel:
    """构造 DeepSeek 模型；默认模型只选支持结构化输出的 deepseek-chat。"""

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

    options: dict[str, Any] = {
        "model": resolved_model,
        "api_key": resolved_key,
        "timeout": float(resolved_timeout),
        "max_retries": 2,
    }
    return ChatDeepSeek(**options)
