"""把前台同步的消息事件端口适配到后端内存事件总线。

服务壳层依赖应用层端口（``front_sync.event_publisher``），而不是
反向：这里只做事件形态转换，不包含任何同步编排逻辑。
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from notalone.front_sync.event_publisher import MessageEventPublisher
from notalone.scopes import ContactScope
from notalone.server.event_bus import EventBus
from notalone.server.event_models import BackendEvent


class EventBusMessagePublisher:
    """把前台同步事件端口适配到后端内存事件总线。"""

    def __init__(self, events: EventBus) -> None:
        self._events = events

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


__all__ = ["EventBusMessagePublisher", "MessageEventPublisher"]