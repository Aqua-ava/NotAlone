"""组合后的升级、更正与版本读取不得把全部依赖降为任选来源。"""

from dataclasses import replace
import json
import unittest
from uuid import uuid4

from notalone.memory import InMemoryMemoryStore, MemoryCandidate, MemoryCategory, SourceDependencyMode
from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.memory.upgrade_snapshot import outcome_payload, restore_outcome, comparison_payload
from notalone.memory.versions import require_auto_previous
from notalone.memory_extraction.flow import ExtractionOutcome
from notalone.persistence.memory_correction import candidate_from_row
from notalone.persistence.memory_versions import raw_memory, version_record_digest
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.dimension_helpers import synthetic_fact


class AllSourceLifecycleTest(unittest.TestCase):
    def setUp(self):
        self.scope = ContactScope(uuid4(), uuid4())
        self.store = InMemoryMemoryStore()
        self.candidate = self.store.create_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=self.scope, text='合成完整依赖正文',
            category=MemoryCategory.COMMON_FACT, source_ids=(uuid4(), uuid4()),
            source_dependency_mode=SourceDependencyMode.ALL))
        self.memory = self.store.confirm(scope=self.scope, candidate_id=self.candidate.candidate_id)

    def test_upgrade_snapshot_roundtrip_keeps_all_and_legacy_any(self):
        for mode in SourceDependencyMode:
            fact = replace(synthetic_fact(), source_dependency_mode=mode)
            saved = json.loads(json.dumps(outcome_payload(ExtractionOutcome(accepted=(fact,)))))
            self.assertIs(restore_outcome(saved).accepted[0].source_dependency_mode, mode)
            saved['accepted'][0].pop('source_dependency_mode')
            self.assertIs(restore_outcome(saved).accepted[0].source_dependency_mode, SourceDependencyMode.ANY)

    def test_correction_and_version_row_decoders_keep_all(self):
        row = dict(id=self.memory.memory_id, owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            text_content=self.memory.text, category=self.memory.category.value, topic=self.memory.topic.value,
            source_ids=list(self.memory.source_ids), source_candidate_id=self.candidate.candidate_id,
            adoption_method='auto', status='active', valid_at=None, invalid_at=None, revision=1,
            confidence=0.8, risk_flags=[], supersedes_memory_id=None, source_dependency_mode='all',
            subject='contact', alternatives=[], interpretation_reason='')
        self.assertIs(raw_memory(row).source_dependency_mode, SourceDependencyMode.ALL)
        self.assertIs(raw_memory({key: value for key, value in row.items() if key != 'contact_id'}).source_dependency_mode, SourceDependencyMode.ALL)
        row['status'] = 'pending'
        self.assertIs(candidate_from_row(row).source_dependency_mode, SourceDependencyMode.ALL)

    def test_version_identity_and_receipt_bind_dependency_mode(self):
        weaker = replace(self.memory, source_dependency_mode=SourceDependencyMode.ANY)
        self.assertNotEqual(version_record_digest(self.memory), version_record_digest(weaker))
        with self.assertRaises(MemoryCorrectionConflictError):
            require_auto_previous(weaker, self.memory)

    def test_new_version_preserves_previous_all_requirement(self):
        candidate = self.store.create_candidate(replace(self.candidate, candidate_id=uuid4(),
            source_ids=(uuid4(),), text='合成新版正文', source_dependency_mode=SourceDependencyMode.ANY))
        updated = self.store.confirm(scope=self.scope, candidate_id=candidate.candidate_id,
            expected_previous=self.memory)
        self.assertIs(updated.source_dependency_mode, SourceDependencyMode.ALL)
        self.assertEqual(set(updated.source_ids), {*self.memory.source_ids, *candidate.source_ids})

    def test_upgrade_preview_of_automatic_all_fact_keeps_mode(self):
        from notalone.application.memory_upgrade_preview import preview_upgrade
        from notalone.memory_extraction.dimensions import DimensionRelease

        fact = replace(synthetic_fact(), source_dependency_mode=SourceDependencyMode.ALL)
        compared = preview_upgrade(self.scope, ExtractionOutcome(accepted=(fact,)),
            memory_port=InMemoryMemoryStore(), dimension_release=DimensionRelease(gate_enabled=False))
        self.assertEqual(compared.actions[0].kind, 'auto_add')
        self.assertIs(compared.actions[0].candidate.source_dependency_mode, SourceDependencyMode.ALL)
        self.assertEqual(comparison_payload(compared)['actions'][0]['new']['source_dependency_mode'], 'all')
