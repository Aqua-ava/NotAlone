"""真实C捕获身份进入A唯一删除闭包；仅用正式迁移和合成资料。"""

from __future__ import annotations

import unittest
from dataclasses import replace
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.persistence.assistant_candidate_versions import (
    EditAssistantCandidate, PostgresAssistantCandidateVersions,
)
from notalone.persistence.assistant_input_lineage import select_assistant_input_dependents
from notalone.persistence.assistant_session_catalog import PostgresAssistantSessionCatalog
from notalone.persistence.assistant_session_inputs import erase_assistant_source_inputs
from notalone.persistence.assistant_session_store import (
    erase_assistant_source_turns, select_assistant_source_input_dependents,
)
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.outbound_ledger import PostgresOutboundLedger
from notalone.persistence.reply_discussion_dependencies import captured_reply_discussion_uses
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.interface import CandidateMessage
from notalone.scopes import ContactScope
from tests.integration.persistence import test_reply_discussion_dependencies as support


class AssistantCapturedInputErasureTest(unittest.TestCase):
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
            raise RuntimeError("合成捕获删除夹具清理失败。")

    def tearDown(self) -> None:
        self.assertEqual(PostgresOutboundLedger(support.support.DATABASE_URL)
                         .summarize_by_owner(self.a.owner_id).total_calls, 0)

    def test_source_preselection_preserves_independent_scope_revoked_running_draft(self) -> None:
        source = self.a._source()
        _, source_request, source_turn = self.a._complete(source=source)
        affected = self.fixture._prepare(relationship=False)
        source_session = self.a.session_id
        independent_session = PostgresAssistantSessionCatalog(support.support.DATABASE_URL).new(self.a.scope)
        self.a.session_id = independent_session
        try:
            independent = self.fixture._prepare(relationship=False)
        finally:
            self.a.session_id = source_session
        before = self.a.sessions.read_session(self.a.scope, independent_session)
        request_ids = [source_request, affected[2].request_id, independent[2].request_id]

        with psycopg.connect(support.support.DATABASE_URL, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.a.owner_id)
            captures = captured_reply_discussion_uses(connection, self.a.scope)
            selected = select_assistant_source_input_dependents(
                connection, owner_id=self.a.owner_id, contact_id=self.a.contact_id,
                removed_ids=set(source), reply_request_ids=request_ids, captured_uses=captures,
            )
            erase_assistant_source_turns(
                connection, owner_id=self.a.owner_id, contact_id=self.a.contact_id,
                removed_ids=set(source), reply_request_ids=request_ids,
                turn_ids=list(selected.turn_ids), captured_uses=captures,
            )

        after = self.a.sessions.read_session(self.a.scope, independent_session)
        self.assertEqual(after.turns[0].state, "failed")
        self.assertEqual(after.turns[0].input, before.turns[0].input)
        self.assertEqual(after.inputs, before.inputs)
        self.assertEqual(after.current_input_version_id, before.current_input_version_id)
        self.assertEqual(set(selected.turn_ids), {source_turn, affected[1]})
        self.assertEqual(set(selected.reply_request_ids), {source_request, affected[2].request_id})
        affected_after = self.a.sessions.read_session(self.a.scope, source_session)
        self.assertTrue(all(turn.state == "redacted" and turn.input is None for turn in affected_after.turns))

    def test_real_captures_close_history_to_generation_and_keep_unconsumed_discussion(self) -> None:
        source_id, message_id = self.a._source()
        root = self.a._discussion("合成实际捕获的旧要求。", dependencies=(message_id,))
        first = self.fixture._prepare(relationship=False)
        self.fixture._save(first)
        independent = self.a._discussion("生成结束后新增的独立讨论。")

        with psycopg.connect(support.support.DATABASE_URL, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.a.owner_id)
            captures = captured_reply_discussion_uses(connection, self.a.scope)
            self.assertEqual(len(captures), 1)
            # C实际捕获raw根，不补写助手turn的历史消息依赖来掩盖缺边。
            dependencies = connection.execute(
                "SELECT dependency_ids FROM public.assistant_session_turn WHERE id=ANY(%s::uuid[])",
                ([first[1]],),
            ).fetchall()
            self.assertTrue(all(message_id not in row["dependency_ids"] for row in dependencies))
            selected = select_assistant_input_dependents(
                connection, owner_id=self.a.owner_id, contact_id=self.a.contact_id,
                removed_ids={message_id}, reply_request_ids=[], captured_uses=captures,
            )
            self.assertEqual(set(selected.input_version_ids), {
                root, first[3].assistant_discussion.current_input_version_id,
            })
            self.assertEqual(set(selected.turn_ids), {first[1]})
            self.assertEqual(set(selected.reply_request_ids), {first[2].request_id})
            erase_assistant_source_turns(
                connection, owner_id=self.a.owner_id, contact_id=self.a.contact_id,
                removed_ids={message_id}, reply_request_ids=[], captured_uses=captures,
            )

        after = self.a.sessions.read_session(self.a.scope, self.a.session_id)
        self.assertEqual(after.current_input_version_id, independent)
        self.assertEqual({item.input_version_id for item in after.inputs if item.state == "redacted"},
                         set(selected.input_version_ids))
        self.assertTrue(all(turn.state == "redacted" and turn.input is None for turn in after.turns))
        self.assertEqual([item.content["requirements"] for item in after.inputs if item.state == "active"],
                         ["生成结束后新增的独立讨论。"])

    def test_selected_input_without_turn_erases_current_without_falling_back(self) -> None:
        earlier = self.a._discussion("合成较早独立讨论。")
        selected = self.a._discussion("合成被明确选中的无turn输入。")
        with psycopg.connect(support.support.DATABASE_URL) as connection:
            lock_owner_scope(connection, owner_id=self.a.owner_id)
            erase_assistant_source_inputs(
                connection, owner_id=self.a.owner_id, removed_ids=set(), input_version_ids=(selected,),
            )
            erase_assistant_source_inputs(
                connection, owner_id=self.a.owner_id, removed_ids=set(), input_version_ids=(selected,),
            )
        after = self.a.sessions.read_session(self.a.scope, self.a.session_id)
        self.assertIsNone(after.current_input_version_id)
        self.assertEqual([(item.input_version_id, item.state) for item in after.inputs],
                         [(earlier, "active"), (selected, "redacted")])
        self.assertIsNone(after.inputs[1].content)

    def test_invalid_typed_capture_and_stale_discussion_hash_reject_and_roll_back(self) -> None:
        root = self.a._discussion("合成等待严格复验的讨论。")
        prepared = self.fixture._prepare(relationship=False)
        with psycopg.connect(support.support.DATABASE_URL) as connection:
            captured = captured_reply_discussion_uses(connection, self.a.scope)[0]
        identity = captured.snapshot.records[0]
        variants = {
            "untyped": ({"reply_request_id": captured.reply_request_id},),
            "foreign_owner": (replace(captured, snapshot=replace(captured.snapshot,
                scope=ContactScope(self.a.other_owner_id, self.a.contact_id))),),
            "foreign_contact": (replace(captured, snapshot=replace(captured.snapshot,
                scope=ContactScope(self.a.owner_id, self.a.other_contact_id))),),
            "missing_c_request": (replace(captured, reply_request_id=uuid4()),),
            "request_key": (replace(captured, request_key=uuid4()),),
            "session": (replace(captured, snapshot=replace(captured.snapshot, session_id=uuid4())),),
            "current_turn": (replace(captured, snapshot=replace(captured.snapshot, current_turn_id=uuid4())),),
            "current_hash": (replace(captured, snapshot=replace(captured.snapshot,
                current_payload_sha256="0" * 64)),),
            "history_hash": (replace(captured, snapshot=replace(captured.snapshot,
                records=(replace(identity, payload_sha256="0" * 64),))),),
        }
        before = self.a.sessions.read_session(self.a.scope, self.a.session_id)
        with psycopg.connect(support.support.DATABASE_URL) as connection:
            before_contact = connection.execute("SELECT display_name FROM public.contact WHERE id=%s",
                                                (self.a.contact_id,)).fetchone()
        for label, uses in variants.items():
            with self.subTest(label=label):
                with self.assertRaises(ReplyStoreInvariantError):
                    with psycopg.connect(support.support.DATABASE_URL, row_factory=dict_row) as connection:
                        lock_owner_scope(connection, owner_id=self.a.owner_id)
                        connection.execute("UPDATE public.contact SET display_name='合成应回滚的写入。' WHERE id=%s",
                                           (self.a.contact_id,))
                        erase_assistant_source_turns(
                            connection, owner_id=self.a.owner_id, contact_id=self.a.contact_id,
                            removed_ids=set(), reply_request_ids=[], turn_ids=[prepared[1]], captured_uses=uses,
                        )
                self.assertEqual(self.a.sessions.read_session(self.a.scope, self.a.session_id), before)
                with psycopg.connect(support.support.DATABASE_URL) as connection:
                    self.assertEqual(connection.execute("SELECT display_name FROM public.contact WHERE id=%s",
                                                        (self.a.contact_id,)).fetchone(), before_contact)
        self.assertEqual(root, identity.input_version_id)

    def test_actual_rebinding_keeps_legitimate_captured_history_with_its_own_binding(self) -> None:
        _, message_id = self.a._source()
        root = self.a._discussion("合成旧已确认绑定下的讨论。", dependencies=(message_id,))
        bindings = PostgresConversationBindingRepository(support.support.DATABASE_URL)
        bindings.revoke_binding(owner_id=self.a.owner_id, contact_id=self.a.contact_id,
                                binding_id=self.a.binding_id)
        self.a.binding_id = bindings.create_binding(
            owner_id=self.a.owner_id, contact_id=self.a.contact_id, channel="wechat",
            account_scope="synthetic-rebound-discussion", conversation_locator=f"synthetic-{uuid4()}",
        ).binding_id
        prepared = self.fixture._prepare(relationship=False)
        self.fixture._save(prepared)
        with psycopg.connect(support.support.DATABASE_URL, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.a.owner_id)
            captures = captured_reply_discussion_uses(connection, self.a.scope)
            selected = select_assistant_input_dependents(
                connection, owner_id=self.a.owner_id, contact_id=self.a.contact_id,
                removed_ids={message_id}, reply_request_ids=[], captured_uses=captures,
            )
        self.assertEqual(set(selected.input_version_ids),
                         {root, prepared[3].assistant_discussion.current_input_version_id})

    def test_old_completed_candidate_closes_after_source_delete_requested_without_current_guard(self) -> None:
        source = self.a._source()
        candidate, old_request, old_turn = self.a._complete(source=source)
        prepared = self.fixture._prepare(relationship=False)
        self.fixture._save(prepared)
        independent = self.a._discussion("历史读取后新增的无来源讨论。")
        self.assertFalse(self.a.sessions.is_current_input(
            self.a.scope, self.a.session_id, prepared[3].assistant_discussion.current_input_version_id,
        ))
        with psycopg.connect(support.support.DATABASE_URL, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.a.owner_id)
            captures = captured_reply_discussion_uses(connection, self.a.scope)
            self.assertEqual(len(captures), 1)
            self.assertEqual({item.kind for item in captures[0].snapshot.records},
                             {"generation_input", "candidate_version"})
            connection.execute("UPDATE public.source_document SET status='delete_requested' WHERE id=%s", (source[0],))
            selected = select_assistant_input_dependents(
                connection, owner_id=self.a.owner_id, contact_id=self.a.contact_id,
                removed_ids=set(), reply_request_ids=[], turn_ids=(old_turn,), captured_uses=captures,
            )
            self.assertEqual(set(selected.turn_ids), {old_turn, prepared[1]})
            self.assertEqual(set(selected.reply_request_ids), {old_request, prepared[2].request_id})
            erase_assistant_source_turns(
                connection, owner_id=self.a.owner_id, contact_id=self.a.contact_id,
                removed_ids=set(), reply_request_ids=[], turn_ids=[old_turn], captured_uses=captures,
            )
        after = self.a.sessions.read_session(self.a.scope, self.a.session_id)
        self.assertEqual(after.current_input_version_id, independent)
        self.assertTrue(all(turn.input is None and turn.state == "redacted" for turn in after.turns))
        self.assertEqual({item.input_version_id for item in after.inputs if item.state == "active"}, {independent})
        self.assertIsNotNone(candidate.candidate_id)

    def test_actual_captured_edited_version_hash_rejects_changed_body_and_rolls_back(self) -> None:
        candidate, _, old_turn = self.a._complete()
        versions = PostgresAssistantCandidateVersions(support.support.DATABASE_URL)
        edited = versions.edit(self.a.scope, self.a.session_id, candidate.candidate_id,
                               EditAssistantCandidate(
                                   uuid4(), candidate.candidate_id,
                                   tuple(CandidateMessage(message.message_id, message.text + "合成编辑。")
                                         for message in candidate.message_group),
                                   "合成此次修改要求。",
                               ))
        versions.select(self.a.scope, self.a.session_id, candidate.candidate_id,
                        candidate.candidate_id, uuid4())
        prepared = self.fixture._prepare(relationship=False)
        self.fixture._save(prepared)
        with psycopg.connect(support.support.DATABASE_URL) as connection:
            captures = captured_reply_discussion_uses(connection, self.a.scope)
        self.assertEqual(sum(record.kind == "candidate_version" for record in captures[0].snapshot.records), 2)
        before = versions.read(self.a.scope, self.a.session_id, candidate.candidate_id)
        changed = [{"message_id": str(message.message_id), "text": message.text + "已改变。"}
                   for message in edited.versions[-1].messages]
        with self.assertRaises(ReplyStoreInvariantError):
            with psycopg.connect(support.support.DATABASE_URL, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=self.a.owner_id)
                connection.execute("UPDATE public.assistant_candidate_version SET message_group=%s WHERE id=%s",
                                   (Jsonb(changed), edited.default_display_version_id))
                erase_assistant_source_turns(
                    connection, owner_id=self.a.owner_id, contact_id=self.a.contact_id,
                    removed_ids=set(), reply_request_ids=[], turn_ids=[old_turn], captured_uses=captures,
                )
        self.assertEqual(versions.read(self.a.scope, self.a.session_id, candidate.candidate_id), before)
