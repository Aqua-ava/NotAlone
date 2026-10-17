"""限定关键词的管理页输入适配；只有公开确认才创建合成绑定。"""

from dataclasses import replace
import json
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


if __name__ == "__main__":
    unittest.main()
