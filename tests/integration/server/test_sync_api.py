"""后端同步控制 API 的进程内契约测试。

使用注入的 fake SyncControl 端口，钉住 JSON 结构；不连接数据库、
不启动真实引擎。主窗口与菜单栏都依赖这个 JSON 契约。
"""

from __future__ import annotations

import unittest
from uuid import UUID, uuid4

from notalone.conversation.matcher import BindingMatchReason
from notalone.front_sync import FrontSyncPhase
from notalone.front_sync.sync_engine import (
    BindingCandidateView,
    FrontSyncCycleReport,
)
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
CONTACT_ID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")


def _report(*, enabled: bool = True) -> FrontSyncCycleReport:
    return FrontSyncCycleReport(
        sync_enabled=enabled,
        phase=FrontSyncPhase.ACTIVE if enabled else FrontSyncPhase.SYNC_DISABLED,
        probe_available=True,
        wechat_in_front=True,
        cli_available=True,
        failure_code=None if enabled else None,
        active_contact_id=CONTACT_ID if enabled else None,
        active_binding_display_name="合成联系人甲" if enabled else None,
        decision_reason=(
            BindingMatchReason.CONFIRMED_ACTIVE_BINDING if enabled else None
        ),
        candidates=(
            (
                BindingCandidateView(
                    username="wxid_candidate",
                    display_name="合成候选",
                    last_timestamp=1787486383,
                ),
            )
            if not enabled
            else ()
        ),
        batch_message_count=2 if enabled else 0,
    )


class ScriptedSyncControl:
    """记录调用的内存同步控制端口。"""

    def __init__(self, report: FrontSyncCycleReport | None = None) -> None:
        self.next_report: FrontSyncCycleReport | None = report or _report()
        self.status_calls = 0
        self.enable_calls = 0
        self.disable_calls = 0
        self.check_calls = 0
        self.confirm_calls: list[tuple[str, str]] = []
        self.confirm_pending_calls: list[tuple[str, str]] = []
        self.confirm_error: Exception | None = None

    def status(self) -> FrontSyncCycleReport | None:
        self.status_calls += 1
        return self.next_report

    def enable(self) -> FrontSyncCycleReport:
        self.enable_calls += 1
        self.next_report = _report(enabled=True)
        return self.next_report

    def disable(self) -> FrontSyncCycleReport:
        self.disable_calls += 1
        self.next_report = _report(enabled=False)
        return self.next_report

    def check(self) -> FrontSyncCycleReport:
        self.check_calls += 1
        return self.next_report

    def confirm(self, *, contact_id, locator) -> FrontSyncCycleReport:
        self.confirm_calls.append((str(contact_id), locator))
        if self.confirm_error is not None:
            raise self.confirm_error
        self.next_report = _report(enabled=True)
        return self.next_report

    def confirm_pending(self, *, contact_id, locator) -> FrontSyncCycleReport:
        self.confirm_pending_calls.append((str(contact_id), locator))
        if self.confirm_error is not None:
            raise self.confirm_error
        self.next_report = _report(enabled=True)
        return self.next_report


class SyncApiContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.sync = ScriptedSyncControl()
        self.app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=OWNER_ID,
            token="test-token",
            sync_control=self.sync,
        )
        self.client = InProcessClient(self.app)
        self.headers = {"Authorization": "Bearer test-token"}

    # ------------------------------------------------------------------
    # 鉴权
    # ------------------------------------------------------------------

    def test_sync_endpoints_require_token(self) -> None:
        for method, path in (
            ("GET", "/api/sync/status"),
            ("POST", "/api/sync/enable"),
            ("POST", "/api/sync/disable"),
            ("POST", "/api/sync/check"),
            ("POST", "/api/sync/confirm"),
            ("POST", "/api/sync/confirm-pending"),
        ):
            with self.subTest(method=method, path=path):
                missing = self.client.request(method, path)
                wrong = self.client.request(
                    method,
                    path,
                    headers={"Authorization": "Bearer wrong-secret"},
                )
                self.assertEqual(missing.status_code, 401)
                self.assertEqual(missing.json(), {"error": "unauthorized"})
                self.assertEqual(wrong.status_code, 401)
                self.assertNotIn("wrong-secret", wrong.body.decode("utf-8"))

    # ------------------------------------------------------------------
    # status
    # ------------------------------------------------------------------

    def test_status_returns_pinned_json_structure(self) -> None:
        response = self.client.get("/api/sync/status", headers=self.headers)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "sync_enabled": True,
                "phase": "active",
                "probe_available": True,
                "wechat_in_front": True,
                "cli_available": True,
                "failure_code": None,
                "active_contact_id": str(CONTACT_ID),
                "active_binding_display_name": "合成联系人甲",
                "decision_reason": "confirmed_active_binding",
                "batch_message_count": 2,
                "candidates": [],
            },
        )

    def test_status_returns_candidates_when_awaiting_selection(self) -> None:
        self.sync.next_report = _report(enabled=False)
        response = self.client.get("/api/sync/status", headers=self.headers)

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["sync_enabled"], False)
        self.assertEqual(payload["phase"], "sync_disabled")
        self.assertEqual(
            payload["candidates"],
            [
                {
                    "username": "wxid_candidate",
                    "display_name": "合成候选",
                    "last_timestamp": 1787486383,
                }
            ],
        )

    def test_status_serialized_body_has_no_message_content(self) -> None:
        response = self.client.get("/api/sync/status", headers=self.headers)

        body = response.body.decode("utf-8")
        self.assertNotIn("text", body)
        self.assertNotIn("content", body)

    def test_status_calls_port_once(self) -> None:
        self.client.get("/api/sync/status", headers=self.headers)
        self.client.get("/api/sync/status", headers=self.headers)

        self.assertEqual(self.sync.status_calls, 2)

    # ------------------------------------------------------------------
    # enable / disable / check
    # ------------------------------------------------------------------

    def test_enable_delegates_and_returns_fresh_status(self) -> None:
        self.sync.next_report = _report(enabled=False)
        response = self.client.request(
            "POST", "/api/sync/enable", headers=self.headers
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.sync.enable_calls, 1)
        self.assertEqual(response.json()["sync_enabled"], True)

    def test_disable_delegates_and_returns_fresh_status(self) -> None:
        response = self.client.request(
            "POST", "/api/sync/disable", headers=self.headers
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.sync.disable_calls, 1)
        self.assertEqual(response.json()["sync_enabled"], False)
        self.assertEqual(response.json()["phase"], "sync_disabled")

    def test_check_delegates(self) -> None:
        response = self.client.request(
            "POST", "/api/sync/check", headers=self.headers
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.sync.check_calls, 1)

    def test_sync_post_requires_post_method(self) -> None:
        response = self.client.get("/api/sync/enable", headers=self.headers)
        self.assertEqual(response.status_code, 404)

    # ------------------------------------------------------------------
    # 绑定确认
    # ------------------------------------------------------------------

    def test_confirm_delegates_and_returns_fresh_status(self) -> None:
        response = self.client.request(
            "POST",
            "/api/sync/confirm",
            headers=self.headers,
            body=(
                '{"contact_id": "' + str(CONTACT_ID) + '",'
                ' "locator": "wxid_candidate"}'
            ).encode("utf-8"),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self.sync.confirm_calls,
            [(str(CONTACT_ID), "wxid_candidate")],
        )
        self.assertEqual(response.json()["sync_enabled"], True)

    def test_confirm_pending_delegates_and_returns_fresh_status(self) -> None:
        response = self.client.request(
            "POST",
            "/api/sync/confirm-pending",
            headers=self.headers,
            body=(
                '{"contact_id": "' + str(CONTACT_ID) + '",'
                ' "locator": "wxid_candidate"}'
            ).encode("utf-8"),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self.sync.confirm_pending_calls,
            [(str(CONTACT_ID), "wxid_candidate")],
        )
        self.assertEqual(response.json()["sync_enabled"], True)

    def test_confirm_rejects_invalid_request_body(self) -> None:
        for body in (
            b"not-json",
            b"[]",
            b"{}",
            b'{"contact_id": "not-a-uuid", "locator": "wxid_candidate"}',
            b'{"contact_id": "' + str(CONTACT_ID).encode("utf-8") + b'"}',
            b'{"locator": "wxid_candidate"}',
            b'{"contact_id": "' + str(CONTACT_ID).encode("utf-8") + b'", "locator": "  "}',
        ):
            with self.subTest(body=body):
                response = self.client.request(
                    "POST",
                    "/api/sync/confirm",
                    headers=self.headers,
                    body=body,
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(
                    response.json(), {"error": "binding_confirmation_invalid"}
                )
        self.assertEqual(self.sync.confirm_calls, [])

    def test_confirm_rejection_is_reported_with_stable_code(self) -> None:
        from notalone.front_sync.sync_engine import BindingConfirmationError

        self.sync.confirm_error = BindingConfirmationError(
            "no_pending_selection", "当前会话没有待确认的一次性选择。"
        )
        body = (
            '{"contact_id": "' + str(CONTACT_ID) + '",'
            ' "locator": "wxid_candidate"}'
        ).encode("utf-8")

        response = self.client.request(
            "POST",
            "/api/sync/confirm",
            headers=self.headers,
            body=body,
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.json(),
            {
                "error": "binding_confirmation_rejected",
                "reason": "no_pending_selection",
            },
        )

    # ------------------------------------------------------------------
    # 无同步控制时
    # ------------------------------------------------------------------

    def test_sync_endpoints_fail_closed_without_control(self) -> None:
        app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=OWNER_ID,
            token="test-token",
        )
        client = InProcessClient(app)
        for method, path in (
            ("GET", "/api/sync/status"),
            ("POST", "/api/sync/enable"),
            ("POST", "/api/sync/disable"),
            ("POST", "/api/sync/check"),
            ("POST", "/api/sync/confirm"),
            ("POST", "/api/sync/confirm-pending"),
        ):
            with self.subTest(method=method, path=path):
                response = client.request(
                    method, path, headers={"Authorization": "Bearer test-token"}
                )
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json(), {"error": "sync_unavailable"})


if __name__ == "__main__":
    unittest.main()
