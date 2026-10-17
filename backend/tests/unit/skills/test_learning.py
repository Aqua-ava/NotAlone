"""经验提案的身份隔离、私人依据与无新增行为。"""

import unittest
from uuid import uuid4

from notalone.scopes import ContactScope
from notalone.skills.learning import LearningBatch, SkillLearningInvalid
from notalone.skills.draft_proposal import normalize_proposal


def proposal():
    return {"outcome": "draft", "proposal_kind": "create", "target_skill_ids": [],
            "name": "confirm-meaning", "description": "先确认表达意愿，再给出可编辑建议。", "scene": "表达有歧义时",
            "scope_suggestion": {"kind": "contact", "reason": "当前仅有同一联系人的经验。"},
            "methods": [{"key": "ask-before-advice", "title": "先询问意愿", "instruction": "确认意愿后再组织措辞。"}]}


class LearningProposalTest(unittest.TestCase):
    def setUp(self):
        self.scope = ContactScope(uuid4(), uuid4())
        self.batch = LearningBatch(({"material_id": str(uuid4()), "priority": "correction", "content": {"correction": "先问清楚"}},), (), (), 1)

    def test_same_contact_retry_stable_other_contact_independent(self):
        first, _ = normalize_proposal(self.scope, self.batch, proposal())
        retry, _ = normalize_proposal(self.scope, self.batch, proposal())
        other, _ = normalize_proposal(ContactScope(self.scope.owner_id, uuid4()), self.batch, proposal())
        self.assertEqual(first['strategy']['methods'], retry['strategy']['methods'])
        self.assertNotEqual(first['logical_skill_id'], other['logical_skill_id'])
        self.assertNotEqual(first['strategy']['methods'][0]['method_id'], other['strategy']['methods'][0]['method_id'])

    def test_external_original_and_private_scope_reason_cannot_be_strategy(self):
        private_text = '这段合成私人原话仅用于审核依据，不能原样成为方法。'
        batch = LearningBatch(({"material_id": str(uuid4()), "priority": "correction", "content": {},
                                "external_messages": [{"text": private_text}]},), (), (), 1)
        for field in ('instruction', 'reason'):
            with self.subTest(field=field):
                value = proposal()
                if field == 'instruction':
                    value['methods'][0]['instruction'] = private_text
                else:
                    value['scope_suggestion']['reason'] = private_text
                with self.assertRaises(SkillLearningInvalid):
                    normalize_proposal(self.scope, batch, value)

    def test_no_change_needs_no_artificial_new_method(self):
        self.assertEqual(normalize_proposal(self.scope, self.batch, {'outcome': 'no_change'}), (None, 'no_change'))
        self.assertTrue(self.batch.ready)
        ordinary = LearningBatch(({"priority": "ordinary"},), (), (), 1)
        self.assertFalse(ordinary.ready)

    def test_malformed_target_is_classified_without_leaking_payload(self):
        value = proposal()
        value['target_skill_ids'] = [{'private': '合成不可识别目标'}]
        with self.assertRaises(SkillLearningInvalid):
            normalize_proposal(self.scope, self.batch, value)


if __name__ == '__main__':
    unittest.main()
