"""隔离测试库验证多父合并、重放、删除和原子拒绝。"""
from dataclasses import replace
from notalone.memory import AdoptionMethod, FactSubject, SourceDependencyMode
from notalone.memory.evidence_binding import candidate_digest
from notalone.memory.evolution import MemoryEvolution
from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.persistence.memory_versions import version_record_digest
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from tests.integration.persistence.test_memory_timing import PostgresMemoryTimingTest


class MemoryMergeTest(PostgresMemoryTimingTest):
    def _merge_evidence(self, candidate, parents):
        """只构造存储合同夹具；真实来源与版本摘要不代表模型语义质量。"""
        source_ids = tuple(dict.fromkeys((*candidate.source_ids,
            *(source for parent in parents for source in parent.source_ids))))
        snapshot = self.store.capture_adjudication_sources(self.scope, source_ids)
        self.assertIsNotNone(snapshot)
        proof = {
            "scope": {"owner_id": str(self.scope.owner_id), "contact_id": str(self.scope.contact_id)},
            "candidate_sha256": candidate_digest(candidate),
            "sources": snapshot,
            "parents": [{
                "memory_id": str(parent.memory_id), "revision": parent.revision,
                "record_sha256": version_record_digest(parent),
                "subject": candidate.subject.value,
                "invalid_at": parent.invalid_at.isoformat() if parent.invalid_at else None,
            } for parent in parents],
        }
        return replace(candidate, evolution=MemoryEvolution(
            kind="supplement", explanation="合成存储合同：两条来源合并保存，未声明状态改变。",
            related_versions=tuple((parent.memory_id, parent.revision) for parent in parents),
            evidence_message_ids=source_ids, source_supported=True,
            claim_changed=False, condition_changed=False, proof=proof))

    def _parents_and_candidate(self, owner=False, manual=False, proof=True):
        store = PostgresOwnerMemoryStore(self.database_url) if owner else self.store
        parents = []
        for source in (self.first, self.second):
            candidate = self._candidate((source,), subject=FactSubject.SELF if owner else FactSubject.CONTACT)
            candidate = self.store.create_candidate(candidate)
            method = AdoptionMethod.MANUAL if manual else AdoptionMethod.AUTO
            parent = (store.confirm_candidate(candidate=candidate, adoption_method=method) if owner else
                      store.confirm(scope=self.scope, candidate_id=candidate.candidate_id, adoption_method=method))
            parents.append(parent)
        candidate = self._candidate((self.first, self.second), subject=FactSubject.SELF if owner else FactSubject.CONTACT)
        if proof:
            candidate = self._merge_evidence(candidate, parents)
        candidate = self.store.create_candidate(candidate)
        return store, tuple(parents), candidate

    def test_direct_merge_without_relation_proof_is_rejected_atomically(self):
        for owner in (False, True):
            with self.subTest(owner=owner):
                store, parents, candidate = self._parents_and_candidate(owner=owner, proof=False)
                with self.assertRaises(MemoryCorrectionConflictError):
                    store.confirm_merge(scope=self.scope, candidate_id=candidate.candidate_id,
                                        expected_parents=parents)
                saved = self.store.get_candidate(scope=self.scope, candidate_id=candidate.candidate_id)
                self.assertEqual(saved.status.value, "pending")
                current = (store.list_active(self.scope.owner_id) if owner
                           else store.list_confirmed(self.scope))
                self.assertTrue({parent.memory_id for parent in parents} <=
                                {memory.memory_id for memory in current if memory.status.value == "active"})
                self.assertFalse(any(memory.source_candidate_id == candidate.candidate_id for memory in current))

    def test_contact_merge_is_replayable_and_lists_both_parents(self):
        store, parents, candidate = self._parents_and_candidate()
        result = store.confirm_merge(scope=self.scope, candidate_id=candidate.candidate_id, expected_parents=parents)
        self.assertEqual(result.source_dependency_mode, SourceDependencyMode.ALL)
        self.assertEqual({m.memory_id for m in store.list_versions(scope=self.scope, memory_id=result.memory_id)},
                         {result.memory_id, *(m.memory_id for m in parents)})
        replay = store.confirm_merge(scope=self.scope, candidate_id=candidate.candidate_id, expected_parents=parents)
        self.assertEqual(replay.memory_id, result.memory_id)
        with self.assertRaises(Exception):
            store.confirm_merge(scope=self.scope, candidate_id=candidate.candidate_id, expected_parents=(replace(parents[0], text='变更'), parents[1]))

    def test_manual_parents_are_rejected_without_confirming_candidate(self):
        store, parents, candidate = self._parents_and_candidate(manual=True)
        with self.assertRaises(Exception):
            store.confirm_merge(scope=self.scope, candidate_id=candidate.candidate_id, expected_parents=parents)
        self.assertEqual(store.get_candidate(scope=self.scope, candidate_id=candidate.candidate_id).status.value, 'pending')

    def test_owner_merge_lists_both_parents(self):
        store, parents, candidate = self._parents_and_candidate(owner=True)
        result = store.confirm_merge(scope=self.scope, candidate_id=candidate.candidate_id, expected_parents=parents)
        self.assertEqual(result.source_dependency_mode, SourceDependencyMode.ALL)
        self.assertEqual(len(store.list_versions(owner_id=self.scope.owner_id, memory_id=result.memory_id)), 3)

    def test_missing_parent_source_rolls_back(self):
        store, parents, candidate = self._parents_and_candidate()
        incomplete = self.store.create_candidate(replace(self._candidate((self.first,)), text='只有第一条依据'))
        with self.assertRaises(Exception):
            store.confirm_merge(scope=self.scope, candidate_id=incomplete.candidate_id, expected_parents=parents)
        self.assertEqual(len(store.list_confirmed(self.scope)), 2)
        self.assertEqual(store.get_candidate(scope=self.scope, candidate_id=incomplete.candidate_id).status.value, 'pending')

    def test_delete_current_clears_both_parent_bodies_and_old_parent_delete_rejected(self):
        import psycopg
        store, parents, candidate = self._parents_and_candidate()
        result = store.confirm_merge(scope=self.scope, candidate_id=candidate.candidate_id, expected_parents=parents)
        with self.assertRaises(Exception):
            store.delete(scope=self.scope, memory_id=parents[0].memory_id)
        store.delete(scope=self.scope, memory_id=result.memory_id)
        with psycopg.connect(self.database_url) as connection:
            rows = connection.execute('SELECT text_content FROM public.confirmed_memory WHERE owner_id=%s', (self.scope.owner_id,)).fetchall()
        self.assertTrue(all(row[0] == '已删除的资料' for row in rows))

    def test_parent_changed_after_read_rejects_merge(self):
        store, parents, candidate = self._parents_and_candidate()
        store.invalidate(scope=self.scope, memory_id=parents[0].memory_id)
        with self.assertRaises(Exception):
            store.confirm_merge(scope=self.scope, candidate_id=candidate.candidate_id, expected_parents=parents)
        self.assertEqual(store.get_candidate(scope=self.scope, candidate_id=candidate.candidate_id).status.value, 'pending')

    def test_owner_delete_clears_both_parent_bodies(self):
        import psycopg
        store, parents, candidate = self._parents_and_candidate(owner=True)
        result = store.confirm_merge(scope=self.scope, candidate_id=candidate.candidate_id, expected_parents=parents)
        with self.assertRaises(Exception):
            store.delete(self.scope.owner_id, parents[1].memory_id)
        store.delete(self.scope.owner_id, result.memory_id)
        with psycopg.connect(self.database_url) as connection:
            rows = connection.execute('SELECT text_content FROM public.owner_memory WHERE owner_id=%s', (self.scope.owner_id,)).fetchall()
        self.assertTrue(all(row[0] == '已删除的资料' for row in rows))

    def test_source_deletion_erases_merged_memory(self):
        import psycopg
        from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
        store, parents, candidate = self._parents_and_candidate()
        result = store.confirm_merge(scope=self.scope, candidate_id=candidate.candidate_id, expected_parents=parents)
        PostgresSourceDeletionRepository(self.database_url).delete_source(owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id, source_document_id=self.source_id)
        with psycopg.connect(self.database_url) as connection:
            row = connection.execute('SELECT 1 FROM public.confirmed_memory WHERE id=%s', (result.memory_id,)).fetchone()
        self.assertIsNone(row)

    def test_failure_after_new_memory_insert_rolls_back_all_writes(self):
        import psycopg
        from unittest.mock import patch
        for owner in (False, True):
            with self.subTest(owner=owner):
                store, parents, candidate = self._parents_and_candidate(owner=owner)
                with patch('notalone.persistence.memory_merge.erase_layered_reply_dependencies', side_effect=RuntimeError('合成写入后故障')):
                    with self.assertRaises(RuntimeError):
                        store.confirm_merge(scope=self.scope, candidate_id=candidate.candidate_id, expected_parents=parents)
                self.assertEqual(self.store.get_candidate(scope=self.scope, candidate_id=candidate.candidate_id).status.value, 'pending')
                table = 'owner_memory' if owner else 'confirmed_memory'
                with psycopg.connect(self.database_url) as connection:
                    created = connection.execute(f'SELECT id FROM public.{table} WHERE source_candidate_id=%s', (candidate.candidate_id,)).fetchone()
                    statuses = connection.execute(f'SELECT status, revision FROM public.{table} WHERE id=ANY(%s)', ([p.memory_id for p in parents],)).fetchall()
                self.assertIsNone(created)
                self.assertEqual(statuses, [('active', 1), ('active', 1)])

    def test_deleting_one_parent_source_erases_merge_candidate_body(self):
        import psycopg
        from tests.integration.persistence.test_memory_timing import SECOND_DATE
        from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
        _, extra = self._add_source_messages(self.scope.owner_id, self.scope.contact_id, (SECOND_DATE,))
        parents = []
        for index, source in enumerate((self.first, extra[0])):
            candidate = self.store.create_candidate(replace(self._candidate((source,)), text=f'独立父事实{index}'))
            parents.append(self.store.confirm(scope=self.scope, candidate_id=candidate.candidate_id))
        candidate = self.store.create_candidate(self._merge_evidence(
            replace(self._candidate((self.first, extra[0])), text='合并两个不同来源的完整事实'), parents))
        result = self.store.confirm_merge(scope=self.scope, candidate_id=candidate.candidate_id, expected_parents=tuple(parents))
        PostgresSourceDeletionRepository(self.database_url).delete_source(owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id, source_document_id=self.source_id)
        with psycopg.connect(self.database_url) as connection:
            memory = connection.execute('SELECT text_content FROM public.confirmed_memory WHERE id=%s', (result.memory_id,)).fetchone()
            remaining = connection.execute('SELECT text_content, source_ids FROM public.memory_candidate WHERE id=%s', (candidate.candidate_id,)).fetchone()
        self.assertIsNone(memory)
        self.assertTrue(remaining is None or remaining[0] == '已删除的资料', repr(remaining))

    def _full_dependency_candidate(self, owner=False):
        from tests.integration.persistence.test_memory_timing import SECOND_DATE
        _, extra = self._add_source_messages(self.scope.owner_id, self.scope.contact_id, (SECOND_DATE,))
        return self.store.create_candidate(replace(self._candidate((self.first, extra[0]),
            subject=FactSubject.SELF if owner else FactSubject.CONTACT), requires_all_sources=True))

    def _delete_first_source(self):
        from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
        PostgresSourceDeletionRepository(self.database_url).delete_source(owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id, source_document_id=self.source_id)

    def test_pending_direct_candidate_erased_when_one_source_deleted(self):
        import psycopg
        candidate = self._full_dependency_candidate()
        self.assertTrue(candidate.requires_all_sources)
        self.assertTrue(self.store.get_candidate(scope=self.scope, candidate_id=candidate.candidate_id).requires_all_sources)
        from uuid import uuid4
        trace_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.memory_extraction_trace(trace_id,owner_id,contact_id,run_id,batch_key) VALUES (%s,%s,%s,%s,'synthetic-merge')",
                (trace_id, self.scope.owner_id, self.scope.contact_id, uuid4()))
            connection.execute("INSERT INTO public.memory_extraction_trace_event(event_id,trace_id,owner_id,contact_id,position,stage,payload) VALUES (%s,%s,%s,%s,0,'window','{\"text\":\"合成待删正文\"}')",
                (uuid4(), trace_id, self.scope.owner_id, self.scope.contact_id))
            connection.execute("INSERT INTO public.memory_extraction_trace_dependency(trace_id,owner_id,contact_id,source_id) VALUES (%s,%s,%s,%s)",
                (trace_id, self.scope.owner_id, self.scope.contact_id, self.first))
        self._delete_first_source()
        with psycopg.connect(self.database_url) as connection:
            events = connection.execute('SELECT count(*) FROM public.memory_extraction_trace_event WHERE trace_id=%s', (trace_id,)).fetchone()[0]
            self.assertEqual(events, 0)
        with psycopg.connect(self.database_url) as connection:
            row = connection.execute('SELECT text_content FROM public.memory_candidate WHERE id=%s', (candidate.candidate_id,)).fetchone()
        self.assertIsNone(row)

    def test_direct_contact_confirm_preserves_lifecycle_and_deletion(self):
        candidate = self._full_dependency_candidate()
        memory = self.store.confirm(scope=self.scope, candidate_id=candidate.candidate_id)
        self.assertTrue(memory.requires_all_sources)
        self.assertEqual(memory.source_dependency_mode, SourceDependencyMode.ANY)
        self._delete_first_source()
        self.assertEqual(self.store.list_confirmed(self.scope), ())

    def test_direct_owner_confirm_preserves_lifecycle_and_deletion(self):
        candidate = self._full_dependency_candidate(owner=True)
        store = PostgresOwnerMemoryStore(self.database_url)
        memory = store.confirm_candidate(candidate=candidate, adoption_method=AdoptionMethod.AUTO)
        self.assertTrue(memory.requires_all_sources)
        self.assertEqual(memory.source_dependency_mode, SourceDependencyMode.ANY)
        self._delete_first_source()
        self.assertEqual(store.list_active(self.scope.owner_id), ())

    def test_manual_correction_preserves_full_source_lifecycle(self):
        candidate = self._full_dependency_candidate()
        memory = self.store.confirm(scope=self.scope, candidate_id=candidate.candidate_id)
        corrected = self.store.correct(scope=self.scope, memory_id=memory.memory_id, text='合成人工修正正文')
        self.assertTrue(corrected.requires_all_sources)

    def test_owner_correction_preserves_full_source_lifecycle(self):
        candidate = self._full_dependency_candidate(owner=True)
        store = PostgresOwnerMemoryStore(self.database_url)
        memory = store.confirm_candidate(candidate=candidate, adoption_method=AdoptionMethod.AUTO)
        corrected = store.correct(owner_id=self.scope.owner_id, memory_id=memory.memory_id, text='合成本人修正正文')
        self.assertTrue(corrected.requires_all_sources)
