"""逐命题合同的本地反例；不声称模型能正确分解或判定关系重要性。"""
from copy import deepcopy
import time
import unittest
from uuid import UUID

from notalone.memory.layered import OrganizationBudget, OrganizationInput
from notalone.memory.organization_deadline import OrganizationCallDeadline
from notalone.memory.organization_quality import content_digest
from notalone.memory.organization_sdk import DeepSeekOrganizationVerification
from tests.unit.memory.test_organization_sdk_verification import ResponseModel


class OrganizationClaimVerificationTest(unittest.TestCase):
    def setUp(self):
        self.parts = ['联系人长期偏好步行出游。', '其亲属近期参加了一次展览。']
        self.memory = OrganizationInput(UUID(int=31), 2, ''.join(self.parts), 'manual_entry',
            {'current_status': 'current_unverified'}, None, 'common_fact', None, None)
        self.reference = {'memory_id': str(self.memory.memory_id), 'revision': 2}
        self.entry = {'text': self.memory.text, 'references': [self.reference],
            'temporal_status': 'uncertain', 'uncertainty': '当前持续情况未核实。'}

    def claim(self, text, *, eligible=True, role='contact', quote=None):
        return {'text': text, 'sources': [{**self.reference, 'quote': quote or text}],
            'subject_role': role, 'subject_basis': '来源原句明确记载该命题的主体。',
            'supported': True, 'profile_eligible': eligible,
            'eligibility_basis': '此命题须独立判断长期价值，不借相邻命题获得准入。'}

    def response(self, claims):
        return {'supported': True, 'reasons': [], 'entries': [{
            'entry_index': 0, 'entry_sha256': content_digest(self.entry),
            'references': [self.reference], 'supported': True, 'profile_eligible': True,
            'temporal_basis': 'current_unverified', 'temporal_references': [],
            'basis': '有字面来源，当前持续性未核实。', 'claims': claims}]}

    def verify(self, response):
        model = ResponseModel(response)
        adapter = DeepSeekOrganizationVerification(model, layer='l3', budget=OrganizationBudget(max_characters=8000, max_model_calls=4), transport=None)
        result = adapter.verify(memories=[self.memory], proposal={'entries': [self.entry]},
            deadline=OrganizationCallDeadline(time.monotonic() + 5))
        self.assertEqual(len(model.requests), 1)
        return result

    def test_every_claim_must_qualify_even_if_entry_and_global_accept(self):
        first = self.claim(self.parts[0])
        second = self.claim(self.parts[1], eligible=False, role='third_party')
        self.assertFalse(self.verify(self.response([first, second])))
        second.update(profile_eligible=True, supported=False)
        self.assertFalse(self.verify(self.response([first, second])))
        second.update(supported=True, subject_role='unknown')
        self.assertFalse(self.verify(self.response([first, second])))

    def test_complete_ordered_text_coverage_is_required(self):
        claims = [self.claim(text) for text in self.parts]
        for altered in ([claims[0]], list(reversed(claims)), [claims[0], claims[0], claims[1]],
                        [dict(claims[0], text=self.parts[0][:-1]), claims[1]], []):
            with self.subTest(altered=altered), self.assertRaises(ValueError):
                self.verify(self.response(altered))

    def test_each_source_quote_binds_actual_direct_version(self):
        claims = [self.claim(text) for text in self.parts]
        for source in ({**self.reference, 'revision': 1, 'quote': self.parts[0]},
                       {**self.reference, 'memory_id': str(UUID(int=99)), 'quote': self.parts[0]},
                       {**self.reference, 'quote': '资料没有的原文'}, {**self.reference, 'quote': ''}):
            altered = deepcopy(claims)
            altered[0]['sources'] = [source]
            with self.subTest(source=source), self.assertRaises(ValueError):
                self.verify(self.response(altered))

    def test_claim_schema_and_bounds_fail_closed(self):
        claims = [self.claim(text) for text in self.parts]
        mutations = [dict(claims[0], supported='true'), dict(claims[0], subject_role='invented'),
            dict(claims[0], subject_basis=''), dict(claims[0], eligibility_basis=''),
            dict(claims[0], sources=[]), dict(claims[0], extra='unrecognized')]
        for claim in mutations:
            with self.subTest(claim=claim), self.assertRaises(ValueError):
                self.verify(self.response([claim, claims[1]]))
        with self.assertRaises(ValueError):
            self.verify(self.response([self.claim(character, quote=self.memory.text) for character in self.memory.text]))

    def test_legitimate_static_history_and_important_third_person_are_allowed(self):
        cases = [
            ('联系人生日为8月16日。', 'stable', 'static_fact', 'contact', '生日是明确静态事实。'),
            ('联系人于某年完成毕业。', 'historical', 'historical', 'contact', '已发生的重要学习背景。'),
            ('联系人母亲长期承担照护责任，资料明确该责任是双方共同生活的重要背景。',
             'uncertain', 'current_unverified', 'third_party', '来源直接说明第三人的责任与双方共同生活有重要联系。'),
            ('联系人长期照护其行动不便的母亲，双方明确将该照护责任列为重要共同生活背景。',
             'uncertain', 'current_unverified', 'relationship', '来源明确记载亲属照护责任与双方共同生活的联系及重要性，当前持续情况未核实。'),
        ]
        for text, status, basis, role, reason in cases:
            with self.subTest(role=role, basis=basis):
                self.memory = OrganizationInput(UUID(int=31), 2, text, 'manual_entry',
                    {'current_status': 'current_unverified'}, None, 'common_fact', None, None)
                self.entry = {**self.entry, 'text': text, 'temporal_status': status}
                claim = self.claim(text, role=role)
                claim['eligibility_basis'] = reason
                response = self.response([claim])
                response['entries'][0]['temporal_basis'] = basis
                self.assertTrue(self.verify(response))

    def test_old_entry_only_schema_is_structural_failure(self):
        response = self.response([self.claim(self.memory.text)])
        del response['entries'][0]['claims']
        with self.assertRaises(ValueError):
            self.verify(response)
