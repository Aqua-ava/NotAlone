"""后端未预期异常的诊断日志；不连接数据库，不记录请求正文。"""

from __future__ import annotations

import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.server.app import BackendApp, create_app
from notalone.server.sync_host import SyncHostStopped


class RequestErrorLoggingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.app = create_app(
            database_url="postgresql:///notalone_synthetic_test",
            owner_id=uuid4(),
            token="synthetic-token",
        )

    def test_unexpected_exception_logs_method_and_path_without_body(self) -> None:
        headers = {"Authorization": "Bearer synthetic-token"}
        with patch.object(
            BackendApp, "_handle_authenticated", side_effect=RuntimeError("internal detail")
        ), self.assertLogs("notalone.server.app", level="ERROR") as captured:
            response = self.app.handle(
                method="POST",
                path="/api/contacts/abc/memories?secret=query",
                headers=headers,
                body=b'{"content": "private-message"}',
            )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json(), {"error": "internal_error"})
        joined = "\n".join(captured.output)
        self.assertIn("method=POST", joined)
        self.assertIn("/api/contacts/abc/memories", joined)
        self.assertNotIn("private-message", joined)
        self.assertNotIn("secret=query", joined)

    def test_expected_domain_errors_are_not_logged_as_unexpected(self) -> None:
        headers = {"Authorization": "Bearer synthetic-token"}
        with self.assertNoLogs("notalone.server.app", level="ERROR"):
            with patch.object(
                BackendApp, "_handle_authenticated", side_effect=SyncHostStopped("stopped")
            ):
                response = self.app.handle(
                    method="GET", path="/api/sync/status", headers=headers
                )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"error": "runtime_stopping"})


class _RaisingFollowSmoke:
    """合成替身：handler 内抛出未预期异常，用于验证 500 记录点。"""

    def status(self):
        raise RuntimeError("synthetic status failure")

    def start(self):
        raise RuntimeError("synthetic start failure")

    def stop(self):
        raise RuntimeError("synthetic stop failure")

    def interrupt(self):
        raise RuntimeError("synthetic interrupt failure")

    def checkpoint(self, label):
        raise RuntimeError("synthetic checkpoint failure")


class HandlerErrorLoggingTest(unittest.TestCase):
    def test_handler_level_500_logs_method_path_and_error_code(self) -> None:
        app = create_app(
            database_url="postgresql:///notalone_synthetic_test",
            owner_id=uuid4(),
            token="synthetic-token",
            follow_smoke=_RaisingFollowSmoke(),
        )
        headers = {"Authorization": "Bearer synthetic-token"}
        with self.assertLogs("notalone.server.app", level="ERROR") as captured:
            response = app.handle(
                method="POST",
                path="/api/sync/follow-smoke/checkpoint?secret=query",
                headers=headers,
                body=b'{"label": "private-message"}',
            )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json(), {"error": "follow_smoke_failed"})
        joined = "\n".join(captured.output)
        self.assertIn("method=POST", joined)
        self.assertIn("path=/api/sync/follow-smoke/checkpoint", joined)
        self.assertIn("error_code=follow_smoke_failed", joined)
        self.assertNotIn("private-message", joined)
        self.assertNotIn("secret=query", joined)
        self.assertNotIn("synthetic-token", joined)
