"""首启向导 API 的进程内契约测试（fake 服务）。

钉住 owner 初始化（幂等）、凭据写入（不回显）与初始化状态查询的
JSON 契约、鉴权与失败关闭。
"""

from __future__ import annotations

import json
import unittest
from uuid import UUID

from notalone.server.app import create_app
from notalone.server.testing import InProcessClient


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")


class FakeSetupService:
    """记录调用并返回合成结果的设置服务 fake。"""

    def __init__(self) -> None:
        self.initialize_calls: list[str] = []
        self.credentials_calls: list[tuple[str, str]] = []
        self.initialized = False

    def status(self) -> dict[str, object]:
        return {
            "initialized": self.initialized,
            "owner_configured": self.initialized,
            "credentials_configured": False,
        }

    def initialize_owner(self, *, display_name: str) -> dict[str, object]:
        self.initialize_calls.append(display_name)
        if self.initialized:
            return {"owner_id": str(OWNER_ID), "created": False}
        self.initialized = True
        return {"owner_id": str(OWNER_ID), "created": True}

    def write_credentials(self, *, api_key: str) -> dict[str, object]:
        self.credentials_calls.append(("deepseek", api_key))
        return {"provider": "deepseek", "configured": True}


class SetupApiContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.setup = FakeSetupService()
        self.app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=OWNER_ID,
            token="test-token",
            setup_service=self.setup,  # type: ignore[arg-type]
        )
        self.client = InProcessClient(self.app)
        self.headers = {"Authorization": "Bearer test-token"}

    # ------------------------------------------------------------------
    # 鉴权
    # ------------------------------------------------------------------

    def test_setup_endpoints_require_token(self) -> None:
        response = self.client.get("/api/setup/status")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"error": "unauthorized"})

    # ------------------------------------------------------------------
    # 状态查询
    # ------------------------------------------------------------------

    def test_status_returns_initialization_state(self) -> None:
        response = self.client.get("/api/setup/status", headers=self.headers)

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["initialized"], False)
        self.assertEqual(payload["owner_configured"], False)
        self.assertIn("credentials_configured", payload)

    # ------------------------------------------------------------------
    # owner 初始化（幂等）
    # ------------------------------------------------------------------

    def test_initialize_owner_creates(self) -> None:
        response = self.client.request(
            "POST",
            "/api/setup/initialize",
            headers=self.headers,
            body=json.dumps({"display_name": "我的关系助手"}).encode("utf-8"),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["owner_id"], str(OWNER_ID))
        self.assertEqual(payload["created"], True)

    def test_initialize_owner_is_idempotent(self) -> None:
        self.setup.initialized = True

        response = self.client.request(
            "POST",
            "/api/setup/initialize",
            headers=self.headers,
            body=json.dumps({"display_name": "我的关系助手"}).encode("utf-8"),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["created"], False)

    def test_initialize_owner_rejects_invalid_body(self) -> None:
        for body in (b"not-json", b"{}", b'{"display_name": ""}'):
            with self.subTest(body=body):
                response = self.client.request(
                    "POST",
                    "/api/setup/initialize",
                    headers=self.headers,
                    body=body,
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(
                    response.json(), {"error": "setup_request_invalid"}
                )

    # ------------------------------------------------------------------
    # 凭据写入（不回显）
    # ------------------------------------------------------------------

    def test_write_credentials_saves_and_never_echoes(self) -> None:
        response = self.client.request(
            "POST",
            "/api/setup/credentials",
            headers=self.headers,
            body=json.dumps({"provider": "deepseek", "api_key": "sk-secret"}).encode("utf-8"),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["configured"], True)
        self.assertNotIn("api_key", str(payload))
        self.assertNotIn("sk-secret", str(payload))
        self.assertEqual(
            self.setup.credentials_calls,
            [("deepseek", "sk-secret")],
        )

    def test_write_credentials_rejects_invalid_body(self) -> None:
        for body in (
            b"{}",
            b'{"api_key": ""}',
            b'{"provider": "deepseek"}',
        ):
            with self.subTest(body=body):
                response = self.client.request(
                    "POST",
                    "/api/setup/credentials",
                    headers=self.headers,
                    body=body,
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(
                    response.json(), {"error": "setup_request_invalid"}
                )

    # ------------------------------------------------------------------
    # 服务不可用
    # ------------------------------------------------------------------

    def test_setup_unavailable_without_service(self) -> None:
        app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=OWNER_ID,
            token="test-token",
        )
        client = InProcessClient(app)

        response = client.get(
            "/api/setup/status",
            headers={"Authorization": "Bearer test-token"},
        )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"error": "setup_unavailable"})

    # ------------------------------------------------------------------
    # owner 未初始化（首启向导场景）
    # ------------------------------------------------------------------

    def test_owner_uninitialized_blocks_non_setup_endpoints(self) -> None:
        app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=None,
            token="test-token",
            setup_service=self.setup,  # type: ignore[arg-type]
        )
        client = InProcessClient(app)

        for path in (
            "/api/contacts",
            "/api/contacts/22222222-2222-2222-2222-222222222222/messages",
            "/api/memories",
            "/api/imports",
            "/api/tasks",
            "/api/skills",
            "/api/ledger/summary",
            "/api/sync/status",
        ):
            with self.subTest(path=path):
                response = client.get(
                    path,
                    headers={"Authorization": "Bearer test-token"},
                )
                self.assertEqual(response.status_code, 503)
                self.assertEqual(
                    response.json(), {"error": "owner_uninitialized"}
                )

    def test_owner_uninitialized_allows_setup_endpoints(self) -> None:
        app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=None,
            token="test-token",
            setup_service=self.setup,  # type: ignore[arg-type]
        )
        client = InProcessClient(app)

        status = client.get(
            "/api/setup/status",
            headers={"Authorization": "Bearer test-token"},
        )
        self.assertEqual(status.status_code, 200)
        self.assertIn("initialized", status.json())

        initialize = client.request(
            "POST",
            "/api/setup/initialize",
            headers={"Authorization": "Bearer test-token"},
            body=json.dumps({"display_name": "我的关系助手"}).encode("utf-8"),
        )
        self.assertEqual(initialize.status_code, 200)
        self.assertEqual(initialize.json()["created"], True)

    def test_owner_uninitialized_allows_credentials_status(self) -> None:
        app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=None,
            token="test-token",
            setup_service=self.setup,  # type: ignore[arg-type]
        )
        client = InProcessClient(app)

        response = client.get(
            "/api/settings/credentials",
            headers={"Authorization": "Bearer test-token"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("provider", response.json())
        self.assertIn("configured", response.json())


if __name__ == "__main__":
    unittest.main()