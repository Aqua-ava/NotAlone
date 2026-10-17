"""063 从真实 062 用户资料向前升级，旧证明与人工决定均保持原值。"""

import os
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from notalone.database_migrations import MigrationError, migrate
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture


CURRENT_MIGRATION_TAIL = (
    "063_relationship_overview_projection.sql",
    "064_owner_memory_revision.sql",
    "065_expression_preferences.sql",
    "066_skill_learning_drafts.sql",
    "067_memory_upgrade_batches.sql",
    "068_skill_review_publication.sql",
    "069_skill_history_operations.sql",
    "070_skill_scope_policies.sql",
    "071_bounded_runtime_evidence.sql",
    "072_scoped_media_lifecycle.sql",
)


class RelationshipOverviewForwardUpgradeHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        pass

    def setUp(self) -> None:
        self.database_name = f"notalone_05_forward_{uuid4().hex}_test"
        instance = os.environ["NOTALONE_TEST_DATABASE_URL"]
        self.database_url = make_conninfo(instance, dbname=self.database_name)
        self.admin = psycopg.connect(instance, dbname="postgres", autocommit=True)
        self.ownership = tempfile.TemporaryDirectory(prefix="notalone05-forward-")
        self.addCleanup(self.ownership.cleanup)
        ownership = Path(self.ownership.name) / "database-ownership.json"
        ownership.write_text(json.dumps({"database_name": self.database_name,
                                         "child_pid": os.getpid(), "phase": "planned"}))
        ownership.chmod(0o600)
        self.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(self.database_name)))
        self.addCleanup(self._drop_database)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute("SELECT current_database()").fetchone()[0], self.database_name)
        binding = patch.dict(os.environ, NOTALONE_DATABASE_URL=self.database_url,
                             NOTALONE_TEST_DATABASE_URL=self.database_url,
                             NOTALONE_EXPECTED_TEST_DATABASE=self.database_name)
        binding.start()
        self.addCleanup(binding.stop)
        self.old_migrations = tempfile.TemporaryDirectory()
        self.addCleanup(self.old_migrations.cleanup)
        self.migrations = Path(__file__).resolve().parents[3] / "database/migrations"
        for path in sorted(self.migrations.glob("*.sql")):
            if int(path.name[:3]) <= 62:
                shutil.copyfile(path, Path(self.old_migrations.name) / path.name)
        self.assertEqual(len(migrate(self.database_url, Path(self.old_migrations.name))), 62)
        super().setUp()

    def _drop_database(self) -> None:
        try:
            self.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(self.database_name)))
            self.assertFalse(self.admin.execute("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)",
                                               (self.database_name,)).fetchone()[0])
        finally:
            self.admin.close()

    def test_actual_062_memory_and_unknown_event_survive_upgrade_and_repeat_without_rewrites(self):
        contact, _, message = self.import_contact("合成升级经历：双方已初次相识。")
        memory = self.confirm(contact, "双方已初次相识。", message)
        status, corrected = self.backend.request(f"/api/contacts/{contact}/memories/{memory['memory_id']}/correct", {
            "text": "双方已首次见面。",
        })
        self.assertEqual(status, 200, corrected)
        tables = ("confirmed_memory", "memory_candidate", "memory_correction_decision", "message_source_ref")
        with psycopg.connect(self.database_url) as connection:
            before = {table: connection.execute(sql.SQL("SELECT to_jsonb(record) FROM public.{} record ORDER BY id")
                .format(sql.Identifier(table))).fetchall() for table in tables}
            history = connection.execute("SELECT name,checksum FROM public.notalone_schema_migration ORDER BY name").fetchall()
            self.assertIsNone(connection.execute("SELECT to_regclass('public.relationship_overview_projection')").fetchone()[0])
        self.assertEqual(migrate(self.database_url, self.migrations), CURRENT_MIGRATION_TAIL)
        self.assertEqual(migrate(self.database_url, self.migrations), ())
        with psycopg.connect(self.database_url) as connection:
            for table in tables:
                # 071 只为旧记忆追加 any 默认值，原字段与证明仍须逐字保持。
                expected = ([({**record, "source_dependency_mode": "any"},) for record, in before[table]]
                            if table in {"confirmed_memory", "memory_candidate"} else before[table])
                self.assertEqual(connection.execute(sql.SQL("SELECT to_jsonb(record) FROM public.{} record ORDER BY id")
                    .format(sql.Identifier(table))).fetchall(), expected)
            self.assertEqual(connection.execute("SELECT name,checksum FROM public.notalone_schema_migration "
                                               "WHERE left(name,3)::int<=62 ORDER BY name").fetchall(), history)
        overview = self.overview(contact, backend=self._backend(self.owner_id))
        self.assertEqual(len(overview["entries"]), 2)
        self.assertTrue(all(entry["memory"]["event"] is None for entry in overview["entries"]))
        self.assertEqual(overview["entries"][0]["current_leaf"], {
            "memory_id": corrected["memory"]["memory_id"], "revision": corrected["memory"]["revision"],
        })

    def test_063_failure_rolls_back_schema_and_ledger_then_recovers(self):
        selected = "063_relationship_overview_projection.sql"
        broken = Path(self.old_migrations.name) / selected
        broken.write_bytes((self.migrations / selected).read_bytes() + b"\nSELECT synthetic_missing_05();\n")
        with self.assertRaisesRegex(MigrationError, "migration_failed"):
            migrate(self.database_url, Path(self.old_migrations.name))
        with psycopg.connect(self.database_url) as connection:
            self.assertIsNone(connection.execute("SELECT to_regclass('public.relationship_overview_projection')").fetchone()[0])
            self.assertEqual(connection.execute("SELECT count(*) FROM public.notalone_schema_migration").fetchone()[0], 62)
        self.assertEqual(migrate(self.database_url, self.migrations), CURRENT_MIGRATION_TAIL)
        self.assertEqual(migrate(self.database_url, self.migrations), ())

    def test_063_has_exact_invalidation_closure_and_scope_foreign_keys(self):
        migrate(self.database_url, self.migrations)
        with psycopg.connect(self.database_url) as connection:
            triggers = connection.execute("SELECT relation.relname, trigger.tgtype FROM pg_trigger trigger "
                "JOIN pg_class relation ON relation.oid=trigger.tgrelid "
                "WHERE trigger.tgfoid='public.invalidate_relationship_overview_projection()'::regprocedure").fetchall()
            self.assertEqual(set(triggers), {(table, 29) for table in (
                "confirmed_memory", "memory_candidate", "source_document", "message", "message_source_ref",
                "local_wechat_observation", "memory_correction_decision", "owner_memory",
                "memory_extraction_trace_dependency", "memory_extraction_trace_link")})
            self.assertEqual(len(triggers), 10)
            self.assertEqual(connection.execute("SELECT count(*) FROM pg_constraint WHERE "
                "conrelid='public.relationship_overview_projection'::regclass AND contype='f' AND confdeltype='c'").fetchone()[0], 2)
            self.assertEqual(connection.execute("SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND "
                "tablename='relationship_overview_projection' AND indexdef LIKE 'CREATE UNIQUE INDEX%'").fetchone()[0], 2)
