"""报告身份一致性只接受同一可观测候选，未知底层权重不伪造。"""
import unittest
from notalone.memory.organization_quality_report import model_evidence_reasons, required_case_phases, REQUIRED_PHASES


class OrganizationModelEvidenceTest(unittest.TestCase):
    def test_allowed_uncertain_summary_does_not_require_normal_l3_when_conservative_empty_is_legal(self):
        case = {'stage_evidence': {'l3_checkpoint': {'kind': 'evaluation_checkpoint',
            'normal_call_required': False, 'documents': []}}, 'output_payload': {
                'l2': {'scenarios': []}, 'l3': {'entries': []}, 'l3_not_required': True}}
        for policy in ('reject', 'uncertain_summary_allowed'):
            case['annotations'] = {'empty_support_policy': policy}
            self.assertEqual(required_case_phases(case), REQUIRED_PHASES - {'l3_proposal', 'l3_verification'})
            self.assertIn('l3_challenge', required_case_phases(case))
        case['annotations'] = {'empty_support_policy': 'normal'}
        self.assertEqual(required_case_phases(case), REQUIRED_PHASES)

    def test_same_request_model_cannot_combine_changed_response_fingerprint_or_route(self):
        base = {'phase': 'l2_proposal', 'request_model': 'fixed-alias', 'response_model': 'observable-a',
                'system_fingerprint': 'fp-a', 'request_route': 'https://candidate.invalid/chat/completions'}
        contract = {'request_model': 'fixed-alias', 'verifier_model': 'fixed-alias'}
        self.assertEqual(model_evidence_reasons([base, dict(base, phase='l3_verification')], contract), [])
        for field, changed in [('response_model', 'observable-b'), ('system_fingerprint', 'fp-b'),
                               ('request_route', 'https://other.invalid/chat/completions')]:
            with self.subTest(field=field):
                self.assertIn('candidate_model_changed', model_evidence_reasons([base, dict(base, **{field: changed})], contract))
        self.assertIn('candidate_model_changed', model_evidence_reasons([dict(base, request_model='unbound')], contract))

    def test_missing_observable_identity_never_counts_as_complete(self):
        contract = {'request_model': 'candidate', 'verifier_model': 'verifier'}
        self.assertIn('actual_model_identity_unknown', model_evidence_reasons([{'phase': 'l2_proposal', 'request_model': 'candidate',
            'response_model': None, 'system_fingerprint': None, 'request_route': 'unknown'}], contract))
