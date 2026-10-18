"""隔离测试库验证多父合并、重放、删除和原子拒绝。"""
from dataclasses import replace
from notalone.memory import AdoptionMethod, FactSubject, SourceDependencyMode
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from tests.integration.persistence.test_memory_timing import PostgresMemoryTimingTest


class MemoryMergeTest(PostgresMemoryTimingTest):
    def _parents_and_candidate(self, owner=False, manual=False):
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
        candidate = self.store.create_candidate(candidate)
        return store, tuple(parents), candidate

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
