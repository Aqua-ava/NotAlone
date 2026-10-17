"""ALL采纳与去重的纯公开控制；不认证正式来源或真实模型。"""
from dataclasses import replace
import unittest
from uuid import uuid4

from notalone.memory import AdoptionMethod, InMemoryMemoryStore, SourceDependencyMode
from notalone.memory_extraction.adoption import MemoryAdoption
from notalone.memory_extraction.flow import ExtractionOutcome
from tests.unit.memory_extraction.test_bounded_runtime_proof import window_for, compiled_fact


class AllSourceAdoptionTest(unittest.TestCase):
    def setUp(self):
        from notalone.scopes import ContactScope
        self.window = window_for('我刚到家。')
        self.scope = ContactScope(self.window.owner_id, self.window.contact_id)
        self.fact = replace(compiled_fact(self.window), source_dependency_mode=SourceDependencyMode.ALL, dimension_evidence=None)
        self.store = InMemoryMemoryStore()
        self.adoption = MemoryAdoption(memory_port=self.store)

    def test_pending_and_memory_lifecycle_keep_mode_when_proof_is_null(self):
        stats = self.adoption.adopt(self.scope, ExtractionOutcome((self.fact,)))
        self.assertEqual(stats.pending, 1)
        candidate, = self.store.list_pending_candidates(self.scope)
        self.assertIs(candidate.source_dependency_mode, SourceDependencyMode.ALL)
        memory = self.store.confirm(scope=self.scope, candidate_id=candidate.candidate_id, adoption_method=AdoptionMethod.MANUAL)
        self.assertIs(memory.source_dependency_mode, SourceDependencyMode.ALL)
        corrected = self.store.correct(scope=self.scope, memory_id=memory.memory_id, text='用户修正原话')
        self.assertIs(corrected.source_dependency_mode, SourceDependencyMode.ALL)
        self.assertEqual(corrected.source_ids, self.fact.source_message_ids)

    def test_all_null_or_any_pending_cannot_swallow_new_all(self):
        for mode in (SourceDependencyMode.ANY, SourceDependencyMode.ALL):
            with self.subTest(mode=mode):
                store = InMemoryMemoryStore()
                adoption = MemoryAdoption(memory_port=store)
                adoption.adopt(self.scope, ExtractionOutcome((replace(self.fact, source_dependency_mode=mode),)))
                stats = adoption.adopt(self.scope, ExtractionOutcome((self.fact,)))
                self.assertEqual((stats.pending, stats.skipped_duplicate), (1, 0))
                self.assertEqual(len(store.list_pending_candidates(self.scope)), 2)

    def _proved_fact(self, window=None):
        from tests.unit.memory_extraction.test_bounded_runtime_proof import arrival_payload
        from notalone.memory_extraction.verification import validate_source_verification
        from notalone.memory_extraction.evidence import build_dimension_evidence
        window = window or self.window
        fact = replace(compiled_fact(window), source_dependency_mode=SourceDependencyMode.ALL)
        result, = validate_source_verification(({'candidate_index': 0, 'verdict': 'supported', 'issues': [],
            'evidence': [{'message_id': str(window.messages[0].message_id), 'quote': window.messages[0].text}],
            'proof': arrival_payload(window, fact)},), window=window, facts=(fact,), mode='nullable-proof-v3')
        return replace(fact, dimension_evidence=build_dimension_evidence(window, fact, result))

    def test_same_all_current_snapshot_can_reuse_pending_and_confirmed(self):
        fact = self._proved_fact()
        self.adoption.adopt(self.scope, ExtractionOutcome((fact,)))
        duplicate = self.adoption.adopt(self.scope, ExtractionOutcome((fact,)))
        self.assertEqual((duplicate.pending, duplicate.skipped_duplicate), (0, 1))
        candidate, = self.store.list_pending_candidates(self.scope)
        self.store.confirm(scope=self.scope, candidate_id=candidate.candidate_id, adoption_method=AdoptionMethod.MANUAL)
        duplicate = self.adoption.adopt(self.scope, ExtractionOutcome((fact,)))
        self.assertEqual((duplicate.pending, duplicate.skipped_duplicate), (0, 1))

    def test_changed_snapshot_support_group_or_cleared_proof_does_not_reuse(self):
        fact = self._proved_fact()
        other_id = uuid4()
        other = replace(self.window, messages=(replace(self.window.messages[0], message_id=other_id),), target_message_ids=(other_id,))
        # 相同正文的独立支持组与不同完整窗口，均不是同一实际依据输入。
        background = replace(self.window.messages[0], message_id=uuid4(), text='合成无关背景。')
        changed = replace(self.window, messages=(*self.window.messages, background))
        for next_fact, clear, confirmed in ((self._proved_fact(other), False, False),
                (self._proved_fact(changed), False, False), (fact, True, False), (fact, True, True)):
            with self.subTest(clear=clear, confirmed=confirmed):
                store = InMemoryMemoryStore()
                adoption = MemoryAdoption(memory_port=store)
                adoption.adopt(self.scope, ExtractionOutcome((replace(fact, dimension_evidence=None) if clear else fact,)))
                if confirmed:
                    candidate, = store.list_pending_candidates(self.scope)
                    store.confirm(scope=self.scope, candidate_id=candidate.candidate_id, adoption_method=AdoptionMethod.MANUAL)
                stats = adoption.adopt(self.scope, ExtractionOutcome((next_fact,)))
                self.assertEqual((stats.pending, stats.skipped_duplicate), (1, 0))

    def test_any_confirmed_and_owner_mixed_pool_do_not_swallow_all(self):
        from notalone.memory import OwnerMemory, ConfirmedMemoryStatus
        from notalone.memory_extraction.models import FactSubject
        from tests.integration.server.test_memory_api import FakeOwnerMemory
        fact = self._proved_fact()
        self.adoption.adopt(self.scope, ExtractionOutcome((replace(self.fact, source_dependency_mode=SourceDependencyMode.ANY),)))
        old, = self.store.list_pending_candidates(self.scope)
        self.store.confirm(scope=self.scope, candidate_id=old.candidate_id, adoption_method=AdoptionMethod.MANUAL)
        self.assertEqual(self.adoption.adopt(self.scope, ExtractionOutcome((fact,))).pending, 1)
        owner = FakeOwnerMemory()
        owner.memories = [OwnerMemory(memory_id=uuid4(), owner_id=self.scope.owner_id,
            text=self.fact.text, category=self.fact.category, topic=self.fact.topic, source_ids=self.fact.source_message_ids,
            adoption_method=AdoptionMethod.MANUAL, status=ConfirmedMemoryStatus.ACTIVE)]
        stats = MemoryAdoption(memory_port=InMemoryMemoryStore(), owner_memory_port=owner).adopt(
            self.scope, ExtractionOutcome((replace(self.fact, subject=FactSubject.SELF),)))
        self.assertEqual((stats.pending, stats.skipped_duplicate), (1, 0))

    def test_in_memory_discard_and_independent_manual_keep_their_modes(self):
        self.adoption.adopt(self.scope, ExtractionOutcome((self.fact,)))
        candidate, = self.store.list_pending_candidates(self.scope)
        with self.assertRaises(ValueError):
            self.store.create_manual_candidate(replace(candidate, candidate_id=uuid4()))
        rejected = self.store.discard_candidate_with_fingerprint(scope=self.scope, candidate_id=candidate.candidate_id)
        self.assertIs(rejected.source_dependency_mode, SourceDependencyMode.ALL)
        self.assertEqual(self.store.deleted_texts(self.scope), (self.fact.text,))

    def test_cross_mode_similarity_cannot_noop_or_replace_all_and_owner_fallback_keeps_mode(self):
        from notalone.memory import OwnerMemory, ConfirmedMemoryStatus
        from notalone.memory_extraction.dimensions import RELEASE_ALL_DIMENSIONS
        from notalone.memory_extraction.models import FactSubject
        from tests.integration.server.test_memory_api import FakeOwnerMemory

        class ForbiddenAdjudication:
            def adjudicate(self, **kwargs):
                raise AssertionError('不同依赖合同不得进入吞并裁决')

        for subject in (FactSubject.CONTACT, FactSubject.SELF):
            with self.subTest(subject=subject):
                store = InMemoryMemoryStore()
                owner = FakeOwnerMemory()
                next_fact = replace(self.fact, risk_flags=())
                old = replace(next_fact, source_dependency_mode=SourceDependencyMode.ANY,
                              text=self.fact.text.replace('刚到家', '刚刚到家'))
                if subject is FactSubject.CONTACT:
                    MemoryAdoption(memory_port=store).adopt(self.scope, ExtractionOutcome((old,)))
                    candidate, = store.list_pending_candidates(self.scope)
                    store.confirm(scope=self.scope, candidate_id=candidate.candidate_id, adoption_method=AdoptionMethod.MANUAL)
                else:
                    owner.create(OwnerMemory(memory_id=uuid4(), owner_id=self.scope.owner_id, text=old.text,
                        category=old.category, topic=old.topic, source_ids=old.source_message_ids,
                        adoption_method=AdoptionMethod.MANUAL, status=ConfirmedMemoryStatus.ACTIVE))
                stats = MemoryAdoption(memory_port=store, owner_memory_port=owner,
                    adjudication_runtime=ForbiddenAdjudication(), dimension_release=RELEASE_ALL_DIMENSIONS).adopt(
                        self.scope, ExtractionOutcome((replace(next_fact, subject=subject),)))
                self.assertEqual((stats.adopted, stats.skipped_duplicate), (1, 0))
                actual = store.list_confirmed(self.scope)[-1] if subject is FactSubject.CONTACT else owner.list_active(self.scope.owner_id)[-1]
                self.assertIs(actual.source_dependency_mode, SourceDependencyMode.ALL)
                self.assertEqual(actual.source_ids, self.fact.source_message_ids)
