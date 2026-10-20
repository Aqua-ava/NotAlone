"""纠错清除实际场景工具、准备、讨论及已保存回复副本。"""

import json
import unittest

from langchain_core.messages import ToolMessage

from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture
from tests.integration.server import test_layered_profile_management as profiles
from tests.integration.server import test_layered_memory_corrections as corrections
from tests.integration.server import test_scenario_read_tool as tools


class LayeredCorrectionReplyCopiesHttpTest(OverviewReplyHttpFixture, unittest.TestCase):
    controlled = profiles.LayeredProfileHttpTest.controlled
    read = profiles.LayeredProfileHttpTest.read
    enable = profiles.LayeredProfileHttpTest.enable
    use_tools = tools.ScenarioReadHttpTest.use_tools

    def _used_reply_feedback(self, scope_kind, target_kind, *, fact=False):
        from notalone.memory.layered import OrganizationBudget
        from notalone.reply.layered_context import LayeredReplyBudget

        contact, _, message = self.import_contact('双方共同参加合成课程。')
        self.confirm(contact, '双方共同参加合成课程。', message)
        management = self.controlled(scenario_proposer=corrections.CorrectionProposal(),
            scenario_verifier=corrections.CorrectionVerification(),
            profile_proposer=corrections.CorrectionProfileProposal(),
            profile_verifier=corrections.CorrectionProfileVerification(),
            budget=OrganizationBudget(max_model_calls=4, max_characters=12000))
        ready = self.enable(management, contact)
        self.assertTrue(ready['scenarios'], ready)
        contact_ready = ready
        management_path = f'/api/contacts/{contact}/layered-memory'
        if scope_kind == 'owner':
            self.assertEqual(self.backend.request('/api/memories/manual-owner', {
                'text': '本人有独立合成学习背景。', 'category': 'common_fact'})[0], 200)
            management_path = '/api/memories/owner/layered-memory'
            status, result = management.request(management_path + '/enable', {
                'settings_generation': 0, 'purpose_confirmed': True})
            self.assertEqual(status, 200, result)
            ready = result['layered_memory']
        self.layered_reply_options = {'layered_memory': self.service,
            'layered_reply_budget': LayeredReplyBudget(4, 4, 4000)}
        self.activate_replies(contact)
        self.use_tools()
        # 08实际工具只接受07联系人目录；本人新层组合由09单独交付。
        scenario = contact_ready['scenarios'][0]
        self.reply_model.plans.extend([tools.ScenarioReadHttpTest.tool_plan(scenario['scenario_id']),
            {'text': '合成纠错前的回复副本。', 'basis': '按本次实际提供的资料。'}])
        reply_path = self.reply_path(contact)
        completed_body = self.rewrite_body(contact, '合成纠错前的输入副本。')
        status, completed = self.backend.request(reply_path + '/replies', completed_body)
        self.assertEqual(status, 200, completed)
        sent = [json.loads(item.content) for item in self.reply_model.seen_calls[-1]
            if isinstance(item, ToolMessage) and item.name == 'read_scenario']
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]['status'], 'succeeded', sent)
        evidence_path = self.evidence_path(contact, completed)
        saved = self._get(self.backend, evidence_path)
        self.assertEqual(saved['layered_scenario_reads'], sent)
        self.assertIn(scenario['paragraphs'][0]['text'], str(sent))
        prepared_body = self.rewrite_body(contact, '合成纠错前待生成的准备副本。')
        self.assertEqual(self.backend.request(reply_path + '/replies/prepare', prepared_body)[0], 200)
        command = corrections.LayeredMemoryCorrectionHttpTest.summary_command(self, ready, kind=target_kind)
        if fact:
            command.pop('reason')
            command.pop('operation_id')
            items = ready['scenarios'][0]['paragraphs'] if target_kind == 'scenario' else ready['profile']['entries']
            command['memory_id'] = items[0]['references'][0]['memory_id']
        status, result = management.request(management_path + ('/fact-error' if fact else '/summary-error'), command)
        self.assertEqual(status, 200, result)
        if scope_kind == 'owner':
            self.assertNotIn(ready['profile']['version_id'], str(saved))
            self.assertEqual(self._get(self.backend, evidence_path), saved,
                '未实际使用的本人新层反馈不能清除合法联系人工具副本')
            self.backend = self._backend(self.owner_id)
            self.assertEqual(self._get(self.backend, evidence_path), saved)
            self.reply_model.plans.append({'text': '本人反馈后仍可用的联系人回复。', 'basis': '按联系人合法资料。'})
            self.assertEqual(self.backend.request(reply_path + '/replies', prepared_body)[0], 200)
            return
        self.assertNotEqual(self.backend.request(evidence_path)[0], 200)
        discussion = self._get(self.backend, reply_path)
        for erased in ('合成纠错前的回复副本。', '合成纠错前的输入副本。', '合成纠错前待生成的准备副本。'):
            self.assertNotIn(erased, str(discussion))
        before = len(self.reply_model.payloads)
        self.backend = self._backend(self.owner_id)
        self.assertNotEqual(self.backend.request(reply_path + '/replies', prepared_body)[0], 200)
        self.assertNotEqual(self.backend.request(reply_path + '/replies', completed_body)[0], 200)
        self.assertEqual(len(self.reply_model.payloads), before)
        self.assertNotEqual(self.backend.request(evidence_path)[0], 200)

    def test_contact_scenario_feedback_erases_actual_tool_and_reply_copies(self):
        self._used_reply_feedback('contact', 'scenario')

    def test_contact_profile_feedback_erases_actual_tool_and_reply_copies(self):
        self._used_reply_feedback('contact', 'profile')

    def test_contact_profile_fact_error_erases_actual_l2_tool_and_reply_copies(self):
        self._used_reply_feedback('contact', 'profile', fact=True)

    def test_contact_scenario_fact_error_erases_actual_tool_and_reply_copies(self):
        self._used_reply_feedback('contact', 'scenario', fact=True)

    def test_owner_profile_feedback_keeps_unaffected_contact_tool_copies(self):
        self._used_reply_feedback('owner', 'profile')
