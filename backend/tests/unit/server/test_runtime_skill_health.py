"""运行时状态投影 Skill 文件健康度；使用 fake 端口，不连接数据库。"""

from __future__ import annotations

import unittest
from uuid import uuid4

from notalone.server.app import BackendApp
from notalone.server.event_bus import EventBus


class FakeSkillService:
    def __init__(self, *, health=None, error: Exception | None = None) -> None:
        self._health = health
        self._error = error

    def skill_file_health(self, *, owner_id):
        if self._error is not None:
            raise self._error
        return self._health


class RuntimeSkillHealthTest(unittest.TestCase):
    def _app(self, service) -> BackendApp:
        return BackendApp(
            contact_directory=object(),
            events=EventBus(),
            owner_id=uuid4(),
            token="synthetic-token",
            skill_service=service,
        )

    def _status(self, app):
        return app.handle(
            method="GET",
            path="/api/runtime/status",
            headers={"Authorization": "Bearer synthetic-token"},
        )

    def test_skill_file_health_is_exposed_without_sensitive_fields(self) -> None:
        service = FakeSkillService(
            health={
                "state": "degraded",
                "pending_working_copies": 1,
                "pending_cleanup_files": 0,
                "failures": [{"operation": "cleanup", "code": "permission_denied",
                              "skill_id": None}],
            }
        )
        response = self._status(self._app(service))

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["skill_files"]["state"], "degraded")
        self.assertEqual(body["skill_files"]["failures"][0]["code"], "permission_denied")

    def test_health_read_failure_does_not_break_runtime_status(self) -> None:
        service = FakeSkillService(error=RuntimeError("synthetic health failure"))
        with self.assertLogs("notalone.server.app", level="WARNING") as captured:
            response = self._status(self._app(service))

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("skill_files", response.json())
        joined = "\n".join(captured.output)
        self.assertIn("skill_file_health_unavailable", joined)
        self.assertNotIn("synthetic health failure", joined)


if __name__ == "__main__":
    unittest.main()
