"""回复资格从真实证据重新计算，工程冒烟不会变成正式放行。"""
import tempfile
import unittest
from pathlib import Path

from notalone.memory.organization_quality import ReplyQualityContract, content_digest
from notalone.memory.organization_quality_suite_budget import atomic_json
from notalone.application.reply_qualification import ReplyComparisonSource


class ReplyQualificationTest(unittest.TestCase):
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
