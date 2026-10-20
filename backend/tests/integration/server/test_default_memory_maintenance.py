"""新记忆默认进入整理；明确停用或删除后不能被新事实重新开启。"""

import unittest
from uuid import uuid4

import psycopg

from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture


class DefaultMemoryMaintenanceTest(CoreBusinessFlowFixture, unittest.TestCase):
    def test_new_owner_and_contact_memories_enable_maintenance_without_upgrade_or_enable(self):
        contact = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成自动整理联系人')",
                (contact, self.owner_id))
        for kind in ('owner', 'contact'):
            with self.subTest(kind=kind):
                body = {'text': '长期喜欢合成茶。', 'category': 'common_fact'}
                if kind == 'contact':
                    body['contact_id'] = str(contact)
                status, _ = self.backend.request('/api/memories/manual-' + kind, body)
                self.assertEqual(status, 200)
                path = ('/api/memories/owner/layered-memory' if kind == 'owner'
                    else f'/api/contacts/{contact}/layered-memory')
                status, result = self.backend.request(path)
                self.assertEqual(status, 200)
                state = result['layered_memory']
                self.assertTrue(state['enabled'])
                self.assertTrue(state['maintenance_pending'])
                for action in ('disable', 'delete'):
                    status, result = self.backend.request(path + '/' + action,
                        {'settings_generation': state['settings_generation']})
                    self.assertEqual(status, 200, result)
                    body['text'] += '合成新事实。'
                    self.assertEqual(self.backend.request('/api/memories/manual-' + kind, body)[0], 200)
                    state = self.backend.request(path)[1]['layered_memory']
                    self.assertFalse(state['enabled'])
                    self.assertEqual(state['status'], 'disabled')

    def test_owner_first_fact_automatically_runs_four_stages_and_reply_snapshot_remains_revocable(self):
        self._assert_four_stage_maintenance('owner')

    def test_contact_first_fact_automatically_runs_four_stages_and_reply_snapshot_remains_revocable(self):
        self._assert_four_stage_maintenance('contact')

    def _assert_four_stage_maintenance(self, kind):
        from threading import Event
        from time import monotonic
        from notalone.application.layered_memory_service import LayeredMemoryService
        from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
        from notalone.scopes import OwnerScope, ContactScope
        from notalone.server.app import create_app
        from tests.integration.server.core_business_flow_support import HttpBackend
        from tests.integration.server.test_layered_memory_management import EchoProposal, ControlledVerification
        from tests.integration.server.test_layered_profile_management import ProfileProposal, ProfileVerification

        service = LayeredMemoryService(PostgresLayeredMemoryStore(self.database_url),
            proposer=EchoProposal(), verifier=ControlledVerification(), profile_proposer=ProfileProposal(),
            profile_verifier=ProfileVerification(), synthetic=True, runtime_policy='verified_items')
        backend = HttpBackend(create_app(database_url=self.database_url, owner_id=self.owner_id,
            token='synthetic-default-maintenance', layered_memory=service), self.owner_id)
        self.addCleanup(backend.close)
        contact = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成四阶段联系人')",
                (contact, self.owner_id))
        scope = OwnerScope(self.owner_id) if kind == 'owner' else ContactScope(self.owner_id, contact)
        path = '/api/memories/owner/layered-memory' if kind == 'owner' else f'/api/contacts/{contact}/layered-memory'
        identity = {} if kind == 'owner' else {'contact_id': str(contact)}
        # 读取空状态不等于手动启用；之后新增L1须唤醒首次工作。
        self.assertEqual(backend.request(path)[0], 200)
        status, _ = self.backend.request('/api/memories/manual-' + kind,
            {**identity, 'text': '双方有共同学习经历。', 'category': 'common_fact'})
        self.assertEqual(status, 200)
        deadline = monotonic() + 5
        while monotonic() < deadline:
            state = backend.request(path)[1]['layered_memory']
            if (state['status'] == 'ready' and state['profile'] is not None
                    and not state['maintenance_pending']):
                break
            Event().wait(.05)
        self.assertEqual(state['status'], 'ready', state)
        self.assertEqual(state['model_calls_used'], 4)
        self.assertTrue(state['scenarios'])
        self.assertIsNotNone(state['profile'])
        self.assertFalse(state['maintenance_pending'])
        self.assertEqual(state['runtime_policy'], 'verified_items')
        snapshot = service.capture(scope)
        self.assertIsNotNone(snapshot)
        self.assertTrue(service.validate(snapshot))
        self.assertTrue(snapshot.quality_receipt.startswith('verified-items-v1:'))
        self.assertEqual(self.backend.request('/api/memories/manual-' + kind,
            {**identity, 'text': '双方又一起参加合成练习。', 'category': 'common_fact'})[0], 200)
        deadline = monotonic() + 5
        while monotonic() < deadline:
            updated = backend.request(path)[1]['layered_memory']
            if (updated['status'] == 'ready' and updated['covered_count'] == 2
                    and updated['profile'] is not None
                    and updated['profile']['version_id'] != state['profile']['version_id']
                    and not updated['maintenance_pending']):
                break
            Event().wait(.05)
        self.assertEqual(updated['status'], 'ready', updated)
        self.assertEqual(updated['covered_count'], 2)
        self.assertIsNotNone(updated['profile'])
        self.assertNotEqual(updated['profile']['version_id'], state['profile']['version_id'])
        self.assertFalse(updated['maintenance_pending'])
        self.assertEqual(updated['model_calls_used'], 4)
        self.assertFalse(service.validate(snapshot))
        snapshot = service.capture(scope)
        self.assertTrue(service.validate(snapshot))
        state = updated
        status, result = backend.request(path + '/disable', {'settings_generation': state['settings_generation']})
        self.assertEqual(status, 200, result)
        self.assertFalse(service.validate(snapshot))
        self.assertIsNone(service.capture(scope))

    def test_correction_rebuilds_current_layers_keeps_audit_then_source_deletion_erases_all_batches(self):
        from threading import Event
        from time import monotonic
        from uuid import UUID
        from tests.integration.server.test_layered_profile_management import LayeredProfileHttpTest
        from tests.integration.server.test_layered_memory_management import EchoProposal
        from notalone.persistence.source_deletion import PostgresSourceDeletionRepository

        contact = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成纠错重建联系人')",
                (contact, self.owner_id))
        class CurrentFactProposal(EchoProposal):
            def propose(self, *, memories, budget, deadline):
                result = super().propose(memories=memories, budget=budget, deadline=deadline)
                result['scenarios'][0]['topic_key'] = 'learning-' + str(memories[0].memory_id)
                return result

        backend = LayeredProfileHttpTest.controlled(self, scenario_proposer=CurrentFactProposal(), automatic_maintenance=True)
        path = f'/api/contacts/{contact}/layered-memory'
        status, result = self.backend.request('/api/memories/manual-contact',
            {'contact_id': str(contact), 'text': '双方共同学习合成课程。', 'category': 'common_fact'})
        self.assertEqual(status, 200, result)
        original = result['memory']

        def ready(previous_profile=None):
            deadline = monotonic() + 8
            while True:
                state = backend.request(path)[1]['layered_memory']
                if (state['status'] == 'ready' and state['profile'] is not None
                        and state['profile']['version_id'] != previous_profile and not state['maintenance_pending']):
                    return state
                self.assertLess(monotonic(), deadline, state)
                Event().wait(.04)

        before = ready()
        with psycopg.connect(self.database_url) as connection:
            old_batches = [row[0] for row in connection.execute(
                'SELECT id FROM public.layered_memory_batch WHERE owner_id=%s AND contact_id=%s',
                (self.owner_id, contact))]
        self.assertTrue(old_batches)
        status, corrected = self.backend.request(f'/api/contacts/{contact}/memories/{original["memory_id"]}/correct',
            {'text': '双方一起完成合成课程。', 'revision': original['revision'], 'category': 'common_fact'})
        self.assertEqual(status, 200, corrected)
        after = ready(before['profile']['version_id'])
        self.assertNotEqual(after['profile']['version_id'], before['profile']['version_id'])
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM public.layered_memory_batch WHERE id=ANY(%s)',
                (old_batches,)).fetchone()[0], len(old_batches))
            self.assertTrue(connection.execute('SELECT 1 FROM public.layered_profile_version WHERE id=%s',
                (UUID(before['profile']['version_id']),)).fetchone())
            all_batches = [row[0] for row in connection.execute(
                'SELECT id FROM public.layered_memory_batch WHERE owner_id=%s AND contact_id=%s', (self.owner_id, contact))]
        self.assertGreater(len(all_batches), len(old_batches))
        source = UUID(original['source_ids'][0])
        deletion = PostgresSourceDeletionRepository(self.database_url)
        deletion.delete_source(owner_id=self.owner_id, contact_id=contact, source_document_id=source)
        deletion.verify_deleted(owner_id=self.owner_id, contact_id=contact, source_document_id=source)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM public.layered_memory_batch WHERE id=ANY(%s)',
                (all_batches,)).fetchone()[0], 0)
            self.assertFalse(connection.execute('SELECT 1 FROM public.layered_profile_version WHERE id=ANY(%s)',
                ([UUID(before['profile']['version_id']), UUID(after['profile']['version_id'])],)).fetchone())
