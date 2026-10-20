"""慢订阅的容量、断连和重连状态契约。"""

import unittest
from datetime import datetime, timezone
from uuid import UUID

from notalone.scopes import ContactScope
from notalone.server.event_bus import EventBus
from notalone.server.event_models import BackendEvent


SCOPE = ContactScope(UUID(int=1), UUID(int=2))
NOW = datetime(2026, 10, 21, tzinfo=timezone.utc)


class EventBackpressureTest(unittest.TestCase):
    def test_overflow_disconnects_slow_subscriber_without_blocking_fast_one(self) -> None:
        bus = EventBus()
        self.addCleanup(bus.close)
        slow = bus.subscribe(owner_id=SCOPE.owner_id)
        fast = bus.subscribe(owner_id=SCOPE.owner_id)
        for index in range(1000):
            event = BackendEvent.message_created(
                scope=SCOPE, occurred_at=NOW, message_id=UUID(int=index + 3))
            bus.publish(event)
            self.assertIs(fast.read(timeout=0), event)
        self.assertTrue(slow.closed)
        self.assertIsNone(slow.read(timeout=0))
        self.assertFalse(fast.closed)
        reconnected = bus.subscribe(owner_id=SCOPE.owner_id)
        self.assertIsNone(reconnected.read(timeout=0))

    def test_reconnect_preserves_each_task_latest_state_and_publish_order(self) -> None:
        bus = EventBus()
        self.addCleanup(bus.close)
        expected = []
        for index in range(300):
            for status in ("running", "failed"):
                event = BackendEvent.task_progress(
                    scope=SCOPE, occurred_at=NOW, task_id=UUID(int=index + 3),
                    step="extract_memory", status=status, processed_count=index,
                    attempt_count=1, retry_count=0,
                    error_code="synthetic_failure" if status == "failed" else None)
                bus.publish(event)
            expected.append(event)
        other = ContactScope(UUID(int=4), SCOPE.contact_id)
        bus.publish(BackendEvent.sync_status_changed(
            scope=other, occurred_at=NOW, phase="active", sync_enabled=True, failure_code=None))
        stream = bus.subscribe(owner_id=SCOPE.owner_id, last_event_id=expected[0].event_id)
        live = BackendEvent.message_created(scope=SCOPE, occurred_at=NOW, message_id=UUID(int=500))
        bus.publish(live)
        self.assertEqual([stream.read(timeout=0) for _ in expected], expected)
        self.assertIs(stream.read(timeout=0), live)
        self.assertFalse(stream.closed)

    def test_close_releases_backlog_and_wakes_blocked_reader(self) -> None:
        import threading

        bus = EventBus()
        stream = bus.subscribe(owner_id=SCOPE.owner_id)
        result = []
        reader = threading.Thread(target=lambda: result.append(stream.read()), daemon=True)
        reader.start()
        bus.close()
        reader.join(timeout=1)
        self.assertFalse(reader.is_alive())
        self.assertEqual(result, [None])
        self.assertTrue(stream.closed)

