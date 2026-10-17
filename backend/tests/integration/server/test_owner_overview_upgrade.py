"""064 从真实 063 本人资料前向升级，保持旧 NULL、人工决定和来源。"""

import json
import os
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
from notalone.memory.models import FactSubject
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server import test_owner_memory_overview as owner_support


CURRENT_MIGRATION_TAIL = (
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


class OwnerOverviewForwardUpgradeHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    owner_overview = owner_support.OwnerMemoryOverviewHttpTest.owner_overview
    add_owner = owner_support.OwnerMemoryOverviewHttpTest.add_owner
    import_self = owner_support.OwnerMemoryOverviewHttpTest.import_self

    @classmethod
    def setUpClass(cls):
        pass

    def setUp(self):
        self.database_name = f"notalone_06_forward_{uuid4().hex}_test"
        instance = os.environ["NOTALONE_TEST_DATABASE_URL"]
        self.database_url = make_conninfo(instance, dbname=self.database_name)
        self.admin = psycopg.connect(instance, dbname="postgres", autocommit=True)
        self.ownership = tempfile.TemporaryDirectory(prefix="notalone06-forward-")
        self.addCleanup(self.ownership.cleanup)
        descriptor = os.open(Path(self.ownership.name) / "database-ownership.json",
                             os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w") as record:
            json.dump({"database_name": self.database_name, "child_pid": os.getpid(), "phase": "planned"}, record)
            record.flush()
            os.fsync(record.fileno())
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
            if int(path.name[:3]) <= 63:
                shutil.copyfile(path, Path(self.old_migrations.name) / path.name)
        self.assertEqual(len(migrate(self.database_url, Path(self.old_migrations.name))), 63)
        super().setUp()

    def _drop_database(self):
        try:
            self.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(self.database_name)))
            self.assertFalse(self.admin.execute("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)",
                                               (self.database_name,)).fetchone()[0])
        finally:
            self.admin.close()

    def test_actual_063_owner_rows_upgrade_without_rewriting_proof_and_revision_changes_transactionally(self):
        contact, _, message = self.import_self("本人偏好热茶。")
        original = self.confirm(contact, "本人偏好热茶。", message, subject=FactSubject.SELF,
                                category="preference")
        status, corrected = self.backend.request(f"/api/memories/owner/{original['memory_id']}/correct", {
            "text": "本人偏好温茶。",
        })
        self.assertEqual(status, 200, corrected)
        manual = self.add_owner("本人已毕业。")
        tables = ("owner_memory", "memory_candidate", "memory_correction_decision", "message", "message_source_ref")
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.memory_candidate SET correction_evidence=NULL "
                               "WHERE owner_id=%s AND id=%s", (self.owner_id, original["source_candidate_id"]))
            before = {table: connection.execute(sql.SQL("SELECT to_jsonb(record) FROM public.{} record ORDER BY id")
                .format(sql.Identifier(table))).fetchall() for table in tables}
            history = connection.execute("SELECT name,checksum FROM public.notalone_schema_migration ORDER BY name").fetchall()
            self.assertIsNone(connection.execute("SELECT to_regclass('public.owner_memory_state')").fetchone()[0])
        self.assertEqual(migrate(self.database_url, self.migrations), CURRENT_MIGRATION_TAIL)
        self.assertEqual(migrate(self.database_url, self.migrations), ())
        with psycopg.connect(self.database_url) as connection:
            for table in tables:
                # 071 只为旧记忆追加 any 默认值，原字段与证明仍须逐字保持。
                expected = ([({**record, "source_dependency_mode": "any"},) for record, in before[table]]
                            if table in {"owner_memory", "memory_candidate"} else before[table])
                self.assertEqual(connection.execute(sql.SQL("SELECT to_jsonb(record) FROM public.{} record ORDER BY id")
                    .format(sql.Identifier(table))).fetchall(), expected)
            self.assertEqual(connection.execute("SELECT name,checksum FROM public.notalone_schema_migration "
                "WHERE left(name,3)::int<=63 ORDER BY name").fetchall(), history)
        snapshot = self.owner_overview()
        self.assertEqual(snapshot["memory_revision"], 0)
        self.assertEqual(len(snapshot["entries"]), 3)
        self.assertEqual(snapshot["entries"][0]["provenance"]["kind"], "unknown")
        self.assertEqual(self.owner_overview()["projection_revision"], snapshot["projection_revision"])
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.owner_memory SET text_content=text_content WHERE owner_id=%s", (self.owner_id,))
        self.assertEqual(self.owner_overview()["memory_revision"], 0)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.owner_memory SET text_content='合成待回滚正文。' WHERE owner_id=%s AND id=%s",
                               (self.owner_id, manual["memory_id"]))
            connection.rollback()
        self.assertEqual(self.owner_overview(), snapshot)
        fresh = self.add_owner("本人偏好纸质书。", category="preference")
        changed = self.owner_overview()
        self.assertEqual(changed["memory_revision"], 1)
        path = f"/api/memories/owner/{fresh['memory_id']}/delete"
        self.assertEqual(self.backend.request(path, {})[0], 200)
        deleted = self.owner_overview()
        self.assertGreater(deleted["memory_revision"], changed["memory_revision"])
        self.assertEqual(self.backend.request(path, {})[0], 200)
        self.assertEqual(self.owner_overview(), deleted)
        self.assertNotIn(fresh["memory_id"], str(deleted))

    def test_064_failure_is_atomic_and_both_projection_and_collection_triggers_survive_recovery(self):
        selected = "064_owner_memory_revision.sql"
        broken = Path(self.old_migrations.name) / selected
        broken.write_bytes((self.migrations / selected).read_bytes() + b"\nSELECT synthetic_missing_06();\n")
        with self.assertRaisesRegex(MigrationError, "migration_failed"):
            migrate(self.database_url, Path(self.old_migrations.name))
        with psycopg.connect(self.database_url) as connection:
            self.assertIsNone(connection.execute("SELECT to_regclass('public.owner_memory_state')").fetchone()[0])
            self.assertEqual(connection.execute("SELECT count(*) FROM public.notalone_schema_migration").fetchone()[0], 63)
        self.assertEqual(migrate(self.database_url, self.migrations), CURRENT_MIGRATION_TAIL)
        self.assertEqual(migrate(self.database_url, self.migrations), ())
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM pg_trigger WHERE "
                "tgfoid='public.invalidate_relationship_overview_projection()'::regprocedure").fetchone()[0], 10)
            self.assertEqual(connection.execute("SELECT count(*) FROM pg_trigger WHERE "
                "tgfoid='public.advance_owner_memory_revision()'::regprocedure AND tgtype=29 "
                "AND tgrelid='public.owner_memory'::regclass").fetchone()[0], 1)
        self.assertEqual(self.owner_overview()["memory_revision"], 0)
