"""失败回执只属于原步骤代次；使用合成事务行，不连接PG。"""

from contextlib import nullcontext
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.persistence.memory_upgrade import PostgresMemoryUpgradeStore
from notalone.tasks.models import BackgroundTaskStepName


class FailureRows:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class FailureReceiptQueries:
    def __init__(self, claim, *, generation, task_state, step_state):
        self.claim = claim
        self.receipt = {'lease_generation': generation, 'step_state': step_state,
                        'task_state': task_state, 'step_name': claim.name.value}
        self.batch = {'id': uuid4(), 'job_id': uuid4(), 'state': 'queued'}
        self.writes = []

    def execute(self, query, params):
        if query.startswith('SELECT step.lease_generation'):
            expected = (self.claim.owner_id, self.claim.contact_id, self.claim.task_id, self.claim.step_id)
            if params != expected or "task.task_type='memory_upgrade'" not in query:
                raise AssertionError('失败回执必须核对原范围、任务类型及步骤。')
            return FailureRows(self.receipt)
        if query.startswith('SELECT id,job_id,state FROM public.memory_upgrade_batch'):
            return FailureRows(self.batch)
        if query.startswith(('UPDATE public.memory_upgrade_batch', 'UPDATE public.memory_upgrade_job')):
            self.writes.append((query, params))
            return FailureRows(None)
        raise AssertionError('合成失败回执出现未声明查询。')


class UpgradeFailureReceiptsTest(unittest.TestCase):
    def setUp(self):
        self.claim = SimpleNamespace(owner_id=uuid4(), contact_id=uuid4(), task_id=uuid4(),
            step_id=uuid4(), lease_generation=3, name=BackgroundTaskStepName.PREVIEW_UPGRADE)

    def _record(self, connection):
        with patch.object(PostgresMemoryUpgradeStore, '_connect', return_value=nullcontext(connection)), \
                patch('notalone.persistence.memory_upgrade._lock'):
            PostgresMemoryUpgradeStore('synthetic-only').failed(self.claim, 'temporary_failure')

    def test_old_failure_callback_cannot_overwrite_explicit_resume_or_a_new_claim(self):
        for generation, task_state, step_state in ((4, 'queued', 'pending'), (4, 'running', 'running'),
                                                    (3, 'succeeded', 'succeeded')):
            with self.subTest(generation=generation, task_state=task_state):
                connection = FailureReceiptQueries(self.claim, generation=generation,
                    task_state=task_state, step_state=step_state)
                self._record(connection)
                self.assertEqual(connection.writes, [])

    def test_current_failed_step_can_still_record_its_original_business_failure(self):
        connection = FailureReceiptQueries(self.claim, generation=3, task_state='failed', step_state='failed')
        self._record(connection)
        self.assertEqual(len(connection.writes), 2)
        self.assertEqual(connection.writes[0][1][:2], ('failed', 'temporary_failure'))
