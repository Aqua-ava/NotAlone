"""两类整理纠错走公开HTTP，使用正式迁移及自有合成资料。"""

import unittest
from datetime import datetime, timezone
from uuid import UUID, uuid4

from notalone.scopes import ContactScope
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server import test_layered_memory_management as scenario_support
from tests.integration.server import test_layered_profile_management as profile_support


class CorrectionProposal(scenario_support.EchoProposal):
    def __init__(self):
        super().__init__()
        self.corrections = []

    def propose(self, *, memories, budget, deadline, corrections=()):
        result = super().propose(memories=memories, budget=budget, deadline=deadline)
        self.corrections.append(corrections)
        if corrections:
            result['scenarios'][0].update(topic_key='supplement-' + str(memories[0].memory_id),
                title='已核对的补充资料', hint='独立资料的原文背景。')
        return result


class CorrectionVerification(scenario_support.ControlledVerification):
    def verify(self, *, memories, proposal, deadline, corrections=()):
        self.corrections = corrections
        return super().verify(memories=memories, proposal=proposal, deadline=deadline)


class CorrectionProfileProposal(profile_support.ProfileProposal):
    def propose(self, *, scenarios, memories, budget, deadline, corrections=()):
        self.inputs.append((scenarios, memories))
        return {'entries': [{'text': memories[0].text, 'temporal_status': 'uncertain',
            'uncertainty': '当前状态按原资料保留，未额外核实。',
            'references': [{'memory_id': str(memories[0].memory_id), 'revision': memories[0].revision}]}]}


class CorrectionProfileVerification(profile_support.ProfileVerification):
    def verify(self, *, scenarios, memories, proposal, deadline, corrections=()):
        return super().verify(scenarios=scenarios, memories=memories, proposal=proposal, deadline=deadline)


class LayeredMemoryCorrectionHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    controlled = scenario_support.LayeredMemoryManagementHttpTest.controlled
    enable = scenario_support.LayeredMemoryManagementHttpTest.enable

    def summary_command(self, ready, *, kind='scenario'):
        return {'settings_generation': ready['settings_generation'],
            'organization_generation': ready['organization_generation'], 'target_kind': kind,
            'version_id': ready['scenarios'][0]['version_id'] if kind == 'scenario' else ready['profile']['version_id'],
            'item_index': 0, 'reason': '该总结含义有误，请按原事实重新整理。', 'operation_id': str(uuid4())}

    def test_independent_new_manual_fact_remains_usable_with_real_correction_comparison(self):
        contact, _, message = self.import_contact('合成独立资料依据。')
        original = self.confirm(contact, '双方共同参加合成课程。', message)
        proposer, verifier = CorrectionProposal(), CorrectionVerification()
        backend = self.controlled(proposer=proposer, verifier=verifier)
        ready = self.enable(backend, contact)
        path = f'/api/contacts/{contact}/layered-memory'
        status, response = backend.request(path + '/summary-error', self.summary_command(ready))
        self.assertEqual(status, 200, response)
        status, added = self.backend.request('/api/memories/manual-contact', {
            'contact_id': contact, 'text': '双方另有独立合成练习事实。', 'category': 'common_fact'})
        self.assertEqual(status, 200, added)
        status, response = backend.request(path + '/refresh', {'settings_generation': ready['settings_generation']})
        self.assertEqual(status, 200, response)
        current = response['layered_memory']
        self.assertEqual(current['status'], 'ready', current)
        self.assertEqual(current['protected_count'], 1)
        self.assertEqual({ref['memory_id'] for doc in current['scenarios'] for para in doc['paragraphs']
            for ref in para['references']}, {added['memory']['memory_id']})
        self.assertTrue(proposer.corrections[-1], '实际提案和核验须取得纠错对照，不能只保存UI反馈')
        self.assertEqual(verifier.corrections, proposer.corrections[-1])
        self.assertNotIn(original['memory_id'], {str(item.memory_id) for item in proposer.inputs[-1]})

    def test_summary_feedback_retracts_result_without_changing_correct_l1(self):
        contact, _, message = self.import_contact("合成课程依据。")
        memory = self.confirm(contact, "双方共同参加合成课程。", message)
        backend = self.controlled(proposer=scenario_support.EchoProposal())
        ready = self.enable(backend, contact)
        snapshot = self.service.capture(ContactScope(self.owner_id, UUID(contact)))
        target = ready['scenarios'][0]
        path = f'/api/contacts/{contact}/layered-memory'
        command = {'settings_generation': ready['settings_generation'],
            'organization_generation': ready['organization_generation'],
            'target_kind': 'scenario', 'version_id': target['version_id'], 'item_index': 0,
            'reason': '这段总结把共同课程写成了长期偏好。', 'operation_id': str(uuid4())}
        status, result = backend.request(path + '/summary-error', command)
        self.assertEqual(status, 200, result)
        corrected = result['layered_memory']
        self.assertEqual(corrected['scenarios'], [])
        self.assertEqual(len(corrected['feedback']), 1)
        self.assertEqual(corrected['feedback'][0]['reason'], command['reason'])
        self.assertFalse(self.service.validate(snapshot))
        self.assertEqual(self._get(self.backend, f'/api/contacts/{contact}/memories')['memories'][0]['text'],
                         memory['text'])
        status, refreshed = backend.request(path + '/refresh', {
            'settings_generation': corrected['settings_generation']})
        self.assertEqual(status, 200, refreshed)
        self.assertEqual(refreshed['layered_memory']['scenarios'], [])
        self.assertEqual(len(self.proposal.inputs), 1, '旧依据不能重新送模型换说法')

    def test_fact_error_selects_only_the_cited_actual_l1_leaf(self):
        contact, _, message = self.import_contact('合成事实修正依据。')
        memory = self.confirm(contact, '双方共同参加合成课程。', message)
        backend = self.controlled(proposer=scenario_support.EchoProposal())
        ready = self.enable(backend, contact)
        path = f'/api/contacts/{contact}/layered-memory'
        command = {'settings_generation': ready['settings_generation'],
            'organization_generation': ready['organization_generation'], 'target_kind': 'scenario',
            'version_id': ready['scenarios'][0]['version_id'], 'item_index': 0,
            'memory_id': str(uuid4())}
        self.assertEqual(backend.request(path + '/fact-error', command)[0], 409)
        command['memory_id'] = memory['memory_id']
        status, result = backend.request(path + '/fact-error', command)
        self.assertEqual(status, 200, result)
        self.assertEqual(result['layered_memory']['correction_target'], {
            'memory_id': memory['memory_id'], 'revision': memory['revision']})
        self.assertEqual(result['layered_memory']['scenarios'], [])
        status, corrected = self.backend.request(f"/api/contacts/{contact}/memories/{memory['memory_id']}/correct", {
            'text': '双方共同参加另一门合成课程。', 'category': 'common_fact', 'revision': memory['revision']})
        self.assertEqual(status, 200, corrected)
        self.assertNotEqual(corrected['memory']['memory_id'], memory['memory_id'])

    def test_feedback_keeps_an_independent_topic_in_the_same_generation_batch_readable(self):
        class SeparateTopics(CorrectionProposal):
            def propose(self, *, memories, budget, deadline, corrections=()):
                result = super().propose(memories=memories, budget=budget, deadline=deadline, corrections=corrections)
                result['scenarios'] = [{'topic_key': f'topic-{index}', 'title': f'独立主题{index}', 'hint': '独立资料。',
                    'paragraphs': [{'text': item.text, 'references': [{'memory_id': str(item.memory_id), 'revision': item.revision}]}]}
                    for index, item in enumerate(memories)]
                return result
        contact, _, _ = self.import_contact('合成独立主题入口。')
        for text in ('主题甲的合成事实。', '主题乙的独立合成事实。'):
            self.backend.request('/api/memories/manual-contact', {'contact_id': contact, 'text': text, 'category': 'common_fact'})
        backend = self.controlled(proposer=SeparateTopics(), verifier=CorrectionVerification())
        ready = self.enable(backend, contact)
        self.assertEqual(len(ready['scenarios']), 2)
        kept = ready['scenarios'][1]
        status, response = backend.request(f'/api/contacts/{contact}/layered-memory/summary-error', self.summary_command(ready))
        self.assertEqual(status, 200, response)
        self.assertEqual([doc['version_id'] for doc in response['layered_memory']['scenarios']], [kept['version_id']])
        snapshot = self.service.capture(ContactScope(self.owner_id, UUID(contact)))
        self.assertTrue(self.service.validate(snapshot))
        read = self.service.read_scenario(snapshot, UUID(kept['scenario_id']), (0, 1))
        self.assertEqual(read['paragraphs'][0]['text'], kept['paragraphs'][0]['text'])

    def test_two_stage_source_erasure_prunes_guard_after_unreferenced_comparison_input(self):
        from threading import Event
        contact, source_a, message_a = self.import_contact('合成主要依据。')
        self.confirm(contact, '双方共同参加合成课程。', message_a)
        _, source_b, message_b = self.import_contact('合成未引用对照依据。', contact_id=contact,
            when=datetime(2024, 2, 1, tzinfo=timezone.utc))
        self.confirm(contact, '双方另有合成比较事实。', message_b)
        backend = self.controlled(proposer=CorrectionProposal(), verifier=CorrectionVerification())
        ready = self.enable(backend, contact)
        path = f'/api/contacts/{contact}/layered-memory'
        status, result = backend.request(path + '/summary-error', self.summary_command(ready))
        self.assertEqual(status, 200, result)
        correction_revision = result['layered_memory']['correction_revision']
        for index, source in enumerate((source_b, source_a)):
            status, result = self.backend.request(f'/api/contacts/{contact}/sources/{source}', method='DELETE')
            self.assertEqual(status, 202, result)
            for _ in range(60):
                sources = self._get(self.backend, f'/api/contacts/{contact}/sources')['sources']
                if next(row for row in sources if row['source_id'] == source)['status'] == 'deleted':
                    break
                Event().wait(.05)
            else:
                self.fail('自有合成来源物理删除未完成')
            state = self._get(backend, path)['layered_memory']
            if index == 0:
                self.assertEqual(state['feedback'][0]['state'], 'erased_guard')
                self.assertIsNone(state['feedback'][0]['reason'])
                self.assertGreater(state['correction_revision'], correction_revision)
                correction_revision = state['correction_revision']
            else:
                self.assertEqual(state['feedback'], [], '最后合法依据删除后不得留永久私密保护')
                self.assertGreater(state['correction_revision'], correction_revision)

    def test_owner_profile_feedback_keeps_l1_and_new_independent_profile_usable(self):
        from notalone.memory.layered import OrganizationBudget
        backend = profile_support.LayeredProfileHttpTest.controlled(self,
            scenario_proposer=CorrectionProposal(), scenario_verifier=CorrectionVerification(),
            profile_proposer=CorrectionProfileProposal(), profile_verifier=CorrectionProfileVerification(),
            budget=OrganizationBudget(max_model_calls=4, max_characters=12000))
        self.backend.request('/api/memories/manual-owner', {'text': '本人完成合成课程。', 'category': 'common_fact'})
        path = '/api/memories/owner/layered-memory'
        status, response = backend.request(path + '/enable', {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, response)
        ready = response['layered_memory']
        self.assertIsNotNone(ready['profile'])
        command = self.summary_command(ready, kind='profile')
        status, response = backend.request(path + '/summary-error', command)
        self.assertEqual(status, 200, response)
        self.assertIsNone(response['layered_memory']['profile'])
        self.assertEqual(response['layered_memory']['scenarios'], ready['scenarios'])
        self.backend.request('/api/memories/manual-owner', {'text': '本人另有独立合成背景。', 'category': 'common_fact'})
        status, response = backend.request(path + '/refresh', {'settings_generation': ready['settings_generation']})
        self.assertEqual(status, 200, response)
        self.assertIsNotNone(response['layered_memory']['profile'], response)
        self.assertEqual(response['layered_memory']['profile']['entries'][0]['text'], '本人另有独立合成背景。')

    def test_old_feedback_operation_cannot_cross_disable_reenable_epoch(self):
        contact, _, message = self.import_contact('合成旧反馈世代依据。')
        self.confirm(contact, '双方共同参加合成课程。', message)
        backend = self.controlled(proposer=CorrectionProposal(), verifier=CorrectionVerification())
        ready = self.enable(backend, contact)
        path = f'/api/contacts/{contact}/layered-memory'
        command = self.summary_command(ready)
        self.assertEqual(backend.request(path + '/summary-error', command)[0], 200)
        self.assertEqual(backend.request(path + '/summary-error', command)[0], 200)
        status, disabled = backend.request(path + '/disable', {'settings_generation': ready['settings_generation']})
        self.assertEqual(status, 200, disabled)
        status, enabled = backend.request(path + '/enable', {
            'settings_generation': disabled['layered_memory']['settings_generation'], 'purpose_confirmed': True})
        self.assertEqual(status, 200, enabled)
        before = enabled['layered_memory']
        status, replayed = backend.request(path + '/summary-error', command)
        self.assertEqual(status, 409, replayed)
        restored = self._get(backend, path)['layered_memory']
        self.assertEqual(restored['feedback'], before['feedback'])
        self.assertEqual(restored['scenarios'], [])
