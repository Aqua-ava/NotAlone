"""旧资料比较沿原采纳逻辑，但预览不得产生正式候选或记忆。"""

import unittest
from uuid import uuid4

from notalone.memory import AdoptionMethod, InMemoryMemoryStore, MemoryCandidate, MemoryCategory, MemoryTopic
from notalone.memory.upgrade import UpgradeBudget
from notalone.application.memory_upgrade_preview import preview_upgrade
from notalone.memory_extraction.dimensions import DimensionRelease, MemoryDimension
from notalone.memory_extraction.flow import ExtractionOutcome
from notalone.memory_extraction.adjudication import AdjudicationAction, AdjudicationDecision
from notalone.memory_extraction.models import FactSubject
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.dimension_helpers import synthetic_fact, synthetic_complete_evidence


class UpgradePreviewTest(unittest.TestCase):
    def setUp(self):
        self.scope = ContactScope(uuid4(), uuid4())
        self.store = InMemoryMemoryStore()

    def test_default_gate_preview_does_not_create_real_pending_or_confirmed(self):
        fact = synthetic_fact(text='联系人喜欢合成茶。', category=MemoryCategory.PREFERENCE)
        compared = preview_upgrade(self.scope, ExtractionOutcome(accepted=(fact,)), memory_port=self.store)
        self.assertEqual(self.store.list_pending_candidates(self.scope), ())
        self.assertEqual(self.store.list_confirmed(self.scope), ())
        self.assertEqual(len(compared.actions), 1)
        self.assertEqual(compared.actions[0].kind, 'pending')
        self.assertEqual(compared.actions[0].candidate.text, fact.text)

    def test_complete_evidence_can_preview_auto_without_auto_applying(self):
        fact = synthetic_complete_evidence(synthetic_fact(text='我喜欢合成茶。', category=MemoryCategory.PREFERENCE), scope=self.scope)
        compared = preview_upgrade(self.scope, ExtractionOutcome(accepted=(fact,)), memory_port=self.store,
                                   dimension_release=DimensionRelease(tuple(MemoryDimension)))
        self.assertEqual(self.store.list_confirmed(self.scope), ())
        self.assertEqual(self.store.list_pending_candidates(self.scope), ())
        self.assertEqual(compared.actions[0].kind, 'auto_add')
        self.assertEqual(compared.actions[0].candidate.dimension_evidence, fact.dimension_evidence)

    def test_explicit_budget_rejects_boolean_and_unbounded_requests(self):
        self.assertEqual(UpgradeBudget(40, 20, 8).batch_size, 20)
        for values in ((0, 20, 8), (201, 20, 8), (40, 21, 8), (40, 0, 8), (40, 20, 0), (40, 20, 41), (True, 1, 1)):
            with self.subTest(values=values):
                with self.assertRaises(ValueError):
                    UpgradeBudget(*values)

    def test_preview_preserves_manual_confirmation_when_model_suggests_update(self):
        original = self.store.create_candidate(MemoryCandidate(candidate_id=uuid4(), scope=self.scope,
            text='联系人喜欢合成绿茶。', category=MemoryCategory.PREFERENCE, source_ids=(uuid4(),)))
        confirmed = self.store.confirm(scope=self.scope, candidate_id=original.candidate_id, adoption_method=AdoptionMethod.MANUAL)
        fact = synthetic_complete_evidence(synthetic_fact(text='联系人喜欢合成红茶。', category=MemoryCategory.PREFERENCE,
            topic=MemoryTopic.OTHER, source_message_ids=(uuid4(),)), scope=self.scope)

        class ControlledDecision:
            def adjudicate(self, **kwargs):
                return AdjudicationDecision(AdjudicationAction.UPDATE, confirmed.memory_id)

        compared = preview_upgrade(self.scope, ExtractionOutcome(accepted=(fact,)), memory_port=self.store,
            adjudication_runtime=ControlledDecision(), dimension_release=DimensionRelease(tuple(MemoryDimension)))
        self.assertEqual(self.store.list_confirmed(self.scope), (confirmed,))
        self.assertEqual(self.store.list_pending_candidates(self.scope), ())
        self.assertEqual(compared.stats.updated, 0)
        self.assertEqual(compared.actions[0].kind, 'pending')

    def test_same_frozen_upgrade_comparison_keeps_candidate_and_result_identities(self):
        fact = synthetic_complete_evidence(synthetic_fact(text='联系人喜欢合成茶。', category=MemoryCategory.PREFERENCE), scope=self.scope)
        batch_id = uuid4()
        first = preview_upgrade(self.scope, ExtractionOutcome(accepted=(fact,)), memory_port=self.store,
            dimension_release=DimensionRelease(tuple(MemoryDimension)), candidate_namespace=batch_id)
        repeated = preview_upgrade(self.scope, ExtractionOutcome(accepted=(fact,)), memory_port=self.store,
            dimension_release=DimensionRelease(tuple(MemoryDimension)), candidate_namespace=batch_id)
        self.assertEqual(first, repeated)
        self.assertIsNotNone(first.actions[0].result_memory_id)
        self.assertEqual(self.store.list_confirmed(self.scope), ())
        self.assertEqual(self.store.list_pending_candidates(self.scope), ())

    def test_owner_preview_remains_independent_and_never_writes_a_real_owner_fact(self):
        class OwnerReadBoundary:
            def list_active(inner, owner_id, *, include_expired=False):
                return ()

            def deleted_texts(inner, owner_id):
                return ()

        owner = OwnerReadBoundary()
        fact = synthetic_complete_evidence(synthetic_fact(text='我喜欢合成茶。', category=MemoryCategory.PREFERENCE,
            subject=FactSubject.SELF), scope=self.scope)
        compared = preview_upgrade(self.scope, ExtractionOutcome(accepted=(fact,)), memory_port=self.store,
            owner_memory_port=owner, dimension_release=DimensionRelease(tuple(MemoryDimension)), candidate_namespace=uuid4())
        self.assertEqual(compared.actions[0].kind, 'auto_add')
        self.assertEqual(compared.actions[0].candidate.subject, FactSubject.SELF)
        self.assertEqual(owner.list_active(self.scope.owner_id), ())
        self.assertEqual(self.store.list_confirmed(self.scope), ())

    def test_pending_difference_includes_current_manual_record_without_replacing_it(self):
        from notalone.memory.upgrade_snapshot import comparison_payload
        candidate = self.store.create_candidate(MemoryCandidate(candidate_id=uuid4(), scope=self.scope,
            text='联系人喜欢合成绿茶。', category=MemoryCategory.PREFERENCE, source_ids=(uuid4(),)))
        current = self.store.confirm(scope=self.scope, candidate_id=candidate.candidate_id, adoption_method=AdoptionMethod.MANUAL)
        compared = preview_upgrade(self.scope, ExtractionOutcome(accepted=(synthetic_fact(
            text='联系人喜欢合成红茶。', category=MemoryCategory.PREFERENCE,
            topic=MemoryTopic.OTHER),)), memory_port=self.store)
        payload = comparison_payload(compared)
        self.assertEqual(payload['actions'][0]['kind'], 'pending')
        self.assertEqual(payload['current'][0]['memory_id'], str(current.memory_id))
        self.assertEqual(payload['current'][0]['text'], '联系人喜欢合成绿茶。')
        self.assertEqual(payload['current'][0]['adoption_method'], 'manual')
        self.assertEqual(self.store.list_confirmed(self.scope), (current,))


if __name__ == '__main__':
    unittest.main()
