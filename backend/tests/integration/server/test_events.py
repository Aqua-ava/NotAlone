"""事件总线与 SSE 的进程内契约测试。"""

from __future__ import annotations

import json
import threading
import unittest
import urllib.request
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import UUID

from notalone.scopes import ContactScope
from notalone.server.app import BackendServer, Response, create_app
from notalone.server.event_bus import EventSubscription
from notalone.server.event_models import BackendEvent, EventType
from notalone.server.testing import InProcessClient, InProcessSseStream


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
OTHER_OWNER_ID = UUID("22222222-2222-2222-2222-222222222222")
CONTACT_ID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
MESSAGE_ID = UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
TASK_ID = UUID("cccccccc-cccc-cccc-cccc-cccccccccccc")
OCCURRED_AT = datetime(2026, 8, 25, 1, 2, 3, tzinfo=timezone.utc)
SCOPE = ContactScope(owner_id=OWNER_ID, contact_id=CONTACT_ID)
OTHER_SCOPE = ContactScope(owner_id=OTHER_OWNER_ID, contact_id=CONTACT_ID)


class EventStreamContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=OWNER_ID,
            token="test-token",
        )
        self.client = InProcessClient(self.app)
        self.headers = {"Authorization": "Bearer test-token"}

    def test_event_subscription_requires_valid_token(self) -> None:
        missing = self.client.get("/api/events")
        wrong = self.client.get(
            "/api/events",
            headers={"Authorization": "Bearer wrong-secret"},
        )

        self.assertIsInstance(missing, Response)
        self.assertEqual(missing.status_code, 401)
        self.assertEqual(missing.json(), {"error": "unauthorized"})
        self.assertEqual(wrong.status_code, 401)
        self.assertEqual(wrong.json(), {"error": "unauthorized"})
        self.assertNotIn("wrong-secret", wrong.body.decode("utf-8"))

    def test_three_event_contracts_are_streamed_in_publish_order(self) -> None:
        stream = self._open_stream()
        events = (
            BackendEvent.message_created(
                event_id=UUID("10000000-0000-0000-0000-000000000001"),
                scope=SCOPE,
                occurred_at=OCCURRED_AT,
                message_id=MESSAGE_ID,
            ),
            BackendEvent.sync_status_changed(
                event_id=UUID("10000000-0000-0000-0000-000000000002"),
                scope=SCOPE,
                occurred_at=OCCURRED_AT,
                phase="active",
                sync_enabled=True,
                failure_code=None,
            ),
            BackendEvent.task_progress(
                event_id=UUID("10000000-0000-0000-0000-000000000003"),
                scope=SCOPE,
                occurred_at=OCCURRED_AT,
                task_id=TASK_ID,
                step="extract_memory",
                status="running",
                processed_count=12,
                attempt_count=2,
                retry_count=1,
            ),
        )

        for event in events:
            self.app.events.publish(event)

        frames = tuple(stream.read(timeout=0.1) for _ in events)
        stream.close()

        self.assertEqual(
            tuple(self._parse_frame(frame) for frame in frames),
            (
                (
                    str(events[0].event_id),
                    "message.created",
                    {
                        "id": str(events[0].event_id),
                        "type": "message.created",
                        "owner_id": str(OWNER_ID),
                        "contact_id": str(CONTACT_ID),
                        "occurred_at": "2026-08-25T01:02:03Z",
                        "payload": {"message_id": str(MESSAGE_ID)},
                    },
                ),
                (
                    str(events[1].event_id),
                    "sync.status_changed",
                    {
                        "id": str(events[1].event_id),
                        "type": "sync.status_changed",
                        "owner_id": str(OWNER_ID),
                        "contact_id": str(CONTACT_ID),
                        "occurred_at": "2026-08-25T01:02:03Z",
                        "payload": {
                            "phase": "active",
                            "sync_enabled": True,
                            "failure_code": None,
                        },
                    },
                ),
                (
                    str(events[2].event_id),
                    "task.progress",
                    {
                        "id": str(events[2].event_id),
                        "type": "task.progress",
                        "owner_id": str(OWNER_ID),
                        "contact_id": str(CONTACT_ID),
                        "occurred_at": "2026-08-25T01:02:03Z",
                        "payload": {
                            "task_id": str(TASK_ID),
                            "step": "extract_memory",
                            "status": "running",
                            "processed_count": 12,
                            "attempt_count": 2,
                            "retry_count": 1,
                        },
                    },
                ),
            ),
        )
        serialized = b"".join(frame for frame in frames if frame is not None)
        self.assertNotIn("text", serialized.decode("utf-8"))
        self.assertNotIn("content", serialized.decode("utf-8"))

    def test_subscription_only_receives_its_owner_events(self) -> None:
        stream = self._open_stream()
        self.app.events.publish(
            BackendEvent.message_created(
                scope=OTHER_SCOPE,
                occurred_at=OCCURRED_AT,
                message_id=MESSAGE_ID,
            )
        )
        own_event = BackendEvent.message_created(
            scope=SCOPE,
            occurred_at=OCCURRED_AT,
            message_id=MESSAGE_ID,
        )
        self.app.events.publish(own_event)

        frame = stream.read(timeout=0.1)

        self.assertEqual(self._parse_frame(frame)[0], str(own_event.event_id))
        self.assertIsNone(stream.read(timeout=0.01))
        stream.close()
        self.app.events.publish(
            BackendEvent.message_created(
                scope=SCOPE,
                occurred_at=OCCURRED_AT,
                message_id=UUID("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"),
            )
        )
        self.assertIsNone(stream.read(timeout=0.01))

    def test_concurrent_publish_preserves_bus_order(self) -> None:
        stream = self._open_stream()
        first = BackendEvent.message_created(
            event_id=UUID("10000000-0000-0000-0000-000000000010"),
            scope=SCOPE,
            occurred_at=OCCURRED_AT,
            message_id=MESSAGE_ID,
        )
        second = BackendEvent.message_created(
            event_id=UUID("10000000-0000-0000-0000-000000000011"),
            scope=SCOPE,
            occurred_at=OCCURRED_AT,
            message_id=MESSAGE_ID,
        )
        first_push_started = threading.Event()
        release_first_push = threading.Event()
        second_publish_started = threading.Event()
        second_publish_done = threading.Event()
        original_push = EventSubscription.push

        def controlled_push(
            subscription: EventSubscription,
            event: BackendEvent,
        ) -> None:
            if event.event_id == first.event_id:
                first_push_started.set()
                release_first_push.wait(timeout=1)
            original_push(subscription, event)

        def publish_second() -> None:
            second_publish_started.set()
            self.app.events.publish(second)
            second_publish_done.set()

        with patch.object(EventSubscription, "push", controlled_push):
            first_thread = threading.Thread(
                target=self.app.events.publish,
                args=(first,),
            )
            second_thread = threading.Thread(target=publish_second)
            first_thread.start()
            self.assertTrue(first_push_started.wait(timeout=1))
            second_thread.start()
            self.assertTrue(second_publish_started.wait(timeout=1))
            self.assertFalse(second_publish_done.wait(timeout=0.1))
            release_first_push.set()
            first_thread.join(timeout=1)
            second_thread.join(timeout=1)

        self.assertFalse(first_thread.is_alive())
        self.assertFalse(second_thread.is_alive())
        received = (
            self._parse_frame(stream.read(timeout=0.1))[0],
            self._parse_frame(stream.read(timeout=0.1))[0],
        )
        stream.close()

        self.assertEqual(received, (str(first.event_id), str(second.event_id)))

    def test_event_payload_cannot_be_replaced_with_message_body(self) -> None:
        with self.assertRaises(TypeError):
            BackendEvent(
                event_id=UUID("10000000-0000-0000-0000-000000000004"),
                event_type=EventType.MESSAGE_CREATED,
                scope=SCOPE,
                occurred_at=OCCURRED_AT,
                payload={"text": "不应进入事件的合成正文"},  # type: ignore[arg-type]
            )

    def test_reconnect_gets_current_state_without_message_history(self) -> None:
        first = self._open_stream()
        old_message = BackendEvent.message_created(
            scope=SCOPE,
            occurred_at=OCCURRED_AT,
            message_id=MESSAGE_ID,
        )
        old_sync = BackendEvent.sync_status_changed(
            scope=SCOPE,
            occurred_at=OCCURRED_AT,
            phase="paused",
            sync_enabled=True,
            failure_code=None,
        )
        self.app.events.publish(old_message)
        self.app.events.publish(old_sync)
        self.assertIsNotNone(first.read(timeout=0.1))
        self.assertIsNotNone(first.read(timeout=0.1))
        first.close()

        missed_message = BackendEvent.message_created(
            scope=SCOPE,
            occurred_at=OCCURRED_AT,
            message_id=UUID("dddddddd-dddd-dddd-dddd-dddddddddddd"),
        )
        latest_sync = BackendEvent.sync_status_changed(
            scope=SCOPE,
            occurred_at=OCCURRED_AT,
            phase="active",
            sync_enabled=True,
            failure_code=None,
        )
        latest_task = BackendEvent.task_progress(
            scope=SCOPE,
            occurred_at=OCCURRED_AT,
            task_id=TASK_ID,
            step="verify",
            status="succeeded",
            processed_count=20,
            attempt_count=2,
            retry_count=1,
        )
        self.app.events.publish(missed_message)
        self.app.events.publish(latest_sync)
        self.app.events.publish(latest_task)

        reconnected = self._open_stream(last_event_id=str(old_sync.event_id))
        snapshots = (
            self._parse_frame(reconnected.read(timeout=0.1)),
            self._parse_frame(reconnected.read(timeout=0.1)),
        )

        self.assertEqual(
            tuple(item[0] for item in snapshots),
            (str(latest_sync.event_id), str(latest_task.event_id)),
        )
        self.assertIsNone(reconnected.read(timeout=0.01))
        reconnected.close()

    def test_real_loopback_http_sse_uses_same_contract(self) -> None:
        server = BackendServer(self.app, port=0)
        host, port = server.start()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            request = urllib.request.Request(
                f"http://{host}:{port}/api/events",
                headers=self.headers,
            )
            with urllib.request.urlopen(request, timeout=1) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers["Content-Type"], "text/event-stream")
                event = BackendEvent.sync_status_changed(
                    scope=SCOPE,
                    occurred_at=OCCURRED_AT,
                    phase="active",
                    sync_enabled=True,
                    failure_code=None,
                )
                self.app.events.publish(event)
                body = response.readline() + response.readline() + response.readline()
                self.assertIn(f"id: {event.event_id}".encode(), body)
                self.assertIn(b"event: sync.status_changed", body)
        finally:
            server.shutdown()
            thread.join(timeout=1)

    def test_real_sse_subscription_close_finishes_http_response(self) -> None:
        server = BackendServer(self.app, port=0)
        host, port = server.start()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            request = urllib.request.Request(
                f"http://{host}:{port}/api/events", headers=self.headers,
            )
            with urllib.request.urlopen(request, timeout=2) as response:
                self.assertEqual(response.status, 200)
                self.app.events.close()
                # 公开HTTP读取必须得到EOF，不能等keep-alive超时才发现订阅结束。
                self.assertEqual(response.read(), b"")
        finally:
            server.shutdown()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())

    def test_head_request_returns_headers_without_body(self) -> None:
        # HEAD 响应按协议不携带 body；状态码维持与 GET 同一分支逻辑。
        import http.client

        server = BackendServer(self.app, port=0)
        host, port = server.start()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection(host, port, timeout=2)
            connection.request("HEAD", "/api/contacts", headers=self.headers)
            response = connection.getresponse()
            self.assertIn(response.status, (200, 404))
            self.assertEqual(response.read(), b"")
            connection.close()
        finally:
            server.shutdown()
            thread.join(timeout=1)

    def test_oversized_body_returns_stable_413(self) -> None:
        # 超限请求体必须能拿到稳定 413，而不是连接被无响应重置。
        import http.client

        server = BackendServer(self.app, port=0)
        host, port = server.start()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection(host, port, timeout=5)
            oversized = b"x" * (1024 * 1024 + 16)
            connection.request(
                "POST",
                "/api/memories/manual-owner",
                body=oversized,
                headers={
                    **self.headers,
                    "Content-Type": "application/json",
                },
            )
            response = connection.getresponse()
            self.assertEqual(response.status, 413)
            self.assertEqual(
                json.loads(response.read())["error"],
                "request_body_too_large",
            )
            connection.close()
        finally:
            server.shutdown()
            thread.join(timeout=1)

    def test_oversized_declared_body_returns_413_without_waiting_for_body(self) -> None:
        import http.client

        server = BackendServer(self.app, port=0)
        host, port = server.start()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection(host, port, timeout=2)
            connection.request(
                "POST",
                "/api/memories/manual-owner",
                headers={
                    **self.headers,
                    "Content-Length": str(1024 * 1024 + 16),
                    "Content-Type": "application/json",
                },
            )
            response = connection.getresponse()
            self.assertEqual(response.status, 413)
            self.assertEqual(response.getheader("Connection"), "close")
            self.assertEqual(
                json.loads(response.read())["error"],
                "request_body_too_large",
            )
            connection.close()
        finally:
            server.shutdown()
            thread.join(timeout=1)

    def test_open_sse_requires_initialized_owner(self) -> None:
        # owner 未初始化时订阅会永久空挂（事件都带真实 owner）；与
        # handle() 的 owner 门禁保持一致，返回稳定 503。
        app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=None,
            token="test-token",
        )
        response = app.open_sse(
            path="/api/events",
            headers={"Authorization": "Bearer test-token"},
        )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            json.loads(response.body)["error"],
            "owner_uninitialized",
        )

    def _open_stream(self, *, last_event_id: str | None = None) -> InProcessSseStream:
        headers = dict(self.headers)
        if last_event_id is not None:
            headers["Last-Event-ID"] = last_event_id
        stream = self.client.open_sse("/api/events", headers=headers)
        self.assertIsInstance(stream, InProcessSseStream)
        self.assertEqual(stream.status_code, 200)
        self.assertEqual(stream.headers["Content-Type"], "text/event-stream")
        return stream

    @staticmethod
    def _parse_frame(frame: bytes | None) -> tuple[str, str, dict[str, object]]:
        if frame is None:
            raise AssertionError("预期收到 SSE 事件。")
        lines = frame.decode("utf-8").strip().splitlines()
        return (
            lines[0].removeprefix("id: "),
            lines[1].removeprefix("event: "),
            json.loads(lines[2].removeprefix("data: ")),
        )


if __name__ == "__main__":
    unittest.main()
