"""实际候选携入的来源及样本删除；仅隔离PG与合成数据。"""

from __future__ import annotations

import unittest
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from notalone.application.assistant_candidate_carry import CarryAssistantCandidate
from notalone.application.assistant_session_service import AssistantSessionPersistenceError
from notalone.application.style_sample_service import SaveStyleSample, StyleSampleDeleted
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

    def test_sample_delete_physically_erases_no_turn_carry_and_keeps_later_independent_input(self) -> None:
        raw_source, raw_message = self.a._source()
        sample = self.fixture.samples.save(self.a.scope, SaveStyleSample(
            uuid4(), "合成表达参考：这次就先这样。", "manual",
        ))
        candidate, request_id, _ = self.a._complete(
            style_references=self.fixture.samples.select_references(self.a.scope),
        )
        carried = self._carry(candidate.candidate_id)
        later = self._carry(candidate.candidate_id)
        marker = "合成后来独立要求：另找时间确认。"
        independent = self.a.sessions.record_discussion_input(
            self.a.scope, later.session_id,
            {"type": "purpose_exploration", "purpose_hint": marker},
        )
        before = self.a.sessions.read_session(self.a.scope, later.session_id)
        self.assertEqual(before.inputs[0].state, "active")
        self.assertEqual(self.a.sessions.read_session(self.a.scope, carried.session_id)
                         .inputs[0].content["messages"],
                         [{"message_id": str(message.message_id), "text": message.text}
                          for message in candidate.message_group])
        with psycopg.connect(support.support.DATABASE_URL) as connection:
            dependencies = connection.execute(
                "SELECT turn_id,dependency_ids FROM public.assistant_session_input WHERE id=%s",
                (carried.input_version_id,),
            ).fetchone()
        self.assertEqual(dependencies, (None, []))

        self.fixture.samples.delete(self.a.scope, sample.sample_id)

        self.assertEqual(self._stored_carry(carried), ("redacted", None, None))
        self.assertEqual(self._stored_carry(later), ("redacted", None, independent))
        self.assertIsNone(self.fixture._row(request_id))
        after = self.a.sessions.read_session(self.a.scope, later.session_id)
        self.assertEqual(after.current_input_version_id, independent)
        self.assertEqual(after.inputs[1], before.inputs[1])
        self.assertEqual(after.inputs[0].state, "redacted")
        self.assertIsNone(after.inputs[0].content)
        with psycopg.connect(support.support.DATABASE_URL) as connection:
            self.assertEqual(connection.execute(
                "SELECT status FROM public.source_document WHERE id=%s", (raw_source,),
            ).fetchone(), ("active",))
            self.assertIsNotNone(connection.execute(
                "SELECT 1 FROM public.message WHERE id=%s", (raw_message,),
            ).fetchone())

    def test_source_delete_erases_no_turn_carry_and_keeps_independent_saved_sample(self) -> None:
        source = self.a._source()
        candidate, request_id, _ = self.a._complete(source=source)
        carried = self._carry(candidate.candidate_id)
        derived = self.fixture.samples.save(self.a.scope, SaveStyleSample(
            uuid4(), "合成从候选主动保存的最终表达。", "candidate", candidate.candidate_id,
        ))
        independent = self.fixture.samples.save(self.a.scope, SaveStyleSample(
            uuid4(), "合成独立手工表达。", "manual",
        ))

        self.a._delete_source(source[0])

        self.assertEqual(self._stored_carry(carried), ("redacted", None, None))
        self.assertIsNone(self.fixture._row(request_id))
        after = self.a.sessions.read_session(self.a.scope, carried.session_id)
        self.assertEqual(after.inputs[0].state, "redacted")
        self.assertIsNone(after.inputs[0].content)
        self.assertIsNone(after.current_input_version_id)
        with self.assertRaises(StyleSampleDeleted):
            self.fixture.samples.read(self.a.scope, derived.sample_id)
        self.assertEqual(self.fixture.samples.read(self.a.scope, independent.sample_id), independent)
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
            "SELECT id,xmin::text,status,final_text,source_ids,dependency_sample_ids FROM public.style_sample",
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
        sample = self.fixture.samples.save(self.a.scope, SaveStyleSample(
            uuid4(), "合成仍有效的表达参考。", "manual",
        ))
        candidate, _, _ = self.a._complete(
            source=source if kind == "source" else None,
            style_references=self.fixture.samples.select_references(self.a.scope),
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
            if kind == "sample":
                self.fixture.samples.delete(self.a.scope, sample.sample_id)
            else:
                self.a._delete_source(source[0])

        self.assertEqual(self._storage_snapshot(), before)
        self.assertEqual(self.fixture.samples.read(self.a.scope, sample.sample_id), sample)
        with psycopg.connect(support.support.DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.assistant_session_input SET content=%s WHERE owner_id=%s AND id=%s",
                (Jsonb(origin), self.a.owner_id, carried.input_version_id),
            )
        if kind == "sample":
            self.fixture.samples.delete(self.a.scope, sample.sample_id)
        else:
            self.a._delete_source(source[0])
        self.assertEqual(self._stored_carry(carried), ("redacted", None, None))

    def test_corrupted_carry_rejects_sample_delete_before_any_erasure_and_retry_succeeds(self) -> None:
        self._assert_corrupted_carry_delete_rolls_back("sample")

    def test_corrupted_carry_rejects_source_delete_and_rolls_back_source_message_and_inputs(self) -> None:
        self._assert_corrupted_carry_delete_rolls_back("source")
