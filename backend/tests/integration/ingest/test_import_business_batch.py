"""完整业务批写经公开入口保留跨批资料、回执、范围及原子性。"""

import json
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Event
import time
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg import sql

from notalone.ingest.import_command import import_file
from notalone.ingest.models import ExistingContactSelection, ImportConfirmationRequest
from notalone.memory_extraction.cli_support import load_contact_messages
from notalone.persistence.memory_overview import PostgresRelationshipOverviewStore
from notalone.persistence.postgres_repository import ImportPersistenceError, PostgresIngestRepository
from notalone.persistence.source_processing import PostgresSourceProcessingStore
from notalone.scopes import ContactScope


class ImportBusinessBatchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.database_url = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")
        if not cls.database_url:
            raise unittest.SkipTest("必须显式提供本任务隔离测试库。")
        with psycopg.connect(cls.database_url) as connection:
            if not connection.info.dbname.endswith("_test"):
                raise RuntimeError("业务批写测试只允许隔离测试库。")

    def setUp(self):
        self.scope = ContactScope(uuid4(), uuid4())
        self.other = ContactScope(self.scope.owner_id, uuid4())
        self.independent = ContactScope(self.scope.owner_id, uuid4())
        self.foreign = ContactScope(uuid4(), uuid4())
        self.owner_external_id = "synthetic_owner_" + uuid4().hex
        self.contact_external_id = "synthetic_contact_" + uuid4().hex
        with psycopg.connect(self.database_url) as connection:
            for owner in (self.scope.owner_id, self.foreign.owner_id):
                connection.execute("INSERT INTO public.owner(id,display_name) VALUES (%s,'合成用户')", (owner,))
            for scope in (self.scope, self.other, self.independent, self.foreign):
                connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,'合成联系人')",
                                   (scope.owner_id, scope.contact_id))
            connection.execute("INSERT INTO public.owner_channel_identity(owner_id,channel,external_id,observed_name) "
                               "VALUES (%s,'wechat',%s,'合成用户')", (self.scope.owner_id, self.owner_external_id))
        self.addCleanup(self.cleanup)
        self.repository = PostgresIngestRepository(self.database_url)
        self.processing = PostgresSourceProcessingStore(self.database_url)
        self.overviews = PostgresRelationshipOverviewStore(self.database_url)

    def cleanup(self):
        with psycopg.connect(self.database_url) as connection:
            connection.execute("DELETE FROM public.owner WHERE id=ANY(%s::uuid[])",
                               ([self.scope.owner_id, self.foreign.owner_id],))

    def records(self, count):
        for position in range(count):
            occurred = datetime.fromtimestamp(1786500000 + position, timezone.utc)
            yield {"id": {"local_id": 101 + position, "server_id_str": f"synthetic-{101 + position}",
                          "talker": self.contact_external_id},
                   "create_time": 1786500000 + position, "is_from_me": bool(position % 2), "kind": "text",
                   "sender": "合成用户" if position % 2 else "合成联系人",
                   "sender_wxid": self.owner_external_id if position % 2 else self.contact_external_id,
                   "text": f"合成正文{position:04d}", "time_iso": occurred.isoformat(),
                   "time": occurred.strftime("%Y-%m-%d %H:%M:%S")}

    def import_records(self, records):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic.jsonl"
            path.write_text("".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records), encoding="utf-8")
            return import_file(path=path, owner_id=self.scope.owner_id,
                               confirmation=ImportConfirmationRequest(ExistingContactSelection(self.scope.contact_id)),
                               repository=self.repository)

    def test_cross_block_and_oversized_record_keep_text_receipts_and_replay(self):
        records = list(self.records(502))
        escaped = "合成正文\t制表\n换行\\路径😀"
        records[0]["text"] = escaped
        oversized = "合成大正文" * 150_000
        self.assertGreater(len(oversized.encode("utf-8")), 2 * 1024 * 1024)
        records[250]["text"] = oversized
        first, repeated = self.import_records(records), self.import_records(records)
        self.assertEqual((first.outcome, repeated.outcome), ("imported", "already_imported"))
        self.assertEqual(first.source_document_id, repeated.source_document_id)
        messages = load_contact_messages(self.scope, self.database_url)
        self.assertEqual(len(messages), 502)
        self.assertEqual((messages[0].text, messages[250].text, messages[-1].text),
                         (escaped, oversized, "合成正文0501"))
        self.assertEqual(load_contact_messages(self.other, self.database_url), ())
        with psycopg.connect(self.database_url) as connection:
            stored = connection.execute(
                "SELECT message.text_content, message.media_placeholder, message.occurred_at, "
                "metadata.external_local_id, metadata.external_server_id, metadata.external_talker, "
                "metadata.source_create_time, ref.raw_payload, jsonb_typeof(ref.raw_payload) "
                "FROM public.message_source_ref AS ref "
                "JOIN public.message AS message ON message.id=ref.message_id "
                "JOIN public.wechat_message_metadata AS metadata ON metadata.message_id=message.id "
                "WHERE ref.owner_id=%s AND ref.contact_id=%s AND ref.source_document_id=%s "
                "AND ref.source_locator='jsonl:1'",
                (self.scope.owner_id, self.scope.contact_id, first.source_document_id),
            ).fetchone()
        self.assertEqual(stored[:7], (
            escaped, None, datetime.fromisoformat(records[0]["time_iso"]),
            records[0]["id"]["local_id"], records[0]["id"]["server_id_str"],
            self.contact_external_id, records[0]["create_time"],
        ))
        self.assertIsInstance(stored[7], dict)
        self.assertEqual(stored[7], records[0])
        self.assertEqual(stored[8], "object")
        for item in self.processing.list_batches(self.scope):
            batch = self.processing.get_batch(self.scope, item["batch_id"])
            self.assertEqual([row["position"] for row in batch["records"]], list(range(502)))
            self.assertEqual(batch["records"][250]["payload"]["parsed"]["text"], oversized)
            self.assertTrue(all(row["message_id"] and row["source_ref_id"] for row in batch["records"]))

    def test_late_source_ref_failure_restores_messages_trace_and_overviews(self):
        before = self.overviews.read_contact(self.scope)
        owner_before = self.overviews.read_owner(self.scope.owner_id)
        name = "synthetic_business_fault_" + uuid4().hex
        with psycopg.connect(self.database_url) as connection:
            connection.execute(sql.SQL("CREATE FUNCTION public.{name}() RETURNS trigger LANGUAGE plpgsql AS $$ "
                "BEGIN IF NEW.owner_id={owner}::uuid AND NEW.source_locator='jsonl:501' THEN "
                "RAISE EXCEPTION '合成后续来源引用失败'; END IF; RETURN NEW; END $$").format(
                    name=sql.Identifier(name), owner=sql.Literal(str(self.scope.owner_id))))
            connection.execute(sql.SQL("CREATE TRIGGER {name} BEFORE INSERT ON public.message_source_ref "
                "FOR EACH ROW EXECUTE FUNCTION public.{name}()").format(name=sql.Identifier(name)))
        def cleanup_fault():
            with psycopg.connect(self.database_url) as connection:
                connection.execute(sql.SQL("DROP TRIGGER {name} ON public.message_source_ref").format(name=sql.Identifier(name)))
                connection.execute(sql.SQL("DROP FUNCTION public.{name}()").format(name=sql.Identifier(name)))
        self.addCleanup(cleanup_fault)
        with self.assertRaises(ImportPersistenceError) as raised:
            self.import_records(self.records(502))
        self.assertIsNone(raised.exception.__cause__)
        self.assertEqual(load_contact_messages(self.scope, self.database_url), ())
        failed_batches = self.processing.list_batches(self.scope)
        self.assertEqual(len(failed_batches), 1)
        self.assertEqual((failed_batches[0]["status"], failed_batches[0]["source_id"]), ("failed", None))
        self.assertEqual(self.overviews.read_contact(self.scope), before)
        self.assertEqual(self.overviews.read_owner(self.scope.owner_id), owner_before)

    def test_skipped_source_ref_rejects_import_and_rolls_back_prior_blocks(self):
        name = "synthetic_business_skip_" + uuid4().hex
        with psycopg.connect(self.database_url) as connection:
            connection.execute(sql.SQL("CREATE FUNCTION public.{name}() RETURNS trigger LANGUAGE plpgsql AS $$ "
                "BEGIN IF NEW.owner_id={owner}::uuid AND NEW.source_locator='jsonl:501' THEN "
                "RETURN NULL; END IF; RETURN NEW; END $$").format(
                    name=sql.Identifier(name), owner=sql.Literal(str(self.scope.owner_id))))
            connection.execute(sql.SQL("CREATE TRIGGER {name} BEFORE INSERT ON public.message_source_ref "
                "FOR EACH ROW EXECUTE FUNCTION public.{name}()").format(name=sql.Identifier(name)))
        def cleanup_skip():
            with psycopg.connect(self.database_url) as connection:
                connection.execute(sql.SQL("DROP TRIGGER {name} ON public.message_source_ref").format(name=sql.Identifier(name)))
                connection.execute(sql.SQL("DROP FUNCTION public.{name}()").format(name=sql.Identifier(name)))
        self.addCleanup(cleanup_skip)
        with self.assertRaises(ImportPersistenceError) as raised:
            self.import_records(self.records(502))
        self.assertIsNone(raised.exception.__cause__)
        self.assertEqual(load_contact_messages(self.scope, self.database_url), ())
        with psycopg.connect(self.database_url) as connection:
            for table in ("source_document", "message_source_ref", "wechat_message_metadata"):
                count = connection.execute(sql.SQL("SELECT count(*) FROM public.{} WHERE owner_id=%s AND contact_id=%s").format(
                    sql.Identifier(table)), (self.scope.owner_id, self.scope.contact_id)).fetchone()[0]
                self.assertEqual(count, 0)
        failed_batches = self.processing.list_batches(self.scope)
        self.assertEqual(len(failed_batches), 1)
        self.assertEqual((failed_batches[0]["status"], failed_batches[0]["source_id"]), ("failed", None))

    def test_statement_insert_invalidates_dependencies_and_rollback_preserves_them(self):
        # 工程夹具直接写无来源消息，独立验证 message INSERT 的投影依赖范围。
        message_ids = [uuid4(), uuid4()]
        snapshots = {scope: self.overviews.read_contact(scope) for scope in (self.scope, self.other, self.independent, self.foreign)}
        owner_before = self.overviews.read_owner(self.scope.owner_id)
        foreign_owner_before = self.overviews.read_owner(self.foreign.owner_id)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.relationship_overview_projection SET source_ids=%s "
                               "WHERE owner_id=%s AND contact_id=%s", ([message_ids[1]], self.other.owner_id, self.other.contact_id))
        query = "INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content) VALUES " \
                "(%s,%s,%s,'contact','text','合成甲'),(%s,%s,%s,'contact','text','合成乙')"
        parameters = tuple(value for message in message_ids for value in (message, self.scope.owner_id, self.scope.contact_id))
        with psycopg.connect(self.database_url) as connection:
            connection.execute(query, parameters)
            connection.rollback()
        self.assertEqual(self.overviews.read_contact(self.scope), snapshots[self.scope])
        self.assertEqual(self.overviews.read_contact(self.other), snapshots[self.other])
        self.assertEqual(self.overviews.read_owner(self.scope.owner_id), owner_before)
        with psycopg.connect(self.database_url) as connection:
            connection.execute(query, parameters)
        self.assertGreater(self.overviews.read_contact(self.scope).built_at, snapshots[self.scope].built_at)
        self.assertGreater(self.overviews.read_contact(self.other).built_at, snapshots[self.other].built_at)
        self.assertGreater(self.overviews.read_owner(self.scope.owner_id).built_at, owner_before.built_at)
        self.assertEqual(self.overviews.read_contact(self.independent), snapshots[self.independent])
        self.assertEqual(self.overviews.read_contact(self.foreign), snapshots[self.foreign])
        self.assertEqual(self.overviews.read_owner(self.foreign.owner_id), foreign_owner_before)


    def test_source_ref_insert_keeps_dependency_identifiers_and_unrelated_scope(self):
        imported = self.import_records(self.records(2))
        message = load_contact_messages(self.scope, self.database_url)[0]
        foreign_before = self.overviews.read_contact(self.foreign)
        independent_before = self.overviews.read_contact(self.independent)
        for position, dependency_kind in enumerate(("ref", "message", "source")):
            ref_id = uuid4()
            dependency = {"ref": ref_id, "message": message.message_id,
                          "source": imported.source_document_id}[dependency_kind]
            before = self.overviews.read_contact(self.other)
            with psycopg.connect(self.database_url) as connection:
                connection.execute("UPDATE public.relationship_overview_projection SET source_ids=%s "
                    "WHERE owner_id=%s AND contact_id=%s", ([dependency], self.other.owner_id, self.other.contact_id))
                connection.execute("UPDATE public.relationship_overview_projection SET source_ids=%s "
                    "WHERE owner_id=%s AND contact_id=%s", ([dependency], self.foreign.owner_id, self.foreign.contact_id))
                # 工程夹具给同一消息添加独立来源定位，不改写已导入的来源。
                connection.execute("INSERT INTO public.message_source_ref "
                    "(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) "
                    "VALUES (%s,%s,%s,%s,'source_document',%s,%s,'{}')",
                    (ref_id, message.message_id, self.scope.owner_id, self.scope.contact_id,
                     imported.source_document_id, f"synthetic:extra:{position}"))
            self.assertGreater(self.overviews.read_contact(self.other).built_at, before.built_at)
            self.assertEqual(self.overviews.read_contact(self.foreign), foreign_before)
            self.assertEqual(self.overviews.read_contact(self.independent), independent_before)

    def test_insert_waiting_for_overview_build_invalidates_the_committed_projection(self):
        started, release = Event(), Event()
        def controlled_clock():
            started.set()
            if not release.wait(8):
                raise RuntimeError("合成概览重建门闩超时。")
            return datetime.now(timezone.utc)
        store = PostgresRelationshipOverviewStore(self.database_url, clock=controlled_clock)
        application_name = "synthetic_business_insert_" + uuid4().hex
        def insert_message():
            with psycopg.connect(self.database_url, application_name=application_name) as connection:
                connection.execute("INSERT INTO public.message(owner_id,contact_id,speaker,message_type,text_content) "
                    "VALUES (%s,%s,'contact','text','合成并发消息')", (self.scope.owner_id, self.scope.contact_id))
        with ThreadPoolExecutor(max_workers=2) as executor:
            building = executor.submit(store.read_contact, self.scope)
            try:
                self.assertTrue(started.wait(8))
                inserting = executor.submit(insert_message)
                deadline = time.monotonic() + 8
                pause = Event()
                with psycopg.connect(self.database_url, autocommit=True) as observing:
                    while not observing.execute("SELECT EXISTS(SELECT 1 FROM pg_stat_activity "
                        "WHERE datname=current_database() AND application_name=%s AND wait_event_type='Lock')",
                        (application_name,)).fetchone()[0]:
                        self.assertFalse(inserting.done())
                        self.assertLess(time.monotonic(), deadline)
                        pause.wait(0.01)
            finally:
                release.set()
            before = building.result(timeout=8)
            inserting.result(timeout=8)
        self.assertGreater(self.overviews.read_contact(self.scope).built_at, before.built_at)
