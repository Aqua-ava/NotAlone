"""真实迁移的非空范围键与删除外键合同。"""
import unittest
from uuid import uuid4
import psycopg
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture


class OwnerLayeredConstraintTest(MemoryOverviewHttpFixture, unittest.TestCase):
    def test_owner_unique_scope_and_cross_scope_foreign_keys_are_enforced(self):
        from tests.integration.server.test_layered_profile_management import LayeredProfileHttpTest
        backend = LayeredProfileHttpTest.controlled(self)
        self.backend.request('/api/memories/manual-owner', {'text': '本人合成学习背景。', 'category': 'common_fact'})
        status, result = backend.request('/api/memories/owner/layered-memory/enable', {
            'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, result)
        self.assertTrue(result['layered_memory']['profile'])
        contact, _, _ = self.import_contact('对方的独立合成资料。')
        with psycopg.connect(self.database_url) as connection:
            other = uuid4()
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'隔离合成用户')", (other,))
            self.addCleanup(self.remove_other, other)
            with self.assertRaises(psycopg.errors.UniqueViolation), connection.transaction():
                connection.execute('INSERT INTO public.layered_memory_state(owner_id,contact_id) VALUES(%s,NULL)', (self.owner_id,))
            with self.assertRaises(psycopg.errors.CheckViolation), connection.transaction():
                connection.execute("INSERT INTO public.background_task(owner_id,contact_id,task_type,current_step,status,message_count) "
                    "VALUES(%s,NULL,'observation','parse','queued',0)", (self.owner_id,))
            for table in ('scenario_document_version', 'layered_profile_batch', 'layered_profile_version',
                          'layered_memory_generation', 'layered_memory_job'):
                with self.subTest(table=table), self.assertRaises(psycopg.errors.ForeignKeyViolation), connection.transaction():
                    connection.execute(f'UPDATE public.{table} SET owner_id=%s WHERE owner_id=%s', (other,self.owner_id))
                with self.subTest(table=table, scope='contact'), self.assertRaises(psycopg.errors.ForeignKeyViolation), connection.transaction():
                    connection.execute(f'UPDATE public.{table} SET contact_id=%s WHERE owner_id=%s', (contact,self.owner_id))
            row = connection.execute('SELECT id,scenario_id,batch_id FROM public.scenario_document_version WHERE owner_id=%s', (self.owner_id,)).fetchone()
            connection.execute('INSERT INTO public.scenario_document_mapping(owner_id,contact_id,source_scenario_id,source_version_id,target_scenario_id,target_version_id,batch_id) VALUES(%s,NULL,%s,%s,%s,%s,%s)',
                (self.owner_id,uuid4(),uuid4(),row[1],row[0],row[2]))
            with self.assertRaises(psycopg.errors.ForeignKeyViolation), connection.transaction():
                connection.execute('UPDATE public.scenario_document_mapping SET owner_id=%s WHERE owner_id=%s', (other,self.owner_id))
            # 删除实际batch须清除主题、映射、画像和引用画像的冻结集合。
            connection.execute('DELETE FROM public.layered_memory_batch WHERE id=%s', (row[2],))
            for table in ('scenario_document_version','scenario_document_mapping','layered_profile_batch',
                          'layered_profile_version','layered_memory_generation'):
                self.assertFalse(connection.execute(f'SELECT 1 FROM public.{table} WHERE owner_id=%s', (self.owner_id,)).fetchone(), table)

    def remove_other(self, owner):
        with psycopg.connect(self.database_url) as connection:
            connection.execute('DELETE FROM public.owner WHERE id=%s', (owner,))
