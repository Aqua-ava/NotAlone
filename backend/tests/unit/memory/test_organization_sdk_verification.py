"""实际整理Adapter的核验合同；不以合成回答替代真实语义质量。"""
from copy import deepcopy
import json
import time
import unittest
from uuid import UUID

from langchain_core.messages import AIMessage
from notalone.memory.layered import OrganizationBudget, OrganizationInput
from notalone.memory.organization_deadline import OrganizationCallDeadline
from notalone.memory.organization_quality import content_digest
from notalone.memory.organization_sdk import DeepSeekOrganizationVerification


class ResponseModel:
    def __init__(self, response):
        self.response, self.requests = response, []

    def bind(self, **kwargs):
        return self

    def invoke(self, messages):
        self.requests.append(messages)
        return AIMessage(json.dumps(self.response, ensure_ascii=False), response_metadata={'finish_reason': 'stop'})


class OrganizationVerificationContractTest(unittest.TestCase):
    def setUp(self):
        self.memory = OrganizationInput(UUID(int=1), 2, '本人自某年起每周参加绘画课。',
            'manual_entry', {'current_status': 'current_unverified'}, None, 'common_fact', None, None)
        self.entry = {'text': self.memory.text, 'references': [{'memory_id': str(self.memory.memory_id), 'revision': 2}],
                      'temporal_status': 'stable', 'uncertainty': '当前持续情况未经核实。'}

    def audit(self, entry=None, **changes):
        entry = entry or self.entry
        return {'entry_index': 0, 'entry_sha256': content_digest(entry),
            'references': deepcopy(entry['references']), 'supported': True, 'profile_eligible': True,
            'temporal_basis': 'current_unverified', 'temporal_references': [],
            'basis': '只支持过去持续的安排，当前是否继续未核实。',
            'claims': [{'text': entry['text'], 'sources': [{**entry['references'][0], 'quote': self.memory.text}],
                'subject_role': 'owner', 'subject_basis': '来源明确记载本人事实。',
                'supported': True, 'profile_eligible': True, 'eligibility_basis': '仅测试逐条时间门，不替代语义判断。'}], **changes}

    def verify(self, response, *, entries=None, memories=None, layer='l3'):
        model = ResponseModel(response)
        adapter = DeepSeekOrganizationVerification(model, layer=layer, budget=OrganizationBudget(), transport=None)
        result = adapter.verify(memories=memories or [self.memory], scenarios=[], corrections=[],
            proposal={'entries': entries if entries is not None else [self.entry]},
            deadline=OrganizationCallDeadline(time.monotonic() + 10))
        return result, model

    def test_legacy_blanket_support_does_not_accept_missing_entry_audit(self):
        with self.assertRaises(ValueError):
            self.verify({'supported': True, 'reasons': []})

    def test_unverified_ongoing_state_cannot_be_accepted_as_stable(self):
        self.assertFalse(self.verify({'supported': True, 'reasons': [], 'entries': [self.audit()]})[0])
        uncertain = {**self.entry, 'temporal_status': 'uncertain'}
        self.assertTrue(self.verify({'supported': True, 'reasons': [], 'entries': [self.audit(uncertain)]}, entries=[uncertain])[0])

    def test_static_birthday_is_not_rejected_by_unverified_generic_source_status(self):
        birthday = {**self.entry, 'text': '联系人生日月日为7月9日。', 'uncertainty': '仅来自所提供资料。'}
        audit = self.audit(birthday, temporal_basis='static_fact', basis='生日月日是静态事实，不声称活动仍在持续。')
        result, model = self.verify({'supported': True, 'reasons': [], 'entries': [audit]}, entries=[birthday])
        self.assertTrue(result)
        request = json.loads(model.requests[0][-1].content)
        self.assertEqual(request['verification_targets'], [{'entry_index': 0, 'entry_sha256': content_digest(birthday)}])

    def test_profile_ineligibility_cannot_be_overridden_by_global_supported(self):
        for text in ('本人计划某次节日出游。', '本人仅在天气晴朗时参加某次活动。'):
            with self.subTest(text=text):
                entry = {**self.entry, 'text': text, 'temporal_status': 'uncertain'}
                audit = self.audit(entry, profile_eligible=False, basis='一次性计划或条件不属于长期背景。')
                self.assertFalse(self.verify({'supported': True, 'reasons': [], 'entries': [audit]}, entries=[entry])[0])

    def test_current_evidence_requires_actual_referenced_verified_version(self):
        verified = OrganizationInput(UUID(int=2), 1, '当前确认的同一安排。', 'manual_entry',
            {'current_status': 'current_verified'}, None, 'common_fact', None, None)
        reference = {'memory_id': str(verified.memory_id), 'revision': 1}
        entry = {**self.entry, 'references': [*self.entry['references'], reference]}
        audit = self.audit(entry, temporal_basis='current_verified', temporal_references=[reference])
        args = {'entries': [entry], 'memories': [self.memory, verified]}
        self.assertTrue(self.verify({'supported': True, 'reasons': [], 'entries': [audit]}, **args)[0])
        audit['temporal_references'] = deepcopy(self.entry['references'])
        self.assertFalse(self.verify({'supported': True, 'reasons': [], 'entries': [audit]}, **args)[0])

    def test_entry_identity_coverage_and_reference_mismatch_close_the_adapter(self):
        entry = {**self.entry, 'temporal_status': 'uncertain'}
        valid = self.audit(entry)
        for audits in ([], [valid, valid], [dict(valid, entry_index=1)], [dict(valid, entry_sha256='old')],
                       [dict(valid, references=[])], [dict(valid, temporal_basis='invented')],
                       [dict(valid, supported='true')]):
            with self.subTest(audits=audits):
                with self.assertRaises(ValueError):
                    self.verify({'supported': True, 'reasons': [], 'entries': audits}, entries=[entry])

    def test_l2_boolean_contract_and_empty_l3_are_preserved(self):
        self.assertTrue(self.verify({'supported': True, 'reasons': []}, layer='l2')[0])
        self.assertTrue(self.verify({'supported': True, 'reasons': [], 'entries': []}, entries=[])[0])
