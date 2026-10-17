"""捕获 SDK 最终 HTTP 正文；追踪故障直接越过 SDK 自动重试。"""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import httpx

from notalone.memory_trace.context import (
    CallObservation,
    current_trace,
    snapshot,
)
from notalone.memory_trace.ports import TraceWriteError


class _TraceTransportAbort(BaseException):
    """仅在 SDK 内穿过宽泛 Exception/重试捕获；在模型边界转回公开错误。"""


def _body_snapshot(content: bytes) -> dict[str, Any]:
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        text = None
    try:
        parsed = json.loads(content)
    except (ValueError, UnicodeDecodeError):
        parsed = None
    return {
        "body_text": text,
        "body_base64": base64.b64encode(content).decode("ascii"),
        "parsed_body": parsed,
        "capture_layer": "sdk_http_body",
    }


def _request_hook(request: httpx.Request) -> None:
    trace = current_trace()
    if trace is None or trace.call_id is None:
        return
    try:
        trace.transport_attempt += 1
        call = trace.observations[trace.call_id]
        call.provider_attempts = trace.transport_attempt
        trace.record(
            "provider_request",
            {
                "attempt": trace.transport_attempt,
                "method": request.method,
                "endpoint": {
                    "scheme": request.url.scheme,
                    "host": request.url.host,
                    "port": request.url.port,
                    "path": request.url.path,
                },
                **_body_snapshot(request.read()),
            },
        )
    except TraceWriteError:
        call.request_capture_failed = True
        raise _TraceTransportAbort() from None


def _response_hook(response: httpx.Response) -> None:
    trace = current_trace()
    if trace is None or trace.call_id is None:
        return
    try:
        call = trace.observations[trace.call_id]
        call.response_status = "received"
        call.finished_at = datetime.now(timezone.utc)
        trace.record(
            "provider_response",
            {
                "attempt": trace.transport_attempt,
                "status_code": response.status_code,
                "request_id": response.headers.get("x-request-id"),
                "content_type": response.headers.get("content-type"),
                **_body_snapshot(response.read()),
            },
        )
    except TraceWriteError:
        raise _TraceTransportAbort() from None


def build_trace_http_client(
    *, transport: httpx.BaseTransport | None = None
) -> httpx.Client:
    """生产 HTTP hooks；测试可显式注入完全本地的合成 HTTP transport。"""
    return httpx.Client(
        transport=transport,
        event_hooks={"request": [_request_hook], "response": [_response_hook]},
    )


def invoke_traced_model(
    model: Any,
    *,
    purpose: str,
    schema: dict[str, Any],
    messages: list[dict[str, Any]],
    tool_options: dict[str, Any] | None = None,
    on_invoke: Callable[[], None] | None = None,
) -> Any:
    """原提示词与绑定方式保持不变，原始响应在解析之前可靠保存。"""
    options = tool_options or {}
    trace = current_trace()
    if trace is None:
        bound_model = model.bind_tools([schema], **options)
        if on_invoke is not None:
            on_invoke()
        return bound_model.invoke(messages)
    previous_call = trace.call_id
    trace.call_id = uuid4()
    trace.calls[purpose] = trace.call_id
    call = CallObservation(trace.call_id, purpose, datetime.now(timezone.utc))
    trace.observations[trace.call_id] = call
    trace.transport_attempt = 0
    parameters = {
        name: getattr(model, name)
        for name in (
            "model_name",
            "model",
            "temperature",
            "max_tokens",
            "max_retries",
            "request_timeout",
            "extra_body",
            "model_kwargs",
            "streaming",
            "disable_streaming",
        )
        if hasattr(model, name)
    }
    try:
        trace.record(
            "model_request",
            {
                "purpose": purpose,
                "candidate_trace_ids": (
                    trace.verification_candidate_ids
                    if purpose == "verification"
                    else (
                        (trace.candidate_trace_id,)
                        if trace.candidate_trace_id
                        else ()
                    )
                ),
                "messages": messages,
                "schema": schema,
                "tool_options": options,
                "model_parameters": parameters,
                "prompt_sha256": hashlib.sha256(
                    json.dumps(
                        messages, ensure_ascii=False, sort_keys=True
                    ).encode()
                ).hexdigest(),
                "schema_sha256": hashlib.sha256(
                    json.dumps(
                        schema, ensure_ascii=False, sort_keys=True
                    ).encode()
                ).hexdigest(),
                "capture_layer": "application_request",
            },
        )
        started_at = datetime.now(timezone.utc)
        try:
            bound_model = model.bind_tools([schema], **options)
            if on_invoke is not None:
                on_invoke()
            call.invoked = True
            message = bound_model.invoke(messages)
        except _TraceTransportAbort:
            raise trace.failure or TraceWriteError(
                "provider_transport", trace.trace_id
            ) from None
        except TraceWriteError:
            raise
        except Exception as error:
            call.finished_at = datetime.now(timezone.utc)
            trace.record(
                "model_failure",
                {
                    "purpose": purpose,
                    "error_code": type(error).__name__,
                    "response_status": "not_obtained_or_sdk_rejected",
                    "provider_capture": (
                        "recorded"
                        if trace.transport_attempt
                        else "not_observable"
                    ),
                },
                started_at=started_at,
                status="failed",
            )
            raise
        call.response_status = "returned"
        call.finished_at = datetime.now(timezone.utc)
        trace.record(
            "model_response",
            {
                "purpose": purpose,
                "raw": snapshot(message),
                "capture_layer": "model_adapter_response",
                "provider_capture": (
                    "recorded" if trace.transport_attempt else "not_observable"
                ),
            },
            started_at=started_at,
            status="returned",
        )
        return message
    finally:
        trace.call_id = previous_call
