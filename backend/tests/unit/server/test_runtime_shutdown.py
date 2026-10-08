"""认证运行时关闭接缝；合成回调不连接业务数据库。"""

import unittest
import json
import threading
import urllib.error
import urllib.request

from notalone.server.app import BackendServer, create_app
from notalone.server.testing import InProcessClient


class RuntimeShutdownTest(unittest.TestCase):
    def test_shutdown_requires_authentication_and_stops_before_success(self) -> None:
        stopped = []
        app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=None,
            token="synthetic-token",
            runtime_shutdown=lambda: stopped.append("stopped"),
        )
        client = InProcessClient(app)

        rejected = client.request("POST", "/api/runtime/shutdown")
        self.assertEqual(rejected.status_code, 401)
        self.assertEqual(stopped, [])
        accepted = client.request(
            "POST", "/api/runtime/shutdown",
            headers={"Authorization": "Bearer synthetic-token"},
        )
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(accepted.json(), {"state": "stopped"})
        self.assertEqual(stopped, ["stopped"])

    def test_stop_is_idempotent_and_only_authenticated_status_remains_available(self) -> None:
        stopped = []
        app = create_app(
            database_url="postgresql:///notalone_test", owner_id=None,
            token="synthetic-token", runtime_shutdown=lambda: stopped.append("stopped"),
        )
        client = InProcessClient(app)
        headers = {"Authorization": "Bearer synthetic-token"}
        self.assertEqual(client.get("/api/runtime/status").status_code, 401)
        self.assertEqual(
            client.get("/api/runtime/status", headers=headers).json(), {"state": "running"}
        )
        for _ in range(2):
            self.assertEqual(
                client.request("POST", "/api/runtime/shutdown", headers=headers).status_code, 200
            )
        self.assertEqual(stopped, ["stopped"])
        self.assertEqual(
            client.get("/api/runtime/status", headers=headers).json(), {"state": "stopped"}
        )
        denied = client.request("POST", "/api/sync/check", headers=headers)
        self.assertEqual(denied.status_code, 503)
        self.assertEqual(denied.json(), {"error": "runtime_stopping"})

    def test_failed_stop_does_not_claim_stopped_and_can_be_retried(self) -> None:
        attempts = []

        def stop() -> None:
            attempts.append(True)
            if len(attempts) == 1:
                raise RuntimeError("合成关闭失败")

        app = create_app(
            database_url="postgresql:///notalone_test", owner_id=None,
            token="synthetic-token", runtime_shutdown=stop,
        )
        client = InProcessClient(app)
        headers = {"Authorization": "Bearer synthetic-token"}
        failed = client.request("POST", "/api/runtime/shutdown", headers=headers)
        self.assertEqual(failed.status_code, 500)
        self.assertEqual(
            client.get("/api/runtime/status", headers=headers).json(), {"state": "stopping"}
        )
        for _ in range(2):
            result = client.request("POST", "/api/runtime/shutdown", headers=headers)
            self.assertEqual(result.json(), {"state": "stopped"})
        self.assertEqual(len(attempts), 2)

    def test_authenticated_http_shutdown_finishes_reading_then_closes_server(self) -> None:
        stopped = []
        app = create_app(
            database_url="postgresql:///notalone_test", owner_id=None,
            token="synthetic-token", runtime_shutdown=lambda: stopped.append("stopped"),
        )
        server = BackendServer(app)
        host, port = server.start()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://{host}:{port}/api/runtime/shutdown"
            with self.assertRaises(urllib.error.HTTPError) as rejected:
                urllib.request.urlopen(
                    urllib.request.Request(url, method="POST"), timeout=2
                )
            self.assertEqual(rejected.exception.code, 401)
            self.assertTrue(thread.is_alive())
            self.assertEqual(stopped, [])

            with urllib.request.urlopen(
                urllib.request.Request(
                    url, method="POST",
                    headers={"Authorization": "Bearer synthetic-token"},
                ), timeout=2,
            ) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read()), {"state": "stopped"})
                self.assertEqual(stopped, ["stopped"])
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
        finally:
            server.shutdown()
            thread.join(timeout=2)
