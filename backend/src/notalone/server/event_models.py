"""本地后端向界面发布的事件模型。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import UUID, uuid4

from notalone.scopes import ContactScope


class EventType(StrEnum):
    """界面可消费的稳定事件类型。"""

    MESSAGE_CREATED = "message.created"
    SYNC_STATUS_CHANGED = "sync.status_changed"
    TASK_PROGRESS = "task.progress"


@dataclass(frozen=True, slots=True)
class MessageCreatedPayload:
    message_id: UUID

    def __post_init__(self) -> None:
        if not isinstance(self.message_id, UUID):
            raise TypeError("message_id 必须是 UUID。")


@dataclass(frozen=True, slots=True)
class SyncStatusPayload:
    phase: str
    sync_enabled: bool
    failure_code: str | None

    def __post_init__(self) -> None:
        if not isinstance(self.phase, str) or not self.phase.strip():
            raise ValueError("phase 不能为空。")
        if not isinstance(self.sync_enabled, bool):
            raise TypeError("sync_enabled 必须是 bool。")
        if self.failure_code is not None and (
            not isinstance(self.failure_code, str)
            or not self.failure_code.strip()
        ):
            raise ValueError("failure_code 必须是非空字符串或 None。")


@dataclass(frozen=True, slots=True)
class TaskProgressPayload:
    task_id: UUID
    step: str
    status: str
    processed_count: int
    attempt_count: int
    retry_count: int
    error_code: str | None = None
    failure_state_commit: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.task_id, UUID):
            raise TypeError("task_id 必须是 UUID。")
        if not isinstance(self.step, str) or not self.step.strip():
            raise ValueError("step 不能为空。")
        if not isinstance(self.status, str) or not self.status.strip():
            raise ValueError("status 不能为空。")
        if self.error_code is not None and (
            not isinstance(self.error_code, str) or not self.error_code.strip()
        ):
            raise ValueError("error_code 必须是非空字符串或 None。")
        if self.failure_state_commit not in {None, "committed", "unknown"}:
            raise ValueError(
                "failure_state_commit 必须是已提交、未知或 None。"
            )
        for name, value in (
            ("processed_count", self.processed_count),
            ("attempt_count", self.attempt_count),
            ("retry_count", self.retry_count),
        ):
            if (
                isinstance(value, bool)
                or not isinstance(value, int)
                or value < 0
            ):
                raise ValueError(f"{name} 必须是非负整数。")


EventPayload = MessageCreatedPayload | SyncStatusPayload | TaskProgressPayload


@dataclass(frozen=True, slots=True)
class BackendEvent:
    """不含消息正文的联系人范围事件。"""

    event_id: UUID
    event_type: EventType
    scope: ContactScope
    occurred_at: datetime
    payload: EventPayload

    def __post_init__(self) -> None:
        if not isinstance(self.event_id, UUID):
            raise TypeError("event_id 必须是 UUID。")
        if not isinstance(self.event_type, EventType):
            raise TypeError("event_type 无效。")
        if not isinstance(self.scope, ContactScope):
            raise TypeError("事件必须携带 ContactScope。")
        if not isinstance(self.occurred_at, datetime):
            raise TypeError("occurred_at 必须是 datetime。")
        if self.occurred_at.tzinfo is None:
            raise ValueError("occurred_at 必须包含时区。")
        expected_payload = {
            EventType.MESSAGE_CREATED: MessageCreatedPayload,
            EventType.SYNC_STATUS_CHANGED: SyncStatusPayload,
            EventType.TASK_PROGRESS: TaskProgressPayload,
        }[self.event_type]
        if not isinstance(self.payload, expected_payload):
            raise TypeError("事件类型与 payload 不匹配。")

    @classmethod
    def message_created(
        cls,
        *,
        scope: ContactScope,
        occurred_at: datetime,
        message_id: UUID,
        event_id: UUID | None = None,
    ) -> "BackendEvent":
        return cls(
            event_id=event_id or uuid4(),
            event_type=EventType.MESSAGE_CREATED,
            scope=scope,
            occurred_at=occurred_at,
            payload=MessageCreatedPayload(message_id=message_id),
        )

    @classmethod
    def sync_status_changed(
        cls,
        *,
        scope: ContactScope,
        occurred_at: datetime,
        phase: str,
        sync_enabled: bool,
        failure_code: str | None,
        event_id: UUID | None = None,
    ) -> "BackendEvent":
        return cls(
            event_id=event_id or uuid4(),
            event_type=EventType.SYNC_STATUS_CHANGED,
            scope=scope,
            occurred_at=occurred_at,
            payload=SyncStatusPayload(
                phase=phase,
                sync_enabled=sync_enabled,
                failure_code=failure_code,
            ),
        )

    @classmethod
    def task_progress(
        cls,
        *,
        scope: ContactScope,
        occurred_at: datetime,
        task_id: UUID,
        step: str,
        status: str,
        processed_count: int,
        attempt_count: int,
        retry_count: int,
        event_id: UUID | None = None,
        error_code: str | None = None,
        failure_state_commit: str | None = None,
    ) -> "BackendEvent":
        return cls(
            event_id=event_id or uuid4(),
            event_type=EventType.TASK_PROGRESS,
            scope=scope,
            occurred_at=occurred_at,
            payload=TaskProgressPayload(
                task_id=task_id,
                step=step,
                status=status,
                processed_count=processed_count,
                attempt_count=attempt_count,
                retry_count=retry_count,
                error_code=error_code,
                failure_state_commit=failure_state_commit,
            ),
        )
