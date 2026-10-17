"""升级业务提交和步骤回执之间的恢复边界；合成行端口，不连接PG。"""

from contextlib import nullcontext
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.memory.upgrade import UpgradeScope
from notalone.persistence.memory_upgrade import PostgresMemoryUpgradeStore
from tests.unit.memory_extraction.upgrade_helpers import synthetic_upgrade_algorithm


class Rows:
    def __init__(self, rows=()):
        self.rows = rows

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class RecoveryRows:
    def __init__(self, scope, *, phase, statuses):
        self.job = {'id': uuid4(), 'revision': 2, 'state': 'cancelled', 'scope_kind': scope.kind}
        self.job['algorithm'] = synthetic_upgrade_algorithm()
        self.batch = {'id': uuid4(), 'job_id': self.job['id'], 'owner_id': scope.owner_id,
            'contact_id': scope.contact_id, 'task_id': uuid4(), 'state': phase,
            'error_code': None, 'message_ids': [uuid4()], 'revision': 2}
        self.batch['algorithm'] = self.job['algorithm']
        names = ('preview_upgrade', 'verify_upgrade_preview', 'apply_upgrade', 'verify_upgrade_apply')
        self.steps = dict(zip(names, statuses))
        self.queued_from = None
        self.reconciled = []

    def execute(self, query, params):
        if query.startswith('SELECT contact_id FROM public.memory_upgrade_batch'):
            return Rows([{'contact_id': self.batch['contact_id']}])
        if query.startswith('SELECT * FROM public.memory_upgrade_operation'):
            return Rows()
        if query.startswith('SELECT * FROM public.memory_upgrade_batch'):
            return Rows([self.batch])
        if query.startswith('SELECT step_name FROM public.background_task_step'):
            return Rows([{'step_name': name} for name, status in self.steps.items() if status != 'succeeded'])
        if query.startswith("UPDATE public.background_task_step SET status='succeeded'"):
            count, total, task_id, name = params
            if task_id != self.batch['task_id'] or count != 1 or total != 1:
                raise AssertionError('恢复必须使用原任务真实冻结消息数。')
            if self.steps[name] != 'succeeded':
                self.steps[name] = 'succeeded'
                self.reconciled.append(name)
            return Rows()
        if query.startswith("UPDATE public.background_task_step SET status='pending'"):
            task_id, first = params
            if task_id != self.batch['task_id']:
                raise AssertionError('不能重排另一任务。')
            for order, (name, status) in enumerate(self.steps.items(), 1):
                if order >= first and ("status<>'succeeded'" not in query or status != 'succeeded'):
                    self.steps[name] = 'pending'
            return Rows()
        if query.startswith("UPDATE public.background_task SET status='queued'"):
            self.queued_from = params[0]
            return Rows()
        if query.startswith('UPDATE public.memory_upgrade_batch SET state=%s'):
            self.batch['state'] = params[0]
            return Rows()
        if query.startswith('INSERT INTO public.background_task_step'):
            self.steps.setdefault(params[1], 'pending')
            return Rows()
        if query.startswith("UPDATE public.memory_upgrade_batch SET state='apply_queued'"):
            self.batch['state'] = 'apply_queued'
            return Rows()
        if query.startswith(('UPDATE public.memory_upgrade_job', 'INSERT INTO public.memory_upgrade_operation')):
            return Rows()
        raise AssertionError('恢复出现未声明查询。')


class UpgradeRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.scope = UpgradeScope(uuid4(), 'contact', uuid4())

    def _operate(self, connection, *, action='resume'):
        with patch.object(PostgresMemoryUpgradeStore, '_connect', return_value=nullcontext(connection)), \
                patch.object(PostgresMemoryUpgradeStore, '_job', return_value=connection.job), \
                patch.object(PostgresMemoryUpgradeStore, '_validate_sources'), \
                patch('notalone.persistence.memory_upgrade._lock'), \
                patch('notalone.persistence.memory_upgrade.generation_current'):
            PostgresMemoryUpgradeStore('synthetic-only', algorithm_provider=synthetic_upgrade_algorithm).operate(self.scope, connection.job['id'],
                action=action, expected_revision=2, operation_key=uuid4(),
                batches=((connection.batch['id'], connection.batch['revision']),) if action == 'apply' else ())

    def test_saved_preview_recovers_cancelled_first_receipt_before_verification(self):
        connection = RecoveryRows(self.scope, phase='ready', statuses=('cancelled', 'cancelled'))
        self._operate(connection)
        self.assertEqual(connection.steps, {'preview_upgrade': 'succeeded', 'verify_upgrade_preview': 'pending'})
        self.assertEqual(connection.reconciled, ['preview_upgrade'])
        self.assertEqual(connection.queued_from, 'verify_upgrade_preview')
        self.assertEqual(connection.batch['state'], 'ready')

    def test_applied_result_recovers_only_failed_last_verification(self):
        connection = RecoveryRows(self.scope, phase='applied',
            statuses=('succeeded', 'succeeded', 'succeeded', 'failed'))
        self._operate(connection)
        self.assertEqual(list(connection.steps.values()), ['succeeded', 'succeeded', 'succeeded', 'pending'])
        self.assertEqual(connection.queued_from, 'verify_upgrade_apply')
        self.assertEqual(connection.batch['state'], 'applied')

    def test_finished_preview_is_not_requeued_by_resume(self):
        connection = RecoveryRows(self.scope, phase='ready', statuses=('succeeded', 'succeeded'))
        self._operate(connection)
        self.assertIsNone(connection.queued_from)
        self.assertEqual(list(connection.steps.values()), ['succeeded', 'succeeded'])

    def test_approval_after_saved_preview_queues_remaining_verification_before_apply(self):
        connection = RecoveryRows(self.scope, phase='ready', statuses=('running', 'pending'))
        connection.job['state'] = 'active'
        connection.batch['memory_generation'] = {'synthetic': True}
        self._operate(connection, action='apply')
        self.assertEqual(connection.steps['preview_upgrade'], 'succeeded')
        self.assertEqual(connection.queued_from, 'verify_upgrade_preview')
        self.assertEqual(connection.steps['apply_upgrade'], 'pending')
        self.assertEqual(connection.batch['state'], 'apply_queued')

    def test_preview_verification_accepts_committed_preview_after_explicit_approval(self):
        for phase in ('ready', 'apply_queued', 'applied'):
            with self.subTest(phase=phase):
                connection = RecoveryRows(self.scope, phase=phase, statuses=('succeeded', 'running'))
                with patch.object(PostgresMemoryUpgradeStore, '_connect', return_value=nullcontext(connection)), \
                        patch.object(PostgresMemoryUpgradeStore, '_claimed', return_value=connection.batch):
                    PostgresMemoryUpgradeStore('synthetic-only').verify(
                        SimpleNamespace(name=SimpleNamespace(value='verify_upgrade_preview')))
