"""合并后的迁移保留既有 096 历史，旧分叉账本明确拒绝。"""

import os
from pathlib import Path
import shutil
import tempfile
import unittest
from datetime import timedelta
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from notalone.database_migrations import MigrationError, migrate


MIGRATIONS = Path(__file__).resolve().parents[3] / "database/migrations"
MERGED_MIGRATIONS = (
    "097_persistent_extraction_schedule.sql",
    "098_import_statement_overview_invalidation.sql",
)


class MergedMigrationHistoryTest(unittest.TestCase):
    def setUp(self):
        instance = os.environ.get("NOTALONE_TEST_DATABASE_URL")
        if not instance:
            self.skipTest("必须显式提供隔离测试实例。")
        self.name = f"notalone_merged_history_{uuid4().hex}_test"
        self.url = make_conninfo(instance, dbname=self.name)
        self.admin = psycopg.connect(instance, dbname="postgres", autocommit=True)
        self.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(self.name)))
        self.addCleanup(self._drop_owned_database)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.prefix = Path(self.directory.name)

    def _drop_owned_database(self):
        try:
            self.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(self.name)))
            self.assertFalse(self.admin.execute(
                "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)", (self.name,),
            ).fetchone()[0])
        finally:
            self.admin.close()

    def _copy_prefix(self, version):
        for path in MIGRATIONS.glob("*.sql"):
            if int(path.name[:3]) <= version:
                shutil.copyfile(path, self.prefix / path.name)

    def _history(self):
        with psycopg.connect(self.url) as connection:
            return connection.execute(
                "SELECT name,checksum,applied_at FROM public.notalone_schema_migration ORDER BY name",
            ).fetchall()

    def test_existing_096_upgrades_to_098_without_rewriting_data_or_history(self):
        self._copy_prefix(96)
        self.assertEqual(len(migrate(self.url, self.prefix)), 96)
        owner, contact, source, message = (uuid4() for _ in range(4))
        with psycopg.connect(self.url) as connection:
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES (%s,'合成用户')", (owner,))
            connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,'合成联系人')", (owner, contact))
            connection.execute(
                "INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) "
                "VALUES (%s,%s,%s,'wechat_jsonl','synthetic.jsonl',%s,1)", (source, owner, contact, "b" * 64),
            )
            connection.execute(
                "INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content) "
                "VALUES (%s,%s,%s,'contact','text','合成升级前消息')", (message, owner, contact),
            )
            connection.execute(
                "INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) "
                "VALUES (%s,%s,%s,'source_document',%s,'jsonl:1','{}')", (message, owner, contact, source),
            )
            before = connection.execute("SELECT to_jsonb(m) FROM public.message m").fetchall()
        history = self._history()
        self.assertEqual(migrate(self.url, MIGRATIONS), MERGED_MIGRATIONS)
        self.assertEqual(self._history()[:96], history)
        with psycopg.connect(self.url) as connection:
            self.assertEqual(connection.execute("SELECT to_jsonb(m) FROM public.message m").fetchall(), before)
            self.assertEqual(connection.execute(
                "SELECT tgname,tgtype FROM pg_trigger WHERE tgrelid='public.message'::regclass "
                "AND tgname IN ('relationship_overview_message','relationship_overview_message_insert') ORDER BY tgname",
            ).fetchall(), [("relationship_overview_message", 25), ("relationship_overview_message_insert", 4)])
            self.assertIsNotNone(connection.execute("SELECT to_regclass('public.memory_extraction_schedule')").fetchone()[0])
        completed = self._history()
        self.assertEqual(len(completed), 98)
        self.assertEqual(migrate(self.url, MIGRATIONS), ())
        self.assertEqual(self._history(), completed)

    def test_old_main_089_branch_history_is_rejected_without_rewriting_ledger(self):
        self._copy_prefix(87)
        shutil.copyfile(MIGRATIONS / MERGED_MIGRATIONS[0], self.prefix / "088_persistent_extraction_schedule.sql")
        shutil.copyfile(MIGRATIONS / MERGED_MIGRATIONS[1], self.prefix / "089_import_statement_overview_invalidation.sql")
        self.assertEqual(len(migrate(self.url, self.prefix)), 89)
        before = self._history()
        with self.assertRaisesRegex(MigrationError, "migration_history_mismatch"):
            migrate(self.url, MIGRATIONS)
        self.assertEqual(self._history(), before)
        with psycopg.connect(self.url) as connection:
            self.assertIsNone(connection.execute("SELECT to_regclass('public.memory_processing_plan')").fetchone()[0])

    def test_cancelled_pending_tail_is_not_revived_by_new_observation(self):
        from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
        from notalone.persistence.extraction_schedule import claim_scope, record_messages, utcnow
        from notalone.persistence.locks import lock_contact_scope

        migrate(self.url, MIGRATIONS)
        owner, contact, binding = (uuid4() for _ in range(3))
        repository = PostgresBackgroundTaskRepository(self.url)
        with psycopg.connect(self.url) as connection:
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES (%s,'合成用户')", (owner,))
            connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,'合成联系人')", (owner, contact))
            connection.execute(
                "INSERT INTO public.conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator) "
                "VALUES (%s,%s,%s,'wechat','synthetic-account','synthetic-contact')", (binding, owner, contact),
            )

        def observe(number):
            observation, message = uuid4(), uuid4()
            with psycopg.connect(self.url) as connection:
                lock_contact_scope(connection, owner_id=owner, contact_id=contact)
                connection.execute(
                    "INSERT INTO public.local_wechat_observation(id,owner_id,contact_id,binding_id,mode,cli_version,"
                    "conversation_locator,last_local_id,last_cursor,record_count,event_count) "
                    "VALUES (%s,%s,%s,%s,'live','synthetic','synthetic-contact',%s,%s,1,1)",
                    (observation, owner, contact, binding, number, str(number)),
                )
                connection.execute(
                    "INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) "
                    "VALUES (%s,%s,%s,'contact','text','合成观察消息',clock_timestamp())", (message, owner, contact),
                )
                connection.execute(
                    "INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,observation_id,source_locator,raw_payload) "
                    "VALUES (%s,%s,%s,'local_wechat_observation',%s,%s,'{}')",
                    (message, owner, contact, observation, f"synthetic:{number}"),
                )
                record_messages(connection, owner_id=owner, contact_id=contact, observation_id=observation, message_ids=(message,))
            return message

        observe(1)
        with psycopg.connect(self.url) as connection:
            task = claim_scope(connection, repository, owner_id=owner, contact_id=contact)
            self.assertIsNotNone(task)
        old_tail = observe(2)
        with psycopg.connect(self.url) as connection:
            connection.execute("UPDATE public.background_task SET status='cancelled' WHERE id=%s", (task,))
            connection.execute("UPDATE public.background_task_step SET status='cancelled' WHERE task_id=%s", (task,))
            self.assertIsNone(claim_scope(connection, repository, owner_id=owner, contact_id=contact,
                                          now=utcnow() + timedelta(seconds=601)))
        new_message = observe(3)
        with psycopg.connect(self.url) as connection:
            self.assertEqual(claim_scope(connection, repository, owner_id=owner, contact_id=contact), task)
            self.assertEqual(connection.execute(
                "SELECT message_id FROM public.memory_processing_target WHERE task_id=%s", (task,),
            ).fetchall(), [(new_message,)])
            self.assertEqual(connection.execute(
                "SELECT task_id FROM public.memory_extraction_receipt WHERE message_id=%s", (old_tail,),
            ).fetchone(), (task,))
