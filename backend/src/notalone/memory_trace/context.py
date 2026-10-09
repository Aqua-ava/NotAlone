"""单次提取的记录上下文；只记录实际运行，不补造历史。"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from contextvars import ContextVar, Token
from dataclasses import dataclass, fields, is_dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal
from uuid import UUID, uuid4

from notalone.ledger.models import LedgerEntry, LedgerOutcome
from notalone.ledger.ports import OutboundLedgerPort
from notalone.memory_trace.ports import TracePort, TraceWriteError
from notalone.scopes import ContactScope


def message_input_links(
    messages: Iterable[dict[str, Any]],
) -> tuple[dict[str, Any], ...]:
    """按实际窗口次序构造无正文输入关联，保留原始标识类型。"""
    return tuple(
        {
            "record_kind": "message",
            "record_id": item["message_id"],
            "commit_status": "committed",
            "operation": "input",
        }
        for item in messages
    )


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


@dataclass
class CallObservation:
    """仅保留可观察调用事实；不缓存请求或响应正文。"""

    call_id: UUID
    purpose: str
    called_at: datetime
    finished_at: datetime | None = None
    invoked: bool = False
    response_status: str = "unavailable"
    provider_attempts: int = 0
    request_capture_failed: bool = False
    ledger_entry: LedgerEntry | None = None
    ledger_commit_status: str = "unknown"
    disposition: str = "consumed"

    def receipt(self) -> dict[str, Any]:
        assert self.ledger_entry is not None
        return snapshot(
            {
                "call_id": self.call_id,
                "purpose": self.purpose,
                "called_at": self.called_at,
                "finished_at": self.finished_at,
                "response_status": self.response_status,
                "provider_attempts": self.provider_attempts,
                "ledger_entry_id": self.ledger_entry.entry_id,
                "ledger_commit_status": self.ledger_commit_status,
                "disposition": self.disposition,
            }
        )


class TraceSession:
    """绑定单一联系人和批次，所有故障立即停止后续处理。"""

    def __init__(
        self,
        store: TracePort,
        scope: ContactScope,
        trace_id: UUID,
        *,
        versions: dict[str, str | int] | None = None,
        ledger: OutboundLedgerPort | None = None,
        provider: str = "deepseek",
        model_name: str | None = None,
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
        self.observations: dict[UUID, CallObservation] = {}
        self.ledger = ledger
        self.provider = provider
        self.model_name = model_name or "unreported"
        self.verification_candidate_ids: tuple[UUID, ...] = ()
        self.versions = versions or {}
        self._token: Token[TraceSession | None] | None = None

    def __enter__(self) -> TraceSession:
        self._token = _CURRENT.set(self)
        return self

    def __exit__(
        self, kind: Any, error: Any, traceback: Any
    ) -> Literal[False]:
        cleanup_failure = None
        if error is not None:
            cleanup_failure = self._account_unconsumed()
            error = cleanup_failure or error
            from notalone.application.model_priority import ModelWorkStopped
            from notalone.persistence.background_tasks import (
                BackgroundTaskLeaseError,
                BackgroundTaskNotFoundError,
                BackgroundTaskPersistenceError,
            )

            if isinstance(error, TraceWriteError):
                error_code = "trace_write_failed"
            elif isinstance(error, ModelWorkStopped):
                error_code = "model_work_stopped"
            elif isinstance(error, BackgroundTaskLeaseError):
                error_code = "background_task_lease_invalidated"
            elif isinstance(error, BackgroundTaskNotFoundError):
                error_code = "background_task_scope_invalidated"
            elif isinstance(error, BackgroundTaskPersistenceError):
                error_code = "background_task_guard_failed"
            else:
                error_code = "business_write_failed"
            try:
                self.store.mark_failed(
                    self.scope,
                    self.trace_id,
                    stage=self.stage,
                    error_code=error_code,
                )
            except Exception:
                pass
        if self._token is not None:
            _CURRENT.reset(self._token)
        if cleanup_failure is not None:
            raise cleanup_failure from None
        return False

    def _account_unconsumed(self) -> TraceWriteError | None:
        """独立故障／停止时补实际调用；正文删除后只写最小关联。"""
        if self.ledger is None:
            return None
        failure = None
        for call in self.observations.values():
            if not call.invoked or call.ledger_entry is not None:
                continue
            if (
                call.request_capture_failed
                and call.provider_attempts == 1
                and call.response_status == "unavailable"
            ):
                # 首个供应商请求 hook 在发送前失败，不能冒充实际外发。
                continue
            call.disposition = "not_adopted"
            finished = call.finished_at or datetime.now(timezone.utc)
            call.ledger_entry = LedgerEntry(
                entry_id=uuid4(),
                owner_id=self.scope.owner_id,
                contact_id=self.scope.contact_id,
                provider=self.provider,
                model_name=self.model_name,
                input_tokens=None,
                output_tokens=None,
                latency_ms=max(
                    0, int((finished - call.called_at).total_seconds() * 1000)
                ),
                outcome=LedgerOutcome.RUN_FAILED,
                called_at=call.called_at,
            )
            try:
                self.ledger.record(call.ledger_entry)
                call.ledger_commit_status = "committed"
            except Exception:
                # 回执未知不能重造另一个 ID 补账；也不掩盖原停止／追踪故障。
                pass
            try:
                self.store.record_call(
                    self.scope, self.trace_id, receipt=call.receipt()
                )
            except Exception:
                self.stage = "call_receipt"
                failure = TraceWriteError(self.stage, self.trace_id)
        return failure

    def reserve_ledger(self, purpose: str, entry: LedgerEntry) -> None:
        """台账 I/O 前保留同一 ID，回执丢失时不另造补账。"""
        call_id = self.calls.get(purpose)
        call = self.observations.get(call_id) if call_id is not None else None
        if call is not None:
            call.ledger_entry = entry
            call.ledger_commit_status = "unknown"

    def persist_ledger(self, purpose: str, *, committed: bool) -> None:
        call_id = self.calls.get(purpose)
        call = self.observations.get(call_id) if call_id is not None else None
        if call is not None:
            if committed:
                call.ledger_commit_status = "committed"
            try:
                self.store.record_call(
                    self.scope, self.trace_id, receipt=call.receipt()
                )
            except Exception:
                self.stage = "call_receipt"
                self.failure = TraceWriteError("call_receipt", self.trace_id)
                raise self.failure from None

    def link_ledger(self, purpose: str, entry: LedgerEntry) -> None:
        self.reserve_ledger(purpose, entry)
        self.persist_ledger(purpose, committed=True)

    def discard_call(self, purpose: str) -> None:
        """许可／来源复验丢弃已返回结果，已有台账只更新无正文关联。"""
        call_id = self.calls.get(purpose)
        call = self.observations.get(call_id) if call_id is not None else None
        if call is not None:
            call.disposition = "not_adopted"
            if call.ledger_entry is not None:
                self.persist_ledger(
                    purpose, committed=call.ledger_commit_status == "committed"
                )

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
        trace.link_ledger(purpose, entry)
        trace.record(
            "ledger_call",
            {"purpose": purpose, "entry": entry, "commit_status": "committed"},
            call_id=trace.calls.get(purpose),
            started_at=started_at,
            status="committed",
            rule_module="transport",
        )


def record_ledger_entry(
    purpose: str,
    ledger: OutboundLedgerPort,
    entry: LedgerEntry,
    *,
    started_at: datetime,
) -> None:
    """沿原台账写入一次；提交回执未知时只保存该 ID 的最小关联。"""
    trace = current_trace()
    if trace is not None:
        trace.reserve_ledger(purpose, entry)
    try:
        ledger.record(entry)
    except Exception:
        if trace is not None:
            trace.persist_ledger(purpose, committed=False)
        raise
    record_ledger_call(purpose, entry, started_at=started_at)
