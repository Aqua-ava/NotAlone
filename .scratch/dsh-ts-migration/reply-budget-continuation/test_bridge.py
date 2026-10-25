"""只使用仓库外合成总账，验证固定回复评测桥的 ACK 边界。"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'backend/src'))
from notalone.problem_budget import ProblemBudget, ProblemStopped

BRIDGE_PATH = ROOT / '.scratch/dsh-ts-migration/ticket25-final-run/bridge.py'
spec = importlib.util.spec_from_file_location('reply_budget_bridge', BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class ReplyBudgetContinuationTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory(prefix='notalone-synthetic-reply-budget-')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.directory.chmod(0o700)
        self.ledger = self.directory / 'ledger.sqlite3'
        environment = patch.dict(os.environ, {
            'NOTALONE_BUDGET_REPOSITORY': str(ROOT),
        }, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        clock = patch('time.time', return_value=1_700_000_000.0)
        self.clock = clock.start()
        self.addCleanup(clock.stop)
        self.budget = ProblemBudget(self.ledger)
        self.budget.create('synthetic-reply-problem', 3, 1)

    def request(self, action='ack', round_id='continued-1', **budget_overrides):
        budget = {
            'ledger': str(self.ledger),
            'round': round_id,
            'problem_id': 'synthetic-reply-problem',
        }
        budget.update(budget_overrides)
        return bridge.execute({
            'schema_version': 'reply-budget-bridge-v1',
            'action': action,
            'budget': budget,
        })

    def continuation(self, *, max_new_rounds=1):
        for round_id in ('original-1', 'original-2'):
            self.budget.start(round_id, '合成假设')
            self.budget.reserve(round_id)
            self.budget.finish(round_id, 'unknown', 'synthetic-evidence')
        self.clock.return_value += 120
        self.budget.authorize_continuation(
            reason='合成人类授权继续同一问题',
            max_new_rounds=max_new_rounds,
            minutes=2,
        )
        self.budget.start('continued-1', '合成续期假设')

    def assert_read_only_ack(self, round_id='continued-1'):
        before = self.budget.snapshot()
        before_bytes = self.ledger.read_bytes()
        result = self.request(round_id=round_id)
        self.assertEqual(self.budget.snapshot(), before)
        self.assertEqual(self.ledger.read_bytes(), before_bytes)
        self.assertFalse(result['reserved'])
        self.assertEqual(result['used_reservations'], before['used'])
        self.assertEqual(result['max_reservations'], before['max_calls'])
        return result

    def corrupt(self, statement, parameters=()):
        """只破坏自有合成夹具，用来验证损坏账本失败关闭。"""
        with self.budget.connection() as connection:
            connection.execute(statement, parameters)

    def assert_read_only_rejection(self, round_id='continued-1'):
        before_bytes = self.ledger.read_bytes()
        with self.assertRaises(ProblemStopped):
            self.request(round_id=round_id)
        self.assertEqual(self.ledger.read_bytes(), before_bytes)

    def test_authorized_continuation_ack_before_and_after_last_reservation(self):
        self.continuation()
        before = self.budget.snapshot()
        self.assertEqual(before['used'], 2)
        self.assertEqual(before['no_improvement_rounds'], 2)
        self.assertLess(before['deadline'], self.clock.return_value)
        self.assert_read_only_ack()
        reserved = self.request('reserve')
        self.assertTrue(reserved['reserved'])
        self.assertEqual(reserved['used_reservations'], 3)
        self.assert_read_only_ack()
        self.assert_read_only_ack()
        for action in ('check', 'reserve'):
            with self.subTest(action=action), self.assertRaises(ProblemStopped):
                self.request(action)
        after = self.budget.snapshot()
        self.assertEqual(after['used'], after['max_calls'])
        self.assertEqual(after['continuations'], before['continuations'])
        self.assertEqual(after['rounds'], before['rounds'])
        self.assertEqual(after['deadline'], before['deadline'])

    def test_ack_reports_effective_deadline_without_rewriting_original(self):
        self.continuation()
        snapshot = self.budget.snapshot()
        result = self.assert_read_only_ack()
        self.assertEqual(result['deadline'], 1_700_000_240.0)
        self.assertEqual(snapshot['deadline'], 1_700_000_060.0)

    def test_malformed_latest_authorization_is_rejected_without_writing(self):
        self.continuation()
        grant = self.budget.snapshot()['continuations'][-1]
        cases = (
            ('id', 0), ('reason', ''), ('reason', '   '),
            ('existing_rounds', -1), ('existing_rounds', 4),
            ('existing_rounds', 1.5), ('max_new_rounds', 0),
            ('max_new_rounds', 4), ('max_new_rounds', 1.5),
            ('max_new_rounds', 'invalid'),
            ('authorized_at', 0), ('authorized_at', 'invalid'),
            ('authorized_at', self.clock.return_value + 1),
            ('authorized_at', float('inf')),
            ('deadline', self.clock.return_value),
            ('deadline', float('inf')),
            ('deadline', 'invalid'),
        )
        for column, invalid in cases:
            with self.subTest(column=column, invalid=invalid):
                self.corrupt(f'UPDATE continuations SET {column}=?', (invalid,))
                try:
                    self.assert_read_only_rejection()
                finally:
                    self.corrupt(f'UPDATE continuations SET {column}=?', (grant[column],))

    def test_conflicting_rounds_and_invalid_streak_fail_closed(self):
        self.continuation()
        cases = (
            ('rounds', 'outcome', "id='original-1'", None, 'unknown'),
            ('rounds', 'outcome', "id='original-1'", 'invalid', 'unknown'),
            ('budget', 'streak', '1=1', -1, 2),
            ('budget', 'streak', '1=1', 'invalid', 2),
        )
        for table, column, where, invalid, original in cases:
            statement = f'UPDATE {table} SET {column}=? WHERE {where}'
            with self.subTest(table=table, invalid=invalid):
                self.corrupt(statement, (invalid,))
                try:
                    self.assert_read_only_rejection()
                finally:
                    self.corrupt(statement, (original,))

    def test_malformed_authorization_history_cannot_hide_behind_latest_grant(self):
        self.continuation(max_new_rounds=3)
        self.budget.finish('continued-1', 'unknown', 'synthetic-evidence')
        self.budget.authorize_continuation(
            reason='合成最新三轮授权', max_new_rounds=3, minutes=2,
        )
        self.budget.start('continued-2', '合成最新授权假设')
        first = self.budget.snapshot()['continuations'][0]
        for column, invalid in (('reason', ''), ('existing_rounds', -1),
                                ('max_new_rounds', 4), ('authorized_at', float('inf'))):
            with self.subTest(column=column):
                self.corrupt(f'UPDATE continuations SET {column}=? WHERE id=1', (invalid,))
                try:
                    self.assert_read_only_rejection('continued-2')
                finally:
                    self.corrupt(f'UPDATE continuations SET {column}=? WHERE id=1', (first[column],))
        self.corrupt('UPDATE continuations SET existing_rounds=1 WHERE id=2')
        self.assert_read_only_rejection('continued-2')
        self.corrupt('UPDATE continuations SET existing_rounds=3 WHERE id=2')
        self.corrupt('UPDATE continuations SET id=0 WHERE id=1')
        self.assert_read_only_rejection('continued-2')

    def test_expired_continuation_is_rejected_at_exact_deadline(self):
        self.continuation()
        self.clock.return_value = 1_700_000_240.0
        self.assert_read_only_rejection()

    def test_latest_expiry_does_not_fall_back_to_older_live_grant(self):
        self.continuation(max_new_rounds=3)
        self.budget.finish('continued-1', 'unknown', 'synthetic-evidence')
        self.budget.authorize_continuation(
            reason='合成较短续期', max_new_rounds=1, minutes=0.1,
        )
        self.budget.start('continued-2', '合成最新授权假设')
        result = self.assert_read_only_ack('continued-2')
        self.assertEqual(result['deadline'], 1_700_000_126.0)
        self.clock.return_value = 1_700_000_126.0
        self.assert_read_only_rejection('continued-2')

    def test_latest_live_grant_accepts_new_round_after_older_expiry(self):
        self.continuation()
        self.budget.finish('continued-1', 'unknown', 'synthetic-evidence')
        self.clock.return_value = 1_700_000_241.0
        self.budget.authorize_continuation(
            reason='合成再次授权', max_new_rounds=1, minutes=1,
        )
        self.budget.start('continued-2', '合成最新授权假设')
        result = self.assert_read_only_ack('continued-2')
        self.assertEqual(result['deadline'], 1_700_000_301.0)
        snapshot = self.budget.snapshot()
        self.assertEqual(snapshot['used'], 2)
        self.assertEqual(snapshot['no_improvement_rounds'], 3)
        self.assertEqual(len(snapshot['continuations']), 2)

    def test_last_allowed_new_round_ack_succeeds_but_next_round_is_denied(self):
        self.continuation(max_new_rounds=3)
        for number in (1, 2, 3):
            round_id = f'continued-{number}'
            if number > 1:
                self.budget.start(round_id, '合成下一轮假设')
            self.assert_read_only_ack(round_id)
            self.budget.finish(round_id, 'unknown', 'synthetic-evidence')
        with self.assertRaises(ProblemStopped):
            self.budget.start('continued-4', '合成超限假设')
        self.corrupt('INSERT INTO rounds VALUES (?, ?, NULL, NULL)',
                     ('continued-4', '合成损坏的超限轮'))
        self.assert_read_only_rejection('continued-4')

    def test_latest_new_round_allowance_cannot_inherit_previous_three_rounds(self):
        self.continuation(max_new_rounds=3)
        self.budget.finish('continued-1', 'unknown', 'synthetic-evidence')
        self.budget.authorize_continuation(
            reason='合成仅一轮授权', max_new_rounds=1, minutes=2,
        )
        self.budget.start('continued-2', '合成最新授权假设')
        self.assert_read_only_ack('continued-2')
        self.budget.finish('continued-2', 'improved', 'synthetic-evidence')
        with self.assertRaises(ProblemStopped):
            self.budget.start('continued-3', '合成超出最新授权假设')
        self.corrupt('INSERT INTO rounds VALUES (?, ?, NULL, NULL)',
                     ('continued-3', '合成损坏的超限轮'))
        self.assert_read_only_rejection('continued-3')

    def test_finished_missing_and_pre_authorization_rounds_are_rejected(self):
        self.continuation(max_new_rounds=3)
        self.assert_read_only_rejection('original-1')
        self.assert_read_only_rejection('missing')
        self.budget.finish('continued-1', 'unknown', 'synthetic-evidence')
        self.assert_read_only_rejection()
        self.corrupt("UPDATE rounds SET outcome=NULL WHERE id='original-1'")
        self.assert_read_only_rejection('original-1')

    def test_problem_identity_private_path_and_permissions_remain_required(self):
        self.continuation()
        before_bytes = self.ledger.read_bytes()
        missing = self.directory / 'missing.sqlite3'
        symlink = self.directory / 'symlink.sqlite3'
        symlink.symlink_to(self.ledger)
        for overrides in ({'problem_id': 'different-problem'},
                          {'ledger': str(missing)}, {'ledger': str(symlink)}):
            with self.subTest(overrides=overrides), self.assertRaises(ProblemStopped):
                self.request(**overrides)
        self.assertFalse(missing.exists())
        for path, invalid_mode, original_mode in (
                (self.ledger, 0o644, 0o600), (self.directory, 0o755, 0o700)):
            path.chmod(invalid_mode)
            try:
                with self.subTest(path=path.name), self.assertRaises(ProblemStopped):
                    self.request()
            finally:
                path.chmod(original_mode)
        with patch('os.getuid', return_value=os.getuid() + 1):
            with self.assertRaises(ProblemStopped):
                self.request()
        with patch.dict(os.environ, {'NOTALONE_BUDGET_REPOSITORY': str(self.directory)}):
            with self.assertRaises(ProblemStopped):
                self.request()
        self.assertEqual(self.ledger.read_bytes(), before_bytes)

    def test_invalid_budget_capacity_and_original_deadline_fail_closed(self):
        self.continuation()
        original = self.budget.snapshot()
        cases = (
            ('used', -1), ('used', 4), ('used', 1.5), ('used', 'invalid'),
            ('max_calls', 0), ('max_calls', 2**53), ('max_calls', 'invalid'),
            ('deadline', -1), ('deadline', float('inf')),
            ('deadline', float('nan')), ('deadline', 'invalid'),
        )
        for column, invalid in cases:
            with self.subTest(column=column, invalid=invalid):
                self.corrupt(f'UPDATE budget SET {column}=?', (invalid,))
                try:
                    self.assert_read_only_rejection()
                finally:
                    self.corrupt(f'UPDATE budget SET {column}=?', (original[column],))

    def test_legacy_ack_check_reserve_and_full_capacity_behavior_is_unchanged(self):
        self.budget.start('legacy', '合成旧行为假设')
        before = self.budget.snapshot()
        self.assertEqual(self.request('check', 'legacy')['used_reservations'], 0)
        self.assertEqual(self.budget.snapshot(), before)
        self.assertEqual(self.assert_read_only_ack('legacy')['deadline'], 1_700_000_060.0)
        for expected in (1, 2, 3):
            self.assertEqual(self.request('reserve', 'legacy')['used_reservations'], expected)
            self.assert_read_only_ack('legacy')
        for action in ('check', 'reserve'):
            with self.subTest(action=action), self.assertRaises(ProblemStopped):
                self.request(action, 'legacy')
        self.budget.finish('legacy', 'unknown', 'synthetic-evidence')
        self.assert_read_only_rejection('legacy')

    def test_legacy_expiry_and_two_unimproved_rounds_still_stop_ack(self):
        self.budget.start('legacy', '合成旧期限假设')
        self.clock.return_value = 1_700_000_060.0
        self.assert_read_only_rejection('legacy')
        self.clock.return_value = 1_700_000_000.0
        self.budget.finish('legacy', 'unknown', 'synthetic-evidence')
        self.budget.start('legacy-2', '合成第二轮假设')
        self.budget.finish('legacy-2', 'unchanged', 'synthetic-evidence')
        self.corrupt('INSERT INTO rounds VALUES (?, ?, NULL, NULL)',
                     ('legacy-3', '合成越过旧停止门禁'))
        self.assert_read_only_rejection('legacy-3')


if __name__ == '__main__':
    unittest.main()
