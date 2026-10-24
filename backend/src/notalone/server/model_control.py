"""启动时选择唯一模型仲裁；TS验收模式缺共享配置时不能回落本地。"""
from __future__ import annotations

import os
from pathlib import Path
from collections.abc import Mapping
from uuid import UUID

from notalone.application.model_priority import ModelPriorityControl
from notalone.application.model_permit_client import SharedModelPriorityControl


def build_model_priority_control(*, background_limit: int,
                                 environment: Mapping[str, str] | None = None) -> ModelPriorityControl:
    values = os.environ if environment is None else environment
    mode = values.get("NOTALONE_REPLY_RUNTIME", "python")
    if mode not in ("python", "typescript"):
        raise ValueError("reply_runtime_invalid")
    path = values.get("NOTALONE_MODEL_PERMIT_SOCKET")
    token = values.get("NOTALONE_MODEL_PERMIT_TOKEN")
    if mode == "python":
        if path is not None or token is not None:
            raise ValueError("model_runtime_ownership_conflict")
        return ModelPriorityControl(background_limit=background_limit)
    if (values.get("NOTALONE_TS_HOST") != "1" or not path or not Path(path).is_absolute()
            or any(char in path for char in "\0\r\n") or not token or len(token) < 32
            or any(ord(char) < 33 or ord(char) > 126 for char in token)):
        raise ValueError("model_runtime_shared_configuration_invalid")
    return SharedModelPriorityControl(socket_path=path, token=token, background_limit=background_limit)


def model_work_available(*, control: ModelPriorityControl, owner_id: UUID | None,
                         environment: Mapping[str, str] | None = None) -> bool:
    """只接受宿主已确认的缺key/owner；配置齐全仍走原08严格装配。"""
    values = os.environ if environment is None else environment
    mode = values.get('NOTALONE_REPLY_RUNTIME', 'python')
    reason = values.get('NOTALONE_MODEL_UNCONFIGURED_REASON', '')
    if mode == 'python':
        if reason:
            raise ValueError('model_runtime_ownership_conflict')
        return True
    if (mode != 'typescript' or values.get('NOTALONE_TS_HOST') != '1'
            or not isinstance(control, SharedModelPriorityControl)):
        raise ValueError('model_runtime_shared_configuration_invalid')
    if not reason:
        if owner_id is None:
            raise ValueError('model_runtime_shared_configuration_invalid')
        return True
    if reason == 'reply_model_unconfigured':
        key = values.get('NOTALONE_DEEPSEEK_API_KEY')
        if key is not None and key.strip():
            raise ValueError('model_runtime_readiness_conflict')
    elif reason == 'reply_owner_unconfigured':
        if owner_id is not None:
            raise ValueError('model_runtime_readiness_conflict')
    else:
        raise ValueError('model_runtime_readiness_invalid')
    return False
