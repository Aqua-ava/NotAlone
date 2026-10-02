"""独立来源复核的评分保留漏提、错误自动采纳与日期误填。"""

import unittest

from notalone.memory_extraction.replica_scoring import score_review


class ReplicaScoringTests(unittest.TestCase):
    def test_correct_candidate_does_not_hide_extra_wrong_auto_fact(self):
        record = {
            'source': {'gold': [{'claim_id': 'g1', 'allowed_destinations': ['auto'],
                                'valid_at': {'mode': 'must_null', 'allowed': []},
                                'invalid_at': {'mode': 'must_null', 'allowed': []}}]},
            'outputs': {'raw': {'failure': False, 'facts': [
                {'text': '正确主张', 'destination': 'auto', 'valid_at': None, 'invalid_at': None},
                {'text': '额外错误', 'destination': 'auto', 'valid_at': None, 'invalid_at': None}]},
                'guarded': None}}
        review = {'raw': {'covered_claim_ids': ['g1'], 'candidates': [
            {'index': 0, 'claim_ids': ['g1'], 'faithful': True, 'subject_error': False},
            {'index': 1, 'claim_ids': [], 'faithful': False, 'subject_error': False}]}}
        result = score_review(record, review)
        self.assertEqual(result['raw']['claims_covered'], 1)
        self.assertFalse(result['raw']['semantic_complete'])
        self.assertEqual(result['raw']['unsupported_auto'], 1)

    def test_missing_fact_is_not_perfect_and_wrong_date_is_separate(self):
        gold = [{'claim_id': 'g', 'allowed_destinations': ['pending'],
                 'valid_at': {'mode': 'allowed', 'allowed': ['2026-07-02T09:00:00+08:00']},
                 'invalid_at': {'mode': 'must_null', 'allowed': []}}]
        source = {'gold': gold}
        record = {'source': source, 'outputs': {
            'raw': {'failure': False, 'facts': [{'text': '正确安排', 'destination': 'pending',
                     'valid_at': '2026-07-03T09:00:00+08:00', 'invalid_at': None}]},
            'guarded': {'failure': False, 'facts': []}}}
        review = {'raw': {'covered_claim_ids': ['g'], 'candidates': [{'index': 0, 'claim_ids': ['g'],
                   'faithful': True, 'subject_error': False}]},
                  'guarded': {'covered_claim_ids': [], 'candidates': []}}
        scored = score_review(record, review)
        self.assertTrue(scored['raw']['semantic_complete'])
        self.assertFalse(scored['raw']['complete_with_time'])
        self.assertEqual(scored['raw']['time_correct_fields'], 1)
        self.assertFalse(scored['guarded']['semantic_complete'])
        self.assertEqual(scored['correct_candidates_dropped'], 0)
        record['outputs']['raw']['facts'][0]['valid_at'] = '2026-07-02T09:00:00+08:00'
        self.assertEqual(score_review(record, review)['correct_candidates_dropped'], 1)

    def test_review_cannot_silently_skip_an_extra_candidate(self):
        record = {'source': {'gold': []}, 'outputs': {
            'raw': {'failure': False, 'facts': [{'text': '错误'}]}, 'guarded': None}}
        with self.assertRaises(ValueError):
            score_review(record, {'raw': {'candidates': []}})

    def test_faithful_independent_clauses_can_jointly_cover_a_claim(self):
        gold = [{'claim_id': 'g', 'allowed_destinations': ['auto'],
                 'valid_at': {'mode': 'must_null', 'allowed': []},
                 'invalid_at': {'mode': 'must_null', 'allowed': []}}]
        record = {'source': {'gold': gold}, 'outputs': {
            'raw': {'failure': False, 'facts': [
                {'text': '物件已修好', 'destination': 'auto'},
                {'text': '物件没有换新', 'destination': 'auto'}]}, 'guarded': None}}
        review = {'raw': {'covered_claim_ids': ['g'], 'candidates': [
            {'index': 0, 'claim_ids': ['g'], 'faithful': True, 'subject_error': False},
            {'index': 1, 'claim_ids': [], 'faithful': True, 'subject_error': False}]}}
        scored = score_review(record, review)
        self.assertTrue(scored['raw']['semantic_complete'])
        review['raw']['covered_claim_ids'] = []
        self.assertFalse(score_review(record, review)['raw']['semantic_complete'])

    def test_correct_date_cannot_hide_an_additional_wrong_date(self):
        gold = [{'claim_id': 'g', 'allowed_destinations': ['pending'],
                 'valid_at': {'mode': 'allowed', 'allowed': ['2026-07-02T09:00:00+08:00']},
                 'invalid_at': {'mode': 'must_null', 'allowed': []}}]
        record = {'source': {'gold': gold}, 'outputs': {'raw': {'failure': False, 'facts': [
            {'text': '同一安排', 'destination': 'pending',
             'valid_at': '2026-07-02T09:00:00+08:00'},
            {'text': '同一安排', 'destination': 'pending',
             'valid_at': '2026-07-03T09:00:00+08:00'}]}, 'guarded': None}}
        review = {'raw': {'covered_claim_ids': ['g'], 'candidates': [
            {'index': index, 'claim_ids': ['g'], 'faithful': True, 'subject_error': False}
            for index in range(2)]}}
        self.assertFalse(score_review(record, review)['raw']['complete_with_time'])

    def test_wrong_subject_is_never_complete_even_with_coverage(self):
        gold = [{'claim_id': 'g', 'allowed_destinations': ['auto'],
                 'valid_at': {'mode': 'must_null', 'allowed': []},
                 'invalid_at': {'mode': 'must_null', 'allowed': []}}]
        record = {'source': {'gold': gold}, 'outputs': {'raw': {'failure': False,
                  'facts': [{'text': '记错了人', 'subject': 'self', 'destination': 'auto'}]},
                  'guarded': None}}
        review = {'raw': {'covered_claim_ids': ['g'], 'candidates': [
                  {'index': 0, 'claim_ids': ['g'], 'faithful': True, 'subject_error': True}]}}
        scored = score_review(record, review)['raw']
        self.assertFalse(scored['semantic_complete'])
        self.assertFalse(scored['complete_with_time'])
        record['outputs']['guarded'] = {'failure': False, 'facts': []}
        review['guarded'] = {'covered_claim_ids': [], 'candidates': []}
        self.assertEqual(score_review(record, review)['correct_candidates_dropped'], 0)


if __name__ == '__main__':
    unittest.main()
