"""物理来源及样本删除消费A捕获闭包；只使用隔离PG和合成资料。"""

from __future__ import annotations

import unittest
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from notalone.application.style_sample_service import SaveStyleSample
from notalone.persistence.assistant_candidate_versions import (
    EditAssistantCandidate, PostgresAssistantCandidateVersions,
)
from notalone.persistence.assistant_session_catalog import PostgresAssistantSessionCatalog
from notalone.persistence.outbound_ledger import PostgresOutboundLedger
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.interface import CandidateMessage
from tests.integration.persistence import test_reply_discussion_dependencies as support


class ReplyCapturedInputCleanupTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        support.ReplyDiscussionDependenciesTest.setUpClass()

    def setUp(self) -> None:
        self.fixture = support.ReplyDiscussionDependenciesTest()
        self.addCleanup(self._release_fixture)
        self.fixture.setUp()
        self.a = self.fixture.fixture

    def _release_fixture(self) -> None:
        if not self.fixture.doCleanups():
            raise RuntimeError("合成物理删除夹具清理失败。")

    def tearDown(self) -> None:
        self.assertEqual(PostgresOutboundLedger(support.support.DATABASE_URL)
                         .summarize_by_owner(self.a.owner_id).total_calls, 0)

    def test_source_delete_erases_actual_captured_child_and_keeps_later_independent_input(self) -> None:
        source_id, message_id = self.a._source()
        root = self.a._discussion("合成来源关联的历史讨论。", dependencies=(message_id,))
        child = self.fixture._prepare(relationship=False)
        result = self.fixture._save(child)
        independent = self.a._discussion("生成之后新建的独立讨论。")

        self.a._delete_source(source_id)

        self.fixture._assert_erased_turn(child)
        self.assertIsNone(self.fixture._row(result.reply_request_id))
        after = self.a.sessions.read_session(self.a.scope, self.a.session_id)
        self.assertEqual(after.current_input_version_id, independent)
        self.assertEqual({item.input_version_id for item in after.inputs if item.state == "redacted"},
                         {root, child[3].assistant_discussion.current_input_version_id})
        self.assertEqual([item.content["requirements"] for item in after.inputs if item.state == "active"],
                         ["生成之后新建的独立讨论。"])

    def test_owner_memory_delete_physically_removes_captured_requests_without_direct_evidence(self) -> None:
        _, message_id = self.a._source()
        memory_id = uuid4()
        with psycopg.connect(support.support.DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner_memory(id,owner_id,text_content,category,source_ids,adoption_method) "
                "VALUES (%s,%s,'合成已主动确认的本人表达。','preference',%s,'manual')",
                (memory_id, self.a.owner_id, [message_id]),
            )
        root = self.a._discussion("通过合成本人记忆支持的历史讨论。", dependencies=(memory_id,))
        child = self.fixture._prepare(relationship=False)
        result = self.fixture._save(child)
        independent = self.a._discussion("删除本人记忆后仍保留的独立讨论。")

        PostgresOwnerMemoryStore(support.support.DATABASE_URL).delete(self.a.owner_id, memory_id)

        self.fixture._assert_erased_turn(child)
        self.assertIsNone(self.fixture._row(result.reply_request_id))
        after = self.a.sessions.read_session(self.a.scope, self.a.session_id)
        self.assertEqual(after.current_input_version_id, independent)
        self.assertEqual({item.input_version_id for item in after.inputs if item.state == "redacted"},
                         {root, child[3].assistant_discussion.current_input_version_id})
        self.assertEqual([item.content["requirements"] for item in after.inputs if item.state == "active"],
                         ["删除本人记忆后仍保留的独立讨论。"])

    def test_public_source_delete_keeps_independent_running_input_and_erases_actual_captured_input(self) -> None:
        source = self.a._source()
        self.a._complete(source=source)
        affected = self.fixture._prepare(relationship=False)
        source_session = self.a.session_id
        independent_session = PostgresAssistantSessionCatalog(support.support.DATABASE_URL).new(self.a.scope)
        self.a.session_id = independent_session
        try:
            independent = self.fixture._prepare(relationship=False)
        finally:
            self.a.session_id = source_session
        before = self.a.sessions.read_session(self.a.scope, independent_session)

        self.a._delete_source(source[0])

        self.fixture._assert_erased_turn(affected)
        self.assertIsNone(self.fixture._row(affected[2].request_id))
        self.assertIsNone(self.fixture._row(independent[2].request_id))
        after = self.a.sessions.read_session(self.a.scope, independent_session)
        self.assertEqual(after.turns[0].state, "failed")
        self.assertEqual(after.turns[0].input, before.turns[0].input)
        self.assertEqual(after.inputs, before.inputs)
        self.assertEqual(after.current_input_version_id, before.current_input_version_id)

    def _stored_bodies(self):
        with psycopg.connect(support.support.DATABASE_URL) as connection:
            return (
                connection.execute(
                    "SELECT id,xmin::text,state,input_payload,reply_request_id "
                    "FROM public.assistant_session_turn WHERE owner_id=%s ORDER BY id",
                    (self.a.owner_id,),
                ).fetchall(),
                connection.execute(
                    "SELECT id,xmin::text,state,content FROM public.assistant_session_input "
                    "WHERE owner_id=%s ORDER BY id", (self.a.owner_id,),
                ).fetchall(),
                connection.execute(
                    "SELECT id,xmin::text,state,context_snapshot FROM public.reply_request "
                    "WHERE owner_id=%s ORDER BY id", (self.a.owner_id,),
                ).fetchall(),
            )

    def test_sample_delete_revalidates_actual_captured_edited_version_before_any_erasure(self) -> None:
        sample = self.fixture.samples.save(self.a.scope, SaveStyleSample(
            uuid4(), "合成独立旧表达。", "manual",
        ))
        candidate, _, _ = self.a._complete(
            style_references=self.fixture.samples.select_references(self.a.scope),
        )
        versions = PostgresAssistantCandidateVersions(support.support.DATABASE_URL)
        edited = versions.edit(self.a.scope, self.a.session_id, candidate.candidate_id,
                               EditAssistantCandidate(
                                   uuid4(), candidate.candidate_id,
                                   tuple(CandidateMessage(message.message_id, message.text + "合成修改。")
                                         for message in candidate.message_group),
                                   "合成这一版要求。",
                               ))
        child = self.fixture._prepare(relationship=False)
        self.fixture._save(child)
        self.a._discussion("后续未被捕获的独立要求。")
        changed = [{"message_id": str(message.message_id), "text": message.text + "合成篡改。"}
                   for message in edited.versions[-1].messages]
        with psycopg.connect(support.support.DATABASE_URL) as connection:
            connection.execute("UPDATE public.assistant_candidate_version SET message_group=%s WHERE id=%s",
                               (Jsonb(changed), edited.default_display_version_id))
        before = self._stored_bodies()

        with self.assertRaises(ReplyStoreInvariantError):
            self.fixture.samples.delete(self.a.scope, sample.sample_id)

        self.assertEqual(self.fixture.samples.read(self.a.scope, sample.sample_id), sample)
        self.assertEqual(self._stored_bodies(), before)

    def test_source_delete_revalidates_captured_discussion_and_rolls_back_source_and_message(self) -> None:
        source_id, message_id = self.a._source()
        root = self.a._discussion("合成来源讨论的原正文。", dependencies=(message_id,))
        child = self.fixture._prepare(relationship=False)
        self.fixture._save(child)
        with psycopg.connect(support.support.DATABASE_URL) as connection:
            connection.execute("UPDATE public.assistant_session_input SET content=%s WHERE id=%s",
                               (Jsonb({"type": "purpose_exploration", "purpose_hint": "合成邀请",
                                       "requirements": "捕获之后篡改的合成正文。"}), root))
            source_before = connection.execute(
                "SELECT xmin::text,status,deletion_operation_id FROM public.source_document WHERE id=%s",
                (source_id,),
            ).fetchone()
            ref_before = connection.execute("SELECT xmin::text,raw_payload FROM public.message_source_ref "
                                            "WHERE message_id=%s", (message_id,)).fetchall()
        before = self._stored_bodies()

        with self.assertRaises(ReplyStoreInvariantError):
            self.a._delete_source(source_id)

        self.assertEqual(self._stored_bodies(), before)
        with psycopg.connect(support.support.DATABASE_URL) as connection:
            self.assertEqual(connection.execute(
                "SELECT xmin::text,status,deletion_operation_id FROM public.source_document WHERE id=%s",
                (source_id,),
            ).fetchone(), source_before)
            self.assertEqual(connection.execute("SELECT xmin::text,raw_payload FROM public.message_source_ref "
                                                "WHERE message_id=%s", (message_id,)).fetchall(), ref_before)
            self.assertIsNotNone(connection.execute("SELECT 1 FROM public.message WHERE id=%s",
                                                    (message_id,)).fetchone())
