"""实际个人画像适配器的固定拒绝原因，不读取私人资料或调用外部模型。"""

from copy import deepcopy
from dataclasses import replace
import json
import time
import unittest
from uuid import UUID

from langchain_core.messages import AIMessage

from notalone.memory.layered import OrganizationBudget, OrganizationInput
from notalone.memory.organization_deadline import OrganizationCallDeadline
from notalone.memory.organization_quality import content_digest
from notalone.memory.organization_sdk import DeepSeekOrganizationVerification


class SyntheticResponseModel:
    def __init__(self, response):
        self.response = response
        self.requests = []

    def bind(self, **kwargs):
        return self

    def invoke(self, messages):
        self.requests.append(messages)
        return AIMessage(json.dumps(self.response), response_metadata={'finish_reason': 'stop'})


class PersonalVerificationDiagnosticsTest(unittest.TestCase):
    def setUp(self):
        self.memory = OrganizationInput(UUID(int=701), 1, '合成人物姓名为林示例。',
            'manual_entry', {'current_status': 'current_unverified'}, None, 'common_fact', None, None)
        self.ref = {'memory_id': str(self.memory.memory_id), 'revision': 1}
        self.entry = {'text': self.memory.text, 'kind': 'fact', 'section': 'basic_information',
            'basis': '资料直接记载姓名。', 'temporal_status': 'uncertain',
            'uncertainty': '仅按原资料保留。', 'references': [self.ref]}

    def response(self):
        return {'items': [{'index': 0, 'sha256': content_digest(self.entry), 'supported': True,
            'contains_action_guidance': False, 'reasons': [], 'statements': [{
                'index': 0, 'kind': self.entry['kind'],
                'support_type': 'direct' if self.entry['kind'] == 'fact' else self.entry['kind'],
                'supported': True, 'uncertainty_preserved': True, 'basis': '实际资料支持该条内容。',
                'temporal_basis': 'static_fact', 'temporal_references': [],
                'sources': [{**self.ref, 'quote': self.memory.text}], 'claims': [{
                    'text': self.entry['text'], 'sources': [{**self.ref, 'quote': self.memory.text}],
                    'source_subjects': [{**self.ref, 'subject_roles': ['contact'], 'basis': '来源直接描述联系人。'}],
                    'subject_role': 'contact', 'subject_basis': '来源直接描述联系人。',
                    'supported': True, 'value_category': 'static_fact',
                    'eligibility_basis': '姓名是静态背景。', 'relationship_impact': None}]}]}]}

    def verify(self, response, *, memories=None, corrections=()):
        self.model = SyntheticResponseModel(response)
        adapter = DeepSeekOrganizationVerification(self.model, layer='l3',
            budget=OrganizationBudget(), transport=None, personal=True)
        return adapter.verify_items(memories=memories or [self.memory], corrections=corrections,
            proposal={'entries': [deepcopy(self.entry)]},
            deadline=OrganizationCallDeadline(time.monotonic() + 10))

    def test_digest_mismatch_has_a_safe_specific_reason(self):
        response = self.response()
        response['items'][0]['sha256'] = 'wrong'
        response['items'][0]['reasons'] = ['不应复制到诊断中的模型原文']
        result = self.verify(response)
        self.assertEqual(result['accepted_indices'], [])
        self.assertEqual(result['rejected'][0]['code'], 'target_digest_mismatch')
        self.assertNotIn('模型原文', result['rejected'][0]['reason'])

    def test_rejection_codes_distinguish_contract_evidence_and_semantic_failures(self):
        cases = [
            ('kind_mismatch', lambda a, s: s.update(kind='preference')),
            ('support_type_mismatch', lambda a, s: s.update(support_type='inference')),
            ('source_reference_mismatch', lambda a, s: s['sources'][0].update(revision=2)),
            ('source_quote_mismatch', lambda a, s: s['sources'][0].update(quote='不存在的来源原文')),
            ('temporal_basis_mismatch', lambda a, s: s.update(temporal_basis='unknown')),
            ('temporal_fields_missing', lambda a, s: s.pop('temporal_references')),
            ('verification_field_missing', lambda a, s: s.pop('kind')),
            ('model_unsupported', lambda a, s: a.update(supported=False)),
            ('model_unsupported', lambda a, s: s.update(supported=False)),
            ('action_guidance_detected', lambda a, s: a.update(contains_action_guidance=True)),
        ]
        for code, change in cases:
            with self.subTest(code=code):
                response = self.response()
                audit = response['items'][0]
                change(audit, audit['statements'][0])
                result = self.verify(response)
                self.assertEqual(result['accepted_indices'], [])
                self.assertEqual(result['rejected'][0]['code'], code)
                self.assertNotIn('林示例', result['rejected'][0]['reason'])

    def test_uncertain_name_fact_accepts_both_valid_time_proofs(self):
        for temporal in ('static_fact', 'current_unverified'):
            with self.subTest(temporal=temporal):
                response = self.response()
                response['items'][0]['statements'][0]['temporal_basis'] = temporal
                self.assertEqual(self.verify(response), {'accepted_indices': [0], 'rejected': []})

    def test_unverified_fact_time_references_are_rejected_and_prompt_is_explicit(self):
        response = self.response()
        statement = response['items'][0]['statements'][0]
        statement.update(temporal_basis='current_unverified', temporal_references=[self.ref])
        result = self.verify(response)
        self.assertEqual(result['accepted_indices'], [])
        self.assertEqual(result['rejected'][0]['code'], 'temporal_references_not_empty')
        prompt = self.model.requests[0][0].content
        self.assertIn('current_unverified/static_fact/historical一律为[]', prompt)
        self.assertIn('普通来源引用仍放在sources', prompt)
        statement['temporal_references'] = []
        self.assertEqual(self.verify(response)['accepted_indices'], [0])

    def test_inference_cannot_claim_verified_current_status_from_a_verified_premise(self):
        self.entry.update(kind='inference', text='此人可能使用该姓名，尚未证实。', uncertainty='推断未证实。')
        response = self.response()
        response['items'][0]['statements'][0].update(
            temporal_basis='current_verified', temporal_references=[self.ref])
        verified_memory = replace(self.memory, timing={'current_status': 'current_verified'})
        result = self.verify(response, memories=[verified_memory])
        self.assertEqual(result['accepted_indices'], [])
        self.assertEqual(result['rejected'][0]['code'], 'temporal_basis_mismatch')

    def test_incidental_family_interest_requires_independent_relationship_impact(self):
        self.memory = replace(self.memory, text='联系人的弟弟喜欢羽毛球。')
        self.entry.update(text=self.memory.text, section='life_context')
        for role in ('third_party', 'relationship'):
            with self.subTest(role=role):
                response = self.response()
                response['items'][0]['statements'][0]['claims'][0].update(
                    subject_role=role, value_category='enduring_fact_or_preference')
                result = self.verify(response)
                self.assertEqual(result['accepted_indices'], [])
                self.assertEqual(result['rejected'][0]['code'], 'profile_eligibility_unconfirmed')

    def test_important_family_responsibility_retains_source_and_temporal_gates(self):
        self.memory = replace(self.memory, text='我长期负责弟弟的日常照料，生活安排需要配合。')
        self.entry.update(text=self.memory.text, section='life_context')
        response = self.response()
        statement = response['items'][0]['statements'][0]
        statement.update(temporal_basis='current_unverified')
        claim = statement['claims'][0]
        claim.update(subject_role='relationship', value_category='important_relationship',
            relationship_impact={'kind': 'ongoing_responsibility', 'basis': '长期日常照料直接影响生活安排。',
                'sources': [{**self.ref, 'quote': self.memory.text}]})
        self.assertEqual(self.verify(response)['accepted_indices'], [0])
        claim['relationship_impact']['sources'][0]['quote'] = '不存在的重要性依据'
        self.assertEqual(self.verify(response)['accepted_indices'], [])

    def test_missing_or_incomplete_claims_cannot_bypass_personal_profile_eligibility(self):
        for mutation in ('missing', 'incomplete', 'unknown', 'none'):
            with self.subTest(mutation=mutation):
                response = self.response()
                statement = response['items'][0]['statements'][0]
                if mutation == 'missing':
                    statement.pop('claims')
                elif mutation == 'incomplete':
                    statement['claims'][0]['text'] = '合成'
                elif mutation == 'unknown':
                    statement['claims'][0]['subject_role'] = 'unknown'
                else:
                    statement['claims'][0]['value_category'] = 'none'
                self.assertEqual(self.verify(response)['accepted_indices'], [])

    def test_mixed_source_subjects_cannot_be_laundered_as_contact_background(self):
        relative = replace(self.memory, text='联系人的堂弟喜欢滑雪。')
        own = replace(self.memory, memory_id=UUID(int=702), text='联系人本人不滑雪。')
        own_ref = {'memory_id': str(own.memory_id), 'revision': 1}
        self.entry.update(text='联系人的堂弟喜欢滑雪；联系人本人不滑雪。',
            references=[self.ref, own_ref], section='life_context')
        response = self.response()
        statement = response['items'][0]['statements'][0]
        sources = [{**self.ref, 'quote': relative.text}, {**own_ref, 'quote': own.text}]
        statement.update(sources=sources)
        claim = statement['claims'][0]
        claim.update(sources=sources, subject_role='contact',
            subject_basis='前半句是第三人，后半句是本人，合为联系人背景。')
        claim['source_subjects'] = [
            {**self.ref, 'subject_roles': ['third_party'], 'basis': '该引文仅描述堂弟。'},
            {**own_ref, 'subject_roles': ['contact'], 'basis': '该引文仅描述本人。'}]
        self.assertEqual(self.verify(response, memories=[relative, own])['accepted_indices'], [])
        # 本人否定可以独立通过，不因共享资料中的第三人而整批丢失。
        self.entry.update(text=own.text, references=[own_ref])
        response['items'][0]['sha256'] = content_digest(self.entry)
        statement['sources'] = [sources[1]]
        claim.update(text=own.text, sources=[sources[1]], source_subjects=[claim['source_subjects'][1]])
        self.assertEqual(self.verify(response, memories=[relative, own])['accepted_indices'], [0])

    def test_same_subject_multiple_sources_preserve_one_conditioned_claim(self):
        first = replace(self.memory, text='联系人周五接电话需要提前预约。')
        second = replace(self.memory, memory_id=UUID(int=702), text='联系人仅在已预约时周五方便接电话。')
        second_ref = {'memory_id': str(second.memory_id), 'revision': 1}
        self.entry.update(text='联系人仅在已预约时周五方便接电话。', references=[self.ref, second_ref])
        response = self.response()
        statement = response['items'][0]['statements'][0]
        sources = [{**self.ref, 'quote': first.text}, {**second_ref, 'quote': second.text}]
        statement['sources'] = sources
        claim = statement['claims'][0]
        claim.update(sources=sources, source_subjects=[{**ref, 'subject_roles': ['contact'],
            'basis': '完整引文主语均为联系人。'} for ref in [self.ref, second_ref]])
        self.assertEqual(self.verify(response, memories=[first, second])['accepted_indices'], [0])
        for mutation in ('missing', 'duplicate', 'unknown', 'extra_role'):
            with self.subTest(mutation=mutation):
                changed = deepcopy(response)
                audits = changed['items'][0]['statements'][0]['claims'][0]['source_subjects']
                if mutation == 'missing': audits.pop()
                elif mutation == 'duplicate': audits[1] = deepcopy(audits[0])
                elif mutation == 'unknown': audits[1]['subject_roles'] = ['unknown']
                else: audits[1]['subject_roles'].append('third_party')
                self.assertEqual(self.verify(changed, memories=[first, second])['accepted_indices'], [])
