"""迁移命令的隔离数据库验收；不复用现有业务库或共享测试库。"""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from uuid import uuid4

import psycopg
from psycopg import sql


ROOT = Path(__file__).resolve().parents[3]


class DatabaseMigrationCommandTest(unittest.TestCase):
    def setUp(self) -> None:
        self.database_name = f"notalone_migration_{uuid4().hex}_test"
        # 显式使用本机管理库，仅创建本用例拥有的随机测试库。
        self.admin = psycopg.connect("host=/tmp dbname=postgres", autocommit=True)
        self.admin.execute(
            sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(
                sql.Identifier(self.database_name)
            )
        )
        self.addCleanup(self._drop_database)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.migrations = Path(self.directory.name)

    def _drop_database(self) -> None:
        try:
            self.admin.execute(
                sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                    sql.Identifier(self.database_name)
                )
            )
        finally:
            self.admin.close()

    def _write(self, name: str, body: str) -> None:
        (self.migrations / name).write_text(body, encoding="utf-8")

    def _run(self, *, directory: Path | None = None) -> subprocess.CompletedProcess:
        env = dict(os.environ)
        env["NOTALONE_DATABASE_URL"] = f"host=/tmp dbname={self.database_name}"
        return subprocess.run(
            [sys.executable, "-m", "notalone.database_migrations",
             "--migrations", str(directory or self.migrations)],
            cwd=ROOT, env=env, text=True, capture_output=True, timeout=60,
        )

    def test_fresh_install_and_repeat_do_not_reapply_completed_sql(self) -> None:
        self._write("001_start.sql", "BEGIN;\nCREATE TABLE public.probe (id int);\nCOMMIT;\n")
        first = self._run()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(json.loads(first.stdout)["applied"], ["001_start.sql"])
        repeated = self._run()
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertEqual(json.loads(repeated.stdout)["applied"], [])

    def test_untracked_existing_database_is_rejected_without_writes(self) -> None:
        with psycopg.connect(f"host=/tmp dbname={self.database_name}") as connection:
            connection.execute("CREATE TABLE public.owner (id int)")
        self._write("001_start.sql", "CREATE TABLE public.probe (id int);")
        result = self._run()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("legacy_database_untracked", result.stderr)
        with psycopg.connect(f"host=/tmp dbname={self.database_name}") as connection:
            self.assertIsNone(connection.execute(
                "SELECT to_regclass('public.probe')"
            ).fetchone()[0])
            self.assertIsNone(connection.execute(
                "SELECT to_regclass('public.notalone_schema_migration')"
            ).fetchone()[0])

    def test_history_changes_are_rejected_before_new_migrations(self) -> None:
        self._write("001_start.sql", "CREATE TABLE public.probe (id int);")
        self.assertEqual(self._run().returncode, 0)
        self._write("001_start.sql", "CREATE TABLE public.probe (id bigint);")
        self._write("002_next.sql", "CREATE TABLE public.next_probe (id int);")
        result = self._run()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("migration_history_mismatch", result.stderr)
        with psycopg.connect(f"host=/tmp dbname={self.database_name}") as connection:
            self.assertIsNone(connection.execute(
                "SELECT to_regclass('public.next_probe')"
            ).fetchone()[0])

    def test_concurrent_runner_reports_busy_instead_of_reapplying(self) -> None:
        self._write("001_start.sql", "SELECT pg_sleep(1); CREATE TABLE public.probe (id int);")
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self._run(), range(2)))
        self.assertEqual(sorted(result.returncode for result in results), [0, 1])
        failed = next(result for result in results if result.returncode)
        self.assertIn("migration_busy", failed.stderr)
        self.assertEqual(json.loads(self._run().stdout)["applied"], [])

    def test_duplicate_version_is_rejected_before_database_writes(self) -> None:
        self._write("001_start.sql", "CREATE TABLE public.probe (id int);")
        self._write("001_other.sql", "CREATE TABLE public.other_probe (id int);")
        result = self._run()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("migration_files_invalid", result.stderr)

    def test_failure_rolls_back_current_file_and_resumes_after_last_success(self) -> None:
        self._write("001_start.sql", "BEGIN;\nCREATE TABLE public.probe (id int);\nCOMMIT;")
        self.assertEqual(self._run().returncode, 0)
        # 无外层事务的 SQL 对应历史 025；错误中的合成正文不得回显。
        self._write("002_next.sql", """
            ALTER TABLE public.probe ADD COLUMN label text;
            DO $$ BEGIN RAISE EXCEPTION '合成私密字段'; END $$;
        """)
        failed = self._run()
        self.assertNotEqual(failed.returncode, 0)
        self.assertNotIn("合成私密字段", failed.stderr + failed.stdout)
        with psycopg.connect(f"host=/tmp dbname={self.database_name}") as connection:
            self.assertEqual(connection.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema='public' AND table_name='probe' ORDER BY ordinal_position"
            ).fetchall(), [("id",)])
        self._write("002_next.sql", "ALTER TABLE public.probe ADD COLUMN label text;")
        resumed = self._run()
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertEqual(json.loads(resumed.stdout)["applied"], ["002_next.sql"])

    def test_all_repository_migrations_install_and_repeat(self) -> None:
        result = self._run(directory=ROOT / "database/migrations")
        self.assertEqual(result.returncode, 0, result.stderr)
        applied = json.loads(result.stdout)["applied"]
        self.assertEqual(len(applied), 46)
        self.assertEqual(applied[-1], "046_background_step_lease_generation.sql")
        repeated = self._run(directory=ROOT / "database/migrations")
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertEqual(json.loads(repeated.stdout)["applied"], [])

    def test_version_record_failure_rolls_back_wrapped_sql(self) -> None:
        self._write("001_start.sql", "CREATE TABLE public.probe (id int);")
        self.assertEqual(self._run().returncode, 0)
        # 通过数据库边界注入记录写入失败，证明 SQL 与账本真正同事务。
        with psycopg.connect(f"host=/tmp dbname={self.database_name}") as connection:
            connection.execute("""
                ALTER TABLE public.notalone_schema_migration
                ADD CONSTRAINT synthetic_record_failure CHECK (name = '001_start.sql')
            """)
        self._write("002_next.sql", """-- 合成迁移说明
BEGIN;
ALTER TABLE public.probe ADD COLUMN label text;
COMMIT;
""")
        self.assertNotEqual(self._run().returncode, 0)
        with psycopg.connect(f"host=/tmp dbname={self.database_name}") as connection:
            self.assertEqual(connection.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema='public' AND table_name='probe' ORDER BY ordinal_position"
            ).fetchall(), [("id",)])
            connection.execute("ALTER TABLE public.notalone_schema_migration "
                               "DROP CONSTRAINT synthetic_record_failure")
        resumed = self._run()
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertEqual(json.loads(resumed.stdout)["applied"], ["002_next.sql"])

    def test_extra_commit_cannot_escape_version_transaction(self) -> None:
        self._write("001_start.sql", "CREATE TABLE public.probe (id int); COMMIT;")
        result = self._run()
        self.assertNotEqual(result.returncode, 0)
        with psycopg.connect(f"host=/tmp dbname={self.database_name}") as connection:
            self.assertIsNone(connection.execute(
                "SELECT to_regclass('public.probe')"
            ).fetchone()[0])

    def test_interrupted_connection_can_resume_same_migration(self) -> None:
        self._write("001_start.sql", "CREATE TABLE public.probe (id int);")
        self.assertEqual(self._run().returncode, 0)
        self._write("002_next.sql", """
            ALTER TABLE public.probe ADD COLUMN label text;
            SELECT pg_advisory_xact_lock(195948557);
        """)
        gate = psycopg.connect(f"host=/tmp dbname={self.database_name}", autocommit=True)
        gate.execute("SELECT pg_advisory_lock(195948557)")
        env = dict(os.environ)
        env["NOTALONE_DATABASE_URL"] = f"host=/tmp dbname={self.database_name}"
        process = subprocess.Popen(
            [sys.executable, "-m", "notalone.database_migrations",
             "--migrations", str(self.migrations)],
            cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                row = self.admin.execute(
                    "SELECT pid FROM pg_stat_activity "
                    "WHERE datname = %s AND wait_event = 'advisory'",
                    (self.database_name,),
                ).fetchone()
                if row:
                    self.admin.execute("SELECT pg_terminate_backend(%s)", (row[0],))
                    break
                time.sleep(0.02)
            else:
                self.fail("合成迁移未进入可中断的数据库步骤。")
            process.communicate(timeout=10)
            self.assertNotEqual(process.returncode, 0)
        finally:
            gate.close()
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=10)
        resumed = self._run()
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertEqual(json.loads(resumed.stdout)["applied"], ["002_next.sql"])


if __name__ == "__main__":
    unittest.main()
