"""把前台同步的消息事件端口适配到后端内存事件总线。

服务壳层依赖应用层端口（``front_sync.event_publisher``），而不是
反向：转换事件形态，并将已提交消息通知交给应用层任务宿主。
"""

from __future__ import annotations

from datetime import datetime
from collections.abc import Callable
import logging
from uuid import UUID

from notalone.application.import_service import TaskHost
from notalone.front_sync.event_publisher import MessageEventPublisher
from notalone.scopes import ContactScope
from notalone.server.event_bus import EventBus
from notalone.server.event_models import BackendEvent


class EventBusMessagePublisher:
    """把前台同步事件端口适配到后端内存事件总线。"""

    def __init__(
        self, events: EventBus, *, owner_id: UUID | None = None,
        task_host: TaskHost | None = None,
        learning_notify: Callable[[ContactScope], None] | None = None,
    ) -> None:
        self._events = events
        self._owner_id = owner_id
        self._task_host = task_host
        self._learning_notify = learning_notify

    def publish_message_created(
        self,
        *,
        scope: ContactScope,
        occurred_at: datetime,
        message_id: UUID,
    ) -> None:
        self._events.publish(
            BackendEvent.message_created(
                scope=scope,
                occurred_at=occurred_at,
                message_id=message_id,
            )
        )
        if self._task_host is not None and scope.owner_id == self._owner_id:
            try:
                self._task_host.wake_observation(
                    owner_id=self._owner_id, contact_id=scope.contact_id,
                    message_id=message_id,
                )
            except Exception:
                # 消息与游标已经提交；调度故障不传播回同步读取流程。
                logging.getLogger(__name__).warning("observation_memory_schedule_failed")
        if self._learning_notify is not None and scope.owner_id == self._owner_id:
            try:
                self._learning_notify(scope)
            except Exception:
                logging.getLogger(__name__).warning('skill_learning_schedule_failed')


__all__ = ["EventBusMessagePublisher", "MessageEventPublisher"]
