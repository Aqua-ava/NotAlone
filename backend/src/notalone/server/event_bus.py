"""本地后端事件的进程内发布与订阅。"""

from __future__ import annotations

import queue
import threading
from collections.abc import Iterator
from typing import Callable
from uuid import UUID

from notalone.server.event_models import BackendEvent, EventType, TaskProgressPayload


_MAX_PENDING_EVENTS = 256


class EventSubscription:
    """一个订阅连接的阻塞读取队列。"""

    __slots__ = ("_close_callback", "_closed", "_lock", "_queue", "_snapshots")

    def __init__(
        self,
        close_callback: Callable[["EventSubscription"], None],
        snapshots: tuple[BackendEvent, ...] = (),
    ) -> None:
        self._queue: queue.Queue[BackendEvent | None] = queue.Queue(_MAX_PENDING_EVENTS)
        # 当前状态与实时积压分开读取；任务数超过容量也能完整重连。
        self._snapshots: Iterator[BackendEvent] = iter(snapshots)
        self._lock = threading.Lock()
        self._closed = False
        self._close_callback = close_callback

    @property
    def closed(self) -> bool:
        with self._lock:
            return self._closed

    def push(self, event: BackendEvent) -> None:
        with self._lock:
            if self._closed:
                return
            try:
                self._queue.put_nowait(event)
                return
            except queue.Full:
                # 通知不承载权威消息。溢出必须断连，让界面标记缺口并重读，
                # 不能静默丢 message.created 或把不同任务合成最后一个任务。
                self._finish()
        self._close_callback(self)

    def read(self, timeout: float | None = None) -> BackendEvent | None:
        with self._lock:
            snapshot = next(self._snapshots, None)
            if snapshot is not None:
                return snapshot
        if self.closed and self._queue.empty():
            return None
        try:
            return self._queue.get(timeout=timeout)
        except queue.Empty:
            return None

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._finish()
        self._close_callback(self)

    def _finish(self) -> None:
        self._closed = True
        self._snapshots = iter(())
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break
        self._queue.put_nowait(None)


class EventBus:
    """按 owner 隔离事件，并保留每类事件的最新状态用于重连。"""

    __slots__ = ("_closed", "_lock", "_subscriptions", "_latest", "_sequence")

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._closed = False
        self._subscriptions: dict[UUID, set[EventSubscription]] = {}
        self._latest: dict[tuple[UUID, UUID, EventType, UUID | None], tuple[int, BackendEvent]] = {}
        self._sequence = 0

    def publish(self, event: BackendEvent) -> None:
        with self._lock:
            if self._closed:
                return
            self._sequence += 1
            if event.event_type is not EventType.MESSAGE_CREATED:
                self._latest[
                    (event.scope.owner_id, event.scope.contact_id, event.event_type,
                     event.payload.task_id if isinstance(event.payload, TaskProgressPayload) else None)
                ] = (self._sequence, event)
            for subscription in tuple(self._subscriptions.get(event.scope.owner_id, ())):
                subscription.push(event)

    def subscribe(
        self,
        *,
        owner_id: UUID,
        last_event_id: UUID | None = None,
    ) -> EventSubscription:
        # Last-Event-ID 只标识重连，不作为历史游标；重连始终发送当前状态。
        del last_event_id
        with self._lock:
            if self._closed:
                raise RuntimeError("事件总线已经关闭。")
            subscription = EventSubscription(
                lambda current: self._remove_subscription(
                    owner_id=owner_id,
                    subscription=current,
                ),
                snapshots=self._snapshots(owner_id=owner_id),
            )
            self._subscriptions.setdefault(owner_id, set()).add(subscription)
        return subscription

    def _remove_subscription(
        self,
        *,
        owner_id: UUID,
        subscription: EventSubscription,
    ) -> None:
        with self._lock:
            owner_subscriptions = self._subscriptions.get(owner_id)
            if owner_subscriptions is not None:
                owner_subscriptions.discard(subscription)
                if not owner_subscriptions:
                    self._subscriptions.pop(owner_id, None)

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            subscriptions = tuple(
                subscription
                for owner_subscriptions in self._subscriptions.values()
                for subscription in owner_subscriptions
            )
            self._subscriptions.clear()
            self._latest.clear()
        for subscription in subscriptions:
            subscription.close()

    def _snapshots(self, *, owner_id: UUID) -> tuple[BackendEvent, ...]:
        latest = [
            (sequence, event)
            for (event_owner, _, _, _), (sequence, event) in self._latest.items()
            if event_owner == owner_id
        ]
        return tuple(event for _, event in sorted(latest, key=lambda item: item[0]))
