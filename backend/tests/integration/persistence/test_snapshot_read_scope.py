"""同一次持锁概览复用来源读取，下一次读取仍核验真实数据库世代。"""

from contextlib import contextmanager, nullcontext
from copy import deepcopy
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.memory.models import FactSubject

from notalone.persistence import correction_evidence
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.memory_overview import PostgresRelationshipOverviewStore
from notalone.scopes import ContactScope
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture


@contextmanager
def snapshot_queries(predicate=None):
    """仅计数实际执行的来源快照 SQL；保留正式数据库读取。"""
    queries = []
    execute = psycopg.Connection.execute

    def counted(connection, query, *args, **kwargs):
        if (predicate(str(query)) if predicate is not None else
                "ref.id AS ref_id" in str(query) and "message.media_placeholder" in str(query)):
            queries.append((connection, args))
        return execute(connection, query, *args, **kwargs)

    with patch.object(psycopg.Connection, "execute", counted):
        yield queries


class SnapshotReadScopeTest(MemoryOverviewHttpFixture, CoreBusinessFlowFixture, unittest.TestCase):
    setUpClass = classmethod(CoreBusinessFlowFixture.setUpClass.__func__)

    def test_overview_reads_shared_source_window_once(self):
        contact, _, message = self.import_contact("对方参加了合成课程。")
        for number in range(4):
            self.confirm(contact, f"合成课程经历 {number}。", message)
        store = PostgresRelationshipOverviewStore(self.database_url)
        with patch("notalone.persistence.memory_overview.reuse_message_snapshots",
                   return_value=nullcontext()), snapshot_queries() as baseline_queries:
            baseline = store.read_contact(ContactScope(self.owner_id, UUID(contact)))
        with snapshot_queries() as queries:
            overview = store.read_contact(ContactScope(self.owner_id, UUID(contact)))
        self.assertEqual(overview, baseline)
        self.assertEqual(len(baseline_queries), 8)
        self.assertEqual(len(overview.entries), 4)
        self.assertLessEqual(len(queries), 2, "相同窗口不应随记忆条数重复查库与计算摘要")

    def test_next_overview_in_same_transaction_observes_body_ref_and_deletion(self):
        mutations = (
            "UPDATE public.message SET text_content='合成正文已改变' WHERE owner_id=%s AND id=%s",
            "UPDATE public.message_source_ref SET source_locator=source_locator || ':changed' WHERE owner_id=%s AND message_id=%s",
            "DELETE FROM public.message_source_ref WHERE owner_id=%s AND message_id=%s",
        )
        store = PostgresRelationshipOverviewStore(self.database_url)
        for statement in mutations:
            with self.subTest(mutation=statement.split()[0:3]):
                contact, _, message = self.import_contact("待复验的合成课程来源。")
                self.confirm(contact, "对方参加过合成课程。", message)
                scope = ContactScope(self.owner_id, UUID(contact))
                with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
                    lock_owner_scope(connection, owner_id=self.owner_id)
                    before = store.read_contact_in_transaction(connection, scope)
                    self.assertEqual(len(before.entries), 1)
                    connection.execute(statement, (self.owner_id, message))
                    with snapshot_queries() as queries:
                        after = store.read_contact_in_transaction(connection, scope)
                    self.assertEqual(after.entries, ())
                    if not statement.startswith("DELETE"):
                        self.assertTrue(queries, "下一次概览必须重新读取当前来源")

    def test_snapshot_results_are_independent_and_scope_expires_on_exception(self):
        contact, _, message = self.import_contact("不能被调用者改写的合成来源。")
        args = {"owner_id": self.owner_id, "contact_id": UUID(contact), "message_ids": {message}}
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            with self.assertRaisesRegex(RuntimeError, "合成异常"):
                with correction_evidence.reuse_message_snapshots(connection), snapshot_queries() as queries:
                    first = correction_evidence.capture_message_snapshot(connection, **args)
                    expected = deepcopy(first)
                    first["message_snapshots"][str(message)]["source_refs"].clear()
                    second = correction_evidence.capture_message_snapshot(connection, **args)
                    self.assertEqual(second, expected)
                    self.assertEqual(len(queries), 1)
                    raise RuntimeError("合成异常")
            connection.execute("UPDATE public.message SET text_content='合成修改' WHERE owner_id=%s AND id=%s",
                               (self.owner_id, message))
            with correction_evidence.reuse_message_snapshots(connection), snapshot_queries() as queries:
                changed = correction_evidence.capture_message_snapshot(connection, **args)
            self.assertNotEqual(changed["message_digests"], expected["message_digests"])
            self.assertEqual(len(queries), 1)

    def test_complete_scope_key_and_other_connection_do_not_share_results(self):
        contact, source, message = self.import_contact("严格限定合成来源范围。")
        args = {"owner_id": self.owner_id, "contact_id": UUID(contact), "message_ids": {message}}
        with psycopg.connect(self.database_url, row_factory=dict_row) as first:
            lock_owner_scope(first, owner_id=self.owner_id)
            with psycopg.connect(self.database_url, row_factory=dict_row) as second:
                with correction_evidence.reuse_message_snapshots(first), snapshot_queries() as queries:
                    baseline = correction_evidence.capture_message_snapshot(first, **args)
                    self.assertTrue(baseline["message_ids"])
                    for changed in ({"owner_id": uuid4()}, {"contact_id": uuid4()},
                                    {"message_ids": set()}, {"ref_ids": set()}):
                        result = correction_evidence.capture_message_snapshot(first, **(args | changed))
                        self.assertEqual(result["message_ids"], [])
                    source_result = correction_evidence.capture_message_snapshot(first,
                        **(args | {"message_ids": set(), "source_ids": (UUID(source),)}))
                    self.assertIn(str(message), source_result["message_ids"])
                    self.assertEqual(correction_evidence.capture_message_snapshot(second, **args), baseline)
                    self.assertEqual(len(queries), 7)

    def test_overview_batches_candidates_and_shared_context_for_owner_and_contact(self):
        store = PostgresRelationshipOverviewStore(self.database_url)
        for owner_scope in (False, True):
            with self.subTest(owner_scope=owner_scope):
                contact, _, message = self.import_contact("对方参加合成课程。", owner_text="本人参加合成课程。")
                if owner_scope:
                    messages = self._get(self.backend, f"/api/contacts/{contact}/messages")["messages"]
                    message = UUID(next(row["message_id"] for row in messages if row["speaker"] == "user"))
                kind = "owner" if owner_scope else "contact"
                status, manual = self.backend.request(f"/api/memories/manual-{kind}", {
                    "text": "独立合成背景。", "category": "common_fact",
                    **({} if owner_scope else {"contact_id": contact}),
                })
                self.assertEqual(status, 200, manual)
                shared_id = UUID(manual["memory"]["memory_id"])
                memories = [UUID(self.confirm(contact, f"合成课程事实 {number}。", message,
                    subject=FactSubject.SELF if owner_scope else FactSubject.CONTACT)["memory_id"])
                    for number in range(4)]
                with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
                    lock_owner_scope(connection, owner_id=self.owner_id)
                    table = "owner_memory" if owner_scope else "confirmed_memory"
                    candidates = [row["source_candidate_id"] for row in connection.execute(
                        f"SELECT source_candidate_id FROM public.{table} WHERE owner_id=%s AND id=ANY(%s::uuid[])",
                        (self.owner_id, memories)).fetchall()]
                    # 装配同一既有记忆作为提取上下文，不伪造原始消息证明。
                    connection.execute("UPDATE public.memory_candidate SET correction_evidence="
                        "jsonb_set(correction_evidence,'{source_ids}',"
                        "(correction_evidence->'source_ids') || %s) "
                        "WHERE owner_id=%s AND id=ANY(%s::uuid[])",
                        (Jsonb([str(shared_id)]), self.owner_id, candidates))
                    read = (lambda: store.read_owner_in_transaction(connection, self.owner_id)) if owner_scope else (
                        lambda: store.read_contact_in_transaction(connection, ContactScope(self.owner_id, UUID(contact))))
                    with snapshot_queries(lambda query: "SELECT id,correction_evidence" in query) as candidate_queries:
                        with snapshot_queries(lambda query: "SELECT id,revision,status,text_content" in query) as context_queries:
                            before = read()
                    self.assertEqual(len(before.entries), 5)
                    self.assertEqual(len(candidate_queries), 1)
                    shared_reads = sum(shared_id in params[0][1] for _, params in context_queries)
                    self.assertEqual(shared_reads, 2, "同一上下文身份在两类记忆表各读取一次")
                    table = "owner_memory" if owner_scope else "confirmed_memory"
                    connection.execute(f"UPDATE public.{table} SET text_content='合成背景已修正' "
                                       "WHERE owner_id=%s AND id=%s", (self.owner_id, shared_id))
                    after = read()
                    self.assertNotEqual(after.projection_revision, before.projection_revision)
                    if owner_scope:
                        connection.execute("UPDATE public.memory_candidate SET subject='contact' "
                                           "WHERE owner_id=%s AND id=ANY(%s::uuid[])",
                                           (self.owner_id, candidates))
                        withdrawn = read()
                        self.assertEqual(len(withdrawn.entries), 1)
