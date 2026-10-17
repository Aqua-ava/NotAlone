"""限定关键词的管理页输入适配；只有公开确认才创建合成绑定。"""

from dataclasses import replace
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from uuid import UUID
from unittest.mock import patch

from tests.unit.front_sync import test_cli_binding as binding_fixture
from tests.unit.wechat_cli import test_acceptance_scope as scope_fixture

fixture = scope_fixture.fixture


class AcceptanceBindingListingTest(unittest.TestCase):
    def setUp(self):
        base = scope_fixture.AcceptanceScopeTest()
        base.setUp()
        self.scope = replace(base.scope, metadata_name="合成测试名")
        self.runner = scope_fixture.SyntheticRunner(scope_fixture.FakeResult(stdout=json.dumps({
            "ok": True, "data": {"sessions": [
                {"username": "synthetic-selected", "display_name": "合成测试名",
                 "chat_type": "private", "summary": "不应转交的合成预览"},
                {"username": "synthetic-other", "display_name": "合成测试名",
                 "chat_type": "private", "last_sender_display_name": "合成发送者"},
                {"username": "synthetic-selected", "display_name": "合成测试名",
                 "chat_type": "private"},
                {"username": "synthetic-group", "display_name": "合成测试名",
                 "chat_type": "group"},
            ]}})))
        self.cli = fixture.build_scoped_cli(self.scope, runner=self.runner,
                                           clock=lambda: 1791782460.0)
        self.repository = binding_fixture.FakeBatchRepository()
        self.coordinator = binding_fixture.CliBindingCoordinator(
            owner_id=binding_fixture.OWNER_ID, channel="wechat", account_scope="synthetic",
            cli=self.cli, bindings=binding_fixture.FakeBindings(),
            batch_repository=self.repository)

    def test_explicit_adapter_allows_public_preview_without_precreating_bindings(self):
        # 未提供适配器的基线保持原守卫，用同一生产管理页调用复现拒绝。
        getattr(fixture, "adapt_binding_session_listing", lambda cli: None)(self.cli)
        candidates = self.coordinator.list_candidates()
        self.assertEqual([item.username for item in candidates],
                         ["synthetic-selected", "synthetic-other", "synthetic-selected"])
        self.assertTrue(all(item.bound_contact_id is None for item in candidates))
        self.assertEqual(self.repository.calls, [])
        self.assertEqual(self.runner.calls, [(str(self.scope.real_cli), "sessions", "--keyword",
            self.scope.metadata_name, "--type-filter", "all", "--limit", "51", "--strict-read-only")])

    def test_default_guard_and_missing_metadata_authorization_stay_closed(self):
        with self.assertRaises(fixture.CliCommandError):
            self.coordinator.list_candidates()
        cli = fixture.build_scoped_cli(replace(self.scope, metadata_name=None),
            runner=self.runner, clock=lambda: 1791782460.0)
        with self.assertRaises(fixture.CliCommandError):
            fixture.adapt_binding_session_listing(cli)
        self.assertEqual(self.runner.calls, [])

    def test_confirm_rereads_candidates_and_writes_only_explicit_selection(self):
        fixture.adapt_binding_session_listing(self.cli)
        self.coordinator.list_candidates()
        contact_id = UUID("33333333-3333-3333-3333-333333333333")
        result = self.coordinator.confirm((binding_fixture.CliBindingSelection(
            locator="synthetic-other", contact_id=contact_id,
            observed_display_name=self.scope.metadata_name),))
        self.assertEqual(len(self.runner.calls), 2)
        self.assertEqual(len(self.repository.calls), 1)
        self.assertEqual(len(self.repository.calls[0]), 1)
        self.assertEqual(self.repository.calls[0][0].conversation_locator, "synthetic-other")
        self.assertEqual(result[0].scope.contact_id, contact_id)

    def test_group_unknown_and_changed_name_cannot_be_confirmed(self):
        fixture.adapt_binding_session_listing(self.cli)
        for locator, name in (("synthetic-group", self.scope.metadata_name),
                              ("synthetic-unlisted", self.scope.metadata_name),
                              ("synthetic-selected", "合成旧名称")):
            with self.subTest(locator=locator, name=name), self.assertRaises(ValueError):
                self.coordinator.confirm((binding_fixture.CliBindingSelection(
                    locator=locator, observed_display_name=name),))
        self.assertEqual(self.repository.calls, [])

    def test_only_exact_management_signature_is_adapted(self):
        fixture.adapt_binding_session_listing(self.cli)
        for args, kwargs in (
            (("synthetic",), {"type_filter": "private", "limit": 5000}),
            ((), {"type_filter": "all", "limit": 5000}),
            ((), {"type_filter": "private", "limit": 4999}),
            ((), {"type_filter": "private", "limit": 5000.0}),
            ((), {"type_filter": "private", "limit": 5000, "keyword": "未声明关键词"}),
            ((), {"type_filter": "private", "limit": 5000, "timeout_seconds": 1}),
        ):
            with self.subTest(args=args, kwargs=kwargs), self.assertRaises(fixture.CliCommandError):
                self.cli.sessions(*args, **kwargs)
        self.assertEqual(self.runner.calls, [])

    def test_original_foreground_metadata_keeps_groups_and_strips_previews(self):
        fixture.adapt_binding_session_listing(self.cli)
        values = self.cli.sessions(keyword=self.scope.metadata_name, type_filter="all", limit=51)
        self.assertEqual([item.chat_type for item in values],
                         ["private", "private", "private", "group"])
        self.assertTrue(all(item.summary is None and item.last_sender_display_name is None
                            for item in values))
        values = self.cli.sessions(type_filter="private", limit=5000)
        self.assertTrue(all(item.summary is None and item.last_sender_display_name is None
                            for item in values))

    def test_adapter_does_not_grant_tail_access_to_same_name_candidates(self):
        fixture.adapt_binding_session_listing(self.cli)
        self.coordinator.list_candidates()
        with self.assertRaises(fixture.CliCommandError):
            self.cli.tail("synthetic-other", since_time="2026-10-12T13:21:00")
        self.assertEqual(len(self.runner.calls), 1)

    def test_original_error_identity_and_expired_window_are_preserved(self):
        error = fixture.CliCommandError("synthetic_failed", "合成错误")
        with patch.object(self.cli, "sessions", side_effect=error):
            fixture.adapt_binding_session_listing(self.cli)
            with self.assertRaises(fixture.CliCommandError) as raised:
                self.cli.sessions(type_filter="private", limit=5000)
            self.assertIs(raised.exception, error)
        cli = fixture.build_scoped_cli(self.scope, runner=self.runner,
            clock=lambda: self.scope.until)
        fixture.adapt_binding_session_listing(cli)
        with self.assertRaises(fixture.CliCommandError) as expired:
            cli.sessions(type_filter="private", limit=5000)
        self.assertEqual(expired.exception.code, "acceptance_window_expired")
        self.assertEqual(self.runner.calls, [])

    def budgeted_cli(self, minimum_seconds=0.4, completed=None, remaining=None):
        output = self.runner.result.stdout

        class BudgetedProcess(scope_fixture.SyntheticProcess):
            def __init__(self):
                super().__init__()
                self.timeouts = []

            def communicate(self, timeout=None):
                self.timeouts.append(timeout)
                if self.returncode is not None:
                    return "", ""
                if timeout is not None and timeout < minimum_seconds:
                    raise subprocess.TimeoutExpired("synthetic-metadata", timeout)
                if completed is not None:
                    completed()
                self.returncode = 0
                return output, ""

        directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        scope = replace(self.scope, audit_path=directory / "audit.jsonl",
                        pid_audit_path=directory / "pids.jsonl")
        owned = BudgetedProcess()
        clock = lambda: 1791782460.0 if remaining is None else scope.until - remaining
        cli = fixture.build_scoped_cli(scope, process_factory=lambda *args, **kwargs: owned, clock=clock)
        self.addCleanup(cli.close)
        return cli, owned, scope

    def test_management_metadata_has_separate_bounded_budget(self):
        cli, owned, scope = self.budgeted_cli()
        fixture.adapt_binding_session_listing(cli)
        candidates = cli.sessions(type_filter="private", limit=5000)
        self.assertEqual(len(candidates), 3)
        self.assertGreater(owned.timeouts[0], 0.4)
        self.assertLessEqual(owned.timeouts[0], 2.0)
        self.assertEqual(owned.returncode, 0)
        audit = [json.loads(line) for line in scope.audit_path.read_text().splitlines()]
        self.assertTrue(all(row["kind"] == "binding_metadata" for row in audit))
        self.assertEqual(audit[-1]["event"], "metadata")

    def test_adapted_cli_foreground_metadata_still_has_250ms_budget(self):
        cli, owned, scope = self.budgeted_cli()
        fixture.adapt_binding_session_listing(cli)
        with self.assertRaises(fixture.CliCommandError) as raised:
            cli.sessions(keyword=self.scope.metadata_name, type_filter="all", limit=51)
        self.assertEqual(raised.exception.code, "acceptance_cli_timeout")
        self.assertLessEqual(owned.timeouts[0], 0.25)
        self.assertEqual(owned.returncode, -9)
        audit = [json.loads(line) for line in scope.audit_path.read_text().splitlines()]
        self.assertTrue(all(row["kind"] == "foreground_metadata" for row in audit))

    def test_management_budget_is_bounded_and_context_resets_after_timeout(self):
        cli, owned, scope = self.budgeted_cli(minimum_seconds=2.1)
        fixture.adapt_binding_session_listing(cli)
        with self.assertRaises(fixture.CliCommandError) as raised:
            cli.sessions(type_filter="private", limit=5000)
        self.assertEqual(raised.exception.code, "acceptance_cli_timeout")
        self.assertLessEqual(owned.timeouts[0], 2.0)
        self.assertEqual(owned.returncode, -9)
        self.assertIsNone(fixture._binding_listing_guard.get())
        audit = [json.loads(line) for line in scope.audit_path.read_text().splitlines()]
        self.assertEqual(audit[-1]["kind"], "binding_metadata")
        self.assertEqual(audit[-1]["returncode"], -9)

    def test_management_result_after_its_deadline_is_rejected(self):
        now = [0.0]
        cli, owned, _ = self.budgeted_cli(completed=lambda: now.__setitem__(0, 2.01))
        fixture.adapt_binding_session_listing(cli)
        with patch.object(fixture.time, "monotonic", side_effect=lambda: now[0]):
            with self.assertRaises(fixture.CliCommandError) as raised:
                cli.sessions(type_filter="private", limit=5000)
        self.assertEqual(owned.returncode, 0)
        self.assertEqual(raised.exception.code, "acceptance_cli_timeout")
        self.assertIsNone(fixture._binding_listing_guard.get())

    def test_management_timeout_cannot_outlive_the_scope(self):
        cli, owned, _ = self.budgeted_cli(remaining=0.1)
        fixture.adapt_binding_session_listing(cli)
        with self.assertRaises(fixture.CliCommandError) as raised:
            cli.sessions(type_filter="private", limit=5000)
        self.assertEqual(raised.exception.code, "acceptance_cli_timeout")
        self.assertLessEqual(owned.timeouts[0], 0.101)
        self.assertEqual(owned.returncode, -9)

    def test_management_context_is_only_for_same_guard_session_command(self):
        other = fixture.build_scoped_cli(self.scope, runner=self.runner,
                                         clock=lambda: 1791782460.0)
        command = (str(self.scope.real_cli), "sessions", "--keyword", self.scope.metadata_name,
                   "--type-filter", "all", "--limit", "51", "--strict-read-only")
        token = fixture._binding_listing_guard.set(self.cli.guard)
        try:
            self.assertEqual(self.cli.guard.command_kind(command), "binding_metadata")
            self.assertEqual(other.guard.command_kind(command), "foreground_metadata")
            self.assertEqual(self.cli.guard.command_kind((str(self.scope.real_cli), "resolve-chat",
                self.scope.metadata_name, "--strict-read-only")), "foreground_metadata")
        finally:
            fixture._binding_listing_guard.reset(token)
        self.assertEqual(self.cli.guard.command_kind(command), "foreground_metadata")


if __name__ == "__main__":
    unittest.main()
