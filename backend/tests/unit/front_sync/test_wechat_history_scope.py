"""TS 绑定授权快照在旧正文读取器中的隔离与撤销回归。"""
import unittest
from unittest.mock import Mock
from uuid import UUID

from notalone.front_sync.wechat_scope_remote import RemoteHistoryAuthorization
from tests.unit.front_sync import test_cli_history_sync as history_fixture
from tests.unit.front_sync.test_cli_history_sync import FakeBinding, BINDING_ID, CONTACT_ID, _page


class WechatHistoryScopeTest(unittest.TestCase):
    def setUp(self):
        self.fixture = history_fixture.HistorySyncEngineTest()
        self.fixture.setUp()
        self.allowed = frozenset([BINDING_ID])
        self.remote = Mock()
        self.remote.authorized_binding_ids.side_effect = lambda **scope: self.allowed
        self.fixture.authorization = RemoteHistoryAuthorization(self.remote)
        self.sync = self.fixture.make_sync()
        self.ensure_ids = []
        def ensure_bindings_started(*, binding_ids, **kwargs):
            self.ensure_ids.append(binding_ids)
            original = self.fixture.history.bindings
            try:
                self.fixture.history.bindings = [b for b in original if b.binding_id in binding_ids]
                return self.fixture.history.ensure_scope_started(**kwargs)
            finally:
                self.fixture.history.bindings = original
        self.fixture.history.ensure_bindings_started = ensure_bindings_started
        self.fixture.cli.history_pages[None] = _page((1, 2), has_more=True, cursor="synthetic-2")

    def test_new_binding_never_inherits_existing_authorization(self):
        new_id = UUID("44444444-4444-4444-4444-444444444444")
        new = FakeBinding(new_id, CONTACT_ID, "synthetic-new")
        self.fixture.history.bindings.append(new)
        self.sync._ensure_history_tasks([self.fixture.binding, new])
        self.assertEqual(self.ensure_ids, [(BINDING_ID,)])
        self.assertNotIn(new_id, self.fixture.history.states)
        self.assertEqual(self.sync.start_history_for_bindings([new]), 0)

    def test_explicit_authorization_continues_existing_history_checkpoint(self):
        self.sync.cycle(enabled=True)
        self.assertEqual(len(self.fixture.observations.recorded), 1)
        self.assertEqual(self.fixture.history.states[BINDING_ID].last_cursor, "synthetic-2")
        self.fixture.cli.history_pages["synthetic-2"] = _page((3,), has_more=False, cursor="synthetic-3")
        self.sync.request_history_start()
        self.sync.cycle(enabled=True)
        self.assertEqual(len(self.fixture.observations.recorded), 2)
        self.assertEqual(self.fixture.cli.calls[-1]["cursor"], "synthetic-2")

    def test_saved_history_task_without_snapshot_cannot_read(self):
        self.sync._ensure_history_tasks([self.fixture.binding])
        self.allowed = frozenset()
        self.sync.cycle(enabled=True)
        self.assertEqual(self.fixture.cli.calls, [])
        self.assertEqual(self.fixture.observations.recorded, [])
        self.assertIsNone(self.fixture.history.states[BINDING_ID].last_cursor)

    def test_late_history_page_after_revoke_is_not_committed(self):
        original = self.fixture.cli.tail
        def revoke_after_read(*args, **kwargs):
            result = original(*args, **kwargs)
            self.allowed = frozenset()
            return result
        self.fixture.cli.tail = revoke_after_read
        self.sync.cycle(enabled=True)
        self.assertEqual(len(self.fixture.cli.calls), 1)
        self.assertEqual(self.fixture.observations.recorded, [])
        self.assertIsNone(self.fixture.history.states[BINDING_ID].last_cursor)

    def test_snapshot_failure_preserves_task_without_reading(self):
        self.sync._ensure_history_tasks([self.fixture.binding])
        self.remote.authorized_binding_ids.side_effect = RuntimeError("synthetic failure")
        self.sync.cycle(enabled=True)
        self.assertEqual(self.fixture.cli.calls, [])
        self.assertEqual(self.fixture.observations.recorded, [])

    def test_new_explicit_consent_is_detected_with_unchanged_binding_set(self):
        self.allowed = frozenset()
        self.sync._ensure_history_tasks([self.fixture.binding])
        self.assertEqual(self.ensure_ids, [])
        self.allowed = frozenset([BINDING_ID])
        self.sync._ensure_history_tasks([self.fixture.binding])
        self.assertEqual(self.ensure_ids, [(BINDING_ID,)])
