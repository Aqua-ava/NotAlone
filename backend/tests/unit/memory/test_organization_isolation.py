"""单条隔离的确定性验收，不调用外部模型。"""
import unittest
from notalone.memory.organization_isolation import isolate_proposal, select_verified


class IsolationTest(unittest.TestCase):
    def test_bad_item_does_not_remove_good_sibling(self):
        def validate(value):
            if any(item.get('bad') for item in value['entries']):
                raise ValueError('bad source')
            return value
        raw, normalized, rejected = isolate_proposal(
            {'entries': [{'text': '有效'}, {'bad': True}]}, 'entries', validate, 5)
        self.assertEqual(raw, {'entries': [{'text': '有效'}]})
        self.assertEqual(normalized, raw)
        self.assertEqual(rejected[0]['index'], 1)

    def test_verification_only_publishes_explicitly_supported_items(self):
        raw = {'entries': [{'text': '甲'}, {'text': '乙'}]}
        result, failures = select_verified(raw, 'entries', {'accepted_indices': [1], 'rejected': [{'index': 0, 'reason': '无依据'}]})
        self.assertEqual(result['entries'], [{'text': '乙'}])
        self.assertEqual(failures[0]['index'], 0)

    def test_malformed_envelope_still_stops(self):
        for raw in (None, {'entries': 'wrong'}, {'entries': [], 'extra': True}):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                isolate_proposal(raw, 'entries', lambda x: x, 5)

    def test_cumulative_limits_still_apply(self):
        def validate(value):
            if sum(len(item) for item in value['entries']) > 4:
                raise ValueError('budget')
            return value
        raw, _, rejected = isolate_proposal({'entries': ['甲乙丙', '丁戊己']}, 'entries', validate, 5)
        self.assertEqual(raw['entries'], ['甲乙丙'])
        self.assertEqual(rejected, [{'index': 1, 'reason': 'budget'}])


class AdapterIsolationTest(unittest.TestCase):
    def test_l2_one_bad_audit_keeps_other_in_one_call(self):
        import time
        from notalone.memory.layered import OrganizationBudget
        from notalone.memory.organization_deadline import OrganizationCallDeadline
        from notalone.memory.organization_quality import content_digest
        from notalone.memory.organization_sdk import DeepSeekOrganizationVerification
        from tests.unit.memory.test_organization_sdk_verification import ResponseModel
        proposal = {'scenarios': [{'topic_key': 'good'}, {'topic_key': 'bad'}]}
        model = ResponseModel({'items': [
            {'index': 0, 'sha256': content_digest(proposal['scenarios'][0]), 'supported': True, 'reasons': []},
            {'index': 1, 'sha256': 'wrong', 'supported': True, 'reasons': []}]})
        adapter = DeepSeekOrganizationVerification(model, layer='l2', budget=OrganizationBudget(), transport=None)
        result = adapter.verify_items(memories=[], proposal=proposal, deadline=OrganizationCallDeadline(time.monotonic()+5))
        self.assertEqual(result['accepted_indices'], [0])
        self.assertEqual(result['rejected'][0]['index'], 1)
        self.assertEqual(len(model.requests), 1)

    def test_l3_bad_claim_does_not_reject_supported_sibling(self):
        from copy import deepcopy
        from notalone.memory.organization_verification import profile_verification_items
        from tests.unit.memory.test_organization_claim_verification import OrganizationClaimVerificationTest
        fixture = OrganizationClaimVerificationTest()
        fixture.setUp()
        claims = [fixture.claim(text) for text in fixture.parts]
        response = fixture.response(claims)
        bad = deepcopy(response['entries'][0])
        bad['entry_index'] = 1
        bad['claims'][0]['sources'][0]['quote'] = '不在原文'
        response['entries'].append(bad)
        response['supported'] = False
        result = profile_verification_items(response, {'entries': [fixture.entry, fixture.entry]}, [fixture.memory.to_payload()])
        self.assertEqual(result['accepted_indices'], [0])
        self.assertEqual(result['rejected'][0]['index'], 1)

    def test_challenge_requires_rejecting_every_bad_item(self):
        from notalone.application.organization_evaluation import verification_passed
        proposal = {'entries': [{'text': '坏甲'}, {'text': '坏乙'}]}
        partial = {'accepted_indices': [1], 'rejected': [{'index': 0, 'reason': '无据'}]}
        rejected = {'accepted_indices': [], 'rejected': [{'index': i, 'reason': '无据'} for i in range(2)]}
        self.assertFalse(verification_passed(proposal, 'entries', partial, challenge=True))
        self.assertTrue(verification_passed(proposal, 'entries', rejected, challenge=True))
        self.assertTrue(verification_passed(proposal, 'entries', partial))
        self.assertFalse(verification_passed(proposal, 'entries', rejected))
