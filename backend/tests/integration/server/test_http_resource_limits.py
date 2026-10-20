"""无数据库的真实回环 HTTP 慢请求回归。"""

import http.client
import json
import socket
import threading
import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import UUID

from notalone.server.app import BackendApp, BackendServer
from notalone.server.event_bus import EventBus
from notalone.server.http_limits import HttpRequestLimits
from notalone.scopes import ContactScope
from notalone.server.event_models import BackendEvent
from notalone.server.sse import encode_sse_frame


class HttpResourceLimitsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.app = BackendApp(contact_directory=None, events=EventBus(),
                              owner_id=UUID(int=1), token="synthetic-token")
        self.server = BackendServer(self.app, port=0, request_limits=HttpRequestLimits(
            header_seconds=0.2, body_seconds=0.2, write_seconds=1, max_connections=4))
        self.address = self.server.start()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self) -> None:
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.assertFalse(self.thread.is_alive())

    def connect(self) -> socket.socket:
        client = socket.create_connection(self.address, timeout=0.5)
        self.addCleanup(client.close)
        return client

    def test_unauthorized_partial_body_is_rejected_before_body_read(self) -> None:
        for auth in (b"", b"Authorization: Bearer wrong\r\n",
                     b"X-NotAlone-Token: wrong\r\n"):
            with self.subTest(auth=auth):
                client = self.connect()
                client.sendall(b"POST /api/unknown HTTP/1.0\r\n" + auth
                               + b"Content-Length: 100\r\n\r\nx")
                response = http.client.HTTPResponse(client)
                response.begin()
                self.assertEqual(response.status, 401)
                self.assertEqual(response.getheader("Connection"), "close")
                self.assertEqual(json.loads(response.read()), {"error": "unauthorized"})

    def test_authenticated_body_has_total_deadline_despite_trickle(self) -> None:
        client = self.connect()
        client.sendall(b"POST /api/unknown HTTP/1.0\r\nAuthorization: Bearer synthetic-token\r\n"
                       b"Content-Length: 100\r\n\r\nx")
        stop = threading.Event()

        def trickle() -> None:
            while not stop.wait(0.025):
                try:
                    client.sendall(b"x")
                except OSError:
                    return

        sender = threading.Thread(target=trickle, daemon=True)
        sender.start()
        try:
            response = http.client.HTTPResponse(client)
            response.begin()
            self.assertEqual(response.status, 408)
            self.assertEqual(response.getheader("Connection"), "close")
            self.assertEqual(json.loads(response.read()), {"error": "request_body_timeout"})
        finally:
            stop.set()
            sender.join(timeout=1)
            self.assertFalse(sender.is_alive())

    def test_incomplete_headers_have_total_deadline_despite_trickle(self) -> None:
        client = self.connect()
        client.sendall(b"GET /api/events HTTP/1.0\r\nX-Synthetic: ")
        stop = threading.Event()

        def trickle() -> None:
            while not stop.wait(0.025):
                try:
                    client.sendall(b"x")
                except OSError:
                    return

        sender = threading.Thread(target=trickle, daemon=True)
        sender.start()
        try:
            self.assertEqual(client.recv(4096), b"")
        finally:
            stop.set()
            sender.join(timeout=1)
            self.assertFalse(sender.is_alive())

    def test_connection_limit_rejects_excess_and_recovers_after_deadlines(self) -> None:
        held = [self.connect() for _ in range(4)]
        for client in held:
            client.sendall(b"GET /api/events HTTP/1.0\r\nX-Synthetic: ")
        extra = self.connect()
        response = http.client.HTTPResponse(extra)
        response.begin()
        self.assertEqual(response.status, 503)
        self.assertEqual(response.read(), b"")
        for client in held:
            self.assertEqual(client.recv(4096), b"")
        recovered = self.connect()
        recovered.sendall(b"GET /api/unknown HTTP/1.0\r\n"
                          b"X-NotAlone-Token: synthetic-token\r\n\r\n")
        response = http.client.HTTPResponse(recovered)
        response.begin()
        self.assertEqual(response.status, 404)

    def test_shutdown_closes_partial_header_body_and_idle_sse_connections(self) -> None:
        header = self.connect()
        header.sendall(b"GET /api/events HTTP/1.0\r\nX-Synthetic: ")
        body = self.connect()
        body.sendall(b"POST /api/unknown HTTP/1.0\r\nAuthorization: Bearer synthetic-token\r\n"
                     b"Content-Length: 100\r\n\r\nx")
        sse = self.connect()
        sse.sendall(b"GET /api/events HTTP/1.0\r\nAuthorization: Bearer synthetic-token\r\n\r\n")
        response = http.client.HTTPResponse(sse)
        response.begin()
        self.assertEqual(response.status, 200)
        workers = [thread for thread in threading.enumerate()
                   if "process_request_thread" in thread.name]
        self.server.shutdown()
        self.assertEqual(response.read(), b"")
        for worker in workers:
            worker.join(timeout=1)
            self.assertFalse(worker.is_alive())

    def test_authenticated_short_body_is_400_and_never_dispatched(self) -> None:
        client = self.connect()
        client.sendall(b"POST /api/unknown HTTP/1.0\r\nAuthorization: Bearer synthetic-token\r\n"
                       b"Content-Length: 100\r\n\r\nx")
        client.shutdown(socket.SHUT_WR)
        response = http.client.HTTPResponse(client)
        response.begin()
        self.assertEqual(response.status, 400)
        self.assertEqual(json.loads(response.read()), {"error": "request_body_incomplete"})

    def test_unauthorized_length_errors_keep_400_and_413_precedence(self) -> None:
        for length, status in (("invalid", 400), ("-1", 400), (str(1024 * 1024 + 1), 413)):
            with self.subTest(length=length):
                client = self.connect()
                client.sendall(("POST /api/unknown HTTP/1.0\r\nContent-Length: "
                                + length + "\r\n\r\n").encode())
                response = http.client.HTTPResponse(client)
                response.begin()
                self.assertEqual(response.status, status)
                self.assertEqual(response.getheader("Connection"), "close")
                response.read()

    def test_sse_stays_open_after_input_deadline_and_overflow_ends_response(self) -> None:
        client = self.connect()
        client.sendall(b"GET /api/events HTTP/1.0\r\nAuthorization: Bearer synthetic-token\r\n\r\n")
        response = http.client.HTTPResponse(client)
        response.begin()
        self.assertEqual(response.status, 200)
        # 模拟客户端暂时不读：HTTP 写端停在第一帧，积压进入真实订阅。
        writing = threading.Event()
        release = threading.Event()
        first = BackendEvent.message_created(
            scope=ContactScope(UUID(int=1), UUID(int=2)),
            occurred_at=datetime(2026, 10, 21, tzinfo=timezone.utc), message_id=UUID(int=3))

        def delayed_encode(event):
            writing.set()
            if not release.wait(timeout=2):
                raise AssertionError("合成慢写端未释放")
            return encode_sse_frame(event)

        with patch("notalone.server.app.encode_sse_frame", delayed_encode):
            try:
                self.app.events.publish(first)
                self.assertTrue(writing.wait(timeout=1))
                # 超过测试头部预算后，SSE 仍可写帧；输入截止不应变成 SSE 寿命。
                self.assertFalse(release.wait(timeout=0.25))
                for _ in range(300):
                    self.app.events.publish(first)
            finally:
                release.set()
            data = response.read()
        self.assertEqual(data, encode_sse_frame(first))

