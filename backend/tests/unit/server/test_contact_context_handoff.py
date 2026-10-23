"""联系人上下文责任移交的公开 HTTP 合同；仅合成身份与数据库边界。"""

import json
import threading
import unittest
import urllib.error
import urllib.request
from uuid import uuid4
from unittest.mock import patch

from notalone.server.app import BackendServer, create_app


class ContactContextHandoffHttpTest(unittest.TestCase):
    def setUp(self) -> None:
        self.start_server()
        self.addCleanup(self.close)

    def start_server(self, owner_id=None) -> None:
        self.app = create_app(
            database_url="postgresql:///notalone_handoff_synthetic_test",
            owner_id=owner_id,
            token="synthetic-handoff-token",
            runtime_shutdown=lambda: None,
        )
        self.server = BackendServer(self.app)
        host, port = self.server.start()
        self.url = f"http://{host}:{port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.thread.join(timeout=3)

    def request(self, method: str, path: str, *, authorized: bool = True, body=None):
        headers = {"Authorization": "Bearer synthetic-handoff-token"} if authorized else {}
        request = urllib.request.Request(self.url + path, method=method, headers=headers, data=json.dumps(body).encode() if body is not None else None)
        try:
            response = urllib.request.urlopen(request, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

    def test_stop_authentication_scope_and_explicit_restart(self) -> None:
        base = "/api/runtime/contact-context"
        self.assertEqual(self.request("POST", base + "/stop", authorized=False)[0], 401)
        self.assertEqual(self.request("GET", base + "/status"),
                         (200, {"state": "running", "active_requests": 0}))
        self.assertEqual(self.request("POST", base + "/stop"),
                         (200, {"state": "stopped", "active_requests": 0}))
        contact = str(uuid4())
        for method, path in [
            ("GET", "/api/contacts"),
            ("GET", f"/api/contacts/{contact}/messages?limit=20"),
            ("GET", f"/api/contacts/{contact}/sources"),
            ("GET", f"/api/contacts/{contact}/relationship-overview"),
            ("POST", f"/api/contacts/{contact}/manual-confirmation"),
        ]:
            self.assertEqual(self.request(method, path),
                             (503, {"error": "contact_context_transferred"}))
        for method, path in [
            ("POST", "/api/contacts"),
            ("DELETE", f"/api/contacts/{contact}/sources/{uuid4()}"),
            ("GET", f"/api/contacts/{contact}/memories"),
            ("GET", f"/api/contacts/{contact}/replies/{uuid4()}/evidence"),
        ]:
            self.assertEqual(self.request(method, path),
                             (503, {"error": "owner_uninitialized"}))
        self.assertEqual(self.request("POST", base + "/start"),
                         (200, {"state": "running", "active_requests": 0}))
        self.assertEqual(self.request("GET", "/api/contacts"),
                         (503, {"error": "owner_uninitialized"}))

    def test_stop_drains_real_http_request_and_rejects_restart_until_finished(self) -> None:
        self.close()
        self.start_server(owner_id=uuid4())
        entered = threading.Event()
        release = threading.Event()
        finished = threading.Event()
        results = []

        class SyntheticDatabaseConnection:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def execute(self, *args):
                entered.set()
                if not release.wait(timeout=3):
                    raise TimeoutError("合成数据库未释放")
                return self

            def fetchall(self):
                return []

        def read_contacts():
            try:
                results.append(self.request("GET", "/api/contacts"))
            finally:
                finished.set()

        base = "/api/runtime/contact-context"
        with patch("psycopg.connect", return_value=SyntheticDatabaseConnection()):
            worker = threading.Thread(target=read_contacts, daemon=True)
            worker.start()
            try:
                self.assertTrue(entered.wait(timeout=2))
                self.assertEqual(self.request("POST", base + "/stop"),
                                 (200, {"state": "stopping", "active_requests": 1}))
                self.assertEqual(self.request("POST", base + "/start"),
                                 (409, {"error": "contact_context_draining"}))
                self.assertEqual(self.request("GET", "/api/contacts"),
                                 (503, {"error": "contact_context_transferred"}))
                self.assertEqual(self.request("GET", base + "/status"),
                                 (200, {"state": "stopping", "active_requests": 1}))
            finally:
                release.set()
                worker.join(timeout=3)
            self.assertTrue(finished.is_set())
            self.assertEqual(results, [(200, {"contacts": []})])
            self.assertEqual(self.request("GET", base + "/status"),
                             (200, {"state": "stopped", "active_requests": 0}))
            self.assertEqual(self.request("POST", base + "/start"),
                             (200, {"state": "running", "active_requests": 0}))
            self.assertEqual(self.request("GET", "/api/contacts"),
                             (200, {"contacts": []}))

    def test_failed_database_read_releases_request_and_shutdown_cannot_restart(self) -> None:
        import psycopg

        self.close()
        self.start_server(owner_id=uuid4())
        with patch("psycopg.connect", side_effect=psycopg.OperationalError("合成连接失败")):
            self.assertEqual(self.request("GET", "/api/contacts"),
                             (500, {"error": "contact_list_unavailable"}))
        base = "/api/runtime/contact-context"
        self.assertEqual(self.request("POST", base + "/stop"),
                         (200, {"state": "stopped", "active_requests": 0}))
        # 进程内 HTTP seam 保留全局关闭后的响应，实际服务器关闭不再接受连接。
        from notalone.server.testing import InProcessClient

        client = InProcessClient(self.app)
        headers = {"Authorization": "Bearer synthetic-handoff-token"}
        self.assertEqual(client.request("POST", "/api/runtime/shutdown", headers=headers).status_code, 200)
        restarted = client.request("POST", base + "/start", headers=headers)
        self.assertEqual(restarted.status_code, 503)
        self.assertEqual(restarted.json(), {"error": "runtime_stopping"})

    def test_configure_accepts_only_authenticated_explicit_loopback_target(self) -> None:
        path = "/api/runtime/contact-context/configure"
        target = {"address": "127.0.0.1:12345", "token": "synthetic-internal-token"}
        self.assertEqual(self.request("POST", path, authorized=False, body=target)[0], 401)
        for invalid in ({**target, "address": "example.com:12345"}, {**target, "address": "127.0.0.1:0"}, {**target, "token": "bad\ntoken"}):
            self.assertEqual(self.request("POST", path, body=invalid),
                             (400, {"error": "contact_context_configuration_invalid"}))
        self.assertEqual(self.request("POST", path, body=target), (200, {"configured": True}))
        # 控制响应和公开状态不回显内部凭据。
        self.assertEqual(self.request("GET", "/api/runtime/contact-context/status"),
                         (200, {"state": "running", "active_requests": 0}))
