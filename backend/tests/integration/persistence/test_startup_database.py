"""启动时在本轮隔离库补齐结构，不复制资料或创建备份。"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from notalone.database_migrations import migrate


ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS = ROOT / "database/migrations"


class StartupDatabaseTest(unittest.TestCase):
    def setUp(self) -> None:
        instance = os.environ.get("NOTALONE_TEST_DATABASE_URL", "host=/tmp dbname=notalone_test")
        self.name = f"notalone_startup_{uuid4().hex}_test"
        self.url = make_conninfo(instance, dbname=self.name)
        self.admin = psycopg.connect(make_conninfo(instance, dbname="postgres"), autocommit=True)
        self.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(self.name)))
        self.addCleanup(self._drop)
        self.temporary = tempfile.TemporaryDirectory(prefix="notalone-startup-schema-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def _drop(self) -> None:
        try:
            self.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(self.name)))
        finally:
            self.admin.close()

    def _run(self) -> dict:
        result = subprocess.run(
            [sys.executable, "-m", "notalone.startup_database", "--migrations", str(MIGRATIONS)],
            cwd=self.directory, text=True, capture_output=True, timeout=45,
            env={**os.environ, "PYTHONPATH": str(ROOT / "src"), "NOTALONE_DISABLE_DOTENV": "1",
                 "NOTALONE_DATABASE_URL": self.url, "NOTALONE_MANAGED_USER_DATA": str(self.directory)},
        )
        self.assertEqual(result.stderr, "")
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0 if report["code"] == "ready" else 1)
        self.assertEqual(list(self.directory.iterdir()), [])
        return report

    def _old_schema(self) -> None:
        with tempfile.TemporaryDirectory() as prefix:
            for migration in sorted(MIGRATIONS.glob("*.sql"))[:59]:
                shutil.copyfile(migration, Path(prefix) / migration.name)
            migrate(self.url, Path(prefix))

    def test_existing_059_keeps_database_and_contact_then_repeats_without_reapplying(self) -> None:
        self._old_schema()
        owner, contact = uuid4(), uuid4()
        with psycopg.connect(self.url) as connection:
            identity = connection.execute("SELECT oid FROM pg_database WHERE datname=current_database()").fetchone()[0]
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成结构用户')", (owner,))
            connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES(%s,%s,'合成保留联系人')", (owner, contact))
        report = self._run()
        self.assertEqual(report["code"], "ready")
        self.assertEqual(len(report["applied"]), 13)
        with psycopg.connect(self.url) as connection:
            self.assertEqual(connection.execute("SELECT oid FROM pg_database WHERE datname=current_database()").fetchone()[0], identity)
            self.assertEqual(connection.execute("SELECT display_name FROM public.contact WHERE owner_id=%s AND id=%s", (owner, contact)).fetchone()[0], "合成保留联系人")
            self.assertIsNotNone(connection.execute("SELECT to_regclass('public.manual_contact_confirmation')").fetchone()[0])
            self.assertIsNotNone(connection.execute("SELECT to_regclass('public.media_attempt')").fetchone()[0])
            ledger = connection.execute("SELECT name,checksum,applied_at FROM public.notalone_schema_migration ORDER BY name").fetchall()
        self.assertEqual(self._run(), {"code": "ready", "applied": []})
        with psycopg.connect(self.url) as connection:
            self.assertEqual(connection.execute("SELECT name,checksum,applied_at FROM public.notalone_schema_migration ORDER BY name").fetchall(), ledger)

    def test_fresh_database_initializes_current_schema(self) -> None:
        report = self._run()
        self.assertEqual(report["code"], "ready")
        self.assertEqual(len(report["applied"]), 73)
        self.assertEqual(self._run(), {"code": "ready", "applied": []})

    def test_other_connections_block_schema_change_without_creating_missing_table(self) -> None:
        self._old_schema()
        with psycopg.connect(self.url):
            self.assertEqual(self._run()["code"], "database_writers_present")
        with psycopg.connect(self.url) as connection:
            self.assertIsNone(connection.execute("SELECT to_regclass('public.manual_contact_confirmation')").fetchone()[0])
        self.assertEqual(self._run()["code"], "ready")

    def test_untracked_existing_objects_are_not_adopted(self) -> None:
        with psycopg.connect(self.url) as connection:
            connection.execute("CREATE TABLE public.original_only(id integer)")
        self.assertEqual(self._run()["code"], "baseline_missing")
        with psycopg.connect(self.url) as connection:
            self.assertIsNone(connection.execute("SELECT to_regclass('public.notalone_schema_migration')").fetchone()[0])

    def test_concurrent_schema_lock_is_respected_and_can_retry(self) -> None:
        self._old_schema()
        with psycopg.connect(self.url, autocommit=True) as connection:
            connection.execute("SELECT pg_catalog.pg_advisory_lock(1852798049, 1)")
            self.assertEqual(self._run()["code"], "migration_busy")
            self.assertIsNone(connection.execute("SELECT to_regclass('public.manual_contact_confirmation')").fetchone()[0])
        self.assertEqual(self._run()["code"], "ready")

    def test_changed_history_is_rejected_without_new_schema(self) -> None:
        self._old_schema()
        with psycopg.connect(self.url) as connection:
            connection.execute("UPDATE public.notalone_schema_migration SET checksum='synthetic-drift' WHERE name='001_initial_ingest.sql'")
        self.assertEqual(self._run()["code"], "migration_history_mismatch")
        with psycopg.connect(self.url) as connection:
            self.assertIsNone(connection.execute("SELECT to_regclass('public.manual_contact_confirmation')").fetchone()[0])

    def test_incomplete_existing_contract_stops_before_new_versions(self) -> None:
        self._old_schema()
        with psycopg.connect(self.url) as connection:
            connection.execute("ALTER TABLE public.contact DROP COLUMN display_name")
        self.assertEqual(self._run()["code"], "schema_incomplete")
        with psycopg.connect(self.url) as connection:
            self.assertIsNone(connection.execute("SELECT to_regclass('public.manual_contact_confirmation')").fetchone()[0])


if __name__ == "__main__":
    unittest.main()
