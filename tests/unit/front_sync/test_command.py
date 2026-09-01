"""前台同步命令的展示与参数门禁测试；不连接数据库或真实探针。"""

from __future__ import annotations

import contextlib
import io
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from notalone.conversation.matcher import BindingMatchReason
from notalone.front_sync import FrontSyncPhase
from notalone.front_sync.command import front_sync_main, render_report_lines
from notalone.front_sync.sync_engine import (
    BindingCandidateView,
    FrontSyncCycleReport,
)


class RenderReportLinesTest(unittest.TestCase):
    def test_renders_status_fields_and_candidates(self) -> None:
        report = FrontSyncCycleReport(
            sync_enabled=True,
            phase=FrontSyncPhase.UNAVAILABLE,
            probe_available=True,
            wechat_in_front=True,
            cli_available=True,
            failure_code=None,
            active_contact_id=None,
            active_binding_display_name=None,
            decision_reason=BindingMatchReason.AMBIGUOUS_REQUIRES_SELECTION,
            candidates=(
                BindingCandidateView(
                    username="wxid_one",
                    display_name="合成甲",
                    last_timestamp=1787486383,
                ),
                BindingCandidateView(
                    username="wxid_two",
                    display_name="合成甲",
                    last_timestamp=None,
                ),
            ),
            batch_message_count=0,
        )

        rendered = "\n".join(render_report_lines(report))

        self.assertIn("sync=enabled", rendered)
        self.assertIn("phase=unavailable", rendered)
        self.assertIn("probe=ok", rendered)
        self.assertIn("wechat_front=yes", rendered)
        self.assertIn("cli=ok", rendered)
        self.assertIn("decision=ambiguous_requires_selection", rendered)
        self.assertIn("candidate[1] username=wxid_one", rendered)
        self.assertIn("candidate[2] username=wxid_two", rendered)
        self.assertIn("last_active=1787486383", rendered)
        self.assertIn("last_active=unknown", rendered)

    def test_renders_active_contact_without_candidates(self) -> None:
        contact_id = uuid4()
        report = FrontSyncCycleReport(
            sync_enabled=True,
            phase=FrontSyncPhase.ACTIVE,
            probe_available=True,
            wechat_in_front=True,
            cli_available=True,
            failure_code=None,
            active_contact_id=contact_id,
            active_binding_display_name="合成甲",
            decision_reason=BindingMatchReason.CONFIRMED_ACTIVE_BINDING,
            candidates=(),
            batch_message_count=3,
        )

        rendered = "\n".join(render_report_lines(report))

        self.assertIn(f"contact_id={contact_id}", rendered)
        self.assertIn("binding_display=合成甲", rendered)
        self.assertIn("batch_messages=3", rendered)
        self.assertNotIn("candidate[", rendered)

    def test_renders_failure_code(self) -> None:
        report = FrontSyncCycleReport(
            sync_enabled=True,
            phase=FrontSyncPhase.FAILED,
            probe_available=True,
            wechat_in_front=True,
            cli_available=False,
            failure_code="cli_not_found",
            active_contact_id=None,
            active_binding_display_name=None,
            decision_reason=None,
        )

        rendered = "\n".join(render_report_lines(report))

        self.assertIn("failure=cli_not_found", rendered)
        self.assertIn("cli=unavailable", rendered)

    def test_renders_independent_cli_and_foreground_status(self) -> None:
        report = FrontSyncCycleReport(
            sync_enabled=True,
            phase=FrontSyncPhase.ACTIVE,
            probe_available=False,
            wechat_in_front=False,
            cli_available=True,
            failure_code=None,
            active_contact_id=None,
            active_binding_display_name=None,
            decision_reason=None,
            sync_mode="cli_background",
            cli_sync_phase="active",
            cli_sync_mode="global_follow",
            cli_stream_active=True,
            cli_bound_count=4,
            cli_pending_count=1,
            cli_batch_message_count=2,
            foreground_phase="failed",
            foreground_failure_code="screen_capture_permission_missing",
        )

        rendered = "\n".join(render_report_lines(report))

        self.assertIn("sync_mode=cli_background", rendered)
        self.assertIn("cli_mode=global_follow", rendered)
        self.assertIn("cli_stream=active", rendered)
        self.assertIn("cli_bound=4", rendered)
        self.assertIn("foreground_phase=failed", rendered)
        self.assertIn(
            "foreground_failure=screen_capture_permission_missing",
            rendered,
        )


class FrontSyncMainGateTest(unittest.TestCase):
    def test_contacts_uses_shared_contact_directory(self) -> None:
        owner_id = uuid4()
        contact_id = uuid4()
        stdout = io.StringIO()
        with patch.dict(
            os.environ,
            {
                "NOTALONE_DISABLE_DOTENV": "1",
                "NOTALONE_DATABASE_URL": "postgresql:///notalone_test",
                "NOTALONE_OWNER_ID": str(owner_id),
            },
            clear=True,
        ), patch(
            "notalone.front_sync.command.PostgresContactDirectory"
        ) as directory_type, contextlib.redirect_stdout(stdout):
            directory_type.return_value.list_contacts.return_value = (
                SimpleNamespace(
                    contact_id=contact_id,
                    display_name="合成联系人",
                ),
            )

            exit_code = front_sync_main(["contacts"])

        self.assertEqual(exit_code, 0)
        directory_type.assert_called_once_with("postgresql:///notalone_test")
        directory_type.return_value.list_contacts.assert_called_once_with(owner_id)
        self.assertEqual(
            stdout.getvalue().strip(),
            f"contact_id={contact_id} display_name=合成联系人",
        )

    def test_missing_database_url_fails_before_any_probe_call(self) -> None:
        stderr = io.StringIO()
        with patch.dict(
            os.environ,
            {"NOTALONE_DISABLE_DOTENV": "1"},
            clear=True,
        ), contextlib.redirect_stderr(stderr):
            exit_code = front_sync_main(["status"])

        self.assertEqual(exit_code, 2)
        self.assertIn("NOTALONE_DATABASE_URL", stderr.getvalue())

    def test_missing_owner_id_fails(self) -> None:
        stderr = io.StringIO()
        with patch.dict(
            os.environ,
            {
                "NOTALONE_DISABLE_DOTENV": "1",
                "NOTALONE_DATABASE_URL": "postgresql:///notalone_test",
            },
            clear=True,
        ), contextlib.redirect_stderr(stderr):
            exit_code = front_sync_main(["status"])

        self.assertEqual(exit_code, 2)
        self.assertIn("NOTALONE_OWNER_ID", stderr.getvalue())

    def test_invalid_owner_uuid_fails(self) -> None:
        stderr = io.StringIO()
        with patch.dict(
            os.environ,
            {
                "NOTALONE_DISABLE_DOTENV": "1",
                "NOTALONE_DATABASE_URL": "postgresql:///notalone_test",
                "NOTALONE_OWNER_ID": "不是UUID",
            },
            clear=True,
        ), contextlib.redirect_stderr(stderr):
            exit_code = front_sync_main(["status"])

        self.assertEqual(exit_code, 2)
        self.assertIn("UUID", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
