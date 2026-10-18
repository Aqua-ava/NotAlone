"""捕获 SDK 最终 HTTP 正文；追踪故障直接越过 SDK 自动重试。"""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Callable
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterator
from uuid import uuid4

import httpx

from notalone.memory_trace.context import (
    CallObservation,
    current_trace,
    snapshot,
    record_ledger_entry,
)
from notalone.ledger.models import LedgerEntry, LedgerOutcome
from notalone.memory_trace.ports import TraceWriteError


class _TraceTransportAbort(BaseException):
    """仅在 SDK 内穿过宽泛 Exception/重试捕获；在模型边界转回公开错误。"""


class Proof3JSONGuardError(BaseException):
    """仅在同次 proof3 边界越过 SDK 重试，回到适配器转为协议失败。"""


@dataclass
class _Proof3JSONState:
    requests: int = 0
    responses: int = 0


_proof3_json_state: ContextVar[_Proof3JSONState | None] = ContextVar("proof3_json_state", default=None)


@contextmanager
def proof3_json_guard() -> Iterator[None]:
    """仅显式同次 V 启用；未经过实际 HTTP hooks 不得认证交付。"""
    state = _Proof3JSONState()
    token = _proof3_json_state.set(state)
    try:
        yield
        if state.requests != 1 or state.responses != 1:
            raise Proof3JSONGuardError("proof3_raw_json_guard_not_delivered")
    finally:
        _proof3_json_state.reset(token)


def _proof3_json(content: bytes | str) -> Any:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("重复JSON键。")
            result[key] = value
        return result
    def invalid_number(_: str) -> None:
        raise ValueError("非有限JSON数值。")
    try:
        value = json.loads(content, object_pairs_hook=unique, parse_constant=invalid_number)
        json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
        return value
    except (ValueError, TypeError, UnicodeError):
        raise Proof3JSONGuardError("proof3_raw_json_invalid") from None


def _proof3_request(request: httpx.Request) -> None:
    state = _proof3_json_state.get()
    if state is None:
        return
    state.requests += 1
    if state.requests != 1:
        raise Proof3JSONGuardError("proof3_retry_forbidden")
    value = _proof3_json(request.read())
    try:
        tools = value["tools"]
        if len(tools) != 1 or tools[0]["function"]["name"] != "SourceVerificationOutput":
            raise ValueError
    except (KeyError, TypeError, ValueError, IndexError):
        raise Proof3JSONGuardError("proof3_single_verification_tool_required") from None


def _proof3_response(response: httpx.Response) -> None:
    state = _proof3_json_state.get()
    if state is None:
        return
    value = _proof3_json(response.read())
    try:
        choices = value["choices"]
        if state.requests != 1 or state.responses or len(choices) != 1 or type(choices[0]["index"]) is not int or choices[0]["index"] != 0:
            raise ValueError
        calls = choices[0]["message"]["tool_calls"]
        if len(calls) != 1 or calls[0]["type"] != "function" or calls[0]["function"]["name"] != "SourceVerificationOutput":
            raise ValueError
        arguments = calls[0]["function"]["arguments"]
        if type(arguments) is not str:
            raise ValueError
        _proof3_json(arguments)
    except (KeyError, TypeError, ValueError, IndexError):
        raise Proof3JSONGuardError("proof3_single_verification_response_required") from None
    state.responses += 1


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
    from notalone.experiments.problem_budget import reserve_problem_attempt
    reserve_problem_attempt(request=request)
    _proof3_request(request)
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
        _proof3_response(response)
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
    # 格式损坏也须先可靠保存实际返回；追踪失败不能被协议错误掩盖。
    _proof3_response(response)


def build_trace_http_client(
    *, transport: httpx.BaseTransport | None = None
) -> httpx.Client:
    """生产 HTTP hooks；测试可显式注入完全本地的合成 HTTP transport。"""
    return httpx.Client(
        transport=transport,
        event_hooks={"request": [_request_hook], "response": [_response_hook]},
    )


def record_model_retry(purpose: str, *, outcome: LedgerOutcome) -> None:
    """下一次尝试前结算本次实际出站，不让最终成功覆盖早先请求。"""
    trace = current_trace()
    if trace is None or trace.ledger is None or not trace.call_was_invoked(purpose):
        return
    call = trace.observations[trace.calls[purpose]]
    if call.ledger_entry is not None:
        return
    finished = call.finished_at or datetime.now(timezone.utc)
    entry = LedgerEntry(
        entry_id=uuid4(), owner_id=trace.scope.owner_id, contact_id=trace.scope.contact_id,
        provider=trace.provider, model_name=trace.model_name, input_tokens=None, output_tokens=None,
        latency_ms=max(0, int((finished - call.called_at).total_seconds() * 1000)),
        outcome=outcome, called_at=call.called_at,
    )
    record_ledger_entry(purpose, trace.ledger, entry, started_at=finished)
    trace.discard_call(purpose)


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
