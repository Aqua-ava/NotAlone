"""受控更新命令的真实 PostgreSQL 验收；只操作本测试创建的随机旧库。"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import time
import shutil
import tempfile
import unittest

import psycopg


ROOT = Path(__file__).resolve().parents[4]
LATEST_VERSION = len(list((ROOT / "backend/database/migrations").glob("*.sql")))


class DatabaseUpdatesTest(unittest.TestCase):
    @staticmethod
    def _response_code(result: subprocess.CompletedProcess[str]) -> str:
        try:
            value = json.loads(result.stdout).get("code")
        except (ValueError, AttributeError):
            return "response_unavailable"
        allowed = {"ready", "adoption_writers_present", "migration_busy", "migration_failed",
                   "update_failed", "update_target_changed", "update_source_changed",
                   "update_schema_mismatch", "update_backup_invalid", "update_recovery_required",
                   "update_retention_mismatch", "backup_restore_failed", "restore_mismatch"}
        return value if value in allowed else "response_unrecognized"

    def setUp(self) -> None:
        self.environment = {**os.environ, "PYTHONPATH": str(ROOT / "backend/src"),
                            "NOTALONE_DISABLE_DOTENV": "1"}
        self.fixture = ROOT / "desktop/tests/fixtures/update-database.py"
        result = self._fixture("create")
        self.target = json.loads(result.stdout)
        self.addCleanup(lambda: self._fixture("drop", self.target["database"]))
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.backup = Path(self.directory.name) / "backup"

    def _fixture(self, action: str, database: str = "", *, baseline: bool = False) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, str(self.fixture), action, "--project", str(ROOT),
                               *(["--database", database] if database else []), *(["--baseline"] if baseline else [])], env=self.environment,
                              capture_output=True, text=True, check=True, timeout=60)

    def _command(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, "-m", "notalone.database_updates", "--migrations",
                               str(ROOT / "backend/database/migrations"), *arguments],
                              env={**self.environment, "NOTALONE_DATABASE_URL": self.target["database_url"]},
                              capture_output=True, text=True, timeout=90)

    def test_explicit_update_verifies_restore_and_retains_existing_contact(self) -> None:
        inspected = self._command("--inspect")
        self.assertEqual(inspected.returncode, 0, inspected.stderr)
        plan = json.loads(inspected.stdout)
        self.assertEqual(plan["code"], "migration_pending")
        updated = self._command("--update", "--backup-dir", str(self.backup),
                                "--expected-target", plan["target_fingerprint"])
        self.assertEqual(updated.returncode, 0, updated.stderr)
        result = json.loads(updated.stdout)
        self.assertEqual(result["code"], "ready")
        self.assertTrue((self.backup / "database.dump").is_file())
        self.assertEqual((self.backup / "database.dump").stat().st_mode & 0o777, 0o600)
        checkpoint = json.loads((self.backup / "checkpoint.json").read_text())
        self.assertEqual(checkpoint["phase"], "complete")
        self.assertTrue(checkpoint["restore_verified"])
        # 对外SQL读取资料是更新命令本身的领域数据契约，非私有函数调用。
        with psycopg.connect(self.target["database_url"]) as connection:
            self.assertEqual(connection.execute("SELECT display_name FROM public.contact").fetchall(),
                             [("合成保留联系人",)])
            self.assertEqual(connection.execute("SELECT phase FROM public.cli_backfill_state").fetchall(), [("paused",)])
            self.assertEqual(connection.execute("SELECT enabled FROM public.front_sync_state").fetchall(), [(False,)])

    def test_copy_update_preserves_original_structure_and_restores_into_new_local_database(self) -> None:
        from uuid import uuid4
        from psycopg import sql
        name = f"notalone_copy_{uuid4().hex}_test"
        with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
            admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(name)))
        def cleanup() -> None:
            with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
                admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
        self.addCleanup(cleanup)
        plan = json.loads(self._command("--inspect").stdout)
        result = subprocess.run([sys.executable, "-m", "notalone.database_updates", "--migrations",
                                 str(ROOT / "backend/database/migrations"), "--copy-update", "--backup-dir",
                                 str(self.backup), "--expected-target", plan["target_fingerprint"]],
                                env={**self.environment, "NOTALONE_DATABASE_URL": self.target["database_url"],
                                     "NOTALONE_UPDATE_DESTINATION_URL": f"host=/tmp dbname={name}"},
                                capture_output=True, text=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        with psycopg.connect(self.target["database_url"]) as source, psycopg.connect(f"host=/tmp dbname={name}") as destination:
            self.assertEqual(source.execute("SELECT count(*) FROM public.notalone_schema_migration").fetchone()[0], 55)
            self.assertEqual(destination.execute("SELECT count(*) FROM public.notalone_schema_migration").fetchone()[0], LATEST_VERSION)
            self.assertEqual(destination.execute("SELECT display_name FROM public.contact").fetchall(), [("合成保留联系人",)])

    def test_interrupted_update_keeps_connection_gate_and_resumes_from_real_ledger(self) -> None:
        migrations = Path(self.directory.name) / "migrations"
        shutil.copytree(ROOT / "backend/database/migrations", migrations)
        (migrations / f"{LATEST_VERSION + 1:03d}_synthetic_interruption.sql").write_text("SELECT pg_sleep(2); CREATE TABLE public.synthetic_update_resume (id int);")
        plan = json.loads(self._command("--inspect").stdout)
        arguments = ["--migrations", str(migrations), "--update", "--backup-dir", str(self.backup),
                     "--expected-target", plan["target_fingerprint"]]
        child = subprocess.Popen([sys.executable, "-m", "notalone.database_updates", *arguments],
                                 env={**self.environment, "NOTALONE_DATABASE_URL": self.target["database_url"]},
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 30
            reached = False
            while child.poll() is None and time.monotonic() < deadline:
                file = self.backup / "checkpoint.json"
                if file.exists():
                    checkpoint = json.loads(file.read_text())
                    if checkpoint["phase"] == "migrating" and checkpoint["through_version"] == LATEST_VERSION:
                        reached = True
                        break
                time.sleep(0.02)
            self.assertTrue(reached, child.communicate(timeout=5) if child.poll() is not None else "未达到实际版本检查点")
            child.kill()
            child.communicate(timeout=5)
            self.assertEqual(json.loads(self._command("--inspect").stdout)["code"], "update_interrupted")
            resumed = self._command(*arguments)
            self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)
            self.assertEqual(json.loads((self.backup / "checkpoint.json").read_text())["phase"], "complete")
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=5)

    def test_changed_target_and_unknown_writer_are_rejected_before_backup(self) -> None:
        plan = json.loads(self._command("--inspect").stdout)
        wrong = self._command("--update", "--backup-dir", str(self.backup), "--expected-target", "0" * 64)
        self.assertEqual(json.loads(wrong.stdout)["code"], "update_target_changed")
        with psycopg.connect(self.target["database_url"]):
            held = self._command("--update", "--backup-dir", str(self.backup), "--expected-target", plan["target_fingerprint"])
            self.assertEqual(json.loads(held.stdout)["code"], "adoption_writers_present")
        self.assertFalse(self.backup.exists())

    def test_restore_failure_retains_original_and_private_archive_without_leaking_tool_errors(self) -> None:
        plan = json.loads(self._command("--inspect").stdout)
        tools = Path(self.directory.name) / "tools"
        tools.mkdir()
        restore = tools / "pg_restore"
        restore.write_text('#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pg_restore (PostgreSQL) 16.15"; exit 0; fi\necho "synthetic-sensitive-tool-content" >&2\nexit 1\n')
        restore.chmod(0o700)
        self.environment["PATH"] = str(tools) + os.pathsep + self.environment["PATH"]
        failed = self._command("--update", "--backup-dir", str(self.backup), "--expected-target", plan["target_fingerprint"])
        self.assertEqual(json.loads(failed.stdout)["code"], "backup_restore_failed")
        self.assertNotIn("synthetic-sensitive-tool-content", failed.stdout + failed.stderr)
        self.assertTrue((self.backup / "database.dump").is_file())
        with psycopg.connect(self.target["database_url"]) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.notalone_schema_migration").fetchone()[0], 55)

    def test_history_drift_is_read_only_and_never_creates_backup(self) -> None:
        with psycopg.connect(self.target["database_url"]) as connection:
            connection.execute("UPDATE public.notalone_schema_migration SET checksum='synthetic-drift' WHERE name='055_assistant_candidate_carry_input.sql'")
        failed = self._command("--inspect")
        self.assertEqual(json.loads(failed.stdout)["code"], "migration_history_mismatch")
        self.assertFalse(self.backup.exists())

    def test_non_regular_checkpoint_is_rejected_without_blocking_or_changing_original(self) -> None:
        plan = json.loads(self._command("--inspect").stdout)
        self.backup.mkdir(mode=0o700)
        os.mkfifo(self.backup / "checkpoint.json", 0o600)
        failed = self._command("--update", "--backup-dir", str(self.backup), "--expected-target", plan["target_fingerprint"])
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(json.loads(failed.stdout)["code"], "update_backup_invalid")
        with psycopg.connect(self.target["database_url"]) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.notalone_schema_migration").fetchone()[0], 55)
        self.assertFalse((self.backup / "database.dump").exists())

    def test_disk_capacity_failure_leaves_original_available_before_backup(self) -> None:
        plan = json.loads(self._command("--inspect").stdout)
        # 仅替换操作系统容量边界；运行真实 CLI、目标核验与正式旧结构。
        program = '''import shutil, sys
from notalone.database_updates import main
from collections import namedtuple
usage = namedtuple('usage', 'total used free')
shutil.disk_usage = lambda _: usage(2**30, 2**30, 0)
raise SystemExit(main(sys.argv[1:]))
'''
        failed = subprocess.run([sys.executable, "-c", program, "--migrations", str(ROOT / "backend/database/migrations"),
                                 "--update", "--backup-dir", str(self.backup), "--expected-target", plan["target_fingerprint"]],
                                env={**self.environment, "NOTALONE_DATABASE_URL": self.target["database_url"]},
                                capture_output=True, text=True, timeout=90)
        self.assertEqual(json.loads(failed.stdout)["code"], "update_disk_space_insufficient")
        self.assertFalse(self.backup.exists())
        self.assertEqual(json.loads(self._command("--inspect").stdout)["code"], "migration_pending")

    def test_non_regular_verified_archive_is_rejected_without_waiting_for_a_writer(self) -> None:
        plan = json.loads(self._command("--inspect").stdout)
        arguments = ["--update", "--backup-dir", str(self.backup), "--expected-target", plan["target_fingerprint"]]
        updated = self._command(*arguments)
        self.assertEqual(updated.returncode, 0, self._response_code(updated))
        (self.backup / "database.dump").rename(self.backup / "owned-original.dump")
        missing = self._command(*arguments)
        self.assertEqual(json.loads(missing.stdout)["code"], "update_backup_invalid")
        os.mkfifo(self.backup / "database.dump", 0o600)
        failed = subprocess.run([sys.executable, "-m", "notalone.database_updates", "--migrations",
                                 str(ROOT / "backend/database/migrations"), *arguments],
                                env={**self.environment, "NOTALONE_DATABASE_URL": self.target["database_url"]},
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(json.loads(failed.stdout)["code"], "update_backup_invalid")
        self.assertEqual(json.loads(self._command("--inspect").stdout)["code"], "ready")

    def test_audited_035_baseline_with_later_real_receipts_updates_without_fabricating_history(self) -> None:
        self._fixture("drop", self.target["database"])
        self.target = json.loads(self._fixture("create", baseline=True).stdout)
        plan = json.loads(self._command("--inspect").stdout)
        result = self._command("--update", "--backup-dir", str(self.backup), "--expected-target", plan["target_fingerprint"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        with psycopg.connect(self.target["database_url"]) as connection:
            self.assertEqual(connection.execute("SELECT through_version FROM public.notalone_schema_baseline").fetchone()[0], 35)
            self.assertEqual(connection.execute("SELECT count(*) FROM public.notalone_schema_migration").fetchone()[0], LATEST_VERSION - 35)

    def test_kill_after_activation_recovers_only_the_bound_original_connection_gate(self) -> None:
        from uuid import uuid4
        from psycopg import sql
        name = f"notalone_copy_{uuid4().hex}_test"
        with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
            admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(name)))
        def cleanup() -> None:
            with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
                admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
        self.addCleanup(cleanup)
        plan = json.loads(self._command("--inspect").stdout)
        # 文件系统边界：真实原子检查点替换完成后杀死自己的更新进程。
        program = '''import os, json, signal, sys
from pathlib import Path
from notalone.database_updates import main
original = os.replace
checkpoint = Path(sys.argv[sys.argv.index('--backup-dir') + 1]) / 'checkpoint.json'
def replace(source, destination):
    original(source, destination)
    if Path(destination) == checkpoint:
        value = json.loads(checkpoint.read_text())
        if value.get('activation_complete') is True and value.get('source_gate') is True:
            os.kill(os.getpid(), signal.SIGKILL)
os.replace = replace
raise SystemExit(main(sys.argv[1:]))
'''
        failed = subprocess.run([sys.executable, "-c", program, "--migrations", str(ROOT / "backend/database/migrations"),
                                 "--copy-update", "--backup-dir", str(self.backup), "--expected-target", plan["target_fingerprint"]],
                                env={**self.environment, "NOTALONE_DATABASE_URL": self.target["database_url"],
                                     "NOTALONE_UPDATE_DESTINATION_URL": f"host=/tmp dbname={name}"},
                                capture_output=True, text=True, timeout=90)
        self.assertEqual(failed.returncode, -9, self._response_code(failed))
        checkpoint = json.loads((self.backup / "checkpoint.json").read_text())
        self.assertTrue(checkpoint["activation_complete"])
        self.assertTrue(checkpoint["source_gate"])
        wrong = self._command("--release-source-gate", "--backup-dir", str(self.backup), "--expected-target", "0" * 64)
        self.assertNotEqual(wrong.returncode, 0)
        self.assertEqual(json.loads(self._command("--inspect").stdout)["code"], "update_interrupted")
        resumed = self._command("--release-source-gate", "--backup-dir", str(self.backup), "--expected-target", plan["target_fingerprint"])
        self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)
        with psycopg.connect(self.target["database_url"]) as source:
            self.assertEqual(source.execute("SELECT count(*) FROM public.notalone_schema_migration").fetchone()[0], 55)
        self.assertFalse(json.loads((self.backup / "checkpoint.json").read_text())["source_gate"])


if __name__ == "__main__":
    unittest.main()
