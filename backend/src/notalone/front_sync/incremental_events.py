"""迁移期接收已提交的无正文通知；不读取CLI、不写消息或游标。"""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID
from time import monotonic

import psycopg

from notalone.front_sync.event_publisher import MessageEventPublisher
from notalone.scopes import ContactScope


class IncrementalEventUnavailable(RuntimeError):
    """数据库不可用或整批通知已超过预算。"""

    def __init__(self) -> None:
        super().__init__("incremental_event_unavailable")


def _remaining_milliseconds(deadline: float) -> int:
    remaining = int((deadline - monotonic()) * 1000)
    if remaining <= 0:
        raise IncrementalEventUnavailable()
    return remaining


class IncrementalEventReceiver:
    def __init__(self, *, database_url: str, owner_id: UUID,
                 publisher: MessageEventPublisher) -> None:
        self._database_url = database_url
        self._owner_id = owner_id
        self._publisher = publisher

    def receive(self, payload: object) -> int:
        if not isinstance(payload, dict) or set(payload) != {"events"}:
            raise ValueError("incremental_event_invalid")
        events = payload["events"]
        if not isinstance(events, list) or not 1 <= len(events) <= 1000:
            raise ValueError("incremental_event_invalid")
        parsed: list[tuple[UUID, UUID, datetime]] = []
        seen: set[UUID] = set()
        for event in events:
            if not isinstance(event, dict) or set(event) != {
                "owner_id", "contact_id", "message_id", "occurred_at"
            }:
                raise ValueError("incremental_event_invalid")
            try:
                owner = UUID(event["owner_id"])
                contact = UUID(event["contact_id"])
                message = UUID(event["message_id"])
                at = datetime.fromisoformat(event["occurred_at"])
            except (TypeError, ValueError, AttributeError):
                raise ValueError("incremental_event_invalid") from None
            if owner != self._owner_id or at.tzinfo is None or message in seen:
                raise ValueError("incremental_event_invalid")
            seen.add(message)
            parsed.append((contact, message, at.astimezone(timezone.utc)))
        valid: list[tuple[UUID, UUID, datetime]] = []
        # 通知是可丢弃的投影；提取意图已经由TS与消息原子持久化。
        # 删除或撤销后的晚通知直接忽略，不恢复来源或队列授权。
        deadline = monotonic() + 3.0
        try:
            with psycopg.connect(self._database_url, connect_timeout=2) as connection:
                for contact, message, at in parsed:
                    remaining = _remaining_milliseconds(deadline)
                    connection.execute("SELECT set_config('statement_timeout', %s, true)",
                                       (str(remaining),))
                    row = connection.execute(
                        """
                        SELECT m.occurred_at FROM public.message m
                        WHERE m.owner_id=%s AND m.contact_id=%s AND m.id=%s
                          AND EXISTS (
                            SELECT 1 FROM public.message_source_ref r
                            JOIN public.local_wechat_observation o
                              ON o.id=r.observation_id AND o.owner_id=r.owner_id
                             AND o.contact_id=r.contact_id
                            JOIN public.conversation_binding b
                              ON b.id=o.binding_id AND b.owner_id=o.owner_id
                             AND b.contact_id=o.contact_id
                            JOIN public.front_sync_state f ON f.owner_id=b.owner_id
                            WHERE r.message_id=m.id AND r.owner_id=m.owner_id
                              AND r.contact_id=m.contact_id AND b.status='active'
                              AND f.enabled AND b.channel='wechat'
                              AND o.is_reliable
                              AND o.conversation_locator=b.conversation_locator
                              AND r.source_kind='local_wechat_observation'
                              AND EXISTS (SELECT 1 FROM public.owner_channel_identity i
                                WHERE i.owner_id=b.owner_id AND i.channel=b.channel
                                  AND i.external_id=b.account_scope AND i.status='active')
                          )
                        """, (self._owner_id, contact, message),
                    ).fetchone()
                    _remaining_milliseconds(deadline)
                    if row is not None:
                        valid.append((contact, message, row[0] or at))
        except psycopg.Error:
            raise IncrementalEventUnavailable() from None
        for contact, message, at in valid:
            _remaining_milliseconds(deadline)
            self._publisher.publish_message_created(
                scope=ContactScope(self._owner_id, contact),
                occurred_at=at, message_id=message,
            )
        return len(valid)
