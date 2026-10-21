"""显式引用集合沿单次稳定读取复用已读行，重组不扩大任一过滤条件。"""

from datetime import datetime, timezone
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.persistence import correction_evidence as snapshots
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.memory_correction import decision_sources_available
from tests.integration.persistence.test_snapshot_read_scope import snapshot_queries
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture


class SnapshotRefReuseTest(MemoryOverviewHttpFixture, CoreBusinessFlowFixture, unittest.TestCase):
    setUpClass = classmethod(CoreBusinessFlowFixture.setUpClass.__func__)

    def test_overlapping_message_sets_share_explicit_ref_rows_and_hashes(self):
        contact, source, message = self.import_contact("重叠合成窗口。")
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            rows = connection.execute("SELECT message_id,id FROM public.message_source_ref "
                "WHERE owner_id=%s AND contact_id=%s", (self.owner_id, contact)).fetchall()
            all_messages = {row["message_id"] for row in rows}
            all_refs = {row["id"] for row in rows}
            base = dict(owner_id=self.owner_id, message_ids=all_messages, ref_ids=all_refs)
            with snapshots.reuse_message_snapshots(connection), snapshot_queries() as queries:
                with patch.object(snapshots, "source_state_digest", wraps=snapshots.source_state_digest) as hashed:
                    complete = snapshots.capture_message_snapshot(connection, **base)
                    selected = snapshots.capture_message_snapshot(connection, **(base | {"message_ids": {message}}))
                    via_source = snapshots.capture_message_snapshot(connection,
                        **(base | {"message_ids": set(), "source_ids": (UUID(source),)}))
                    self.assertEqual(len(queries), 1)
                    self.assertEqual(hashed.call_count, len(all_messages))
                    self.assertEqual(selected["message_snapshots"][str(message)], complete["message_snapshots"][str(message)])
                    self.assertEqual(via_source["message_snapshots"], complete["message_snapshots"])
                    selected["message_snapshots"][str(message)]["source_refs"].clear()
                    repeated = snapshots.capture_message_snapshot(connection, **base)
                    self.assertEqual(repeated, complete)

    def test_filter_changes_match_fresh_sql_and_missing_refs_are_not_negative_cached(self):
        contact, source, message = self.import_contact("多来源合成消息。")
        _, second_source, second_message = self.import_contact("第二条合成消息。", contact_id=contact,
            when=datetime(2024, 1, 2, tzinfo=timezone.utc))
        other_contact, _, _ = self.import_contact("另一联系人合成消息。")
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            extra = connection.execute("INSERT INTO public.message_source_ref "
                "(owner_id,contact_id,message_id,source_kind,source_document_id,source_locator,raw_payload) "
                "VALUES(%s,%s,%s,'source_document',%s,'synthetic:alias','{}') RETURNING id",
                (self.owner_id, contact, message, second_source)).fetchone()["id"]
            ref_ids = {row["id"] for row in connection.execute("SELECT id FROM public.message_source_ref "
                "WHERE owner_id=%s AND message_id=%s", (self.owner_id, message)).fetchall()}
            base = dict(owner_id=self.owner_id, contact_id=UUID(contact), message_ids={message}, ref_ids=ref_ids)
            variations = [base,
                base | {"contact_id": None},
                base | {"message_ids": set(), "source_ids": (UUID(source),)},
                base | {"message_ids": set(), "source_ids": (UUID(second_source),)},
                base | {"message_ids": {second_message}},
                base | {"contact_id": UUID(other_contact)},
                base | {"owner_id": uuid4()},
                base | {"ref_ids": {extra}},
                base | {"ref_ids": ref_ids - {extra}},
                base | {"ref_ids": None},
            ]
            expected = [snapshots.capture_message_snapshot(connection, **args) for args in variations]
            with snapshots.reuse_message_snapshots(connection):
                wrong = snapshots.capture_message_snapshot(connection,
                    **(base | {"contact_id": UUID(other_contact)}))
                self.assertEqual(wrong["message_ids"], [])
                for args, baseline in zip(variations, expected):
                    with self.subTest(parameters=tuple(args)):
                        self.assertEqual(snapshots.capture_message_snapshot(connection, **args), baseline)
            connection.execute("UPDATE public.message_source_ref SET raw_payload=%s WHERE owner_id=%s AND id=%s",
                               (Jsonb({"synthetic_revision": 2}), self.owner_id, extra))
            with snapshots.reuse_message_snapshots(connection):
                changed = snapshots.capture_message_snapshot(connection, **base)
            self.assertNotEqual(changed["source_refs"], expected[0]["source_refs"])
            connection.execute("DELETE FROM public.message_source_ref WHERE owner_id=%s AND id=%s",
                               (self.owner_id, extra))
            with snapshots.reuse_message_snapshots(connection):
                deleted = snapshots.capture_message_snapshot(connection, **base)
            self.assertEqual({UUID(ref["ref_id"]) for ref in deleted["source_refs"]}, ref_ids - {extra})

    def test_exception_releases_ref_rows_hashes_and_source_availability(self):
        _, source, message = self.import_contact("异常前的合成正文。")
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            refs = {row["id"] for row in connection.execute("SELECT id FROM public.message_source_ref "
                "WHERE owner_id=%s AND message_id=%s", (self.owner_id, message)).fetchall()}
            args = dict(owner_id=self.owner_id, message_ids={message}, ref_ids=refs)
            with self.assertRaisesRegex(RuntimeError, "合成中断"):
                with snapshots.reuse_message_snapshots(connection):
                    before = snapshots.capture_message_snapshot(connection, **args)
                    self.assertTrue(decision_sources_available(connection, owner_id=self.owner_id, evidence=before))
                    raise RuntimeError("合成中断")
            connection.execute("UPDATE public.message SET text_content='异常后已修改的合成正文' "
                "WHERE owner_id=%s AND id=%s", (self.owner_id, message))
            with snapshot_queries() as queries:
                after = snapshots.capture_message_snapshot(connection, **args)
            self.assertEqual(len(queries), 1, "异常退出后的调用必须重新读库")
            self.assertNotEqual(after["message_digests"], before["message_digests"])
            connection.execute("UPDATE public.source_document SET status='delete_requested' WHERE owner_id=%s AND id=%s",
                               (self.owner_id, source))
            self.assertFalse(decision_sources_available(connection, owner_id=self.owner_id, evidence=before))
            with snapshots.reuse_message_snapshots(connection):
                deleted = snapshots.capture_message_snapshot(connection, **args)
            self.assertEqual(deleted["message_ids"], [])
