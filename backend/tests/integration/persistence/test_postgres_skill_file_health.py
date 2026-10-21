"""Skill 工作副本/清理失败的可观测状态与可重试恢复测试。"""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
import subprocess
import sys

from notalone.persistence.skill_directory import synchronize_skill_library
from notalone.persistence.skill_library import PostgresSkillLibrary
from notalone.persistence.skill_port import PostgresSkillPort
from notalone.scopes import ContactScope


class PostgresSkillFileHealthTest(unittest.TestCase):
    """故障注入只使用临时管理目录与合成 Skill。"""

    @classmethod
    def setUpClass(cls):
        instance = os.environ.get(
            "NOTALONE_TEST_DATABASE_URL", "host=/tmp dbname=notalone_test"
        )
        cls.database_name = f"notalone_skill_health_{uuid4().hex}_test"
        cls.database_url = make_conninfo(instance, dbname=cls.database_name)
        cls.admin = psycopg.connect(instance, dbname="postgres", autocommit=True)
        cls.admin.execute(
            sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(
                sql.Identifier(cls.database_name)
            )
        )
        cls.addClassCleanup(cls._drop_database)
        result = subprocess.run(
            [sys.executable, "-m", "notalone.database_migrations",
             "--migrations", "database/migrations"],
            cwd=Path(__file__).resolve().parents[3],
            env={**os.environ, "NOTALONE_DATABASE_URL": cls.database_url},
            capture_output=True, text=True, timeout=90,
        )
        if result.returncode:
            raise RuntimeError("合成 Skill 健康测试库迁移失败：" + result.stderr[-1000:])

    @classmethod
    def _drop_database(cls):
        try:
            cls.admin.execute(
                sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                    sql.Identifier(cls.database_name)
                )
            )
        finally:
            cls.admin.close()

    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        environment = patch.dict(os.environ, {"NOTALONE_SKILLS_DIR": str(self.root)})
        environment.start()
        self.addCleanup(environment.stop)
        self.owner_id, self.contact_id = uuid4(), uuid4()
        self.scope = ContactScope(self.owner_id, self.contact_id)
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.owner(id,display_name) VALUES (%s,'合成健康用户')",
                (self.owner_id,),
            )
            connection.execute(
                "INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,'合成健康联系人')",
                (self.owner_id, self.contact_id),
            )
        self.port = PostgresSkillPort(self.database_url)
        self.library = PostgresSkillLibrary(self.database_url)

    def _package(self, *, name="warm-reply", body="先回应感受，再表达需要。") -> Path:
        directory = self.root / "packages" / name
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "SKILL.md").write_text(
            "---\n" f"name: {name}\n" "description: 适合健康状态测试。\n"
            "---\n\n" f"{body}\n",
            encoding="utf-8",
        )
        return directory

    def _import(self, *, name="warm-reply"):
        result = self.library.import_package(self.owner_id, self._package(name=name))
        self.assertEqual(
            [entry.name for entry in self.port.catalog(self.scope).entries], [name]
        )
        return result

    def _snapshot_document(self, result) -> Path:
        return (
            self.root
            / ".versions"
            / str(self.owner_id)
            / str(result.skill_id)
            / str(result.version_id)
            / result.name
            / "SKILL.md"
        )

    def _queue_working_copy(self, result) -> None:
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.reply_skill_working_copy(skill_id,version_id) "
                "VALUES (%s,%s) ON CONFLICT(skill_id) DO UPDATE SET version_id=excluded.version_id",
                (result.skill_id, result.version_id),
            )

    def test_working_copy_failure_is_logged_queryable_and_retry_recovers(self) -> None:
        result = self._import()
        document = self._snapshot_document(result)
        original = document.read_bytes()
        document.write_bytes(original + b"\ncorrupted")
        self._queue_working_copy(result)

        with self.assertLogs("notalone.persistence.skill_files", level="WARNING") as captured:
            synchronize_skill_library(
                self.database_url, self.owner_id, migrate_legacy=False
            )

        self.assertIn("skill_file_sync_failed", "\n".join(captured.output))
        # 运行资格仍 fail-closed：待重试工作副本期间该技能不可执行。
        self.assertEqual(self.port.catalog(self.scope).entries, ())
        health = self.library.skill_file_health(self.owner_id)
        self.assertEqual(health["state"], "degraded")
        self.assertEqual(health["pending_working_copies"], 1)
        self.assertEqual(len(health["failures"]), 1)
        failure = health["failures"][0]
        self.assertEqual(failure["operation"], "working_copy_sync")
        self.assertEqual(failure["code"], "file_unavailable")
        self.assertNotIn(str(self.root), json.dumps(health, ensure_ascii=False))
        self.assertNotIn("先回应感受", json.dumps(health, ensure_ascii=False))

        document.write_bytes(original)
        synchronize_skill_library(self.database_url, self.owner_id, migrate_legacy=False)

        self.assertEqual(
            [entry.name for entry in self.port.catalog(self.scope).entries],
            [result.name],
        )
        recovered = self.library.skill_file_health(self.owner_id)
        self.assertEqual(recovered["state"], "ok")
        self.assertEqual(recovered["pending_working_copies"], 0)
        self.assertEqual(recovered["failures"], [])

    def test_cleanup_failure_keeps_task_logs_warning_and_retry_recovers(self) -> None:
        blocked = self.root / str(self.owner_id) / "blocked-cleanup"
        blocked.mkdir(parents=True)
        (blocked / "residual.txt").write_text("合成残留。", encoding="utf-8")
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.reply_skill_file_cleanup(relative_path) VALUES (%s)",
                (f"{self.owner_id}/blocked-cleanup",),
            )

        with patch(
            "notalone.persistence.skill_files.shutil.rmtree",
            side_effect=PermissionError("合成权限失败"),
        ):
            with self.assertLogs(
                "notalone.persistence.skill_files", level="WARNING"
            ) as captured:
                synchronize_skill_library(
                    self.database_url, self.owner_id, migrate_legacy=False
                )

        self.assertIn("skill_file_sync_failed", "\n".join(captured.output))
        self.assertTrue(blocked.exists())
        health = self.library.skill_file_health(self.owner_id)
        self.assertEqual(health["state"], "degraded")
        self.assertEqual(health["pending_cleanup_files"], 1)
        failure = health["failures"][0]
        self.assertEqual(failure["operation"], "cleanup")
        self.assertEqual(failure["code"], "permission_denied")
        self.assertNotIn(str(self.root), json.dumps(health, ensure_ascii=False))

        synchronize_skill_library(self.database_url, self.owner_id, migrate_legacy=False)

        self.assertFalse(blocked.exists())
        recovered = self.library.skill_file_health(self.owner_id)
        self.assertEqual(recovered, {
            "state": "ok",
            "pending_working_copies": 0,
            "pending_cleanup_files": 0,
            "failures": [],
        })


if __name__ == "__main__":
    unittest.main()
