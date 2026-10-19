"""089 从真实 088/063 旧触发器升级，失败回滚且不改写已有资料。"""

import os
from pathlib import Path
import shutil
import tempfile
import unittest
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from notalone.database_migrations import MigrationError, migrate
from notalone.memory_extraction.cli_support import load_contact_messages
from notalone.persistence.memory_overview import PostgresRelationshipOverviewStore
from notalone.scopes import ContactScope


class ImportStatementMigrationTest(unittest.TestCase):
    def test_real_088_upgrade_preserves_data_failure_rolls_back_and_repeat_is_noop(self):
        instance = os.environ.get("NOTALONE_TEST_DATABASE_URL")
        if not instance:
            self.skipTest("必须显式提供隔离测试库。")
        name = f"notalone_business_upgrade_{uuid4().hex}_test"
        database = make_conninfo(instance, dbname=name)
        migrations = Path(__file__).resolve().parents[3] / "database/migrations"
        scope = ContactScope(uuid4(), uuid4())
        source, message = uuid4(), uuid4()
        with psycopg.connect(instance, dbname="postgres", autocommit=True) as admin:
            admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(name)))
            try:
                with tempfile.TemporaryDirectory() as directory:
                    prefix = Path(directory)
                    for path in migrations.glob("*.sql"):
                        if int(path.name[:3]) <= 88:
                            shutil.copyfile(path, prefix / path.name)
                    self.assertEqual(len(migrate(database, prefix)), 88)
                    with psycopg.connect(database) as connection:
                        connection.execute("INSERT INTO public.owner(id,display_name) VALUES (%s,'合成用户')", (scope.owner_id,))
                        connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,'合成联系人')",
                                           (scope.owner_id, scope.contact_id))
                        connection.execute("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,"
                            "file_name,content_sha256,record_count) VALUES (%s,%s,%s,'wechat_jsonl','synthetic.jsonl',%s,1)",
                            (source, scope.owner_id, scope.contact_id, "a" * 64))
                        connection.execute("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content) "
                            "VALUES (%s,%s,%s,'contact','text','升级前的合成正文')", (message, scope.owner_id, scope.contact_id))
                        connection.execute("INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,"
                            "source_document_id,source_locator,raw_payload) VALUES (%s,%s,%s,'source_document',%s,'jsonl:1','{}')",
                            (message, scope.owner_id, scope.contact_id, source))
                    before = load_contact_messages(scope, database)
                    overview = PostgresRelationshipOverviewStore(database).read_contact(scope)
                    current = migrations / "089_import_statement_overview_invalidation.sql"
                    (prefix / current.name).write_text(current.read_text().replace(
                        "COMMIT;", "SELECT synthetic_business_migration_failure();\nCOMMIT;"))
                    with self.assertRaises(MigrationError):
                        migrate(database, prefix)
                    with psycopg.connect(database) as connection:
                        self.assertEqual(connection.execute("SELECT count(*) FROM public.notalone_schema_migration").fetchone()[0], 88)
                        # 失败时仍保留 063 的 INSERT/UPDATE/DELETE 逐行触发器。
                        self.assertEqual(connection.execute("SELECT tgtype FROM pg_trigger WHERE tgrelid='public.message'::regclass "
                            "AND tgname='relationship_overview_message'").fetchone()[0], 29)
                    self.assertEqual(load_contact_messages(scope, database), before)
                    self.assertEqual(PostgresRelationshipOverviewStore(database).read_contact(scope), overview)
                    self.assertEqual(migrate(database, migrations), (current.name,))
                    self.assertEqual(migrate(database, migrations), ())
                    self.assertEqual(load_contact_messages(scope, database), before)
                    self.assertEqual(PostgresRelationshipOverviewStore(database).read_contact(scope), overview)
            finally:
                admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
                self.assertFalse(admin.execute("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)", (name,)).fetchone()[0])
                print("业务迁移自有库精确清理核验通过", flush=True)
