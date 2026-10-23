"""只执行已授权历史页，不进入移交后的旧增量写路径。"""
from pathlib import Path
import hashlib
import importlib.util
import shutil
import sys
import tempfile
import unittest
from dataclasses import replace
from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

from tests.unit.front_sync import test_cli_history_sync as base
from notalone.front_sync.wechat_scope_remote import RemoteHistoryAuthorization
from notalone.persistence.history_sync_state import HistorySyncPhase
from notalone.persistence.observation_store import ObservationPersistenceError
from notalone.wechat_cli import CliCommandError

from notalone.front_sync import cli_sync as module

class SelectiveHistoryStore(base.FakeHistoryStateStore):
    def ensure_bindings_started(self, *, binding_ids, **kwargs):
        saved = self.bindings
        try:
            self.bindings = [b for b in saved if b.binding_id in binding_ids]
            return super().ensure_scope_started(**kwargs)
        finally:
            self.bindings = saved

class NoIncrementalObservation(base.FakeObservationStore):
    def ensure_baseline(self, **kwargs):
        raise AssertionError('history_only touched baseline')
    def read_cursor(self, **kwargs):
        raise AssertionError('history_only read incremental cursor')
    def read_reliable_cursor(self, **kwargs):
        raise AssertionError('history_only reconciled incremental cursor')
    def rewind_cursor(self, **kwargs):
        raise AssertionError('history_only rewound incremental cursor')

class ForbiddenBackfill:
    def __getattr__(self, name):
        raise AssertionError('history_only touched cli_backfill_state: ' + name)

class HistoryOnlyPatchTest(unittest.TestCase):
    def setUp(self):
        self.now = base.NOW
        self.binding = base.FakeBinding(base.BINDING_ID, base.CONTACT_ID)
        self.bindings = [self.binding]
        self.allowed = {base.BINDING_ID}
        self.authorization_error = False
        def authorized_binding_ids(**scope):
            if self.authorization_error:
                raise RuntimeError('synthetic authorization unavailable')
            return frozenset(self.allowed)
        self.authorization = RemoteHistoryAuthorization(SimpleNamespace(authorized_binding_ids=authorized_binding_ids))
        self.cli = base.FakeHistoryCli()
        self.history = SelectiveHistoryStore()
        self.history.bindings = self.bindings
        self.observations = NoIncrementalObservation(self.history, lambda: self.now)
        self.sync = self.make_sync()

    def make_sync(self, authorization=None):
        return module.CliBackgroundSync(
            owner_id=base.OWNER_ID, channel='wechat', account_scope='synthetic-account',
            cli=self.cli, bindings=self.bindings, observation_store=self.observations,
            history_state=self.history, history_authorization=authorization or self.authorization,
            backfill_state=ForbiddenBackfill(), history_only=True, clock=lambda: self.now,
        )

    def test_history_pages_only_then_no_incremental_fallthrough(self):
        self.cli.history_pages[None] = base._page((5,), has_more=True, cursor='opaque_a')
        self.cli.history_pages['opaque_a'] = base._page((2,), has_more=False, cursor='opaque_b')
        self.sync.cycle(enabled=True, max_bindings=1)
        self.assertFalse(self.observations.recorded[0]['advance_cursor'])
        self.assertFalse(self.observations.recorded[0]['is_reliable'])
        self.assertEqual(self.observations.cursors, {})
        self.sync.cycle(enabled=True, max_bindings=1)
        self.assertTrue(self.observations.recorded[1]['history_checkpoint'].complete)
        self.assertTrue(self.observations.recorded[1]['is_reliable'])
        self.assertEqual(self.history.states[base.BINDING_ID].phase, HistorySyncPhase.COMPLETE)
        for _ in range(3):
            result = self.sync.cycle(enabled=True, max_bindings=1)
        self.assertEqual(len(self.cli.calls), 2)
        self.assertTrue(all(c.get('history') is True for c in self.cli.calls))
        self.assertNotIn('follow', self.cli.command_calls)
        self.assertFalse(result.status.stream_active)
        self.assertIsNone(result.status.stream_mode)
        self.assertEqual(len(result.status.history_coverages), 1)

    def test_only_per_binding_authorized_tasks_start(self):
        other = base.FakeBinding(uuid4(), uuid4(), 'synthetic_ungranted')
        self.bindings.append(other)
        self.cli.history_pages[None] = base._page((1,), has_more=False, cursor='done')
        self.sync.cycle(enabled=True)
        self.assertNotIn(other.binding_id, self.history.states)
        self.assertEqual([c['talker'] for c in self.cli.calls], [self.binding.conversation_locator])
        old = self.make_sync(authorization=base.FakeAuthorization())
        result = old.cycle(enabled=True)
        self.assertEqual(result.status.failure_code, 'history_authorization_required')
        self.assertEqual(old.start_history_for_bindings(self.bindings), 0)
        self.assertEqual(len(self.cli.calls), 1)

    def test_offline_grant_error_and_disabled_never_read(self):
        self.authorization_error = True
        result = self.sync.cycle(enabled=True)
        self.assertEqual(result.status.failure_code, 'history_authorization_unavailable')
        self.assertEqual(self.cli.calls, [])
        self.authorization_error = False
        self.sync.cycle(enabled=False)
        self.assertEqual(self.history.states, {})
        self.assertEqual(self.cli.command_calls, [])

    def test_revocation_after_cli_return_discards_late_page(self):
        self.cli.history_pages[None] = base._page((1,), has_more=False, cursor='late')
        original = self.cli.tail
        def tail(*args, **kwargs):
            result = original(*args, **kwargs)
            self.allowed.clear()
            return result
        self.cli.tail = tail
        result = self.sync.cycle(enabled=True)
        self.assertEqual(result.status.failure_code, 'history_authorization_required')
        self.assertEqual(self.observations.recorded, [])
        self.assertEqual(self.observations.cursors, {})

    def test_pause_retry_start_and_disabled_keep_history_contract(self):
        self.cli.errors[None] = CliCommandError('cli_timeout', 'synthetic timeout')
        self.sync.cycle(enabled=True)
        first = len(self.cli.calls)
        self.sync.cycle(enabled=True)
        self.assertEqual(len(self.cli.calls), first)
        self.cli.errors.clear()
        self.cli.history_pages[None] = base._page((1,), has_more=False, cursor='done')
        self.sync.pause_backfill()
        self.sync.retry_backfill()
        self.sync.request_backfill_check()
        self.sync.cycle(enabled=False)
        self.assertEqual(len(self.cli.calls), first)
        result = self.sync.cycle(enabled=True)
        self.assertEqual(len(self.cli.calls), first + 1)
        self.assertEqual(result.batch_message_count, 1)

    def test_restored_completed_history_never_reads_incremental(self):
        self.cli.history_pages[None] = base._page((1,), has_more=False, cursor='done')
        self.sync.cycle(enabled=True)
        self.history.states[base.BINDING_ID] = replace(self.history.states[base.BINDING_ID], phase=HistorySyncPhase.INCOMPLETE, failure_code='cli_scope_unverified')
        self.sync.cycle(enabled=True)
        self.assertEqual(self.history.states[base.BINDING_ID].phase, HistorySyncPhase.COMPLETE)
        self.assertEqual(len(self.cli.calls), 1)

    def test_failure_trace_write_failure_never_touches_backfill(self):
        error = CliCommandError('cli_output_invalid', 'synthetic invalid')
        error.failure_record = SimpleNamespace()
        self.cli.errors[None] = error
        def record_input_failure(**kwargs):
            raise ObservationPersistenceError('synthetic write failure')
        self.observations.record_input_failure = record_input_failure
        result = self.sync.cycle(enabled=True)
        self.assertEqual(result.status.failure_code, 'observation_persistence_failed')
        self.assertEqual(self.observations.recorded, [])

if __name__ == '__main__':
    unittest.main()
