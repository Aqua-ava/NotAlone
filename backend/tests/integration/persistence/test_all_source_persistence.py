"""ALL正文依赖的隔离PG纵切；仅使用公开合成消息。"""
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
import shutil
import tempfile
import unittest
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.types.json import Jsonb

from notalone.database_migrations import migrate
from notalone.memory import AdoptionMethod, MemoryCandidate, MemoryCategory, SourceDependencyMode
from notalone.memory_extraction.models import FactSubject
from notalone.persistence import PostgresMemoryStore, PostgresOwnerMemoryStore
from notalone.persistence.memory_store import MemoryPersistenceError
from notalone.scopes import ContactScope

MIGRATIONS = Path(__file__).resolve().parents[3] / 'database/migrations'


class AllSourcePersistenceTest(unittest.TestCase):
    def setUp(self):
        self.name = f'notalone_all_store_{uuid4().hex}_test'
        self.admin = psycopg.connect('host=/tmp dbname=postgres', autocommit=True)
        self.admin.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(self.name)))
        self.addCleanup(self._drop)
        self.url = make_conninfo('host=/tmp', dbname=self.name)
        migrate(self.url, MIGRATIONS)
        self.scope = ContactScope(uuid4(), uuid4())
        self.other = uuid4()
        self._seed()

    def _seed(self):
        with psycopg.connect(self.url) as connection:
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成用户')", (self.scope.owner_id,))
            for contact in (self.scope.contact_id, self.other):
                connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES(%s,%s,'合成联系人')", (self.scope.owner_id, contact))
        self.source, self.message = self._source('合成目标原文。')
        self.context_source, self.context = self._source('合成必需上下文。')
        self.store = PostgresMemoryStore(self.url)
        self.owner_store = PostgresOwnerMemoryStore(self.url)

    def _drop(self):
        try:
            self.admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(self.name)))
            self.assertEqual(self.admin.execute('SELECT count(*) FROM pg_database WHERE datname=%s', (self.name,)).fetchone(), (0,))
            print(f'isolated_database_cleaned={self.name};residual=0')
        finally:
            self.admin.close()

    def _source(self, text, *, contact=None, speaker='contact'):
        from notalone.memory.evidence_binding import content_digest
        source, message = uuid4(), uuid4()
        contact = contact or self.scope.contact_id
        with psycopg.connect(self.url) as connection:
            connection.execute("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES(%s,%s,%s,'wechat_jsonl','synthetic-all-store.jsonl',%s,1)", (source, self.scope.owner_id, contact, content_digest(text)))
            connection.execute("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES(%s,%s,%s,%s,'text',%s,%s)", (message, self.scope.owner_id, contact, speaker, text, datetime(2026, 10, 17, tzinfo=timezone.utc)))
            connection.execute("INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES(%s,%s,%s,'source_document',%s,'synthetic:all-store',%s)", (message, self.scope.owner_id, contact, source, Jsonb({'text': text, 'time_iso': '2026-10-17T00:00:00+00:00'})))
        return source, message

    def _candidate(self, **changes):
        values = dict(candidate_id=uuid4(), scope=self.scope, text='合成正文及必需上下文', category=MemoryCategory.COMMON_FACT,
                      source_ids=(self.message, self.context), source_dependency_mode=SourceDependencyMode.ALL)
        values.update(changes)
        return MemoryCandidate(**values)

    def test_null_snapshot_all_survives_manual_confirm_and_correct(self):
        self._assert_null_snapshot_confirmation(AdoptionMethod.MANUAL)

    def test_null_snapshot_all_survives_auto_confirm_and_correct(self):
        self._assert_null_snapshot_confirmation(AdoptionMethod.AUTO)

    def _assert_null_snapshot_confirmation(self, method):
        candidate = self.store.create_candidate(self._candidate())
        self.assertIs(candidate.source_dependency_mode, SourceDependencyMode.ALL)
        self.assertIsNone(candidate.dimension_evidence)
        self.assertIs(self.store.get_candidate(scope=self.scope, candidate_id=candidate.candidate_id).source_dependency_mode, SourceDependencyMode.ALL)
        memory = self.store.confirm(scope=self.scope, candidate_id=candidate.candidate_id, adoption_method=method)
        corrected = self.store.correct(scope=self.scope, memory_id=memory.memory_id, text='用户修正合成正文')
        for item in (memory, corrected, *self.store.list_confirmed(self.scope)):
            self.assertIs(item.source_dependency_mode, SourceDependencyMode.ALL)
            self.assertEqual(item.source_ids, (self.message, self.context))

    def test_null_snapshot_rejection_keeps_all_fingerprint(self):
        pending = self.store.create_candidate(self._candidate())
        rejected = self.store.discard_candidate_with_fingerprint(scope=self.scope, candidate_id=pending.candidate_id)
        self.assertIs(rejected.source_dependency_mode, SourceDependencyMode.ALL)
        self.assertIsNone(rejected.dimension_evidence)
        with psycopg.connect(self.url) as connection:
            self.assertEqual(connection.execute('SELECT source_dependency_mode,source_ids FROM public.confirmed_memory WHERE source_candidate_id=%s', (pending.candidate_id,)).fetchone(), ('all', [self.message, self.context]))

    def test_owner_manual_confirmation_fallback_and_correction_keep_all_sources(self):
        self._assert_owner_confirmation(AdoptionMethod.MANUAL)

    def test_owner_auto_confirmation_fallback_and_correction_keep_all_sources(self):
        self._assert_owner_confirmation(AdoptionMethod.AUTO)

    def _assert_owner_confirmation(self, method):
        from notalone.memory import OwnerMemory, MemoryTopic, ConfirmedMemoryStatus
        candidate = self.store.create_candidate(self._candidate(subject=FactSubject.SELF))
        memory = self.owner_store.confirm_candidate(candidate=candidate, adoption_method=method)
        corrected = self.owner_store.correct(owner_id=self.scope.owner_id, memory_id=memory.memory_id, text='用户修正本人合成正文')
        for item in (memory, corrected):
            self.assertIs(item.source_dependency_mode, SourceDependencyMode.ALL)
            self.assertEqual(item.source_ids, (self.message, self.context))
        fallback = self.owner_store.create(OwnerMemory(memory_id=uuid4(), owner_id=self.scope.owner_id,
            text='回退本人合成正文', category=MemoryCategory.COMMON_FACT, topic=MemoryTopic.OTHER, status=ConfirmedMemoryStatus.ACTIVE, source_ids=(self.message, self.context),
            adoption_method=AdoptionMethod.AUTO, source_dependency_mode=SourceDependencyMode.ALL))
        self.assertIs(fallback.source_dependency_mode, SourceDependencyMode.ALL)
        self.assertTrue(all(item.source_dependency_mode is SourceDependencyMode.ALL
                            for item in self.owner_store.list_active(self.scope.owner_id)))

    def test_all_rejects_raw_missing_foreign_and_inactive_sources_even_without_snapshot(self):
        _, foreign = self._source('其他联系人合成消息。', contact=self.other)
        for sources in ((self.source,), (uuid4(),), (self.message, foreign)):
            with self.subTest(sources=sources), self.assertRaises(PermissionError):
                self.store.create_candidate(self._candidate(source_ids=sources))
        with psycopg.connect(self.url) as connection:
            connection.execute("UPDATE public.source_document SET status='delete_requested' WHERE id=%s", (self.context_source,))
        with self.assertRaises(PermissionError):
            self.store.create_candidate(self._candidate())
        # 旧ANY仍允许原始source_document引用。
        old = self.store.create_candidate(self._candidate(source_ids=(self.source,), source_dependency_mode=SourceDependencyMode.ANY))
        self.assertIs(old.source_dependency_mode, SourceDependencyMode.ANY)

    def test_legacy_missing_columns_read_any_and_reject_all_before_new_writes(self):
        # 仅在自有随机库重建001–059，核真实缺列旧结构而非放松071约束。
        with psycopg.connect(self.url) as connection:
            connection.execute('DROP SCHEMA public CASCADE')
            connection.execute('CREATE SCHEMA public')
        with tempfile.TemporaryDirectory(prefix='notalone-all-legacy-') as directory:
            target = Path(directory)
            for source in MIGRATIONS.glob('*.sql'):
                if source.name[:3] <= '059':
                    shutil.copyfile(source, target / source.name)
            migrate(self.url, target)
        self._seed()
        candidate = self.store.create_candidate(self._candidate(source_dependency_mode=SourceDependencyMode.ANY))
        self.assertIs(candidate.source_dependency_mode, SourceDependencyMode.ANY)
        memory = self.store.confirm(scope=self.scope, candidate_id=candidate.candidate_id, adoption_method=AdoptionMethod.MANUAL)
        self.assertIs(memory.source_dependency_mode, SourceDependencyMode.ANY)
        corrected = self.store.correct(scope=self.scope, memory_id=memory.memory_id, text='旧库修正合成正文')
        self.assertIs(corrected.source_dependency_mode, SourceDependencyMode.ANY)
        self.assertEqual(len(self.store.list_confirmed(self.scope)), 1)
        from notalone.memory import OwnerMemory, MemoryTopic, ConfirmedMemoryStatus
        from notalone.persistence.owner_memory_store import OwnerMemoryPersistenceError
        manual = OwnerMemory(memory_id=uuid4(), owner_id=self.scope.owner_id, text='旧库独立本人资料',
            category=MemoryCategory.COMMON_FACT, topic=MemoryTopic.OTHER, status=ConfirmedMemoryStatus.ACTIVE,
            source_ids=(self.scope.owner_id,), adoption_method=AdoptionMethod.MANUAL)
        self.assertIs(self.owner_store.create(manual).source_dependency_mode, SourceDependencyMode.ANY)
        self.assertEqual(len(self.owner_store.list_active(self.scope.owner_id)), 1)
        with self.assertRaises(OwnerMemoryPersistenceError):
            self.owner_store.create(replace(manual, memory_id=uuid4(), source_ids=(self.message,), source_dependency_mode=SourceDependencyMode.ALL))
        with self.assertRaises(MemoryPersistenceError):
            self.store.create_candidate(self._candidate())
        with psycopg.connect(self.url) as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM public.memory_candidate').fetchone(), (1,))
            self.assertEqual(connection.execute("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND column_name='source_dependency_mode'").fetchone(), (0,))

    def test_independent_manual_candidate_remains_any(self):
        with self.assertRaises(ValueError):
            self.store.create_manual_candidate(self._candidate())
        manual = self.store.create_manual_candidate(self._candidate(source_dependency_mode=SourceDependencyMode.ANY))
        self.assertIs(manual.source_dependency_mode, SourceDependencyMode.ANY)
        self.assertNotEqual(manual.source_ids, (self.message, self.context))

    def _sdk_candidate(self, *, speaker='contact', proof=True):
        from tests.integration.memory_extraction.test_evaluation_wire_contract import EvaluationWireContractTest
        from tests.unit.memory_extraction.test_bounded_runtime_proof import arrival_payload, compiled_fact
        from notalone.memory_extraction.cli_support import load_contact_messages
        from notalone.memory_extraction.models import ExtractionWindow
        from notalone.memory_extraction.grounded_adapter import GroundedExtractionRuntime
        from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
        from notalone.memory_extraction.flow import ExtractionFlow
        from notalone.memory_trace.transport import _request_hook, _response_hook
        _, message_id = self._source('我刚到家。', speaker=speaker)
        message, = (row for row in load_contact_messages(self.scope, self.url) if row.message_id == message_id)
        window = ExtractionWindow(self.scope.owner_id, self.scope.contact_id, (message,), (message_id,))
        expected = compiled_fact(window)
        wire = EvaluationWireContractTest()
        wire.setUp()
        self.addCleanup(wire.doCleanups)
        labels = {'units': {'0:0': {'kind': 'event', 'subject': message.sender.value, 'topic': 'other',
            'dependency': None, 'unresolved': False, 'confidence': .92, 'sensitivity': 'none', 'event': None}}}
        extraction = wire.model(tool_name='GroundedMemoryLabels', arguments=labels)
        verification = wire.model(tool_name='SourceVerificationOutput', arguments={'results': [{
            'candidate_index': 0, 'verdict': 'supported', 'issues': [],
            'evidence': [{'message_id': str(message_id), 'quote': message.text}],
            'proof': arrival_payload(window, expected) if proof else None}]})
        verification.root_client._client.event_hooks = {'request': [_request_hook], 'response': [_response_hook]}
        outcome = ExtractionFlow(runtime=GroundedExtractionRuntime(model=extraction),
            verification_runtime=LangChainSourceVerificationRuntime(model=verification, verification_mode='nullable-proof-v3')).run(window)
        self.assertIsNone(outcome.failure_reason)
        fact, = outcome.accepted
        self.sdk_fact = fact
        self.assertEqual(len(wire.requests), 2)
        self.assertEqual([request[2]['tools'][0]['function']['name'] for request in wire.requests],
                         ['GroundedMemoryLabels', 'SourceVerificationOutput'])
        self.assertIs(fact.source_dependency_mode, SourceDependencyMode.ALL)
        self.assertEqual(fact.dimension_evidence.version, 4)
        self.assertEqual(fact.dimension_evidence.semantic_basis is not None, proof)
        return MemoryCandidate(candidate_id=uuid4(), scope=self.scope, text=fact.text,
            category=fact.category, topic=fact.topic, subject=fact.subject, source_ids=fact.source_message_ids,
            valid_at=fact.valid_at, invalid_at=fact.invalid_at, confidence=fact.confidence,
            risk_flags=fact.risk_flags, alternatives=fact.alternatives, interpretation_reason=fact.interpretation_reason,
            timing=fact.timing, dimension_evidence=fact.dimension_evidence, source_dependency_mode=fact.source_dependency_mode)

    def test_sdk_e2_same_v_v4_save_reads_and_auto_confirmation_rebind_current_sources(self):
        from notalone.memory.dimension_evidence import DimensionEvidenceChangedError
        candidate = self._sdk_candidate()
        saved = self.store.create_candidate(candidate)
        self.assertTrue(saved.dimension_evidence.source_bound)
        self.assertEqual(saved.dimension_evidence.to_payload(), candidate.dimension_evidence.to_payload())
        with self.assertRaises(MemoryPersistenceError):
            self.store.create_candidate(replace(candidate, candidate_id=uuid4(), source_dependency_mode=SourceDependencyMode.ANY))
        confirmed = self.store.confirm(scope=self.scope, candidate_id=saved.candidate_id,
            expected_dimension_evidence=saved.dimension_evidence)
        self.assertIs(confirmed.source_dependency_mode, SourceDependencyMode.ALL)
        second = self.store.create_candidate(replace(candidate, candidate_id=uuid4()))
        with psycopg.connect(self.url) as connection:
            connection.execute("UPDATE public.message SET text_content='我刚刚到家。' WHERE id=%s", (candidate.source_ids[0],))
        # 旧source_bound不能跨写入或确认事务取得信用。
        with self.assertRaises(DimensionEvidenceChangedError):
            self.store.create_candidate(replace(candidate, candidate_id=uuid4()))
        with self.assertRaises(DimensionEvidenceChangedError):
            self.store.confirm(scope=self.scope, candidate_id=second.candidate_id,
                expected_dimension_evidence=second.dimension_evidence)
        read = self.store.get_candidate(scope=self.scope, candidate_id=second.candidate_id)
        self.assertFalse(read.dimension_evidence.source_bound)
        self.assertIs(read.source_dependency_mode, SourceDependencyMode.ALL)

    def test_owner_all_rejects_raw_and_mixed_scope_and_missing_capability(self):
        from notalone.memory import OwnerMemory, MemoryTopic, ConfirmedMemoryStatus
        from notalone.persistence.owner_memory_store import OwnerMemoryPersistenceError
        _, foreign = self._source('不同联系人来源。', contact=self.other)
        memory = OwnerMemory(memory_id=uuid4(), owner_id=self.scope.owner_id, text='合成本人资料',
            category=MemoryCategory.COMMON_FACT, topic=MemoryTopic.OTHER, status=ConfirmedMemoryStatus.ACTIVE,
            source_ids=(self.message, self.context), adoption_method=AdoptionMethod.MANUAL,
            source_dependency_mode=SourceDependencyMode.ALL)
        for sources in ((self.source,), (self.scope.owner_id,), (self.message, foreign)):
            with self.subTest(sources=sources), self.assertRaises(PermissionError):
                self.owner_store.create(replace(memory, source_ids=sources))
        with psycopg.connect(self.url) as connection:
            connection.execute('ALTER TABLE public.owner_memory DROP CONSTRAINT owner_memory_source_dependency_mode_check')
        with self.assertRaises(MemoryPersistenceError):
            self.store.create_candidate(self._candidate())
        with self.assertRaises(OwnerMemoryPersistenceError):
            self.owner_store.create(memory)
        self.assertEqual(self.owner_store.list_active(self.scope.owner_id), ())
        # 迁移能力不足不会阻塞旧ANY独立手动录入。
        old = self.owner_store.create(replace(memory, source_dependency_mode=SourceDependencyMode.ANY, source_ids=(self.scope.owner_id,)))
        self.assertIs(old.source_dependency_mode, SourceDependencyMode.ANY)

    def test_owner_sdk_v4_confirmation_rebinds_the_stored_mode_and_evidence(self):
        from notalone.memory.dimension_evidence import DimensionEvidenceChangedError
        candidate = self._sdk_candidate(speaker='user')
        saved = self.store.create_candidate(candidate)
        # 调用方的旧DTO不能覆盖数据库当前模式。
        confirmed = self.owner_store.confirm_candidate(candidate=replace(saved, source_dependency_mode=SourceDependencyMode.ANY), adoption_method=AdoptionMethod.AUTO)
        self.assertIs(confirmed.source_dependency_mode, SourceDependencyMode.ALL)
        second = self.store.create_candidate(replace(candidate, candidate_id=uuid4()))
        with psycopg.connect(self.url) as connection:
            connection.execute("UPDATE public.message_source_ref SET raw_payload=%s WHERE message_id=%s", (Jsonb({'text': '已改变的合成来源。'}), candidate.source_ids[0]))
        with self.assertRaises(DimensionEvidenceChangedError):
            self.owner_store.confirm_candidate(candidate=second, adoption_method=AdoptionMethod.AUTO)
        current = self.store.get_candidate(scope=self.scope, candidate_id=second.candidate_id)
        self.assertEqual(current.status.value, 'pending')
        self.assertIs(current.source_dependency_mode, SourceDependencyMode.ALL)

    def test_sdk_fact_adoption_reuses_only_the_same_current_all_candidate(self):
        from notalone.memory_extraction.adoption import MemoryAdoption
        from notalone.memory_extraction.flow import ExtractionOutcome
        self._sdk_candidate()
        fact = self.sdk_fact
        adoption = MemoryAdoption(memory_port=self.store, owner_memory_port=self.owner_store)
        self.assertEqual(adoption.adopt(self.scope, ExtractionOutcome((fact,))).pending, 1)
        saved, = self.store.list_pending_candidates(self.scope)
        self.assertIs(saved.source_dependency_mode, SourceDependencyMode.ALL)
        self.assertEqual(adoption.adopt(self.scope, ExtractionOutcome((fact,))).skipped_duplicate, 1)
        self.store.confirm(scope=self.scope, candidate_id=saved.candidate_id, adoption_method=AdoptionMethod.MANUAL)
        self.assertEqual(adoption.adopt(self.scope, ExtractionOutcome((fact,))).skipped_duplicate, 1)
        with psycopg.connect(self.url) as connection:
            connection.execute('UPDATE public.memory_candidate SET dimension_evidence=NULL WHERE id=%s', (saved.candidate_id,))
        stats = adoption.adopt(self.scope, ExtractionOutcome((fact,)))
        self.assertEqual((stats.pending, stats.skipped_duplicate), (1, 0))
        pending, = self.store.list_pending_candidates(self.scope)
        self.assertIs(pending.source_dependency_mode, SourceDependencyMode.ALL)

    def _assert_manual_stale_preserves_all_until_source_deletion(self, speaker):
        from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
        candidate = self._sdk_candidate(speaker=speaker)
        saved = self.store.create_candidate(candidate)
        with psycopg.connect(self.url) as connection:
            source_id, = connection.execute('SELECT source_document_id FROM public.message_source_ref WHERE message_id=%s', (saved.source_ids[0],)).fetchone()
            connection.execute("UPDATE public.message SET text_content='我刚刚到家。' WHERE id=%s", (saved.source_ids[0],))
        current = self.store.get_candidate(scope=self.scope, candidate_id=saved.candidate_id)
        self.assertFalse(current.dimension_evidence.source_bound)
        from notalone.memory.correction import MemoryCorrectionConflictError
        # 现行冻结世代门同时保护人工确认，旧正文变化不能沿新ALL协议绕过。
        with self.assertRaises(MemoryCorrectionConflictError):
            if speaker == 'user':
                self.owner_store.confirm_candidate(candidate=saved, adoption_method=AdoptionMethod.MANUAL)
            else:
                self.store.confirm(scope=self.scope, candidate_id=saved.candidate_id, adoption_method=AdoptionMethod.MANUAL)
        current = self.store.get_candidate(scope=self.scope, candidate_id=saved.candidate_id)
        self.assertIs(current.source_dependency_mode, SourceDependencyMode.ALL)
        self.assertEqual(current.source_ids, saved.source_ids)
        self.assertFalse(current.dimension_evidence.source_bound)
        PostgresSourceDeletionRepository(self.url).delete_source(owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id, source_document_id=source_id)
        with self.assertRaises(LookupError):
            self.store.get_candidate(scope=self.scope, candidate_id=saved.candidate_id)
        with psycopg.connect(self.url) as connection:
            for table in ('owner_memory', 'confirmed_memory'):
                self.assertEqual(connection.execute(sql.SQL('SELECT count(*) FROM public.{} WHERE source_candidate_id=%s').format(sql.Identifier(table)), (saved.candidate_id,)).fetchone(), (0,))

    def test_contact_manual_stale_keeps_all_and_remains_physically_deletable(self):
        self._assert_manual_stale_preserves_all_until_source_deletion('contact')

    def test_owner_manual_stale_keeps_all_and_remains_physically_deletable(self):
        self._assert_manual_stale_preserves_all_until_source_deletion('user')

    def test_owner_same_current_all_snapshot_can_reuse_confirmed_pool(self):
        from notalone.memory_extraction.adoption import MemoryAdoption
        from notalone.memory_extraction.flow import ExtractionOutcome
        self._sdk_candidate(speaker='user')
        fact = self.sdk_fact
        adoption = MemoryAdoption(memory_port=self.store, owner_memory_port=self.owner_store)
        self.assertEqual(adoption.adopt(self.scope, ExtractionOutcome((fact,))).pending, 1)
        saved, = self.store.list_pending_candidates(self.scope)
        memory = self.owner_store.confirm_candidate(candidate=saved, adoption_method=AdoptionMethod.MANUAL)
        self.assertIs(memory.source_dependency_mode, SourceDependencyMode.ALL)
        self.assertEqual(adoption.adopt(self.scope, ExtractionOutcome((fact,))).skipped_duplicate, 1)
        with psycopg.connect(self.url) as connection:
            connection.execute('UPDATE public.memory_candidate SET dimension_evidence=NULL WHERE id=%s', (saved.candidate_id,))
        self.assertEqual(adoption.adopt(self.scope, ExtractionOutcome((fact,))).pending, 1)
