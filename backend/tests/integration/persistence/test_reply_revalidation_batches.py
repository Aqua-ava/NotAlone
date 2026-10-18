"""公开检索／回复上下文上的合成批量复验与数据库读取预算。"""

from __future__ import annotations

import unittest
from collections import Counter
from dataclasses import replace
from unittest.mock import patch
from uuid import uuid4

import psycopg

from notalone.persistence import PostgresMemoryStore, PostgresRetrieval
from notalone.memory import MemoryCandidate, MemoryCategory
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.reply.context import ReplyContextInvariantError, RetrievalReplyContext
from notalone.reply.interface import ConfirmedDirection, DirectionSource, GenerateReply, ReplyToMessage
from notalone.scopes import ContactScope, VerifiedConversationScope
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture


class ReadMetrics:
    """在数据库连接边界记录实际 SQL 和取回行；不替换业务检索器。"""

    def __init__(self):
        self.queries = 0
        self.rows = Counter()
        self.connect = psycopg.connect

    def __call__(self, *args, **kwargs):
        return MeasuredConnection(self.connect(*args, **kwargs), self)


class MeasuredConnection:
    def __init__(self, connection, metrics):
        self.connection, self.metrics = connection, metrics

    def __getattr__(self, name):
        return getattr(self.connection, name)

    def __enter__(self):
        self.connection.__enter__()
        return self

    def __exit__(self, *args):
        return self.connection.__exit__(*args)

    def execute(self, statement, *args, **kwargs):
        self.metrics.queries += 1
        return MeasuredCursor(self.connection.execute(statement, *args, **kwargs),
                              self.metrics, str(statement))


class MeasuredCursor:
    def __init__(self, cursor, metrics, statement):
        self.cursor, self.metrics, self.statement = cursor, metrics, statement

    def __getattr__(self, name):
        return getattr(self.cursor, name)

    def fetchall(self):
        rows = self.cursor.fetchall()
        self.record(rows)
        return rows

    def fetchone(self):
        row = self.cursor.fetchone()
        self.record([row] if row is not None else [])
        return row

    def record(self, rows):
        for row in rows:
            if not isinstance(row, dict):
                continue
            for column, table in (("memory_text", "confirmed_memory"),
                                  ("text_content", "owner_memory"),
                                  ("candidate_text", "memory_candidate"),
                                  ("retrieved_text", "message")):
                if column in row and ("memory_id" in row or "candidate_id" in row or "message_id" in row):
                    self.metrics.rows[table] += 1
                    break


class ReplyRevalidationBatchTest(CoreBusinessFlowFixture, unittest.TestCase):
    def setUp(self):
        self.owner_id, self.contact_id, self.source_id = uuid4(), uuid4(), uuid4()
        self.scope = ContactScope(self.owner_id, self.contact_id)
        self.retrieval = PostgresRetrieval(self.database_url,
            owner_memory_store=PostgresOwnerMemoryStore(self.database_url))
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES (%s,'合成批量用户')", (self.owner_id,))
            connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,'合成批量联系人')",
                               (self.owner_id, self.contact_id))
            connection.execute("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count,status) "
                "VALUES (%s,%s,%s,'manual','synthetic.txt',%s,1,'active')",
                (self.source_id, self.owner_id, self.contact_id, 'a' * 64))
        self.addCleanup(self.remove_owner)

    def remove_owner(self):
        with psycopg.connect(self.database_url) as connection:
            if connection.info.dbname != self.database_name or not self.database_name.endswith('_test'):
                raise RuntimeError('批量复验只清理本轮专用测试库。')
            connection.execute("TRUNCATE public.owner CASCADE")

    def seed(self, count):
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.confirmed_memory(owner_id,contact_id,text_content,category,source_ids,adoption_method) "
                "SELECT %s,%s,'合成偏好' || value,'preference',ARRAY[%s]::uuid[],'manual' FROM generate_series(1,%s) value",
                (self.owner_id, self.contact_id, self.source_id, count))

    def seed_other_tracks(self, count):
        template = PostgresMemoryStore(self.database_url).create_candidate(MemoryCandidate(
            uuid4(), self.scope, f'合成偏好模板{count}', MemoryCategory.PREFERENCE, (self.source_id,)))
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.owner_memory(id,owner_id,text_content,category,source_ids,adoption_method) "
                "SELECT gen_random_uuid(),%s,'合成偏好' || value,'preference',ARRAY[%s]::uuid[],'manual' FROM generate_series(1,%s) value",
                (self.owner_id, self.source_id, count))
            connection.execute("INSERT INTO public.memory_candidate(owner_id,contact_id,text_content,category,source_ids,correction_evidence) "
                "SELECT %s,%s,'合成偏好' || value,'preference',ARRAY[%s]::uuid[],template.correction_evidence "
                "FROM generate_series(1,%s) value CROSS JOIN public.memory_candidate template WHERE template.id=%s",
                (self.owner_id, self.contact_id, self.source_id, count - 1, template.candidate_id))

    def prepare_context(self):
        message_ids = (uuid4(), uuid4())
        with psycopg.connect(self.database_url) as connection:
            for message_id in message_ids:
                connection.execute("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content) "
                    "VALUES (%s,%s,%s,'contact','text','合成偏好')", (message_id, self.owner_id, self.contact_id))
                connection.execute("INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) "
                    "VALUES (%s,%s,%s,'source_document',%s,%s,'{}'::jsonb)",
                    (message_id, self.owner_id, self.contact_id, self.source_id, str(message_id)))
        binding_id = uuid4()
        command = GenerateReply(idempotency_key=uuid4(), scope=self.scope, conversation_binding_id=binding_id,
            content=ReplyToMessage(message_ids[0], ConfirmedDirection('合成偏好', DirectionSource.DIRECT_INPUT)))
        context = RetrievalReplyContext(retrieval=self.retrieval, skill_library_revision=1,
                                       message_limit=2, memory_limit=4, owner_memory_limit=3, pending_limit=2)
        snapshot = context.build(command=command,
            verified_scope=VerifiedConversationScope(self.owner_id, self.contact_id, binding_id))
        self.assertEqual(Counter(item.kind for item in snapshot.evidence),
            {'message': 2, 'confirmed_memory': 4, 'owner_memory': 3, 'pending_candidate': 2})
        return context, snapshot

    def test_explicit_memory_ids_only_fetch_requested_rows(self):
        self.seed(100)
        expected = self.retrieval.search_confirmed_memories(scope=self.scope, limit=4)
        metrics = ReadMetrics()
        with patch("psycopg.connect", metrics):
            actual = self.retrieval.search_confirmed_memories(scope=self.scope, limit=4,
                memory_ids=tuple(item.memory_id for item in expected))
        self.assertEqual(actual, expected)
        self.assertEqual(metrics.rows['confirmed_memory'], 4, metrics.rows)

    def test_historical_id_reads_exact_version_without_ancestor_rows(self):
        self.seed(4)
        memories = self.retrieval.search_confirmed_memories(scope=self.scope, limit=4)
        with psycopg.connect(self.database_url) as connection:
            for current, previous in zip(memories[1:], memories):
                connection.execute('UPDATE public.confirmed_memory SET supersedes_memory_id=%s WHERE id=%s',
                                   (previous.memory_id, current.memory_id))
            connection.execute("UPDATE public.confirmed_memory SET status='invalidated',retirement_reason='state_changed' WHERE id=%s",
                               (memories[-1].memory_id,))
        metrics = ReadMetrics()
        with patch('psycopg.connect', metrics):
            actual = self.retrieval.search_confirmed_memories(scope=self.scope, limit=1,
                memory_ids=(memories[-1].memory_id,), include_historical=True)
        self.assertEqual([(item.memory_id, item.text, item.status) for item in actual],
                         [(memories[-1].memory_id, memories[-1].text, 'invalidated')])
        self.assertEqual(metrics.rows['confirmed_memory'], 1, metrics.rows)

    def test_eleven_evidence_rows_have_constant_read_budget_as_pools_grow(self):
        self.seed(100)
        self.seed_other_tracks(100)
        context, snapshot = self.prepare_context()
        previous = 100
        for size in (100, 1000, 10000):
            with self.subTest(pool_size=size):
                if size > previous:
                    self.seed(size - previous)
                    self.seed_other_tracks(size - previous)
                previous = size
                metrics = ReadMetrics()
                with patch('psycopg.connect', metrics):
                    context.validate_current(snapshot)
                print(f'合成复验 pool={size} evidence=11 queries={metrics.queries} rows={dict(metrics.rows)}', flush=True)
                self.assertEqual(dict(metrics.rows), {'message': 2, 'confirmed_memory': 4,
                    'owner_memory': 3, 'memory_candidate': 2})
                self.assertLessEqual(metrics.queries, 35)

    def test_batch_reads_keep_scope_and_empty_id_filters(self):
        self.seed(4)
        self.seed_other_tracks(3)
        memories = self.retrieval.search_confirmed_memories(scope=self.scope)
        identifiers = tuple(item.memory_id for item in memories)
        for scope in (ContactScope(self.owner_id, uuid4()), ContactScope(uuid4(), self.contact_id)):
            with self.subTest(scope=scope):
                self.assertEqual(self.retrieval.search_confirmed_memories(scope=scope, memory_ids=identifiers), ())
                self.assertEqual(self.retrieval.search_confirmed_memories(scope=scope,
                    memory_ids=identifiers, include_historical=True), ())
                self.assertEqual(self.retrieval.search_pending_candidates(scope=scope,
                    candidate_ids=tuple(item.candidate_id for item in self.retrieval.search_pending_candidates(scope=self.scope))), ())
        owners = self.retrieval.search_owner_memories(owner_id=self.owner_id)
        self.assertEqual(self.retrieval.search_owner_memories(owner_id=uuid4(),
            memory_ids=tuple(item.memory_id for item in owners)), ())
        for method, arguments in ((self.retrieval.search_confirmed_memories, {'scope': self.scope, 'memory_ids': ()}),
                                  (self.retrieval.search_owner_memories, {'owner_id': self.owner_id, 'memory_ids': ()}),
                                  (self.retrieval.search_pending_candidates, {'scope': self.scope, 'candidate_ids': ()}),
                                  (self.retrieval.search_messages, {'scope': self.scope, 'message_ids': ()})):
            self.assertEqual(method(**arguments), ())

    def test_new_validation_boundary_rereads_all_four_evidence_tracks(self):
        self.seed(4)
        self.seed_other_tracks(3)
        context, snapshot = self.prepare_context()
        context.validate_current(snapshot)
        cases = (
            ('confirmed_memory', 'confirmed_memory', 'revision=revision+1', 'revision=revision-1'),
            ('owner_memory', 'owner_memory', 'revision=revision+1', 'revision=revision-1'),
            ('pending_candidate', 'memory_candidate', "status='rejected'", "status='pending'"),
            ('message', 'message', "text_content='已变更合成正文'", "text_content='合成偏好'"),
        )
        for kind, table, change, restore in cases:
            evidence = next(item for item in snapshot.evidence if item.kind == kind)
            with self.subTest(kind=kind):
                with psycopg.connect(self.database_url) as connection:
                    connection.execute(f'UPDATE public.{table} SET {change} WHERE id=%s', (evidence.evidence_id,))
                try:
                    with self.assertRaises(ReplyContextInvariantError):
                        context.validate_current(snapshot)
                finally:
                    with psycopg.connect(self.database_url) as connection:
                        connection.execute(f'UPDATE public.{table} SET {restore} WHERE id=%s', (evidence.evidence_id,))
        forged = tuple(replace(item, selection_reason='已确认') if item.kind == 'pending_candidate' else item
                       for item in snapshot.evidence)
        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(replace(snapshot, evidence=forged))
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET status='deleting' WHERE id=%s", (self.source_id,))
        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(snapshot)
