"""后端事件到 SSE 帧的传输编码。"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from notalone.server.event_models import (
    BackendEvent,
    MessageCreatedPayload,
    SyncStatusPayload,
    TaskProgressPayload,
)


def encode_sse_frame(event: BackendEvent) -> bytes:
    """把领域事件编码为界面侧稳定解析的 SSE 帧。"""

    body = json.dumps(
        event_payload(event), ensure_ascii=False, separators=(",", ":")
    )
    return (
        f"id: {event.event_id}\n"
        f"event: {event.event_type.value}\n"
        f"data: {body}\n\n"
    ).encode("utf-8")


def event_payload(event: BackendEvent) -> dict[str, object]:
    return {
        "id": str(event.event_id),
        "type": event.event_type.value,
        "owner_id": str(event.scope.owner_id),
        "contact_id": str(event.scope.contact_id),
        "occurred_at": _format_timestamp(event.occurred_at),
        "payload": _payload_data(event),
    }


def _payload_data(event: BackendEvent) -> dict[str, object]:
    payload = event.payload
    if isinstance(payload, MessageCreatedPayload):
        return {"message_id": str(payload.message_id)}
    if isinstance(payload, SyncStatusPayload):
        return {
            "phase": payload.phase,
            "sync_enabled": payload.sync_enabled,
            "failure_code": payload.failure_code,
        }
    if isinstance(payload, TaskProgressPayload):
        return {
            "task_id": str(payload.task_id),
            "step": payload.step,
            "status": payload.status,
            "processed_count": payload.processed_count,
            "attempt_count": payload.attempt_count,
            "retry_count": payload.retry_count,
            "error_code": payload.error_code,
            "failure_state_commit": payload.failure_state_commit,
        }
    raise TypeError("不支持的事件 payload。")


def _format_timestamp(value: datetime) -> str:
    """转为秒级 UTC ISO8601；None 返回空串（调用方决定是否输出字段）。"""

    if value is None:
        return ""
    utc_value = value.astimezone(timezone.utc)
    return utc_value.isoformat(timespec="seconds").replace("+00:00", "Z")
