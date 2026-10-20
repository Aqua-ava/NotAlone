"""同输入依赖失效后的手动刷新保留旧审计，并建立新的有限整理任务。"""

import unittest
from uuid import UUID

import psycopg

from notalone.memory.layered import OrganizationBudget
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server import test_layered_memory_management as management


class InvalidatedLayeredRefreshTest(MemoryOverviewHttpFixture, unittest.TestCase):
    controlled = management.LayeredMemoryManagementHttpTest.controlled
    enable = management.LayeredMemoryManagementHttpTest.enable

    def disable_initial_maintenance(self, contact):
        # 默认维护已开启；夹具先经公开入口停用，再由本测试显式启动。
        # 避免后台首次维护与同步 enable 响应竞争，恢复阶段仍保持 enabled。
        path = f'/api/contacts/{contact}/layered-memory'
        state = self._get(self.backend, path)['layered_memory']
        status, result = self.backend.request(path + '/disable', {
            'settings_generation': state['settings_generation'],
        })
        self.assertEqual(status, 200, result)

    def audit(self, task_id):
        with psycopg.connect(self.database_url) as connection:
            return tuple(connection.execute(
                f"SELECT to_jsonb(row) FROM public.{table} row WHERE {key}=%s ORDER BY id",
                (UUID(task_id),),
            ).fetchall() for table, key in (
                ('background_task', 'id'), ('background_task_step', 'task_id'),
            )) + (connection.execute(
                "SELECT to_jsonb(row) FROM public.layered_memory_job row WHERE task_id=%s",
                (UUID(task_id),),
            ).fetchone(),)

    def invalidate(self, backend, contact, state, memory_id):
        path = f'/api/contacts/{contact}/layered-memory'
        status, paused = backend.request(path + '/pause', {
            'settings_generation': state['settings_generation'],
            'work_revision': state['work_revision'],
        })
        self.assertEqual(status, 200, paused)
        with psycopg.connect(self.database_url) as connection:
            connection.execute('SELECT public.erase_layered_memory_dependencies(%s,%s)',
                               (self.owner_id, [UUID(memory_id)]))
            self.assertFalse(connection.execute(
                'SELECT maintenance_allowed FROM public.layered_memory_state '
                'WHERE owner_id=%s AND contact_id=%s', (self.owner_id, UUID(contact)),
            ).fetchone()[0])
        state = self._get(backend, path)['layered_memory']
        self.assertEqual(state['status'], 'stale')
        self.assertTrue(state['enabled'])
        return state

    def test_refresh_rebuilds_identical_invalidated_target_without_rewriting_audit(self):
        contact, _, message = self.import_contact('双方共同参加合成课程。')
        original = self.confirm(contact, '双方共同参加合成课程。', message)
        self.disable_initial_maintenance(contact)
        backend = self.controlled(proposer=management.EchoProposal())
        overview_path = f'/api/contacts/{contact}/relationship-overview'
        original_entries = self._get(backend, overview_path)['overview']['entries']
        ready = self.enable(backend, contact)
        self.assertEqual(ready['status'], 'ready')
        invalidated = self.invalidate(backend, contact, ready, original['memory_id'])
        old_audit = self.audit(ready['work_id'])
        path = f'/api/contacts/{contact}/layered-memory'
        status, result = backend.request(path + '/refresh', {
            'settings_generation': invalidated['settings_generation'],
        })
        self.assertEqual(status, 200, result)
        rebuilt = result['layered_memory']
        self.assertEqual(rebuilt['status'], 'ready')
        self.assertNotEqual(rebuilt['work_id'], ready['work_id'])
        self.assertEqual(rebuilt['settings_generation'], ready['settings_generation'])
        self.assertTrue(rebuilt['enabled'])
        self.assertEqual(len(rebuilt['scenarios']), 1)
        self.assertEqual(self.audit(ready['work_id']), old_audit)
        status, repeated = backend.request(path + '/refresh', {
            'settings_generation': rebuilt['settings_generation'],
        })
        self.assertEqual(status, 200, repeated)
        self.assertEqual(repeated['layered_memory']['work_id'], rebuilt['work_id'])
        self.assertEqual(len(self.proposal.inputs), 2)
        self.invalidate(backend, contact, rebuilt, original['memory_id'])
        rebuilt_audit = self.audit(rebuilt['work_id'])
        status, result = backend.request(path + '/refresh', {
            'settings_generation': rebuilt['settings_generation'],
        })
        self.assertEqual(status, 200, result)
        recovered_again = result['layered_memory']
        self.assertEqual(recovered_again['status'], 'ready')
        self.assertNotIn(recovered_again['work_id'], {ready['work_id'], rebuilt['work_id']})
        self.assertEqual(self.audit(ready['work_id']), old_audit)
        self.assertEqual(self.audit(rebuilt['work_id']), rebuilt_audit)
        status, result = backend.request(path + '/pause', {
            'settings_generation': recovered_again['settings_generation'],
            'work_revision': recovered_again['work_revision'],
        })
        self.assertEqual(status, 200, result)
        paused = result['layered_memory']
        self.assertEqual(paused['status'], 'paused')
        self.assertEqual(paused['scenarios'], recovered_again['scenarios'])
        self.assertEqual(paused['settings_generation'], ready['settings_generation'])
        self.assertTrue(paused['enabled'])
        self.assertEqual(self._get(backend, overview_path)['overview']['entries'], original_entries)
        with psycopg.connect(self.database_url) as connection:
            self.assertFalse(connection.execute(
                'SELECT maintenance_allowed FROM public.layered_memory_state '
                'WHERE owner_id=%s AND contact_id=%s', (self.owner_id, UUID(contact)),
            ).fetchone()[0])

    def test_recovered_partial_work_continues_same_new_task(self):
        contact, _, message = self.import_contact('双方共同参加合成课程。')
        original = self.confirm(contact, '双方共同参加合成课程。', message)
        status, result = self.backend.request('/api/memories/manual-contact', {
            'contact_id': contact, 'text': '双方共同完成合成练习。', 'category': 'common_fact',
        })
        self.assertEqual(status, 200, result)
        self.disable_initial_maintenance(contact)
        backend = self.controlled(proposer=management.EchoProposal(),
                                  budget=OrganizationBudget(max_memories=1))
        paused = self.enable(backend, contact)
        self.assertEqual(paused['status'], 'paused')
        invalidated = self.invalidate(backend, contact, paused, original['memory_id'])
        path = f'/api/contacts/{contact}/layered-memory'
        status, result = backend.request(path + '/refresh', {
            'settings_generation': invalidated['settings_generation'],
        })
        self.assertEqual(status, 200, result)
        recovered = result['layered_memory']
        self.assertEqual((recovered['status'], recovered['covered_count']), ('paused', 1))
        self.assertNotEqual(recovered['work_id'], paused['work_id'])
        command = {'settings_generation': recovered['settings_generation'],
                   'work_revision': recovered['work_revision']}
        status, result = backend.request(path + '/continue', command)
        self.assertEqual(status, 200, result)
        finished = result['layered_memory']
        self.assertEqual((finished['status'], finished['covered_count']), ('ready', 2))
        self.assertEqual(finished['work_id'], recovered['work_id'])
        status, repeated = backend.request(path + '/continue', command)
        self.assertEqual(status, 200, repeated)
        self.assertEqual(repeated['layered_memory'], finished)
