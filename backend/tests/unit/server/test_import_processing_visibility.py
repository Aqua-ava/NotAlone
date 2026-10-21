"""导入后后台提取被延后时的可见性；使用 fake 端口，不连接数据库。"""

from __future__ import annotations

import json
import unittest
from uuid import UUID, uuid4

from notalone.server.app import BackendApp
from notalone.server.event_bus import EventBus


class FakeImportService:
    def __init__(self, contact_id: UUID, task_id: UUID) -> None:
        self.contact_id = contact_id
        self.task_id = task_id

    def commit(self, **kwargs):
        return {
            "contact_id": str(self.contact_id),
            "task_id": str(self.task_id),
            "message_count": 3,
        }


class FakeTaskHost:
    def __init__(self, *, raises: bool = False) -> None:
        self.raises = raises
        self.calls: list[dict] = []

    def wake(self, **kwargs) -> None:
        self.calls.append(kwargs)
        if self.raises:
            raise RuntimeError("synthetic wake failure")


class FakeTaskService:
    def __init__(self, *, raises: bool = False) -> None:
        self.raises = raises
        self.calls: list[dict] = []

    def defer(self, **kwargs) -> None:
        self.calls.append(kwargs)
        if self.raises:
            raise RuntimeError("synthetic defer failure")


class ImportProcessingVisibilityTest(unittest.TestCase):
    def setUp(self) -> None:
        self.owner = uuid4()
        self.contact = uuid4()
        self.task = uuid4()
        self.headers = {"Authorization": "Bearer synthetic-token"}

    def _app(self, *, task_host=None, task_service=None) -> BackendApp:
        return BackendApp(
            contact_directory=object(),
            events=EventBus(),
            owner_id=self.owner,
            token="synthetic-token",
            import_service=FakeImportService(self.contact, self.task),
            task_host=task_host,
            task_service=task_service,
        )

    def _commit(self, app: BackendApp):
        return app.handle(
            method="POST",
            path="/api/imports/commit",
            headers=self.headers,
            body=json.dumps(
                {"path": "/tmp/synthetic-import.json", "contact_id": str(self.contact)}
            ).encode(),
        )

    def _runtime_status(self, app: BackendApp):
        return app.handle(
            method="GET", path="/api/runtime/status", headers=self.headers
        ).json()

    def test_missing_task_host_marks_processing_deferred_and_degraded(self) -> None:
        task_service = FakeTaskService()
        app = self._app(task_host=None, task_service=task_service)

        response = self._commit(app)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["processing_deferred"])
        self.assertEqual(body["deferred_reason"], "task_host_unavailable")
        self.assertEqual(len(task_service.calls), 1)
        status = self._runtime_status(app)
        self.assertEqual(status["degraded"][0]["code"], "import_processing_deferred")
        self.assertEqual(status["degraded"][0]["reason"], "task_host_unavailable")

    def test_wake_failure_is_visible_and_logged(self) -> None:
        task_host = FakeTaskHost(raises=True)
        task_service = FakeTaskService()
        app = self._app(task_host=task_host, task_service=task_service)

        with self.assertLogs("notalone.server.app", level="WARNING") as captured:
            response = self._commit(app)

        body = response.json()
        self.assertEqual(body["processing_deferred"], True)
        self.assertEqual(body["deferred_reason"], "wake_failed")
        self.assertEqual(len(task_service.calls), 1)
        self.assertIn("import_task_wake_failed", "\n".join(captured.output))
        self.assertNotIn("synthetic wake failure", "\n".join(captured.output))

    def test_defer_failure_is_visible(self) -> None:
        app = self._app(task_host=None, task_service=FakeTaskService(raises=True))

        response = self._commit(app)

        body = response.json()
        self.assertEqual(body["deferred_reason"], "defer_failed")
        status = self._runtime_status(app)
        self.assertEqual(status["degraded"][0]["reason"], "defer_failed")

    def test_successful_wake_keeps_old_shape_and_clears_degraded(self) -> None:
        app = self._app(task_host=FakeTaskHost(raises=True), task_service=FakeTaskService())
        self._commit(app)
        self.assertIn("degraded", self._runtime_status(app))

        app = self._app(task_host=FakeTaskHost(), task_service=FakeTaskService())
        response = self._commit(app)

        body = response.json()
        self.assertNotIn("processing_deferred", body)
        self.assertNotIn("degraded", self._runtime_status(app))
