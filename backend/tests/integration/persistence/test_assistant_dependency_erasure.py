"""实际依赖命中的助手输入清除；仅使用正式存储及隔离库合成资料。"""

from __future__ import annotations

import os
import unittest
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row

from notalone.application.assistant_session_service import AssistantSessionRejected
from notalone.application.reply_service import ReplyServiceRequest
from notalone.persistence.assistant_discussion_context import (
    read_assistant_discussion_in_transaction, require_assistant_discussion_current,
)
from notalone.persistence.assistant_session_catalog import PostgresAssistantSessionCatalog
from notalone.persistence.assistant_session_inputs import require_current_input
from notalone.persistence.assistant_session_store import (
    PostgresAssistantSessionStore, erase_assistant_source_turns,
)
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.interface import RewriteDraft
from notalone.scopes import ContactScope, VerifiedConversationScope


DATABASE_URL = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")


class AssistantDependencyErasureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not DATABASE_URL:
            raise unittest.SkipTest("必须显式提供本地隔离 PostgreSQL 测试库。")
        with psycopg.connect(DATABASE_URL) as connection:
            name = connection.execute("SELECT current_database()").fetchone()[0]
        if not name.endswith("_test"):
            raise RuntimeError("依赖清除仅使用自有 _test 数据库。")

    def setUp(self) -> None:
        self.owner_id, self.contact_id = uuid4(), uuid4()
        self.owner_ids = [self.owner_id]
        self.scope = ContactScope(self.owner_id, self.contact_id)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES (%s,'合成清除用户')",
                               (self.owner_id,))
            connection.execute("INSERT INTO public.skill_library(owner_id,revision) VALUES (%s,0)",
                               (self.owner_id,))
            connection.execute(
                "INSERT INTO public.contact(id,owner_id,display_name) VALUES (%s,%s,'合成清除联系人')",
                (self.contact_id, self.owner_id),
            )
        self.addCleanup(self._clean_owners)
        self.binding_id = PostgresConversationBindingRepository(DATABASE_URL).create_binding(
            owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
            account_scope="synthetic-dependency-erasure", conversation_locator=f"synthetic-{uuid4()}",
        ).binding_id
        self.sessions = PostgresAssistantSessionStore(DATABASE_URL)
        self.catalog = PostgresAssistantSessionCatalog(DATABASE_URL)
        self.replies = PostgresReplyStore(DATABASE_URL)
        self.session_id = self.sessions.default(self.scope)

    def _clean_owners(self) -> None:
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("DELETE FROM public.owner WHERE id=ANY(%s::uuid[])", (self.owner_ids,))

    def _pending(
        self, session_id: UUID, text: str, *, scope: ContactScope | None = None,
        binding_id: UUID | None = None,
    ) -> tuple[UUID, UUID, UUID]:
        selected_scope = scope or self.scope
        selected_binding = binding_id or self.binding_id
        request = ReplyServiceRequest(idempotency_key=uuid4(), content=RewriteDraft(
            text, include_relationship_context=False,
        ))
        turn_id = self.sessions.reserve(selected_scope, session_id, request)
        command = request.build_command(owner_id=selected_scope.owner_id, contact_id=selected_scope.contact_id,
                                        binding_id=selected_binding)
        started = self.replies.start(command, VerifiedConversationScope(
            selected_scope.owner_id, selected_scope.contact_id, selected_binding,
        ))
        version = self.sessions.read_session(selected_scope, session_id).current_input_version_id
        self.assertIsNotNone(version)
        return turn_id, started.request.request_id, version

    def _other_contact(self, *, other_owner: bool = False) -> tuple[ContactScope, UUID, UUID]:
        owner_id, contact_id = uuid4() if other_owner else self.owner_id, uuid4()
        with psycopg.connect(DATABASE_URL) as connection:
            if other_owner:
                self.owner_ids.append(owner_id)
                connection.execute("INSERT INTO public.owner(id,display_name) VALUES (%s,'另一合成清除用户')",
                                   (owner_id,))
                connection.execute("INSERT INTO public.skill_library(owner_id,revision) VALUES (%s,0)",
                                   (owner_id,))
            connection.execute(
                "INSERT INTO public.contact(id,owner_id,display_name) VALUES (%s,%s,'同名合成清除联系人')",
                (contact_id, owner_id),
            )
        scope = ContactScope(owner_id, contact_id)
        binding_id = PostgresConversationBindingRepository(DATABASE_URL).create_binding(
            owner_id=owner_id, contact_id=contact_id, channel="wechat",
            account_scope="synthetic-dependency-erasure", conversation_locator=f"synthetic-{uuid4()}",
        ).binding_id
        return scope, binding_id, self.sessions.default(scope)

    def test_explicit_affected_draft_is_erased_but_unrelated_canceled_draft_remains_readable(self) -> None:
        discussion_id = self.sessions.record_discussion_input(self.scope, self.session_id, {
            "type": "purpose_exploration", "purpose_hint": "合成独立讨论", "requirements": "独立要求保留。",
        })
        affected_turn, affected_reply, affected_version = self._pending(self.session_id, "受影响的合成草稿。")
        other_session = self.catalog.new(self.scope)
        unrelated_turn, unrelated_reply, unrelated_version = self._pending(other_session, "独立合成草稿仍可回看。")
        unrelated_before = self.sessions.read_session(self.scope, other_session)

        with psycopg.connect(DATABASE_URL, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            erase_assistant_source_turns(
                connection, owner_id=self.owner_id, contact_id=self.contact_id,
                removed_ids={uuid4()}, reply_request_ids=[affected_reply, unrelated_reply],
                turn_ids=[affected_turn],
            )

        affected = self.sessions.read_session(self.scope, self.session_id)
        self.assertEqual(affected.turns[0].state, "redacted")
        self.assertIsNone(affected.turns[0].input)
        self.assertIsNone(affected.current_input_version_id)
        self.assertFalse(self.sessions.is_current_input(self.scope, self.session_id, affected_version))
        self.assertEqual([(item.input_version_id, item.state) for item in affected.inputs],
                         [(discussion_id, "active"), (affected_version, "redacted")])
        self.assertEqual(affected.inputs[0].content["requirements"], "独立要求保留。")
        self.assertIsNone(affected.inputs[1].content)

        unrelated = self.sessions.read_session(self.scope, other_session)
        self.assertEqual(unrelated.turns[0].turn_id, unrelated_turn)
        self.assertEqual(unrelated.turns[0].state, "failed")
        self.assertEqual(unrelated.turns[0].input, unrelated_before.turns[0].input)
        self.assertEqual(unrelated.current_input_version_id, unrelated_version)
        self.assertTrue(self.sessions.is_current_input(self.scope, other_session, unrelated_version))
        with psycopg.connect(DATABASE_URL) as connection:
            erased = connection.execute(
                "SELECT turn.state,turn.input_payload,turn.input_digest,turn.reply_request_id,turn.dependency_ids,"
                "input.state,input.content,input.dependency_ids FROM public.assistant_session_turn AS turn "
                "JOIN public.assistant_session_input AS input ON input.id=turn.input_version_id "
                "WHERE turn.id=%s", (affected_turn,),
            ).fetchone()
        self.assertEqual(erased, ("redacted", None, None, None, [], "redacted", None, []))

    def test_erasing_older_generation_keeps_later_independent_discussion_current(self) -> None:
        turn_id, request_id, old_version = self._pending(self.session_id, "后来已不用的合成草稿。")
        discussion_version = self.sessions.record_discussion_input(self.scope, self.session_id, {
            "type": "purpose_exploration", "purpose_hint": "新的独立讨论", "requirements": "以新的要求继续。",
        })
        discussion_before = self.sessions.read_session(self.scope, self.session_id).inputs[-1]
        with psycopg.connect(DATABASE_URL) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            erase_assistant_source_turns(
                connection, owner_id=self.owner_id, contact_id=self.contact_id,
                removed_ids=set(), reply_request_ids=[request_id], turn_ids=[turn_id],
            )
        restored = self.sessions.read_session(self.scope, self.session_id)
        self.assertEqual(restored.turns[0].state, "redacted")
        self.assertEqual(restored.inputs[0].state, "redacted")
        self.assertEqual(restored.inputs[1], discussion_before)
        self.assertEqual(restored.current_input_version_id, discussion_version)
        self.assertTrue(self.sessions.is_current_input(self.scope, self.session_id, discussion_version))
        self.assertFalse(self.sessions.is_current_input(self.scope, self.session_id, old_version))

    def test_explicit_ids_do_not_erase_other_owner_contact_or_unselected_session(self) -> None:
        target_turn, _, _ = self._pending(self.session_id, "本范围实际依赖的草稿。")
        other_scope, other_binding, other_session = self._other_contact()
        other_turn, _, _ = self._pending(other_session, "其他联系人的独立草稿。",
                                         scope=other_scope, binding_id=other_binding)
        foreign_scope, foreign_binding, foreign_session = self._other_contact(other_owner=True)
        foreign_turn, _, _ = self._pending(foreign_session, "其他用户的独立草稿。",
                                           scope=foreign_scope, binding_id=foreign_binding)
        sibling_session = self.catalog.new(self.scope)
        self._pending(sibling_session, "同联系人未命中会话的草稿。")
        unaffected = tuple((scope, session, self.sessions.read_session(scope, session)) for scope, session in (
            (other_scope, other_session), (foreign_scope, foreign_session), (self.scope, sibling_session),
        ))
        with psycopg.connect(DATABASE_URL) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            erase_assistant_source_turns(
                connection, owner_id=self.owner_id, contact_id=self.contact_id,
                removed_ids=set(), reply_request_ids=[], turn_ids=[target_turn, other_turn, foreign_turn],
            )
        target = self.sessions.read_session(self.scope, self.session_id)
        self.assertEqual(target.turns[0].state, "redacted")
        self.assertIsNone(target.current_input_version_id)
        for scope, session_id, before in unaffected:
            with self.subTest(scope=scope, session_id=session_id):
                self.assertEqual(self.sessions.read_session(scope, session_id), before)

    def test_caller_transaction_rollback_restores_turn_input_and_current_pointer(self) -> None:
        turn_id, request_id, version = self._pending(self.session_id, "回滚后保留的合成草稿。")
        before = self.sessions.read_session(self.scope, self.session_id)
        with self.assertRaisesRegex(RuntimeError, "合成事务回滚"):
            # 默认 tuple row 的调用方仍能在同一事务中使用公开清除及 CURRENT 门禁。
            with psycopg.connect(DATABASE_URL) as connection:
                lock_owner_scope(connection, owner_id=self.owner_id)
                erase_assistant_source_turns(
                    connection, owner_id=self.owner_id, contact_id=self.contact_id,
                    removed_ids=set(), reply_request_ids=[request_id], turn_ids=[turn_id],
                )
                with self.assertRaises(AssistantSessionRejected):
                    require_current_input(connection, self.scope, self.session_id, version)
                raise RuntimeError("合成事务回滚")
        self.assertEqual(self.sessions.read_session(self.scope, self.session_id), before)
        self.assertTrue(self.sessions.is_current_input(self.scope, self.session_id, version))

    def test_fresh_discussion_omits_erased_body_and_old_current_snapshot_is_rejected(self) -> None:
        independent_version = self.sessions.record_discussion_input(self.scope, self.session_id, {
            "type": "purpose_exploration", "purpose_hint": "保留的独立讨论", "requirements": "仍需保留的合成要求。",
        })
        turn_id, request_id, version = self._pending(self.session_id, "绝不能恢复的合成删除正文。")
        request_key = self.sessions.read_session(self.scope, self.session_id).turns[0].request_key
        with psycopg.connect(DATABASE_URL) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            captured = read_assistant_discussion_in_transaction(connection, self.scope, request_key)
            self.assertIsNotNone(captured)
            erase_assistant_source_turns(
                connection, owner_id=self.owner_id, contact_id=self.contact_id,
                removed_ids=set(), reply_request_ids=[request_id], turn_ids=[turn_id],
            )
            with self.assertRaises(ReplyStoreInvariantError):
                require_assistant_discussion_current(connection, self.scope, captured.snapshot)
        self.assertFalse(self.sessions.is_current_input(self.scope, self.session_id, version))
        self._pending(self.session_id, "新的明确合成草稿。")
        fresh_key = self.sessions.read_session(self.scope, self.session_id).turns[-1].request_key
        with psycopg.connect(DATABASE_URL) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            fresh = read_assistant_discussion_in_transaction(connection, self.scope, fresh_key)
            self.assertEqual([(item.kind, item.input_version_id) for item in fresh.items],
                             [("discussion_input", independent_version)])
            self.assertIn("仍需保留的合成要求。", fresh.items[0].text)
            self.assertNotIn("绝不能恢复的合成删除正文。", "".join(item.text for item in fresh.items))
            require_assistant_discussion_current(connection, self.scope, fresh.snapshot)


if __name__ == "__main__":
    unittest.main()
