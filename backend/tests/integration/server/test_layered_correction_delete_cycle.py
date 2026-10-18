"""删除整理结果结束纠错周期，普通停用恢复仍保留原保护。"""

import unittest
from uuid import uuid4

import psycopg

from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server import test_layered_correction_matrix as matrix


class LayeredCorrectionDeleteCycleHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    _prepare_scope = matrix.LayeredCorrectionMatrixHttpTest._prepare_scope
    _target_command = matrix.LayeredCorrectionMatrixHttpTest._target_command

    def _delete_cycle(self, scope_kind):
        backend, path, memories_path, ready, primary, unrelated = self._prepare_scope(scope_kind)
        before_memories = self._get(self.backend, memories_path)['memories']
        summary = {**self._target_command(ready, 'profile', primary['memory_id']),
            'reason': '合成总结含义有误。', 'operation_id': str(uuid4())}
        status, response = backend.request(path + '/summary-error', summary)
        self.assertEqual(status, 200, response)
        current = response['layered_memory']
        fact = {**self._target_command(current, 'scenario', primary['memory_id']),
            'memory_id': primary['memory_id']}
        status, response = backend.request(path + '/fact-error', fact)
        self.assertEqual(status, 200, response)
        protected = response['layered_memory']
        self.assertEqual(len(protected['feedback']), 1)
        self.assertEqual(protected['pending_fact_count'], 1)
        self.assertEqual(protected['protected_count'], 2)
        for action in ('refresh', 'disable', 'enable'):
            command = {'settings_generation': protected['settings_generation']}
            if action == 'enable':
                command['purpose_confirmed'] = True
            status, response = backend.request(path + '/' + action, command)
            self.assertEqual(status, 200, response)
            protected = response['layered_memory']
            self.assertEqual(len(protected['feedback']), 1)
            self.assertEqual(protected['pending_fact_count'], 1)
            self.assertEqual(protected['protected_count'], 2)
            self.assertEqual(protected['scenarios'], [])

        # 真实删除请求应物理移除两类记录，不能仅在公开投影隐藏正文或身份。
        delete_command = {'settings_generation': protected['settings_generation']}
        status, response = backend.request(path + '/delete', delete_command)
        self.assertEqual(status, 200, response)
        deleted = response['layered_memory']
        self.assertFalse(deleted['enabled'])
        self.assertEqual(deleted['feedback'], [])
        self.assertEqual(deleted['pending_fact_count'], 0)
        self.assertEqual(deleted['protected_count'], 0)
        self.assertEqual(deleted['scenarios'], [])
        self.assertIsNone(deleted['profile'])
        self.assertGreater(deleted['settings_generation'], protected['settings_generation'])
        self.assertGreater(deleted['organization_generation'], protected['organization_generation'])
        contact_id = path.split('/')[3] if scope_kind == 'contact' else None
        with psycopg.connect(self.database_url) as connection:
            for table in ('layered_memory_feedback', 'layered_memory_fact_correction',
                          'layered_memory_generation', 'layered_memory_batch', 'layered_profile_batch'):
                self.assertEqual(connection.execute(
                    f'SELECT count(*) FROM public.{table} WHERE owner_id=%s '
                    'AND contact_id IS NOT DISTINCT FROM %s', (self.owner_id, contact_id)).fetchone()[0], 0, table)
        for endpoint, command in (('summary-error', summary), ('fact-error', fact)):
            self.assertEqual(backend.request(path + '/' + endpoint, command)[0], 409)
        status, response = backend.request(path + '/enable', {
            'settings_generation': deleted['settings_generation'], 'purpose_confirmed': True})
        self.assertEqual(status, 200, response)
        reopened = response['layered_memory']
        self.assertEqual(reopened['feedback'], [])
        self.assertEqual(reopened['pending_fact_count'], 0)
        self.assertEqual(reopened['protected_count'], 0)
        self.assertEqual({ref['memory_id'] for doc in reopened['scenarios']
            for paragraph in doc['paragraphs'] for ref in paragraph['references']},
            {primary['memory_id'], unrelated['memory_id']})
        self.assertIsNotNone(reopened['profile'])
        self.assertEqual(self._get(self.backend, memories_path)['memories'], before_memories)
        for endpoint, command in (('summary-error', summary), ('fact-error', fact), ('delete', delete_command)):
            self.assertEqual(backend.request(path + '/' + endpoint, command)[0], 409)

    def test_contact_delete_clears_feedback_and_pending_then_explicitly_restarts(self):
        self._delete_cycle('contact')

    def test_owner_delete_clears_feedback_and_pending_then_explicitly_restarts(self):
        self._delete_cycle('owner')
