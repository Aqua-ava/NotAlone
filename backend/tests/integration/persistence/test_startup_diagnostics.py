"""公开只读诊断命令验收；不读取既有业务库或默认配置。"""

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

from notalone.database_baseline import BASELINE_MANIFEST
from notalone.database_migrations import migrate


ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS = ROOT / "database/migrations"


class StartupDiagnosticCommandTest(unittest.TestCase):
    def setUp(self) -> None:
        self.name = f"notalone_diagnostic_{uuid4().hex}_test"
        self.url = f"host=/tmp dbname={self.name}"
        self.admin = psycopg.connect("host=/tmp dbname=postgres", autocommit=True)
        self.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(self.name)))
        self.addCleanup(self._drop_database)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def _drop_database(self) -> None:
        try:
            self.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(self.name)))
        finally:
            self.admin.close()

    def _run(self, *, url: str | None = None, migrations: Path = MIGRATIONS) -> dict[str, str]:
        environment = dict(os.environ, PYTHONPATH=str(ROOT / "src"),
                           NOTALONE_DISABLE_DOTENV="1", NOTALONE_ENV_FILE=str(Path(self.temp.name) / "synthetic.env"),
                           NOTALONE_BACKEND_INFO=str(Path(self.temp.name) / "backend.info"),
                           NOTALONE_DATABASE_URL=self.url if url is None else url,
                           NOTALONE_OWNER_ID="", DEEPSEEK_API_KEY="",
                           NOTALONE_WECHAT_CLI=str(Path(self.temp.name) / "unavailable-cli"),
                           NOTALONE_SYNC_PROBE=str(Path(self.temp.name) / "unavailable-probe"))
        result = subprocess.run([sys.executable, "-m", "notalone.startup_diagnostics", "--migrations", str(migrations)],
                                cwd=ROOT.parent, env=environment, text=True, capture_output=True, timeout=15)
        self.assertEqual(result.stderr, "")
        report = json.loads(result.stdout)
        self.assertEqual(set(report), {"code"})
        self.assertEqual(result.returncode, 0 if report["code"] == "ready" else 1)
        return report

    def test_ready_with_no_business_read_or_write_privileges(self) -> None:
        migrate(self.url, MIGRATIONS)
        role = f"notalone_diagnostic_{uuid4().hex}"
        self.admin.execute(sql.SQL("CREATE ROLE {} LOGIN NOCREATEDB").format(sql.Identifier(role)))
        try:
            with psycopg.connect(self.url) as connection:
                connection.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(sql.Identifier(role)))
                connection.execute(sql.SQL("GRANT SELECT ON public.notalone_schema_migration TO {}").format(sql.Identifier(role)))
            self.assertEqual(self._run(url=f"{self.url} user={role}"), {"code": "ready"})
        finally:
            with psycopg.connect(self.url) as connection:
                connection.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(role)))
            self.admin.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(role)))

    def test_empty_database_reports_pending_without_creating_ledger(self) -> None:
        self.assertEqual(self._run(), {"code": "migration_pending"})
        with psycopg.connect(self.url) as connection:
            self.assertIsNone(connection.execute("SELECT to_regclass('public.notalone_schema_migration')").fetchone()[0])

    def test_untracked_existing_schema_requires_baseline(self) -> None:
        migrate(self.url, MIGRATIONS)
        with psycopg.connect(self.url) as connection:
            connection.execute("DROP TABLE public.notalone_schema_migration")
        self.assertEqual(self._run(), {"code": "baseline_missing"})

    def test_ledger_drift_and_missing_schema_are_distinct(self) -> None:
        migrate(self.url, MIGRATIONS)
        with psycopg.connect(self.url) as connection:
            checksum = connection.execute("SELECT checksum FROM public.notalone_schema_migration WHERE name = '001_initial_ingest.sql'").fetchone()[0]
            connection.execute("UPDATE public.notalone_schema_migration SET checksum = 'synthetic-drift' WHERE name = '001_initial_ingest.sql'")
        self.assertEqual(self._run(), {"code": "migration_history_mismatch"})
        with psycopg.connect(self.url) as connection:
            connection.execute("UPDATE public.notalone_schema_migration SET checksum = %s WHERE name = '001_initial_ingest.sql'", (checksum,))
            connection.execute("ALTER TABLE public.contact DROP COLUMN display_name")
        self.assertEqual(self._run(), {"code": "schema_incomplete"})

    def test_owner_creation_timestamp_is_required_and_can_be_restored(self) -> None:
        migrate(self.url, MIGRATIONS)
        with psycopg.connect(self.url) as connection:
            connection.execute("ALTER TABLE public.owner DROP COLUMN created_at")
        self.assertEqual(self._run(), {"code": "schema_incomplete"})
        # 本轮空测试库恢复迁移原定义；产品诊断不会执行此 DDL。
        with psycopg.connect(self.url) as connection:
            connection.execute("ALTER TABLE public.owner ADD COLUMN created_at timestamptz NOT NULL DEFAULT now()")
        self.assertEqual(self._run(), {"code": "ready"})

    def test_audited_baseline_with_only_real_subsequent_ledger_is_ready(self) -> None:
        migrate(self.url, MIGRATIONS)
        with psycopg.connect(self.url) as connection:
            connection.execute("""
                CREATE TABLE public.notalone_schema_baseline (
                    format_version integer, through_version integer, manifest jsonb,
                    backup_sha256 text, restore_verified_at timestamptz
                )
            """)
            connection.execute("INSERT INTO public.notalone_schema_baseline VALUES (1, 35, %s::jsonb, %s, now())",
                               (json.dumps([{"name": name, "checksum": checksum} for name, checksum in BASELINE_MANIFEST]), "a" * 64))
            connection.execute("DELETE FROM public.notalone_schema_migration WHERE name <= '035_extraction_watermark_cascade.sql'")
        self.assertEqual(self._run(), {"code": "ready"})
        with psycopg.connect(self.url) as connection:
            connection.execute("UPDATE public.notalone_schema_baseline SET backup_sha256 = NULL")
        self.assertEqual(self._run(), {"code": "baseline_invalid"})

    def test_baseline_view_is_rejected_without_querying_business_fields(self) -> None:
        migrate(self.url, MIGRATIONS)
        with psycopg.connect(self.url) as connection:
            connection.execute("CREATE VIEW public.notalone_schema_baseline AS SELECT display_name AS format_version FROM public.owner")
        self.assertEqual(self._run(), {"code": "baseline_invalid"})

    def test_database_configuration_and_connection_failures_are_safe(self) -> None:
        self.assertEqual(self._run(url=""), {"code": "database_unconfigured"})
        self.assertEqual(self._run(url=f"postgresql://synthetic-secret@127.0.0.1:1/{self.name}"), {"code": "database_unavailable"})

    def test_later_repository_migration_reports_pending_without_execution(self) -> None:
        migrate(self.url, MIGRATIONS)
        directory = Path(self.temp.name) / "migrations"
        shutil.copytree(MIGRATIONS, directory)
        next_version = len(list(directory.glob("*.sql"))) + 1
        (directory / f"{next_version:03}_synthetic_pending.sql").write_text("CREATE TABLE public.unexecuted_probe (id int);", encoding="utf-8")
        self.assertEqual(self._run(migrations=directory), {"code": "migration_pending"})
        with psycopg.connect(self.url) as connection:
            self.assertIsNone(connection.execute("SELECT to_regclass('public.unexecuted_probe')").fetchone()[0])

    def test_pre_manual_schema_is_pending_without_creating_confirmation_table(self) -> None:
        previous = Path(self.temp.name) / "previous-migrations"
        previous.mkdir()
        for migration in sorted(MIGRATIONS.glob("*.sql")):
            if migration.name < "060_":
                shutil.copy2(migration, previous / migration.name)
        migrate(self.url, previous)
        self.assertEqual(self._run(), {"code": "migration_pending"})
        with psycopg.connect(self.url) as connection:
            self.assertIsNone(connection.execute("SELECT to_regclass('public.manual_contact_confirmation')").fetchone()[0])
            self.assertEqual(connection.execute("SELECT count(*) FROM public.notalone_schema_migration").fetchone()[0], 59)

    def test_latest_ledger_without_manual_confirmation_table_fails_before_business_starts(self) -> None:
        migrate(self.url, MIGRATIONS)
        with psycopg.connect(self.url) as connection:
            connection.execute("DROP TABLE public.manual_contact_confirmation")
        self.assertEqual(self._run(), {"code": "schema_incomplete"})
