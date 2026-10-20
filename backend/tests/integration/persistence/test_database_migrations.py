"""迁移命令的隔离数据库验收；不复用现有业务库或共享测试库。"""

from __future__ import annotations

import json
import shutil
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
from psycopg.conninfo import make_conninfo


ROOT = Path(__file__).resolve().parents[3]
EVOLUTION_MIGRATIONS = (
    "061_memory_correction_protection.sql",
    "062_memory_events_and_version_evidence.sql",
    "063_relationship_overview_projection.sql",
    "064_owner_memory_revision.sql",
    "065_expression_preferences.sql",
    "066_skill_learning_drafts.sql",
    "067_memory_upgrade_batches.sql",
    "068_skill_review_publication.sql",
    "069_skill_history_operations.sql",
    "070_skill_scope_policies.sql",
)

REPOSITORY_MIGRATIONS = tuple(sorted(path.name for path in (ROOT / "database/migrations").glob("*.sql")))
# 历史前缀和各迁移语义继续固定；全量升级应验证当前正式目录的完整尾部。
INTEGRATION_MIGRATIONS = tuple(name for name in REPOSITORY_MIGRATIONS if int(name[:3]) >= 61)


class DatabaseMigrationCommandTest(unittest.TestCase):
    def setUp(self) -> None:
        self.database_name = f"notalone_migration_{uuid4().hex}_test"
        # 保持显式隔离实例的 host/port，只创建本用例拥有的随机测试库。
        instance_url = os.environ.get("NOTALONE_TEST_DATABASE_URL", "host=/tmp dbname=notalone_test")
        self.database_url = make_conninfo(instance_url, dbname=self.database_name)
        self.admin = psycopg.connect(instance_url, dbname="postgres", autocommit=True)
        self.admin.execute(
            sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(
                sql.Identifier(self.database_name)
            )
        )
        self.addCleanup(self._drop_database)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute("SELECT current_database()").fetchone()[0], self.database_name)
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
            self.assertFalse(self.admin.execute("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)",
                                                (self.database_name,)).fetchone()[0])
        finally:
            self.admin.close()

    def _write(self, name: str, body: str) -> None:
        (self.migrations / name).write_text(body, encoding="utf-8")

    def _run(self, *, directory: Path | None = None) -> subprocess.CompletedProcess:
        env = dict(os.environ)
        env["NOTALONE_DATABASE_URL"] = self.database_url
        env["NOTALONE_TEST_DATABASE_URL"] = self.database_url
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

    def test_062_forward_upgrade_preserves_unknown_legacy_rows_and_repeats_without_writes(self) -> None:
        migrations = ROOT / "database/migrations"
        for path in sorted(migrations.glob("*.sql")):
            if int(path.name[:3]) <= 61:
                shutil.copyfile(path, self.migrations / path.name)
        first = self._run()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(len(json.loads(first.stdout)["applied"]), 61)
        owner_id, contact_id, candidate_id, memory_id, owner_memory_id = (uuid4() for _ in range(5))
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES (%s,'合成迁移用户')", (owner_id,))
            connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,'合成迁移联系人')", (owner_id, contact_id))
            connection.execute(
                "INSERT INTO public.memory_candidate(id,owner_id,contact_id,text_content,category,source_ids,status) "
                "VALUES (%s,%s,%s,'旧候选未知事件','relationship_note',%s,'confirmed')", (candidate_id, owner_id, contact_id, [contact_id]),
            )
            connection.execute(
                "INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,source_candidate_id,adoption_method) "
                "VALUES (%s,%s,%s,'旧资料未知事件','relationship_note',%s,%s,'auto')", (memory_id, owner_id, contact_id, [contact_id], candidate_id),
            )
            connection.execute(
                "INSERT INTO public.owner_memory(id,owner_id,text_content,category,source_ids,adoption_method) "
                "VALUES (%s,%s,'旧本人资料未知事件','relationship_note',%s,'manual')", (owner_memory_id, owner_id, [owner_id]),
            )
            before = {table: connection.execute(sql.SQL("SELECT to_jsonb(record) FROM public.{} record").format(sql.Identifier(table))).fetchall()
                      for table in ("memory_candidate", "confirmed_memory", "owner_memory")}
        migration = migrations / "062_memory_events_and_version_evidence.sql"
        shutil.copyfile(migration, self.migrations / migration.name)
        upgraded = self._run()
        self.assertEqual(upgraded.returncode, 0, upgraded.stderr)
        self.assertEqual(json.loads(upgraded.stdout)["applied"], [migration.name])
        with psycopg.connect(self.database_url) as connection:
            for table, rows in before.items():
                after = connection.execute(sql.SQL("SELECT to_jsonb(record) FROM public.{} record").format(sql.Identifier(table))).fetchall()
                for old, current in zip(rows, after, strict=True):
                    expected = {**old[0], "event": None, **({"version_evidence": None} if table != "memory_candidate" else {})}
                    self.assertEqual(current[0], expected)
        repeated = self._run()
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertEqual(json.loads(repeated.stdout)["applied"], [])

    def test_untracked_existing_database_is_rejected_without_writes(self) -> None:
        with psycopg.connect(self.database_url) as connection:
            connection.execute("CREATE TABLE public.owner (id int)")
        self._write("001_start.sql", "CREATE TABLE public.probe (id int);")
        result = self._run()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("legacy_database_untracked", result.stderr)
        with psycopg.connect(self.database_url) as connection:
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
        with psycopg.connect(self.database_url) as connection:
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
        with psycopg.connect(self.database_url) as connection:
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
        expected = sorted(path.name for path in (ROOT / "database/migrations").glob("*.sql"))
        self.assertGreaterEqual(len(expected), 77)
        self.assertEqual(expected[76], '077_owner_layered_scope.sql')
        self.assertEqual([int(name[:3]) for name in expected], list(range(1, len(expected) + 1)))
        self.assertEqual(applied, expected)
        repeated = self._run(directory=ROOT / "database/migrations")
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertEqual(json.loads(repeated.stdout)["applied"], [])

    def test_existing_current_096_accepts_schedule_without_rewriting_history(self) -> None:
        source = ROOT / "database/migrations"
        for path in sorted(source.glob("*.sql")):
            if int(path.name[:3]) <= 96:
                shutil.copyfile(path, self.migrations / path.name)
        initial = self._run()
        self.assertEqual(initial.returncode, 0, initial.stderr)
        with psycopg.connect(self.database_url) as connection:
            history = connection.execute(
                "SELECT name, checksum FROM public.notalone_schema_migration ORDER BY name"
            ).fetchall()
        shutil.copyfile(source / "097_persistent_extraction_schedule.sql",
                        self.migrations / "097_persistent_extraction_schedule.sql")
        upgraded = self._run()
        self.assertEqual(upgraded.returncode, 0, upgraded.stderr)
        self.assertEqual(json.loads(upgraded.stdout)["applied"],
                         ["097_persistent_extraction_schedule.sql"])
        with psycopg.connect(self.database_url) as connection:
            current = connection.execute(
                "SELECT name, checksum FROM public.notalone_schema_migration ORDER BY name"
            ).fetchall()
            self.assertEqual(current[:-1], history)
            for table in ("memory_extraction_schedule", "memory_extraction_receipt"):
                self.assertIsNotNone(connection.execute(
                    "SELECT to_regclass(%s)", ("public." + table,)
                ).fetchone()[0])
        repeated = self._run()
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertEqual(json.loads(repeated.stdout)["applied"], [])

    def test_version_record_failure_rolls_back_wrapped_sql(self) -> None:
        self._write("001_start.sql", "CREATE TABLE public.probe (id int);")
        self.assertEqual(self._run().returncode, 0)
        # 通过数据库边界注入记录写入失败，证明 SQL 与账本真正同事务。
        with psycopg.connect(self.database_url) as connection:
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
        with psycopg.connect(self.database_url) as connection:
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
        with psycopg.connect(self.database_url) as connection:
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
        gate = psycopg.connect(self.database_url, autocommit=True)
        gate.execute("SELECT pg_advisory_lock(195948557)")
        env = dict(os.environ)
        env["NOTALONE_DATABASE_URL"] = self.database_url
        env["NOTALONE_TEST_DATABASE_URL"] = self.database_url
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

    def _copy_canonical_prefix(self, last_version: int) -> None:
        for path in (ROOT / "database/migrations").glob("*.sql"):
            if int(path.name.split("_", 1)[0]) <= last_version:
                shutil.copyfile(path, self.migrations / path.name)

    def _assert_existing_canonical_prefix_upgrades_once(self, last_version: int) -> None:
        self._copy_canonical_prefix(last_version)
        installed = self._run()
        self.assertEqual(installed.returncode, 0, installed.stderr)
        self.assertEqual(len(json.loads(installed.stdout)["applied"]), last_version)
        owner_id, contact_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES (%s,'合成整合用户')", (owner_id,))
            connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,'合成整合联系人')",
                               (owner_id, contact_id))
            if last_version == 60:
                connection.execute("INSERT INTO public.manual_contact_confirmation(owner_id,contact_id) VALUES (%s,%s)",
                                   (owner_id, contact_id))
            tables = ("owner", "contact", "manual_contact_confirmation") if last_version == 60 else ("owner", "contact")
            before = {table: connection.execute(sql.SQL("SELECT to_jsonb(record) FROM public.{} record ORDER BY id")
                      .format(sql.Identifier(table))).fetchall() for table in tables}
            history = connection.execute(
                "SELECT name,checksum,applied_at FROM public.notalone_schema_migration ORDER BY name"
            ).fetchall()
        upgraded = self._run(directory=ROOT / "database/migrations")
        self.assertEqual(upgraded.returncode, 0, upgraded.stderr)
        expected = (["060_manual_contact_confirmation.sql"] if last_version == 59 else []) + list(INTEGRATION_MIGRATIONS)
        self.assertEqual(json.loads(upgraded.stdout)["applied"], expected)
        with psycopg.connect(self.database_url) as connection:
            for table, rows in before.items():
                self.assertEqual(connection.execute(sql.SQL("SELECT to_jsonb(record) FROM public.{} record ORDER BY id")
                                 .format(sql.Identifier(table))).fetchall(), rows)
            completed = connection.execute(
                "SELECT name,checksum,applied_at FROM public.notalone_schema_migration ORDER BY name"
            ).fetchall()
            self.assertEqual(completed[:last_version], history)
            self.assertEqual((len(completed), completed[-1][0]), (len(REPOSITORY_MIGRATIONS), REPOSITORY_MIGRATIONS[-1]))
        repeated = self._run(directory=ROOT / "database/migrations")
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertEqual(json.loads(repeated.stdout)["applied"], [])
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute(
                "SELECT name,checksum,applied_at FROM public.notalone_schema_migration ORDER BY name"
            ).fetchall(), completed)

    def test_main_059_upgrades_without_rewriting_existing_rows_or_history(self) -> None:
        self._assert_existing_canonical_prefix_upgrades_once(59)

    def test_standalone_060_upgrades_without_losing_manual_contact_confirmation(self) -> None:
        self._assert_existing_canonical_prefix_upgrades_once(60)

    def test_old_memory_059_to_068_fork_is_rejected_without_ledger_conversion(self) -> None:
        self._copy_canonical_prefix(58)
        for canonical_name in EVOLUTION_MIGRATIONS:
            old_name = f"{int(canonical_name[:3]) - 2:03d}" + canonical_name[3:]
            shutil.copyfile(ROOT / "database/migrations" / canonical_name, self.migrations / old_name)
        installed = self._run()
        self.assertEqual(installed.returncode, 0, installed.stderr)
        self.assertEqual(len(json.loads(installed.stdout)["applied"]), 68)
        with psycopg.connect(self.database_url) as connection:
            history = connection.execute(
                "SELECT name,checksum,applied_at FROM public.notalone_schema_migration ORDER BY name"
            ).fetchall()
        refused = self._run(directory=ROOT / "database/migrations")
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("migration_history_mismatch", refused.stderr)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute(
                "SELECT name,checksum,applied_at FROM public.notalone_schema_migration ORDER BY name"
            ).fetchall(), history)
            self.assertIsNone(connection.execute("SELECT to_regclass('public.manual_contact_confirmation')").fetchone()[0])
            self.assertIsNone(connection.execute("SELECT to_regprocedure('public.notalone_semantic_basis_v2_valid(jsonb)')").fetchone()[0])

    def test_correction_061_follows_standalone_060_and_repeats_without_rewriting_history(self) -> None:
        self._copy_canonical_prefix(60)
        first = self._run()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(json.loads(first.stdout)["applied"][-1], "060_manual_contact_confirmation.sql")
        advanced = self._run(directory=ROOT / "database/migrations")
        self.assertEqual(advanced.returncode, 0, advanced.stderr)
        self.assertEqual(json.loads(advanced.stdout)["applied"], list(INTEGRATION_MIGRATIONS))
        repeated = self._run(directory=ROOT / "database/migrations")
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertEqual(json.loads(repeated.stdout)["applied"], [])
        with psycopg.connect(self.database_url) as connection:
            self.assertIsNotNone(connection.execute("SELECT to_regclass('public.memory_correction_decision')").fetchone()[0])
            with self.assertRaises(psycopg.errors.CheckViolation), connection.transaction():
                connection.execute("""INSERT INTO public.memory_correction_decision
                    (id,owner_id,scope_kind,record_kind,record_id,decision,evidence)
                    VALUES (gen_random_uuid(),gen_random_uuid(),'self','candidate',gen_random_uuid(),
                      'rejected','{"version":1,"kind":"erased_guard","canonical_ids":[]}'::jsonb)""")

    def test_synthetic_s_058_fork_is_rejected_without_ledger_adoption(self) -> None:
        self._copy_canonical_prefix(57)
        shutil.copyfile(ROOT / "database/migrations/061_memory_correction_protection.sql",
                        self.migrations / "058_memory_correction_protection.sql")
        first = self._run()
        self.assertEqual(first.returncode, 0, first.stderr)
        refused = self._run(directory=ROOT / "database/migrations")
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("migration_history_mismatch", refused.stderr)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute("SELECT name FROM public.notalone_schema_migration ORDER BY name DESC LIMIT 1").fetchone()[0],
                             "058_memory_correction_protection.sql")
            self.assertIsNone(connection.execute("SELECT to_regclass('public.assistant_prepared_context')").fetchone()[0])

    def test_correction_061_failure_rolls_back_ddl_then_resumes(self) -> None:
        self._copy_canonical_prefix(60)
        first = self._run()
        self.assertEqual(first.returncode, 0, first.stderr)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("CREATE TABLE public.memory_correction_decision (synthetic int)")
        failed = self._run(directory=ROOT / "database/migrations")
        self.assertNotEqual(failed.returncode, 0)
        with psycopg.connect(self.database_url) as connection:
            self.assertIsNone(connection.execute("SELECT to_regprocedure('public.notalone_correction_erased_guard_shape(jsonb)')").fetchone()[0])
            connection.execute("DROP TABLE public.memory_correction_decision")
        resumed = self._run(directory=ROOT / "database/migrations")
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertEqual(json.loads(resumed.stdout)["applied"], list(INTEGRATION_MIGRATIONS))

    def test_event_062_failure_rolls_back_then_resumes_without_changing_061(self) -> None:
        self._copy_canonical_prefix(61)
        first = self._run()
        self.assertEqual(first.returncode, 0, first.stderr)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("CREATE FUNCTION public.notalone_version_window_shape(jsonb) RETURNS boolean LANGUAGE sql AS 'SELECT false'")
        failed = self._run(directory=ROOT / "database/migrations")
        self.assertNotEqual(failed.returncode, 0)
        with psycopg.connect(self.database_url) as connection:
            self.assertIsNone(connection.execute("SELECT to_regprocedure('public.notalone_memory_event_shape(jsonb)')").fetchone()[0])
            self.assertEqual(connection.execute("SELECT name FROM public.notalone_schema_migration ORDER BY name DESC LIMIT 1").fetchone()[0], "061_memory_correction_protection.sql")
            connection.execute("DROP FUNCTION public.notalone_version_window_shape(jsonb)")
        resumed = self._run(directory=ROOT / "database/migrations")
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertEqual(json.loads(resumed.stdout)["applied"], list(INTEGRATION_MIGRATIONS[1:]))


if __name__ == "__main__":
    unittest.main()
