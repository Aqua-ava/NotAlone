"""记忆依据只读取条件与变化列，旧 NULL 及当前变更仍参与同一摘要合同。"""

from contextlib import contextmanager
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.memory.models import MemoryCandidate, MemoryCategory
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.reply_basis_changes import (
    historical_basis_revision_sha256, read_reply_basis_changes, require_current_reply_memory,
)
from notalone.reply.context import ContextEvidence
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.scopes import ContactScope
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture


@contextmanager
def executed_sql():
    queries = []
    execute = psycopg.Connection.execute

    def recorded(connection, query, *args, **kwargs):
        queries.append(query if isinstance(query, str) else query.as_string(connection))
        return execute(connection, query, *args, **kwargs)

    with patch.object(psycopg.Connection, "execute", recorded):
        yield queries


class ReplyBasisProjectionTest(MemoryOverviewHttpFixture, CoreBusinessFlowFixture, unittest.TestCase):
    setUpClass = classmethod(CoreBusinessFlowFixture.setUpClass.__func__)

    def test_basis_queries_do_not_convert_entire_memory_rows_to_json(self):
        contact, _, message = self.import_contact("用于合成记忆依据的原话。")
        scope = ContactScope(self.owner_id, UUID(contact))
        memory = self.confirm(contact, "合成资料。", message)
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            with executed_sql() as queries:
                historical_basis_revision_sha256(connection, scope, (UUID(memory["memory_id"]),))
                self.assertEqual(read_reply_basis_changes(connection, scope, uuid4()), ())
                for kind in ("confirmed_memory", "owner_memory", "pending_candidate"):
                    with self.assertRaises(ReplyStoreInvariantError):
                        require_current_reply_memory(connection, scope,
                            (ContextEvidence(uuid4(), kind, "已不存在的合成资料。", scope,
                                             source_ids=(message,), selection_reason="合成校验"),))
            self.assertFalse(any("to_jsonb(" in query for query in queries),
                             "条件和变化读取不得先序列化整行证据大 JSON")

    def test_null_conditions_and_current_conditions_are_bound_for_all_memory_tables(self):
        contact, _, message = self.import_contact("用于合成条件的原话。")
        scope = ContactScope(self.owner_id, UUID(contact))
        memory = self.confirm(contact, "合成联系人资料。", message)
        status, owner = self.backend.request("/api/memories/manual-owner", {
            "text": "合成本人资料。", "category": "common_fact"})
        self.assertEqual(status, 200, owner)
        pending = PostgresMemoryStore(self.database_url).create_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=scope, text="合成待确认资料。", category=MemoryCategory.COMMON_FACT,
            source_ids=(message,),
        ))
        rows = (("confirmed_memory", UUID(memory["memory_id"])),
                ("owner_memory", UUID(owner["memory"]["memory_id"])),
                ("memory_candidate", pending.candidate_id))
        conditions = {"version": 1, "items": [{"text": "仅限合成条件", "evidence": [], "source_supported": False}]}
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            for table, identifier in rows:
                with self.subTest(table=table):
                    before = historical_basis_revision_sha256(connection, scope, (identifier,))
                    self.assertEqual(before, historical_basis_revision_sha256(connection, scope, (identifier,)))
                    connection.execute(f"UPDATE public.{table} SET conditions=%s WHERE owner_id=%s AND id=%s",
                                       (Jsonb(conditions), self.owner_id, identifier))
                    after = historical_basis_revision_sha256(connection, scope, (identifier,))
                    self.assertNotEqual(before, after)
                    connection.execute(f"UPDATE public.{table} SET conditions=NULL WHERE owner_id=%s AND id=%s",
                                       (self.owner_id, identifier))
                    self.assertEqual(before, historical_basis_revision_sha256(connection, scope, (identifier,)))
