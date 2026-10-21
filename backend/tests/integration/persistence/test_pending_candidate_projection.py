"""候选读取不序列化无关的大份依据，并兼容尚无可选列的结构。"""
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4
import psycopg
from psycopg.rows import dict_row
from notalone.memory.models import MemoryCandidate, MemoryCategory
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.scopes import ContactScope
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture

class PendingCandidateProjectionTest(MemoryOverviewHttpFixture, CoreBusinessFlowFixture, unittest.TestCase):
    setUpClass = classmethod(CoreBusinessFlowFixture.setUpClass.__func__)

    def test_pending_projection_avoids_whole_row_conversion(self):
        contact, _, message = self.import_contact("合成候选来源。")
        scope = ContactScope(self.owner_id, UUID(contact))
        store = PostgresMemoryStore(self.database_url)
        candidate = store.create_candidate(MemoryCandidate(candidate_id=uuid4(), scope=scope,
            text="合成候选。", category=MemoryCategory.COMMON_FACT, source_ids=(message,)))
        queries = []
        execute = psycopg.Connection.execute
        def counted(connection, query, *args, **kwargs):
            if isinstance(query, str) and 'AS candidate_text' in query:
                queries.append(query)
            return execute(connection, query, *args, **kwargs)
        with patch.object(psycopg.Connection, 'execute', counted):
            rows = store.list_pending_candidates(scope)
        self.assertEqual([row.candidate_id for row in rows], [candidate.candidate_id])
        self.assertTrue(queries)
        self.assertFalse(any('to_jsonb(memory_candidate)' in query for query in queries))

    def test_projection_preserves_missing_optional_columns_as_null(self):
        from notalone.persistence.memory_store import _pending_candidate_columns
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            # 同一测试事务撤销列改名，不影响夹具或其他数据库。
            connection.execute('ALTER TABLE public.memory_candidate RENAME COLUMN evolution TO hidden_evolution')
            try:
                columns = _pending_candidate_columns(connection)
                self.assertIn('NULL AS candidate_evolution', columns)
                connection.execute(f'SELECT {columns} FROM public.memory_candidate LIMIT 0')
            finally:
                connection.rollback()
