"""真实 CLI 适配器与后台调度的分页回归，外部命令和数据库使用合成边界。"""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

from notalone.front_sync.cli_sync import CliBackgroundSync
from notalone.wechat_cli import LocalWechatCli
from notalone.persistence.observation_store import ObservationPersistenceError
from tests.unit.front_sync.test_cli_background_sync import (
    OWNER_ID,
    FakeBinding,
    FakeBackfillStateStore,
    FakeObservationStore,
)


class PaginatedRunner:
    def __init__(self) -> None:
        self.calls = []
        self.total = 77
        self.repeat_first_page = False
        self.non_text_first_page = False
        self.force_more = False
        self.fail_cursor = None

    def __call__(self, command):
        if command[1] == '--version':
            return SimpleNamespace(returncode=0, stdout=json.dumps({
                'ok': True, 'data': {'version': 'synthetic'},
            }), stderr='')
        assert command[1] == 'tail'
        cursor = command[command.index('--cursor') + 1] if '--cursor' in command else None
        self.calls.append((command[2], cursor))
        if cursor is not None and cursor == self.fail_cursor:
            return SimpleNamespace(returncode=1, stdout='', stderr='合成读取失败')
        start = int(cursor.split(':')[1]) if cursor else 0
        if self.repeat_first_page:
            start = 0
        stop = min(start + 50, self.total)
        events = [{
            'type': 'message', 'cursor': f'local_id:{index}',
            'message': {
                'id': {'local_id': index, 'talker': command[2]},
                'kind': 'image' if self.non_text_first_page and index <= 50 else 'text',
                'text': f'合成分页消息 {index}',
                'is_from_me': False, 'create_time': 1788256800,
            },
        } for index in range(start + 1, stop + 1)]
        return SimpleNamespace(returncode=0, stderr='', stdout=json.dumps({
            'ok': True, 'data': {
                'events': events,
                'freshness': {'message_source': 'live_message_db'},
                'query': {'chat': command[2], 'has_more': self.force_more or stop < self.total},
            },
        }))


class CliPaginationSyncTest(unittest.TestCase):
    def setUp(self) -> None:
        self.binding = FakeBinding(uuid4(), uuid4(), 'wxid_synthetic_a', '合成甲')
        self.runner = PaginatedRunner()
        self.store = FakeObservationStore()
        self.now = datetime(2026, 9, 1, 10, tzinfo=timezone.utc)
        self.sync = self.make_sync()

    def make_sync(self, *, bindings=None, backfill_state=None):
        return CliBackgroundSync(
            owner_id=OWNER_ID, channel='wechat', account_scope='synthetic',
            cli=LocalWechatCli(runner=self.runner),
            bindings=[self.binding] if bindings is None else bindings,
            observation_store=self.store, backfill_state=backfill_state,
            clock=lambda: self.now,
        )

    def test_each_cycle_commits_one_page_and_schedules_the_next(self) -> None:
        first = self.sync.cycle(enabled=True)
        self.assertEqual(first.batch_message_count, 50)
        self.assertEqual(first.status.pending_count, 1)
        self.assertEqual(len(self.runner.calls), 1)
        second = self.sync.cycle(enabled=True)
        self.assertEqual(second.batch_message_count, 27)
        self.assertEqual(second.status.pending_count, 0)
        self.assertEqual(self.runner.calls[1][1], 'local_id:50')

    def test_backfill_accumulates_pages_and_completes_only_on_last_page(self) -> None:
        backfill = FakeBackfillStateStore()
        self.sync = self.make_sync(backfill_state=backfill)
        first = self.sync.cycle(enabled=True)
        self.assertEqual(first.status.backfill_phase, 'backfilling')
        self.assertEqual(first.status.backfill_message_count, 50)
        second = self.sync.cycle(enabled=True)
        self.assertEqual(second.status.backfill_phase, 'complete')
        self.assertEqual(second.status.backfill_message_count, 77)

    def test_non_advancing_page_fails_without_infinite_requeue(self) -> None:
        self.sync.cycle(enabled=True)
        self.runner.repeat_first_page = True
        failed = self.sync.cycle(enabled=True)
        self.assertEqual(failed.status.failure_code, 'cli_output_invalid')
        self.assertEqual(failed.status.pending_count, 0)
        self.assertEqual(len(self.store.recorded), 1)

    def test_restart_keeps_committed_progress_with_a_later_start_time(self) -> None:
        backfill = FakeBackfillStateStore()
        self.sync = self.make_sync(backfill_state=backfill)
        self.sync.cycle(enabled=True)
        self.sync.close()
        self.now += timedelta(minutes=1)
        restarted = self.make_sync(backfill_state=backfill)
        result = restarted.cycle(enabled=True)
        self.assertEqual(result.status.backfill_message_count, 77)
        self.assertEqual(result.status.backfill_phase, 'complete')
        self.assertEqual(self.runner.calls[1][1], 'local_id:50')

    def test_media_only_page_advances_and_preserves_backfill_counts(self) -> None:
        self.runner.non_text_first_page = True
        backfill = FakeBackfillStateStore()
        self.sync = self.make_sync(backfill_state=backfill)
        first = self.sync.cycle(enabled=True)
        self.assertEqual(first.batch_message_count, 0)
        self.assertEqual(first.status.backfill_non_text_count, 50)
        self.assertEqual(first.status.pending_count, 1)
        second = self.sync.cycle(enabled=True)
        self.assertEqual(second.status.backfill_message_count, 27)
        self.assertEqual(second.status.backfill_non_text_count, 50)
        self.assertEqual(second.status.backfill_phase, 'complete')
        self.assertEqual(self.runner.calls[1][1], 'local_id:50')

    def test_other_contact_is_read_before_the_first_contacts_next_page(self) -> None:
        other = FakeBinding(uuid4(), uuid4(), 'wxid_synthetic_b', '合成乙')
        self.sync = self.make_sync(bindings=[self.binding, other])
        self.sync.cycle(enabled=True, max_bindings=1)
        self.sync.cycle(enabled=True, max_bindings=1)
        self.sync.cycle(enabled=True, max_bindings=1)
        self.assertEqual(self.runner.calls, [
            ('wxid_synthetic_a', None),
            ('wxid_synthetic_b', None),
            ('wxid_synthetic_a', 'local_id:50'),
        ])

    def test_disabled_cycle_does_not_read_queued_page(self) -> None:
        self.sync.cycle(enabled=True)
        self.sync.cycle(enabled=False)
        self.assertEqual(len(self.runner.calls), 1)
        self.sync.cycle(enabled=True)
        self.assertEqual(self.runner.calls[1][1], 'local_id:50')

    def test_revoked_binding_is_not_read_from_the_continuation_queue(self) -> None:
        bindings = [self.binding]
        self.sync = self.make_sync(bindings=bindings)
        self.sync.cycle(enabled=True)
        bindings.clear()
        self.sync.cycle(enabled=True)
        self.assertEqual(len(self.runner.calls), 1)

    def test_read_failure_retries_from_the_last_committed_page(self) -> None:
        self.sync.cycle(enabled=True)
        self.runner.fail_cursor = 'local_id:50'
        failed = self.sync.cycle(enabled=True)
        self.assertEqual(failed.batch_message_count, 0)
        self.assertEqual(len(self.store.recorded), 1)
        self.runner.fail_cursor = None
        restarted = self.make_sync()
        recovered = restarted.cycle(enabled=True)
        self.assertEqual(recovered.batch_message_count, 27)
        self.assertEqual(self.runner.calls[-1][1], 'local_id:50')

    def test_write_failure_does_not_advance_cursor_or_skip_page(self) -> None:
        class FailingStore(FakeObservationStore):
            failed = False

            def record_batch_with_messages(self, **kwargs):
                if kwargs['since_cursor'] == 'local_id:50' and not self.failed:
                    self.failed = True
                    raise ObservationPersistenceError('合成写入失败')
                return super().record_batch_with_messages(**kwargs)

        self.store = FailingStore()
        self.sync = self.make_sync()
        self.sync.cycle(enabled=True)
        failed = self.sync.cycle(enabled=True)
        self.assertEqual(failed.status.failure_code, 'observation_persistence_failed')
        self.assertEqual(len(self.store.recorded), 1)
        recovered = self.make_sync().cycle(enabled=True)
        self.assertEqual(recovered.batch_message_count, 27)
        self.assertEqual(self.runner.calls[-1][1], 'local_id:50')

    def test_empty_intermediate_page_is_rejected_without_requeue(self) -> None:
        self.runner.total = 0
        self.runner.force_more = True
        result = self.sync.cycle(enabled=True)
        self.assertEqual(result.status.failure_code, 'cli_output_invalid')
        self.assertEqual(result.status.pending_count, 0)
        self.assertEqual(len(self.store.recorded), 0)

    def test_legacy_paused_backfill_resumes_across_live_pages(self) -> None:
        backfill = FakeBackfillStateStore()
        scope = {
            'owner_id': OWNER_ID, 'contact_id': self.binding.contact_id,
            'binding_id': self.binding.binding_id,
        }
        backfill.ensure_started(**scope, trigger_at=self.now)
        backfill.mark_paused(**scope)
        self.sync = self.make_sync(backfill_state=backfill)
        first = self.sync.cycle(enabled=True, priority_contact_id=self.binding.contact_id)
        second = self.sync.cycle(enabled=True, priority_contact_id=self.binding.contact_id)
        self.assertEqual(first.batch_message_count, 50)
        self.assertEqual(second.batch_message_count, 27)
        self.assertEqual(backfill.read(**scope).phase, 'complete')
        self.assertEqual(backfill.read(**scope).message_count, 77)
        self.assertEqual(self.runner.calls[1][1], 'local_id:50')
