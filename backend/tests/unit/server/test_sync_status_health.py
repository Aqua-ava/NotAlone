"""同步状态接口的健康度投影；使用 fake 端口，不连接数据库。"""

from __future__ import annotations

import unittest
from uuid import uuid4

from notalone.front_sync import FrontSyncPhase
from notalone.front_sync.sync_engine import FrontSyncCycleReport
from notalone.server.app import create_app


class FakeSyncControl:
    def __init__(self, report: FrontSyncCycleReport | None, health: dict) -> None:
        self._report = report
        self._health = health

    def status(self) -> FrontSyncCycleReport | None:
        return self._report

    def health(self) -> dict:
        return self._health


def _report() -> FrontSyncCycleReport:
    return FrontSyncCycleReport(
        sync_enabled=True,
        phase=FrontSyncPhase.ACTIVE,
        probe_available=True,
        wechat_in_front=True,
        cli_available=True,
        failure_code=None,
        active_contact_id=None,
        active_binding_display_name=None,
        decision_reason=None,
    )


class SyncStatusHealthTest(unittest.TestCase):
    def _app(self, sync: FakeSyncControl):
        return create_app(
            database_url="postgresql:///notalone_synthetic_test",
            owner_id=uuid4(),
            token="synthetic-token",
            sync_control=sync,
        )

    def _get_status(self, app):
        return app.handle(
            method="GET",
            path="/api/sync/status",
            headers={"Authorization": "Bearer synthetic-token"},
        )

    def test_status_payload_includes_health(self) -> None:
        app = self._app(
            FakeSyncControl(
                _report(),
                {
                    "healthy": False,
                    "failure_code": "sync_switch_unavailable",
                    "failed_at": "2026-10-22T00:00:00+00:00",
                },
            )
        )

        response = self._get_status(app)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["sync_enabled"])
        self.assertEqual(body["health"]["failure_code"], "sync_switch_unavailable")

    def test_unavailable_status_keeps_health_reason(self) -> None:
        app = self._app(
            FakeSyncControl(
                None,
                {
                    "healthy": False,
                    "failure_code": "sync_switch_unavailable",
                    "failed_at": None,
                },
            )
        )

        response = self._get_status(app)

        self.assertEqual(response.status_code, 503)
        body = response.json()
        self.assertEqual(body["error"], "sync_status_unavailable")
        self.assertEqual(body["health"]["failure_code"], "sync_switch_unavailable")

    def test_sync_port_without_health_keeps_existing_shape(self) -> None:
        class LegacySync:
            def status(self):
                return _report()

        app = self._app(LegacySync())  # type: ignore[arg-type]

        response = self._get_status(app)

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("health", response.json())
