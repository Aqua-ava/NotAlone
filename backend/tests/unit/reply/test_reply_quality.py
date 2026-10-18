"""回复资格从真实证据重新计算，工程冒烟不会变成正式放行。"""
import tempfile
import unittest
from pathlib import Path

from notalone.memory.organization_quality import ReplyQualityContract, content_digest
from notalone.memory.organization_quality_suite_budget import atomic_json
from notalone.application.reply_qualification import ReplyComparisonSource


class ReplyQualificationTest(unittest.TestCase):
    def test_production_configuration_records_disabled_review_without_beta_route(self):
        from types import SimpleNamespace
        from notalone.reply.quality import reply_model_configuration

        model = SimpleNamespace(model_name='deepseek-flash', max_retries=0,
            root_async_client=SimpleNamespace(base_url='https://api.deepseek.com/'),
            _get_request_payload=lambda messages: {'model': 'deepseek-flash', 'messages': messages,
                                                   'temperature': 0.0})
        configuration = reply_model_configuration(model)

        self.assertEqual(configuration['post_generation_review'], 'disabled')
        self.assertEqual(configuration['request_route'], 'https://api.deepseek.com/chat/completions')
        self.assertNotIn('review_route', configuration)
        self.assertEqual(configuration['parameters']['temperature'], 0.0)

    def test_production_wiring_change_invalidates_reply_contract(self):
        from dataclasses import dataclass
        from types import SimpleNamespace
        from unittest.mock import patch
        from notalone.reply.quality import build_reply_contract

        @dataclass
        class Profile:
            context_window: int = 4096

        model = SimpleNamespace(model_name='deepseek-flash', max_retries=0,
            root_client=SimpleNamespace(max_retries=0),
            root_async_client=SimpleNamespace(base_url='https://api.deepseek.com/', max_retries=0),
            _get_request_payload=lambda messages: {'model': 'deepseek-flash', 'messages': messages})
        baseline = build_reply_contract(model, Profile(), None, None)
        original_read = Path.read_text

        def changed_wiring(path, *args, **kwargs):
            text = original_read(path, *args, **kwargs)
            if path.as_posix().endswith('/server/reply_wiring.py'):
                return text + '\n# 合成接线变化，不能继承原回复质量资格。\n'
            return text

        with patch.object(Path, 'read_text', changed_wiring):
            changed = build_reply_contract(model, Profile(), None, None)

        self.assertNotEqual(changed.identity, baseline.identity)
        self.assertNotEqual(changed.rules_version, baseline.rules_version)
        self.assertEqual(changed.model_version, baseline.model_version)
        self.assertEqual(changed.budget_version, baseline.budget_version)

    def test_replacing_final_reply_cannot_reuse_old_review_or_persisted_evidence(self):
        from copy import deepcopy
        import json
        from notalone.reply.quality import comparison_report, reply_review_binding
        config = {'request_model': 'deepseek-flash', 'request_route': 'https://api.deepseek.com/chat/completions'}
        contract = ReplyQualityContract(model_version=content_digest(config))
        package = {'request': {'content': {'draft_text': '约周六见面。'}}, 'l1_version': 'frozen-l1'}
        case = {'case_id': 'review-bound-output', 'input_sha256': content_digest(package),
                'organization_review': {'reviewer_kind': 'human', 'decision': 'approved'}}
        manifest = {'contract_id': contract.identity, 'reply_contract': contract.to_payload(),
            'data_kind': 'synthetic', 'coverage_kind': 'smoke', 'cases': [case],
            'model_configuration': config, 'request_limit': 48, 'per_arm_limit': 6}
        dimensions = {key: {'status': 'pass', 'basis': '逐条对照本次实际输入及输出。'} for key in (
            'background_use', 'irrelevant_interference', 'instruction_pollution',
            'facts_commitments', 'l1_preserved', 'naturalness')}
        bundle = {'schema_version': 'reply-comparison-v1', 'manifest': manifest,
            'manifest_sha256': content_digest(manifest), 'arms': [], 'calls': [], 'reviews': [],
            'budget_receipt': {'closed': True, 'request_limit': 48, 'reserved_requests': 2,
                               'config_sha256': content_digest(manifest)}}
        for number, arm in enumerate(('baseline', 'layered'), 1):
            candidate = {'candidate_id': 'fixed-candidate', 'text': '周六见。', 'basis': '保留原意。',
                         'citation_ids': ['draft'], 'risk_notes': [],
                         'messages': [{'message_id': 'fixed-candidate', 'text': '周六见。'}]}
            output = {'reply_request_id': arm, 'candidates': [candidate]}
            persisted = {'reply_request_id': arm, 'candidate_output': [candidate],
                         'layered_context': None, 'owner_layered_context': None,
                         'layered_scenario_reads': [], 'owner_layered_scenario_reads': []}
            request = {'model': 'deepseek-flash', 'messages': [{'role': 'user', 'content':
                json.dumps({'input_mode': 'rewrite', 'draft_text': '约周六见面。', 'evidence': []})}]}
            args = {'candidates': [{key: value for key, value in candidate.items()
                    if key not in {'candidate_id', 'messages'}}], 'used_skill_version_id': None}
            response = {'model': 'deepseek-flash', 'system_fingerprint': 'fixed',
                'choices': [{'message': {'tool_calls': [{'function': {'name': 'ReplyRuntimeOutput',
                    'arguments': json.dumps(args)}}]}}]}
            call = {'sequence': number, 'case_id': case['case_id'], 'arm': arm,
                'request_route': config['request_route'], 'request': request, 'response': response, 'outcome': 'succeeded'}
            record = {'case_id': case['case_id'], 'arm': arm, 'status': 'succeeded',
                'input_sha256': case['input_sha256'], 'request_id': arm, 'output': output,
                'evidence': {'input_package': package, 'first_model_request': request, 'l1_budget': {'contact_memory': 5},
                    'reply_evidence': persisted, 'http_steps': [
                        {'method': 'POST', 'path': '/replies', 'status': 200, 'request': package['request'], 'response': output},
                        {'method': 'GET', 'path': '/evidence', 'status': 200, 'response': persisted}]}}
            bundle['calls'].append(call)
            bundle['arms'].append(record)
            bundle['reviews'].append({'case_id': case['case_id'], 'arm': arm, 'reviewer_kind': 'human',
                'decision': 'approved', 'dimensions': dimensions,
                'binding': reply_review_binding(case, record, [call])})
        initial = comparison_report(bundle, contract)['stage']['reasons']
        self.assertNotIn('reply_review_binding_changed', initial)
        self.assertNotIn('reply_output_capture_changed', initial)
        changed = deepcopy(bundle)
        changed['arms'][1]['output']['candidates'][0]['text'] = '我保证每周六都陪你。'
        reasons = comparison_report(changed, contract)['stage']['reasons']
        self.assertIn('reply_review_binding_changed', reasons)
        self.assertIn('reply_output_capture_changed', reasons)
        changed = deepcopy(bundle)
        changed['calls'][1]['request']['messages'][0]['content'] = '另一位联系人的请求'
        self.assertIn('reply_review_binding_changed', comparison_report(changed, contract)['stage']['reasons'])
        changed = deepcopy(bundle)
        changed['calls'][1]['response']['choices'][0]['message']['tool_calls'][0]['function']['arguments'] = json.dumps(
            {'candidates': [{'text': '换成未审候选。', 'basis': '无原审依据。', 'citation_ids': ['draft'], 'risk_notes': []}]})
        reasons = comparison_report(changed, contract)['stage']['reasons']
        self.assertIn('reply_review_binding_changed', reasons)
        self.assertIn('reply_output_capture_changed', reasons)

    def test_changed_contract_or_missing_source_cannot_reuse_a_claimed_verified_report(self):
        with tempfile.TemporaryDirectory() as directory:
            source = ReplyComparisonSource(Path(directory))
            contract = ReplyQualityContract(model_version='actual-model', budget_version='bounded')
            self.assertEqual(source.resolve(contract)['stage']['status'], 'unknown')
            manifest = {'contract_id': 'old-contract', 'reply_contract': {}, 'data_kind': 'synthetic',
                        'coverage_kind': 'smoke', 'cases': [], 'request_limit': 48, 'per_arm_limit': 6}
            atomic_json(Path(directory) / 'bundle.json', {'schema_version': 'reply-comparison-v1',
                'manifest': manifest, 'manifest_sha256': content_digest(manifest), 'arms': [], 'calls': [],
                'reviews': [], 'budget_receipt': {}, 'status': 'verified'})
            result = source.resolve(contract)
            self.assertEqual(result['stage']['status'], 'unknown')
            self.assertIn('reply_contract_changed', result['stage']['reasons'])
            self.assertFalse(result.get('automatic_use_allowed', False))

    def test_reply_gate_needs_both_receipts_and_reading_changes_do_not_change_organization_contract(self):
        from uuid import uuid4
        from notalone.memory.organization_quality import OrganizationQualityService

        class FixedSource:
            def __init__(self, receipt):
                self.receipt = receipt
            def resolve(self, contract, **kwargs):
                return {'stage': {'status': 'verified', 'contract_id': contract.identity, 'report_id': 'controlled'},
                        'receipt': self.receipt, 'model_identities': []}

        quality = OrganizationQualityService(qualification_source=FixedSource('organization-evidence'))
        owner_id = uuid4()
        organization_id = quality.organization_contract.identity
        self.assertFalse(quality.status(owner_id)['automatic_use_allowed'])
        reply = FixedSource('reply-evidence')
        quality.configure_reply(ReplyQualityContract(model_version='actual', budget_version='bounded'), reply)
        self.assertTrue(quality.status(owner_id)['automatic_use_allowed'])
        original = quality.reading_receipt(owner_id)
        reply.receipt = 'replacement-reply-evidence'
        self.assertNotEqual(quality.reading_receipt(owner_id), original)
        self.assertEqual(quality.organization_contract.identity, organization_id)

    def test_observed_response_identity_change_revokes_even_the_same_requested_model(self):
        from types import SimpleNamespace
        from uuid import uuid4
        from langchain_core.messages import AIMessage
        from notalone.memory.layered import LayeredMemoryConflict
        from notalone.memory.organization_quality import OrganizationQualityService
        identity = {'request_model': 'deepseek-flash', 'response_model': 'deepseek-flash',
                    'request_route': 'https://api.deepseek.com/chat/completions', 'system_fingerprint': 'fixed'}
        class Source:
            def resolve(self, contract, **kwargs):
                return {'stage': {'status': 'verified', 'contract_id': contract.identity},
                        'receipt': 'fixed-evidence', 'model_identities': [identity]}
        owner = uuid4()
        quality = OrganizationQualityService(qualification_source=Source())
        quality.configure_reply(ReplyQualityContract(), Source())
        model = SimpleNamespace(model_name='deepseek-flash',
            root_async_client=SimpleNamespace(base_url='https://api.deepseek.com/'))
        quality.check_reply_identity(owner, model, AIMessage('', response_metadata={
            'model_name': 'deepseek-flash', 'system_fingerprint': 'fixed'}))
        with self.assertRaises(LayeredMemoryConflict):
            quality.check_reply_identity(owner, model, AIMessage('', response_metadata={
                'model_name': 'deepseek-flash', 'system_fingerprint': 'changed'}))
        self.assertIsNone(quality.reading_receipt(owner))
