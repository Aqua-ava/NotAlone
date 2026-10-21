"""讨论复验只读取实际消费的字段和冻结输入；不搬运整份准备快照。"""

from contextlib import contextmanager
from dataclasses import replace
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.application.reply_service import ReplyServiceRequest
from notalone.persistence import assistant_discussion_context as discussion
from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.locks import lock_owner_scope
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.interface import RewriteDraft
from notalone.scopes import ContactScope
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture


@contextmanager
def history_row_counts():
    counts = []
    execute = psycopg.Cursor.execute

    def counted(cursor, query, *args, **kwargs):
        result = execute(cursor, query, *args, **kwargs)
        if "ORDER BY input.created_at" in str(query):
            counts.append(cursor.rowcount)
        return result

    with patch.object(psycopg.Cursor, "execute", counted):
        yield counts


class DiscussionReadProjectionTest(MemoryOverviewHttpFixture, CoreBusinessFlowFixture, unittest.TestCase):
    setUpClass = classmethod(CoreBusinessFlowFixture.setUpClass.__func__)

    def _prepare(self):
        contact, _, _ = self.import_contact("合成讨论上下文。")
        scope = ContactScope(self.owner_id, UUID(contact))
        PostgresConversationBindingRepository(self.database_url).create_binding(
            owner_id=self.owner_id, contact_id=scope.contact_id, channel="wechat",
            account_scope="synthetic-discussion-projection", conversation_locator=f"synthetic-{uuid4()}",
        )
        store = PostgresAssistantSessionStore(self.database_url)
        session = store.default(scope)
        for value in ("先明确合成邀请", "保留合成要求"):
            store.record_discussion_input(scope, session,
                {"type": "purpose_exploration", "purpose_hint": value}, verified_dependencies=())
        request = ReplyServiceRequest(idempotency_key=uuid4(), content=RewriteDraft("合成明确意愿。"))
        turn = store.reserve(scope, session, request)
        return scope, request, turn

    def test_anchor_excludes_large_prepared_context_without_changing_discussion(self):
        scope, request, turn = self._prepare()
        with psycopg.connect(self.database_url) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            before = discussion.read_assistant_discussion_in_transaction(connection, scope, request.idempotency_key)
            self.assertEqual(len(before.items), 2)
            connection.execute("UPDATE public.assistant_session_turn SET prepared_context=%s "
                "WHERE owner_id=%s AND contact_id=%s AND id=%s",
                (Jsonb({"synthetic_large_snapshot": "合成" * 500_000}), self.owner_id, scope.contact_id, turn))
            size = connection.execute("SELECT octet_length(prepared_context::text) FROM public.assistant_session_turn "
                "WHERE owner_id=%s AND id=%s", (self.owner_id, turn)).fetchone()[0]
            self.assertGreater(size, 1_000_000)
            with connection.cursor(row_factory=dict_row) as cursor:
                anchor = discussion._captured_anchor(cursor, scope, request.idempotency_key)
            self.assertNotIn("prepared_context", anchor.keys())
            after = discussion.read_assistant_discussion_in_transaction(connection, scope, request.idempotency_key)
            self.assertEqual(after, before)
            discussion.require_assistant_discussion_current(connection, scope, before.snapshot)
            connection.execute("UPDATE public.assistant_session_turn SET input_digest=repeat('f',64) "
                "WHERE owner_id=%s AND id=%s", (self.owner_id, turn))
            with self.assertRaises(ReplyStoreInvariantError):
                discussion.require_assistant_discussion_current(connection, scope, before.snapshot)

    def test_validation_only_reads_captured_input_ids_and_empty_snapshot_reads_none(self):
        scope, request, _ = self._prepare()
        with psycopg.connect(self.database_url) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            context = discussion.read_assistant_discussion_in_transaction(connection, scope, request.idempotency_key)
            self.assertEqual(len(context.snapshot.records), 2, "首次读取保持完整历史")
            captured = replace(context.snapshot, records=context.snapshot.records[:1])
            with history_row_counts() as counts:
                discussion.require_assistant_discussion_current(connection, scope, captured)
            self.assertEqual(counts, [1], "复验仅读取本次实际捕获的输入身份")
            with history_row_counts() as counts:
                discussion.require_assistant_discussion_current(connection, scope, replace(captured, records=()))
            self.assertEqual(counts, [])
            identifier = captured.records[0].input_version_id
            connection.execute("UPDATE public.assistant_session_input SET state='redacted',content=NULL,dependency_ids='{}' "
                "WHERE owner_id=%s AND contact_id=%s AND id=%s", (self.owner_id, scope.contact_id, identifier))
            with self.assertRaises(ReplyStoreInvariantError):
                discussion.require_assistant_discussion_current(connection, scope, captured)
