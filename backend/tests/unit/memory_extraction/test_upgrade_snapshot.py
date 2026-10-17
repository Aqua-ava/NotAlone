"""升级恢复的来源证明保持未知或新证明，不用当前资料补造旧证明。"""

from dataclasses import replace
import json
import unittest
from uuid import uuid4

from notalone.application.memory_upgrade_preview import preview_upgrade
from notalone.memory import InMemoryMemoryStore, MemoryCategory
from notalone.memory_extraction.dimensions import DimensionRelease, MemoryDimension
from notalone.memory_extraction.flow import ExtractionOutcome
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.dimension_helpers import synthetic_fact, synthetic_complete_evidence


class UpgradeSnapshotTest(unittest.TestCase):
    def test_saved_outcome_keeps_original_candidate_trace_mapping_and_old_unknown_stays_unknown(self):
        from notalone.memory.upgrade_snapshot import outcome_payload,restore_outcome
        identifier=uuid4()
        result=ExtractionOutcome(accepted=(synthetic_fact(),),candidate_trace_ids=(identifier,))
        payload=json.loads(json.dumps(outcome_payload(result)))
        self.assertEqual(restore_outcome(payload).candidate_trace_ids,(identifier,))
        old={key:value for key,value in payload.items() if key!='candidate_trace_ids'}
        old['version']=1
        self.assertEqual(restore_outcome(old).candidate_trace_ids,())

    def test_durable_restore_requires_source_revalidation_and_never_fills_unknown_proof(self):
        from notalone.memory.upgrade_snapshot import outcome_payload, restore_outcome
        scope = ContactScope(uuid4(), uuid4())
        fresh = synthetic_complete_evidence(synthetic_fact(text='联系人喜欢合成茶。', category=MemoryCategory.PREFERENCE), scope=scope)
        for fact in (fresh, replace(fresh, dimension_evidence=None)):
            with self.subTest(proof_present=fact.dimension_evidence is not None):
                outcome = ExtractionOutcome(accepted=(fact,), extraction_completed=True)
                recovered = restore_outcome(json.loads(json.dumps(outcome_payload(outcome))))
                store = InMemoryMemoryStore()
                compared = preview_upgrade(scope, recovered, memory_port=store,
                    dimension_release=DimensionRelease(tuple(MemoryDimension)), candidate_namespace=uuid4())
                self.assertEqual(compared.actions[0].kind, 'pending')
                self.assertEqual(store.list_pending_candidates(scope), ())
                self.assertEqual(store.list_confirmed(scope), ())
                self.assertEqual(recovered.accepted[0].dimension_evidence, fact.dimension_evidence)
                if recovered.accepted[0].dimension_evidence is not None:
                    self.assertFalse(recovered.accepted[0].dimension_evidence.source_bound)


if __name__ == '__main__':
    unittest.main()
