"""本人整理通过公开HTTP验证，不要求联系人或原会话。"""
import unittest
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture


class OwnerLayeredMemoryHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    def test_owner_recent_state_and_relationship_note_are_eligible(self):
        from tests.integration.server.test_layered_profile_management import LayeredProfileHttpTest
        backend = LayeredProfileHttpTest.controlled(self)
        for category in ('recent_state', 'relationship_note'):
            status, result = self.backend.request('/api/memories/manual-owner',
                {'text': '本人合成阶段资料：' + category, 'category': category})
            self.assertEqual(status, 200, result)
        status, result = backend.request('/api/memories/owner/layered-memory/enable',
            {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, result)
        self.assertEqual(result['layered_memory']['eligible_count'], 2)
        self.assertTrue(result['layered_memory']['scenarios'])

    def test_owner_management_without_any_contact_keeps_unknown_quality_closed(self):
        self.assertEqual(self._get(self.backend, '/api/contacts')['contacts'], [])
        path = '/api/memories/owner/layered-memory'
        state = self._get(self.backend, path)['layered_memory']
        self.assertEqual((state['scope_kind'], state['contact_id'], state['quality_status']),
                         ('owner', None, 'unknown'))
        status, result = self.backend.request(path + '/enable', {
            'settings_generation': state['settings_generation'], 'purpose_confirmed': True})
        self.assertEqual(status, 200, result)
        self.assertEqual(result['layered_memory']['status'], 'blocked')
        for action in ('disable', 'delete'):
            status, result = self.backend.request(path + '/' + action, {
                'settings_generation': result['layered_memory']['settings_generation']})
            self.assertEqual(status, 200, result)
            self.assertFalse(result['layered_memory']['enabled'])
        self.assertEqual(self._get(self.backend, '/api/contacts')['contacts'], [])

    def test_owner_generates_both_layers_and_deletes_without_contact(self):
        from tests.integration.server.test_layered_profile_management import LayeredProfileHttpTest
        backend = LayeredProfileHttpTest.controlled(self)
        status, added = self.backend.request('/api/memories/manual-owner', {
            'text': '本人长期学习合成课程。', 'category': 'common_fact'})
        self.assertEqual(status, 200, added)
        path = '/api/memories/owner/layered-memory'
        state = self._get(backend, path)['layered_memory']
        status, result = backend.request(path + '/enable', {
            'settings_generation': state['settings_generation'], 'purpose_confirmed': True})
        self.assertEqual(status, 200, result)
        state = result['layered_memory']
        self.assertEqual(state['status'], 'ready', state)
        self.assertTrue(state['scenarios'])
        self.assertTrue(state['profile'])
        self.assertEqual(state['model_calls_used'], 4)
        status, result = backend.request(path + '/delete', {
            'settings_generation': state['settings_generation']})
        self.assertEqual(status, 200, result)
        self.assertEqual(result['layered_memory']['scenarios'], [])
        self.assertIsNone(result['layered_memory']['profile'])

    def test_owner_model_input_is_whitelisted_and_unreferenced_input_deletion_erases_both_layers(self):
        from dataclasses import fields
        from tests.integration.server.test_layered_profile_management import LayeredProfileHttpTest
        backend = LayeredProfileHttpTest.controlled(self)
        ids = []
        for text in ('本人学习合成课程。', '本人偏好提前安排合成学习。'):
            status, result = self.backend.request('/api/memories/manual-owner', {'text': text, 'category': 'common_fact'})
            self.assertEqual(status, 200, result)
            ids.append(result['memory']['memory_id'])
        path = '/api/memories/owner/layered-memory'
        status, result = backend.request(path + '/enable', {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, result)
        self.assertTrue(result['layered_memory']['profile'])
        for item in self.profile_proposer.inputs[0][1]:
            self.assertEqual({field.name for field in fields(item)}, {'memory_id', 'revision', 'text', 'timing'})
            self.assertEqual(set(item.to_payload()), {'memory_id', 'revision', 'text', 'timing'})
        status, deleted = self.backend.request('/api/memories/owner/' + ids[1] + '/delete', {})
        self.assertEqual(status, 200, deleted)
        state = self._get(backend, path)['layered_memory']
        self.assertEqual(state['scenarios'], [])
        self.assertIsNone(state['profile'])

    def test_withdraw_owner_scenario_revokes_profile_and_frozen_snapshot(self):
        from tests.integration.server.test_layered_profile_management import LayeredProfileHttpTest
        from notalone.scopes import OwnerScope
        backend = LayeredProfileHttpTest.controlled(self)
        self.backend.request('/api/memories/manual-owner', {'text': '本人学习合成课程。', 'category': 'common_fact'})
        path = '/api/memories/owner/layered-memory'
        status, result = backend.request(path + '/enable', {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, result)
        state = result['layered_memory']
        snapshot = self.service.capture(OwnerScope(self.owner_id))
        self.assertTrue(self.service.validate(snapshot))
        command = {'settings_generation': state['settings_generation'],
            'organization_generation': state['organization_generation'],
            'scenario_version_id': state['scenarios'][0]['version_id']}
        status, result = backend.request(path + '/withdraw-scenario', command)
        self.assertEqual(status, 200, result)
        self.assertEqual(result['layered_memory']['scenarios'], [])
        self.assertIsNone(result['layered_memory']['profile'])
        self.assertFalse(self.service.validate(snapshot))
        self.assertEqual(backend.request(path + '/withdraw-scenario', command)[0], 409)
        reread = self._get(backend, path)['layered_memory']
        self.assertEqual(reread['scenarios'], [])
        self.assertIsNone(reread['profile'])
        self.assertEqual(reread['model_calls_used'], state['model_calls_used'])
