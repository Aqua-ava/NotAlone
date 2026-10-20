"""实际候选携入的来源删除；仅隔离PG与合成数据。"""

from __future__ import annotations

import unittest
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from notalone.application.assistant_candidate_carry import CarryAssistantCandidate
from notalone.application.assistant_session_service import AssistantSessionPersistenceError
from notalone.persistence.assistant_candidate_versions import PostgresAssistantCandidateVersions
from notalone.persistence.assistant_session_catalog import PostgresAssistantSessionCatalog
from notalone.persistence.outbound_ledger import PostgresOutboundLedger
from tests.integration.persistence import test_reply_discussion_dependencies as support


class ReplyCandidateCarryCleanupTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        support.ReplyDiscussionDependenciesTest.setUpClass()

    def setUp(self) -> None:
        self.fixture = support.ReplyDiscussionDependenciesTest()
        self.addCleanup(self._release_fixture)
        self.fixture.setUp()
        self.a = self.fixture.fixture
        self.catalog = PostgresAssistantSessionCatalog(support.support.DATABASE_URL)
        self.versions = PostgresAssistantCandidateVersions(support.support.DATABASE_URL)

    def _release_fixture(self) -> None:
        if not self.fixture.doCleanups():
            raise RuntimeError("合成候选携入删除夹具清理失败。")

    def tearDown(self) -> None:
        self.assertEqual(PostgresOutboundLedger(support.support.DATABASE_URL)
                         .summarize_by_owner(self.a.owner_id).total_calls, 0)

    def _carry(self, candidate_id):
        selected = self.versions.select(
            self.a.scope, self.a.session_id, candidate_id, candidate_id, uuid4(),
        )
        return self.catalog.new_with_candidate(
            self.a.scope, self.a.session_id,
            CarryAssistantCandidate(selected.selection_id, candidate_id, candidate_id),
        )

    def _stored_carry(self, carried):
        with psycopg.connect(support.support.DATABASE_URL) as connection:
            return connection.execute(
                "SELECT input.state,input.content,session.current_input_version_id "
                "FROM public.assistant_session_input AS input "
                "JOIN public.assistant_session AS session ON session.id=input.session_id "
                "AND session.owner_id=input.owner_id AND session.contact_id=input.contact_id "
                "WHERE input.owner_id=%s AND input.contact_id=%s AND input.id=%s",
                (self.a.owner_id, self.a.contact_id, carried.input_version_id),
            ).fetchone()


    def test_source_delete_erases_no_turn_carry(self) -> None:
        source = self.a._source()
        candidate, request_id, _ = self.a._complete(source=source)
        carried = self._carry(candidate.candidate_id)

        self.a._delete_source(source[0])

        self.assertEqual(self._stored_carry(carried), ("redacted", None, None))
        self.assertIsNone(self.fixture._row(request_id))
        after = self.a.sessions.read_session(self.a.scope, carried.session_id)
        self.assertEqual(after.inputs[0].state, "redacted")
        self.assertIsNone(after.inputs[0].content)
        self.assertIsNone(after.current_input_version_id)
        with psycopg.connect(support.support.DATABASE_URL) as connection:
            self.assertIsNone(connection.execute(
                "SELECT 1 FROM public.message WHERE id=%s", (source[1],),
            ).fetchone())

    def _storage_snapshot(self):
        queries = (
            "SELECT id,xmin::text,state,content FROM public.assistant_session_input",
            "SELECT id,xmin::text,state,input_payload,reply_request_id FROM public.assistant_session_turn",
            "SELECT id,xmin::text,current_input_version_id FROM public.assistant_session",
            "SELECT id,xmin::text,state,context_snapshot FROM public.reply_request",
            "SELECT id,xmin::text,status,deletion_operation_id FROM public.source_document",
            "SELECT id,xmin::text,text_content FROM public.message",
        )
        with psycopg.connect(support.support.DATABASE_URL) as connection:
            rows = tuple(connection.execute(query + " WHERE owner_id=%s AND contact_id=%s ORDER BY id",
                                            (self.a.owner_id, self.a.contact_id)).fetchall()
                         for query in queries)
            return rows + (connection.execute(
                "SELECT message_id,xmin::text,source_document_id,source_locator "
                "FROM public.message_source_ref WHERE owner_id=%s AND contact_id=%s ORDER BY message_id",
                (self.a.owner_id, self.a.contact_id),
            ).fetchall(),)

    def _assert_corrupted_carry_delete_rolls_back(self, kind: str) -> None:
        source = self.a._source()
        candidate, _, _ = self.a._complete(
            source=source if kind == "source" else None,
        )
        carried = self._carry(candidate.candidate_id)
        with psycopg.connect(support.support.DATABASE_URL) as connection:
            origin = connection.execute(
                "SELECT content FROM public.assistant_session_input WHERE owner_id=%s AND id=%s",
                (self.a.owner_id, carried.input_version_id),
            ).fetchone()[0]
            connection.execute(
                "UPDATE public.assistant_session_input SET content=%s WHERE owner_id=%s AND id=%s",
                (Jsonb({**origin, "payload_sha256": "f" * 64}), self.a.owner_id, carried.input_version_id),
            )
        before = self._storage_snapshot()

        with self.assertRaises(AssistantSessionPersistenceError):
            self.a._delete_source(source[0])

        self.assertEqual(self._storage_snapshot(), before)
        with psycopg.connect(support.support.DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.assistant_session_input SET content=%s WHERE owner_id=%s AND id=%s",
                (Jsonb(origin), self.a.owner_id, carried.input_version_id),
            )
        self.a._delete_source(source[0])
        self.assertEqual(self._stored_carry(carried), ("redacted", None, None))


    def test_corrupted_carry_rejects_source_delete_and_rolls_back_source_message_and_inputs(self) -> None:
        self._assert_corrupted_carry_delete_rolls_back("source")
