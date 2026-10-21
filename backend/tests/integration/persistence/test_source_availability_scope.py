"""来源活动性仅在既有持锁读取内复用，下一读取重新检查删除状态。"""

from contextlib import contextmanager
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row

from notalone.persistence.correction_evidence import capture_message_snapshot, reuse_message_snapshots
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.memory_correction import decision_sources_available, source_documents_available
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture


@contextmanager
def availability_queries():
    queries = []
    execute = psycopg.Connection.execute

    def counted(connection, query, *args, **kwargs):
        text = str(query)
        if ("AS unavailable" in text or "SELECT ref.id FROM public.message_source_ref" in text):
            queries.append(text)
        return execute(connection, query, *args, **kwargs)

    with patch.object(psycopg.Connection, "execute", counted):
        yield queries


class SourceAvailabilityScopeTest(MemoryOverviewHttpFixture, CoreBusinessFlowFixture, unittest.TestCase):
    setUpClass = classmethod(CoreBusinessFlowFixture.setUpClass.__func__)

    def test_identical_checks_query_sources_and_refs_once_per_read(self):
        _, _, message = self.import_contact("需要重复核验的合成来源。")
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            evidence = capture_message_snapshot(connection, owner_id=self.owner_id, message_ids={message})
            with reuse_message_snapshots(connection), availability_queries() as queries:
                for _ in range(3):
                    self.assertTrue(decision_sources_available(connection, owner_id=self.owner_id, evidence=evidence))
                self.assertTrue(source_documents_available(connection, owner_id=self.owner_id,
                    source_ids=[UUID(identifier) for identifier in reversed(evidence["source_ids"])]))
            self.assertEqual(len(queries), 2, "同一读取应各查询一次来源状态与引用活动性")
            with availability_queries() as queries:
                for _ in range(2):
                    self.assertTrue(decision_sources_available(connection, owner_id=self.owner_id, evidence=evidence))
            self.assertEqual(len(queries), 4, "未进入持锁读取作用域不能复用结果")

    def test_scope_connection_owner_source_and_ref_parameters_remain_isolated(self):
        _, source, message = self.import_contact("有效合成来源。")
        _, inactive, _ = self.import_contact("另一个待删合成来源。")
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            connection.execute("UPDATE public.source_document SET status='delete_requested' WHERE owner_id=%s AND id=%s",
                               (self.owner_id, inactive))
            evidence = capture_message_snapshot(connection, owner_id=self.owner_id, message_ids={message})
            with reuse_message_snapshots(connection):
                self.assertTrue(decision_sources_available(connection, owner_id=self.owner_id, evidence=evidence))
                self.assertFalse(decision_sources_available(connection, owner_id=self.owner_id,
                    evidence=evidence | {"source_ids": evidence["source_ids"] + [inactive]}))
                self.assertFalse(decision_sources_available(connection, owner_id=uuid4(), evidence=evidence))
                self.assertFalse(decision_sources_available(connection, owner_id=self.owner_id,
                    evidence=evidence | {"source_refs": [{"ref_id": str(uuid4())}]}))
                self.assertFalse(decision_sources_available(connection, owner_id=self.owner_id,
                    evidence=evidence | {"kind": "generation_unknown"}))
                with psycopg.connect(self.database_url, row_factory=dict_row) as other, availability_queries() as queries:
                    self.assertTrue(decision_sources_available(other, owner_id=self.owner_id, evidence=evidence))
                self.assertEqual(len(queries), 2, "另一连接必须重新检查真实来源")
            connection.execute("UPDATE public.source_document SET status='delete_requested' WHERE owner_id=%s AND id=%s",
                               (self.owner_id, source))
            with reuse_message_snapshots(connection):
                self.assertFalse(decision_sources_available(connection, owner_id=self.owner_id, evidence=evidence))
                self.assertFalse(source_documents_available(connection, owner_id=self.owner_id, source_ids=[source]))
            connection.execute("UPDATE public.source_document SET status='active' WHERE owner_id=%s AND id=%s",
                               (self.owner_id, source))
            connection.execute("DELETE FROM public.message_source_ref WHERE owner_id=%s AND message_id=%s",
                               (self.owner_id, message))
            with reuse_message_snapshots(connection):
                self.assertTrue(source_documents_available(connection, owner_id=self.owner_id, source_ids=[source]))
                self.assertFalse(decision_sources_available(connection, owner_id=self.owner_id, evidence=evidence))
