"""CLI 排序位置与本地编号不同序时仍可续读。"""

import json
import subprocess
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from notalone.front_sync.cli_sync import CliBackgroundSync
from notalone.wechat_cli import LocalWechatCli
from notalone.wechat_cli.errors import CliCommandError, CliOutputError
from notalone.wechat_cli.models import TailResult
from tests.unit.front_sync.test_cli_background_sync import (
    OWNER_ID, FakeBinding, FakeObservationStore,
)


class CursorOrderTest(unittest.TestCase):
    def test_empty_contact_does_not_hide_another_contacts_read_failure(self):
        from tests.unit.front_sync.test_cli_background_sync import FakeBackfillStateStore
        class MixedCli:
            def session_events_follow(self, **kwargs):
                raise CliCommandError('cli_follow_unsupported', '合成不支持')
            def tail(self, talker, **kwargs):
                if talker.endswith('empty'):
                    return TailResult(events=(), cursor=None, freshness_confirmed=True, local_history_state='empty')
                raise CliCommandError('cli_timeout', '合成超时')
        bindings = [FakeBinding(uuid4(), uuid4(), 'wxid_synthetic_empty', '合成空会话'),
                    FakeBinding(uuid4(), uuid4(), 'wxid_synthetic_error', '合成失败')]
        sync = CliBackgroundSync(owner_id=OWNER_ID, channel='wechat', account_scope='synthetic',
            cli=MixedCli(), bindings=bindings, observation_store=FakeObservationStore(),
            backfill_state=FakeBackfillStateStore())
        result = sync.cycle(enabled=True)
        self.assertEqual(result.status.backfill_failure_code, 'cli_timeout')

    def test_empty_history_keeps_cursor_and_later_message_still_syncs(self):
        state = {'empty': False, 'id': 8}
        cursors = []
        def runner(command):
            if command[1] == '--version':
                return SimpleNamespace(returncode=0, stderr='', stdout=json.dumps({'ok': True, 'data': {'version': 'synthetic'}}))
            if command[1] == 'sql':
                data = {'freshness': {'message_source': 'live_selected_db_read_only'},
                        'query': {'has_more': False, 'returned': 1},
                        'rows': [{'deleted_count': 0, 'session_count': 1, 'empty_session_count': 1}]}
                return SimpleNamespace(returncode=0, stderr='', stdout=json.dumps({'ok': True, 'data': data}))
            cursors.append(command[command.index('--cursor') + 1] if '--cursor' in command else None)
            if state['empty']:
                return SimpleNamespace(returncode=1, stderr='', stdout=json.dumps({'ok': False, 'error': {
                    'code': 'tool_error', 'message': 'table Msg_synthetic not found in 9 message shards'}}))
            cursor = f"local_id:{state['id']}"
            event = {'type': 'message', 'cursor': cursor, 'message': {
                'id': {'local_id': state['id'], 'talker': command[2]}, 'kind': 'text',
                'text': '合成新消息', 'is_from_me': False, 'create_time': 1788256800}}
            return SimpleNamespace(returncode=0, stderr='', stdout=json.dumps({'ok': True, 'data': {
                'events': [event], 'cursor': cursor, 'freshness': {'message_source': 'live_message_db'},
                'query': {'chat': command[2], 'has_more': False}}}))
        binding = FakeBinding(uuid4(), uuid4(), 'wxid_synthetic_resume', '合成恢复')
        store = FakeObservationStore()
        now = [datetime(2026, 9, 1, tzinfo=timezone.utc)]
        sync = CliBackgroundSync(owner_id=OWNER_ID, channel='wechat', account_scope='synthetic',
            cli=LocalWechatCli(runner=runner), bindings=[binding], observation_store=store, clock=lambda: now[0])
        sync.cycle(enabled=True, priority_contact_id=binding.contact_id)
        state['empty'] = True
        now[0] += timedelta(seconds=20)
        empty = sync.cycle(enabled=True, priority_contact_id=binding.contact_id)
        self.assertEqual(empty.status.priority_local_history_state, 'empty')
        self.assertEqual(len(store.recorded), 1)
        state.update(empty=False, id=6)
        now[0] += timedelta(seconds=20)
        resumed = sync.cycle(enabled=True, priority_contact_id=binding.contact_id)
        self.assertIsNone(resumed.status.priority_local_history_state)
        self.assertEqual(resumed.batch_message_count, 1)
        self.assertEqual(cursors, [None, 'local_id:8', 'local_id:8'])
        self.assertEqual(store.recorded[-1]['last_cursor'], 'local_id:6')

    def test_metadata_probe_timeout_is_a_failure(self):
        def runner(command):
            if command[1] == 'tail':
                return SimpleNamespace(returncode=1, stderr='', stdout=json.dumps({
                    'ok': False, 'error': {'code': 'tool_error', 'message':
                        'table Msg_synthetic not found in 9 message shards'},
                }))
            raise subprocess.TimeoutExpired(command, 0.1)
        with self.assertRaises(CliCommandError) as caught:
            LocalWechatCli(runner=runner).tail('wxid_synthetic', cursor='local_id:8', timeout_seconds=0.1)
        self.assertEqual(caught.exception.code, 'cli_timeout')

    def test_expired_tail_budget_does_not_start_metadata_probe(self):
        calls = []
        def runner(command):
            calls.append(command)
            return SimpleNamespace(returncode=1, stderr='', stdout=json.dumps({
                'ok': False, 'error': {'code': 'tool_error', 'message':
                    'table Msg_synthetic not found in 9 message shards'},
            }))
        with patch('notalone.wechat_cli.adapter.monotonic', side_effect=[10.0, 11.1]):
            with self.assertRaises(CliCommandError) as caught:
                LocalWechatCli(runner=runner).tail('wxid_synthetic', timeout_seconds=1)
        self.assertEqual(caught.exception.code, 'cli_timeout')
        self.assertEqual(len(calls), 1)

    def test_mismatched_page_cursor_is_rejected(self):
        def runner(command):
            return SimpleNamespace(returncode=0, stderr='', stdout=json.dumps({
                'ok': True, 'data': {
                    'events': [{'type': 'message', 'cursor': 'local_id:6',
                                'message': {'id': {'local_id': 6, 'talker': command[2]}, 'kind': 'image'}}],
                    'cursor': 'local_id:8',
                    'freshness': {'message_source': 'live_message_db'},
                    'query': {'chat': command[2], 'has_more': False},
                },
            }))
        with self.assertRaises(CliOutputError):
            LocalWechatCli(runner=runner).tail('wxid_synthetic')

    def test_confirmed_empty_history_is_not_a_read_failure_or_complete_backfill(self):
        from tests.unit.front_sync.test_cli_background_sync import FakeBackfillStateStore

        calls = []
        def runner(command):
            calls.append(command)
            if command[1] == 'tail':
                return SimpleNamespace(returncode=1, stderr='', stdout=json.dumps({
                    'ok': False, 'error': {'code': 'tool_error', 'message':
                        'table Msg_0123456789abcdef0123456789abcdef not found in 9 message shards'},
                }))
            if command[1] == 'sql':
                return SimpleNamespace(returncode=0, stderr='', stdout=json.dumps({
                    'ok': True, 'data': {
                        'freshness': {'message_source': 'live_selected_db_read_only'},
                        'query': {'has_more': False, 'returned': 1},
                        'rows': [{'deleted_count': 0, 'session_count': 1, 'empty_session_count': 1}],
                    },
                }))
            raise AssertionError(command[1])

        binding = FakeBinding(uuid4(), uuid4(), 'wxid_synthetic_empty', '合成空会话')
        store = FakeObservationStore()
        sync = CliBackgroundSync(
            owner_id=OWNER_ID, channel='wechat', account_scope='synthetic',
            cli=LocalWechatCli(runner=runner), bindings=[binding], observation_store=store,
            backfill_state=FakeBackfillStateStore(),
        )
        result = sync.cycle(enabled=True, priority_contact_id=binding.contact_id)
        self.assertIsNone(result.status.priority_last_failure_code)
        self.assertEqual(result.status.priority_local_history_state, 'empty')
        self.assertEqual(result.status.backfill_phase, 'incomplete')
        self.assertEqual(result.status.backfill_failure_code, 'local_history_empty')
        self.assertEqual(store.recorded, [])
        self.assertEqual([c[1] for c in calls], ['tail', 'sql'])

    def test_page_uses_last_position_and_continues_to_smaller_id(self):
        calls = []

        def runner(command):
            if command[1] == '--version':
                return SimpleNamespace(returncode=0, stderr='', stdout=json.dumps({
                    'ok': True, 'data': {'version': 'synthetic'},
                }))
            cursor = command[command.index('--cursor') + 1] if '--cursor' in command else None
            calls.append(cursor)
            ids = [8, 6] if cursor is None else [4] if cursor == 'local_id:6' else []
            events = [{
                'type': 'message', 'cursor': f'local_id:{n}',
                'message': {'id': {'local_id': n, 'talker': command[2]},
                            'kind': 'image', 'is_from_me': False},
            } for n in ids]
            return SimpleNamespace(returncode=0, stderr='', stdout=json.dumps({
                'ok': True, 'data': {
                    'events': events, 'cursor': f'local_id:{ids[-1]}' if ids else cursor,
                    'freshness': {'message_source': 'live_message_db'},
                    'query': {'chat': command[2], 'has_more': cursor is None},
                },
            }))

        binding = FakeBinding(uuid4(), uuid4(), 'wxid_synthetic_order', '合成排序')
        store = FakeObservationStore()
        sync = CliBackgroundSync(
            owner_id=OWNER_ID, channel='wechat', account_scope='synthetic',
            cli=LocalWechatCli(runner=runner), bindings=[binding], observation_store=store,
        )
        first = sync.cycle(enabled=True)
        self.assertNotEqual(first.status.failure_code, "cli_output_invalid")
        self.assertEqual(store.recorded[-1]['last_cursor'], 'local_id:6')
        second = sync.cycle(enabled=True)
        self.assertNotEqual(second.status.failure_code, "cli_output_invalid")
        self.assertEqual(calls, [None, 'local_id:6'])
        self.assertEqual(store.recorded[-1]['last_cursor'], 'local_id:4')
        self.assertTrue(store.recorded[-1]['cursor_ordered'])


if __name__ == '__main__':
    unittest.main()
