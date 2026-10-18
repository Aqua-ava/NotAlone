"""纠错实际对照、四Port拒绝与完整输入预算走公开HTTP。"""

import unittest

from notalone.memory.layered import OrganizationBudget
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server import test_layered_memory_corrections as correction
from tests.integration.server import test_layered_memory_management as scenario
from tests.integration.server import test_layered_profile_management as profile


class LayeredCorrectionContractHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    controlled = profile.LayeredProfileHttpTest.controlled
    enable = profile.LayeredProfileHttpTest.enable
    read = profile.LayeredProfileHttpTest.read

    def _feedback_then_new_fact(self):
        contact, _, message = self.import_contact('合成纠错合同的原规范消息。')
        self.confirm(contact, '双方共同参加合成课程。', message)
        backend = self.controlled(**self._adapters(), budget=OrganizationBudget(max_model_calls=4, max_characters=12000))
        ready = self.enable(backend, contact)
        path = f'/api/contacts/{contact}/layered-memory'
        command = correction.LayeredMemoryCorrectionHttpTest.summary_command(self, ready)
        command['reason'] = '总结保真需要重新核对。' * 30
        status, result = backend.request(path + '/summary-error', command)
        self.assertEqual(status, 200, result)
        self.assertEqual(self.backend.request('/api/memories/manual-contact', {
            'contact_id': contact, 'text': '双方另有独立合成事实。', 'category': 'common_fact'})[0], 200)
        return path, ready

    @staticmethod
    def _adapters():
        return {'scenario_proposer': correction.CorrectionProposal(), 'scenario_verifier': correction.CorrectionVerification(),
            'profile_proposer': correction.CorrectionProfileProposal(), 'profile_verifier': correction.CorrectionProfileVerification()}

    def _unsupported(self, name, adapter, expected_calls):
        path, ready = self._feedback_then_new_fact()
        adapters = self._adapters()
        adapters[name] = adapter
        backend = self.controlled(**adapters, budget=OrganizationBudget(max_model_calls=4, max_characters=12000))
        status, result = backend.request(path + '/refresh', {'settings_generation': ready['settings_generation']})
        self.assertEqual(status, 200, result)
        state = result['layered_memory']
        self.assertEqual(state['status'], 'failed', state)
        self.assertEqual(state['error_code'], 'profile_proposal_invalid' if name.startswith('profile') else 'proposal_invalid')
        self.assertIsNone(state['profile'])
        self.assertEqual(state['model_calls_used'], expected_calls)
        if name.startswith('scenario'):
            self.assertEqual(state['scenarios'], [])
        else:
            self.assertTrue(state['scenarios'], '画像拒绝不能误撤合法的新L2')

    def test_unsupported_scenario_proposer_stays_closed(self):
        self._unsupported('scenario_proposer', scenario.EchoProposal(), 1)

    def test_unsupported_scenario_verifier_stays_closed(self):
        self._unsupported('scenario_verifier', scenario.ControlledVerification(), 2)

    def test_unsupported_profile_proposer_stays_closed(self):
        self._unsupported('profile_proposer', profile.ProfileProposal(), 3)

    def test_unsupported_profile_verifier_stays_closed(self):
        self._unsupported('profile_verifier', profile.ProfileVerification(), 4)

    def test_feedback_comparison_counts_before_any_new_model_send(self):
        path, ready = self._feedback_then_new_fact()
        adapters = self._adapters()
        backend = self.controlled(**adapters, budget=OrganizationBudget(max_model_calls=4, max_characters=700))
        status, result = backend.request(path + '/refresh', {'settings_generation': ready['settings_generation']})
        self.assertEqual(status, 200, result)
        state = result['layered_memory']
        self.assertEqual(state['status'], 'failed', state)
        self.assertEqual(state['error_code'], 'input_budget_exceeded')
        self.assertEqual(state['model_calls_used'], 0)
        self.assertEqual(state['scenarios'], [])
        self.assertEqual(adapters['scenario_proposer'].inputs, [])
        control_contact, _, _ = self.import_contact('合成无反馈的预算对照入口。')
        self.assertEqual(self.backend.request('/api/memories/manual-contact', {
            'contact_id': control_contact, 'text': '双方另有独立合成事实。', 'category': 'common_fact'})[0], 200)
        control_adapters = self._adapters()
        control = self.controlled(**control_adapters, budget=OrganizationBudget(max_model_calls=4, max_characters=700))
        self.enable(control, control_contact)
        self.assertEqual(len(control_adapters['scenario_proposer'].inputs), 1,
            '同一份L1在无反馈时能进入提案；新增对照必须与它合计而非只检查L1')
