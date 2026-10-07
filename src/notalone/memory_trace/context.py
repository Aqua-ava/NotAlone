"""单次提取的记录上下文；只记录实际运行，不补造历史。"""

from __future__ import annotations

import hashlib
import json
from contextvars import ContextVar, Token
from dataclasses import fields, is_dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal
from uuid import UUID

from notalone.memory_trace.ports import TracePort, TraceWriteError
from notalone.scopes import ContactScope


def snapshot(value: Any) -> Any:
    """生成独立 JSON 快照；调用者只传当前阶段允许保存的资料。"""
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    if is_dataclass(value) and not isinstance(value, type):
        return {
            field.name: snapshot(getattr(value, field.name))
            for field in fields(value)
        }
    if isinstance(value, dict):
        return {str(key): snapshot(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [snapshot(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return dump(mode="json")
    return {"capture_status": "unavailable", "type": type(value).__name__}


def event_payload(
    payload: Any,
    *,
    started_at: datetime | None = None,
    finished_at: datetime | None = None,
    rule_version: str = "trace-schema-v1",
    status: str = "recorded",
) -> dict[str, Any]:
    """实际处理起止由执行点提供，未提供时明确只测量快照捕获。"""
    capture_started = datetime.now(timezone.utc)
    value = snapshot(payload)
    capture_finished = datetime.now(timezone.utc)
    digest = hashlib.sha256(
        json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
    ).hexdigest()
    value["_execution"] = {
        "kind": "processing" if started_at is not None else "snapshot_capture",
        "started_at": snapshot(started_at or capture_started),
        "finished_at": snapshot(finished_at or capture_finished),
        "status": status,
        "rule_version": rule_version,
        "payload_sha256": digest,
    }
    return value


_CURRENT: ContextVar[TraceSession | None] = ContextVar(
    "memory_extraction_trace", default=None
)


def current_trace() -> TraceSession | None:
    return _CURRENT.get()


class TraceSession:
    """绑定单一联系人和批次，所有故障立即停止后续处理。"""

    def __init__(
        self,
        store: TracePort,
        scope: ContactScope,
        trace_id: UUID,
        *,
        versions: dict[str, str | int] | None = None,
    ) -> None:
        self.store = store
        self.scope = scope
        self.trace_id = trace_id
        self.stage = "begin"
        self.failure: TraceWriteError | None = None
        self.call_id: UUID | None = None
        self.candidate_trace_id: UUID | None = None
        self.transport_attempt = 0
        self.calls: dict[str, UUID] = {}
        self.verification_candidate_ids: tuple[UUID, ...] = ()
        self.versions = versions or {}
        self._token: Token[TraceSession | None] | None = None

    def __enter__(self) -> TraceSession:
        self._token = _CURRENT.set(self)
        return self

    def __exit__(
        self, kind: Any, error: Any, traceback: Any
    ) -> Literal[False]:
        if error is not None:
            try:
                self.store.mark_failed(
                    self.scope,
                    self.trace_id,
                    stage=self.stage,
                    error_code=(
                        "trace_write_failed"
                        if isinstance(error, TraceWriteError)
                        else "business_write_failed"
                    ),
                )
            except Exception:
                pass
        if self._token is not None:
            _CURRENT.reset(self._token)
        return False

    def record(
        self,
        stage: str,
        payload: Any,
        *,
        candidate_trace_id: UUID | None = None,
        call_id: UUID | None = None,
        links: tuple[dict[str, Any], ...] = (),
        dependency_ids: tuple[UUID, ...] = (),
        started_at: datetime | None = None,
        finished_at: datetime | None = None,
        status: str = "recorded",
        rule_module: str | None = None,
    ) -> None:
        self.stage = stage
        if self.failure is not None:
            raise self.failure
        try:
            module = rule_module or (
                "transport"
                if stage
                in {
                    "model_request",
                    "model_response",
                    "model_failure",
                    "provider_request",
                    "provider_response",
                }
                else (
                    "adoption"
                    if stage
                    in {
                        "memory_pool",
                        "prepare_for_adoption",
                        "deleted_fingerprint",
                        "duplicate",
                        "adoption_gates",
                        "similarity",
                        "adjudication_input",
                        "adjudication",
                        "adjudication_failure",
                        "write_plan",
                        "write_result",
                        "candidate_result",
                    }
                    else (
                        "pragmatics"
                        if stage == "pragmatics"
                        else (
                            "verification"
                            if stage == "verification_contract"
                            else "flow"
                        )
                    )
                )
            )
            self.store.append(
                self.scope,
                self.trace_id,
                stage=stage,
                payload=event_payload(
                    payload,
                    started_at=started_at,
                    finished_at=finished_at,
                    status=status,
                    rule_version=str(
                        self.versions.get(module, "trace-schema-v1")
                    ),
                ),
                candidate_trace_id=candidate_trace_id
                or self.candidate_trace_id,
                call_id=call_id or self.call_id,
                links=snapshot(links),
                dependency_ids=dependency_ids,
            )
        except Exception as error:
            self.failure = TraceWriteError(stage, self.trace_id)
            raise self.failure from None

    def complete(self, **kwargs: Any) -> None:
        self.stage = "batch_end"
        if self.failure is not None:
            raise self.failure
        try:
            self.store.complete(self.scope, self.trace_id, **kwargs)
        except Exception:
            self.failure = TraceWriteError(self.stage, self.trace_id)
            raise self.failure from None


def record(stage: str, payload: Any, **kwargs: Any) -> None:
    trace = current_trace()
    if trace is not None:
        trace.record(stage, payload, **kwargs)


def record_ledger_call(
    purpose: str, entry: Any, *, started_at: datetime
) -> None:
    """关联既有最小台账的实际标识，不把正文复制进台账。"""
    trace = current_trace()
    if trace is not None:
        trace.record(
            "ledger_call",
            {"purpose": purpose, "entry": entry, "commit_status": "committed"},
            call_id=trace.calls.get(purpose),
            started_at=started_at,
            status="committed",
            rule_module="transport",
        )
