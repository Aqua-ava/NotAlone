"""助手会话目录的公开持久化接缝；使用正式迁移与自有隔离 PG。"""

from __future__ import annotations

import os
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from typing import Iterator
import unittest
from uuid import uuid4

import psycopg
from psycopg import sql

from notalone.application.assistant_session_service import (
    AssistantSessionNotFound, AssistantSessionPersistenceError, AssistantSessionRejected,
)
from notalone.application.reply_service import ReplyServiceRequest
from notalone.persistence.assistant_session_catalog import PostgresAssistantSessionCatalog
from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
from notalone.reply.interface import RewriteDraft
from notalone.scopes import ContactScope


DATABASE_URL = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")


class AssistantSessionCatalogStoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not DATABASE_URL:
            raise unittest.SkipTest("必须显式提供隔离 PostgreSQL 测试库。")
        with psycopg.connect(DATABASE_URL) as connection:
            name = connection.execute("SELECT current_database()").fetchone()[0]
        if not name.endswith("_test"):
            raise RuntimeError("会话目录只允许自有隔离 _test 数据库。")

    def setUp(self) -> None:
        self.owner_id, self.other_owner_id = uuid4(), uuid4()
        self.contact_id, self.other_contact_id = uuid4(), uuid4()
        self.scope = ContactScope(self.owner_id, self.contact_id)
        self.other_scope = ContactScope(self.owner_id, self.other_contact_id)
        with psycopg.connect(DATABASE_URL) as connection:
            for owner_id in (self.owner_id, self.other_owner_id):
                connection.execute(
                    "INSERT INTO public.owner (id, display_name) VALUES (%s, '合成目录用户')",
                    (owner_id,),
                )
            for contact_id in (self.contact_id, self.other_contact_id):
                connection.execute(
                    "INSERT INTO public.contact (id, owner_id, display_name) "
                    "VALUES (%s, %s, '同名合成联系人')",
                    (contact_id, self.owner_id),
                )
        self.addCleanup(self._clean_owners)
        self.bindings = PostgresConversationBindingRepository(DATABASE_URL)
        self.binding = self.bindings.create_binding(
            owner_id=self.owner_id, contact_id=self.contact_id,
            channel="wechat", account_scope="synthetic-catalog-account",
            conversation_locator=f"synthetic-{uuid4()}",
        )
        self.catalog = PostgresAssistantSessionCatalog(DATABASE_URL)
        self.sessions = PostgresAssistantSessionStore(DATABASE_URL)

    def _clean_owners(self) -> None:
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = ANY(%s::uuid[])",
                ([self.owner_id, self.other_owner_id],),
            )

    def _revoke(self) -> None:
        self.bindings.revoke_binding(
            owner_id=self.owner_id, contact_id=self.contact_id,
            binding_id=self.binding.binding_id,
        )

    def _source(self):
        source_id, message_id = uuid4(), uuid4()
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.source_document "
                "(id, owner_id, contact_id, source_type, file_name, content_sha256, record_count) "
                "VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic-catalog.jsonl', %s, 1)",
                (source_id, self.owner_id, self.contact_id, uuid4().hex * 2),
            )
            connection.execute(
                "INSERT INTO public.message "
                "(id, owner_id, contact_id, speaker, message_type, text_content) "
                "VALUES (%s, %s, %s, 'contact', 'text', '合成目录来源消息')",
                (message_id, self.owner_id, self.contact_id),
            )
            connection.execute(
                "INSERT INTO public.message_source_ref "
                "(message_id, owner_id, contact_id, source_kind, source_document_id, source_locator, raw_payload) "
                "VALUES (%s, %s, %s, 'source_document', %s, %s, '{}'::jsonb)",
                (message_id, self.owner_id, self.contact_id, source_id, str(message_id)),
            )
        return source_id, message_id

    @contextmanager
    def _reject_write(self, *, creation: bool) -> Iterator[None]:
        name = f"synthetic_catalog_failure_{uuid4().hex}"
        event = "INSERT" if creation else "UPDATE OF is_default"
        condition = "NEW.owner_id = {owner}::uuid AND NEW.is_default"
        if not creation:
            condition += " AND NOT OLD.is_default"
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(sql.SQL(
                "CREATE FUNCTION public.{name}() RETURNS trigger LANGUAGE plpgsql AS "
                "'BEGIN RAISE EXCEPTION ''synthetic_catalog_failure''; END;'"
            ).format(name=sql.Identifier(name)))
            connection.execute(sql.SQL(
                "CREATE TRIGGER {name} BEFORE " + event + " ON public.assistant_session "
                "FOR EACH ROW WHEN (" + condition + ") EXECUTE FUNCTION public.{name}()"
            ).format(name=sql.Identifier(name), owner=sql.Literal(str(self.owner_id))))
        try:
            yield
        finally:
            with psycopg.connect(DATABASE_URL) as connection:
                connection.execute(sql.SQL("DROP TRIGGER {name} ON public.assistant_session").format(
                    name=sql.Identifier(name),
                ))
                connection.execute(sql.SQL("DROP FUNCTION public.{name}()").format(name=sql.Identifier(name)))

    def test_revoked_binding_keeps_existing_session_list_and_read_available(self) -> None:
        session_id = self.sessions.default(self.scope)
        self._revoke()

        self.assertEqual(self.sessions.read_session(self.scope, session_id).turns, ())
        listed = self.catalog.list_sessions(self.scope)
        self.assertEqual([(item.session_id, item.is_current) for item in listed], [(session_id, True)])

    def test_selecting_old_session_after_revocation_does_not_authorize_new_generation(self) -> None:
        old_session = self.catalog.new(self.scope)
        new_session = self.catalog.new(self.scope)
        self._revoke()

        self.assertEqual(self.catalog.select(self.scope, old_session), old_session)
        listed = self.catalog.list_sessions(self.scope)
        self.assertEqual({item.session_id: item.is_current for item in listed}, {
            old_session: True, new_session: False,
        })
        self.assertEqual(self.sessions.read_session(self.scope, old_session).turns, ())
        with self.assertRaises(AssistantSessionRejected) as failure:
            self.sessions.reserve(self.scope, old_session, ReplyServiceRequest(
                idempotency_key=uuid4(), content=RewriteDraft("合成旧会话新要求"),
            ))
        self.assertEqual(failure.exception.reason, "no_active_binding")
        with self.assertRaises(AssistantSessionRejected) as failure:
            self.catalog.new(self.scope)
        self.assertEqual(failure.exception.reason, "no_active_binding")
        self.assertEqual(self.sessions.read_session(self.scope, old_session).inputs, ())

    def test_new_empty_session_preserves_old_discussion_and_turn_identity(self) -> None:
        old_session = self.catalog.new(self.scope)
        discussion_version = self.sessions.record_discussion_input(self.scope, old_session, {
            "type": "purpose_exploration", "purpose_hint": "合成旧讨论目的", "requirements": "不作新承诺",
        })
        turn_id = self.sessions.reserve(self.scope, old_session, ReplyServiceRequest(
            idempotency_key=uuid4(), content=RewriteDraft("合成旧讨论草稿"),
            expected_input_version_id=discussion_version,
        ))
        self.sessions.fail(self.scope, turn_id)
        before = self.sessions.read_session(self.scope, old_session)

        new_session = self.catalog.new(self.scope)
        self.assertNotEqual(old_session, new_session)
        empty = self.sessions.read_session(self.scope, new_session)
        self.assertIsNone(empty.current_input_version_id)
        self.assertEqual(empty.inputs, ())
        self.assertEqual(empty.turns, ())
        self.assertEqual(self.sessions.read_session(self.scope, old_session), before)
        self.assertEqual(self.sessions.default(self.scope), new_session)
        self.catalog.select(self.scope, old_session)
        self.assertEqual(self.sessions.default(self.scope), old_session)
        self.assertEqual(self.sessions.read_session(self.scope, old_session), before)

    def test_empty_list_does_not_implicitly_create_a_session_or_require_a_binding(self) -> None:
        self.assertEqual(self.catalog.list_sessions(self.scope), ())
        self.assertEqual(self.catalog.list_sessions(self.scope), ())
        self.assertEqual(self.catalog.list_sessions(self.other_scope), ())
        session_id = self.catalog.new(self.scope)
        listed = self.catalog.list_sessions(self.scope)
        self.assertEqual([(item.session_id, item.is_current) for item in listed], [(session_id, True)])
        self.assertEqual(self.catalog.list_sessions(self.other_scope), ())

    def test_scope_mismatch_and_unknown_session_do_not_move_current(self) -> None:
        first = self.catalog.new(self.scope)
        current = self.catalog.new(self.scope)
        for wrong_scope in (ContactScope(self.other_owner_id, self.contact_id),
                            ContactScope(self.owner_id, uuid4())):
            with self.subTest(scope=wrong_scope):
                with self.assertRaises(AssistantSessionNotFound):
                    self.catalog.new(wrong_scope)
                with self.assertRaises(AssistantSessionNotFound):
                    self.catalog.list_sessions(wrong_scope)
                with self.assertRaises(AssistantSessionNotFound):
                    self.catalog.select(wrong_scope, first)
        for scope, session_id in ((self.other_scope, first), (self.scope, uuid4())):
            with self.subTest(scope=scope, session_id=session_id):
                with self.assertRaises(AssistantSessionNotFound):
                    self.catalog.select(scope, session_id)
        self.assertEqual({item.session_id: item.is_current for item in self.catalog.list_sessions(self.scope)}, {
            first: False, current: True,
        })
        self.assertEqual(self.catalog.list_sessions(self.other_scope), ())

    def test_failed_new_and_selection_roll_back_current_and_keep_old_discussion(self) -> None:
        old_session = self.catalog.new(self.scope)
        self.sessions.record_discussion_input(self.scope, old_session, {
            "type": "purpose_exploration", "purpose_hint": "合成回滚保留讨论",
        })
        before = self.sessions.read_session(self.scope, old_session)
        with self._reject_write(creation=True):
            with self.assertRaises(AssistantSessionPersistenceError):
                self.catalog.new(self.scope)
        self.assertEqual(self.sessions.default(self.scope), old_session)
        self.assertEqual(self.sessions.read_session(self.scope, old_session), before)
        self.assertEqual(len(self.catalog.list_sessions(self.scope)), 1)

        current = self.catalog.new(self.scope)
        with self._reject_write(creation=False):
            with self.assertRaises(AssistantSessionPersistenceError):
                self.catalog.select(self.scope, old_session)
        self.assertEqual(self.sessions.default(self.scope), current)
        self.assertEqual(self.sessions.read_session(self.scope, old_session), before)
        self.assertEqual({item.session_id: item.is_current for item in self.catalog.list_sessions(self.scope)}, {
            old_session: False, current: True,
        })

    def test_selecting_source_deleted_old_session_keeps_placeholder_and_unrelated_session(self) -> None:
        source_id, message_id = self._source()
        old_session = self.catalog.new(self.scope)
        self.sessions.record_discussion_input(self.scope, old_session, {
            "type": "response_exploration", "target_message_id": str(message_id),
            "requirements": "合成来源讨论要求",
        })
        new_session = self.catalog.new(self.scope)
        self.sessions.record_discussion_input(self.scope, new_session, {
            "type": "purpose_exploration", "purpose_hint": "合成无关新讨论",
        })
        independent = self.sessions.read_session(self.scope, new_session)
        result = PostgresSourceDeletionRepository(DATABASE_URL).delete_source(
            owner_id=self.owner_id, contact_id=self.contact_id, source_document_id=source_id,
        )
        self.assertEqual(result.outcome, "deleted")

        self.assertEqual(self.catalog.select(self.scope, old_session), old_session)
        saved = self.sessions.read_session(self.scope, old_session)
        self.assertEqual(len(saved.inputs), 1)
        self.assertEqual(saved.inputs[0].state, "redacted")
        self.assertIsNone(saved.inputs[0].content)
        self.assertEqual(self.sessions.read_session(self.scope, new_session), independent)
        self.assertEqual({item.session_id: item.is_current for item in self.catalog.list_sessions(self.scope)}, {
            old_session: True, new_session: False,
        })

    def test_parallel_new_actions_keep_one_current_and_both_empty_sessions_recoverable(self) -> None:
        original = self.catalog.new(self.scope)
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(self.catalog.new, self.scope)
            second = pool.submit(self.catalog.new, self.scope)
            created = {first.result(timeout=5), second.result(timeout=5)}
        self.assertEqual(len(created), 2)
        listed = self.catalog.list_sessions(self.scope)
        self.assertEqual({item.session_id for item in listed}, {original, *created})
        current = [item.session_id for item in listed if item.is_current]
        self.assertEqual(len(current), 1)
        self.assertIn(current[0], created)
        self.assertEqual(self.sessions.default(self.scope), current[0])
        for session_id in created:
            with self.subTest(session_id=session_id):
                saved = self.sessions.read_session(self.scope, session_id)
                self.assertIsNone(saved.current_input_version_id)
                self.assertEqual(saved.inputs, ())
                self.assertEqual(saved.turns, ())

    def test_ambiguous_binding_rejects_new_without_changing_explicit_current(self) -> None:
        old_session = self.catalog.new(self.scope)
        current = self.catalog.new(self.scope)
        self.bindings.create_binding(
            owner_id=self.owner_id, contact_id=self.contact_id,
            channel="wechat", account_scope="synthetic-catalog-account",
            conversation_locator=f"synthetic-second-{uuid4()}",
        )
        with self.assertRaises(AssistantSessionRejected) as failure:
            self.catalog.new(self.scope)
        self.assertEqual(failure.exception.reason, "ambiguous_binding")
        self.assertEqual({item.session_id: item.is_current for item in self.catalog.list_sessions(self.scope)}, {
            old_session: False, current: True,
        })
        self.assertEqual(self.catalog.select(self.scope, old_session), old_session)
        with self.assertRaises(AssistantSessionRejected) as failure:
            self.sessions.reserve(self.scope, old_session, ReplyServiceRequest(
                idempotency_key=uuid4(), content=RewriteDraft("合成歧义绑定草稿"),
            ))
        self.assertEqual(failure.exception.reason, "ambiguous_binding")


if __name__ == "__main__":
    unittest.main()
