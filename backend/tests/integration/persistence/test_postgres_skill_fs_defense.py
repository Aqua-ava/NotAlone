"""Skill 目录文件系统错误区分与路径防御测试。"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from notalone.persistence.skill_directory import synchronize_skill_library
from notalone.persistence.skill_library import PostgresSkillLibrary
from notalone.persistence.skill_port import PostgresSkillPort
from notalone.scopes import ContactScope


class PostgresSkillFsDefenseTest(unittest.TestCase):
    """只使用临时管理目录与合成包；不触碰真实 Skill 根。"""

    @classmethod
    def setUpClass(cls):
        instance = os.environ.get(
            "NOTALONE_TEST_DATABASE_URL", "host=/tmp dbname=notalone_test"
        )
        cls.database_name = f"notalone_skill_fs_{uuid4().hex}_test"
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
            raise RuntimeError("合成 Skill 路径防御测试库迁移失败：" + result.stderr[-1000:])

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
                "INSERT INTO public.owner(id,display_name) VALUES (%s,'合成路径用户')",
                (self.owner_id,),
            )
            connection.execute(
                "INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,'合成路径联系人')",
                (self.owner_id, self.contact_id),
            )
        self.port = PostgresSkillPort(self.database_url)
        self.library = PostgresSkillLibrary(self.database_url)

    def _document(self, body: str) -> str:
        return (
            "---\nname: warm-reply\ndescription: 适合路径防御测试。\n"
            f"---\n\n{body}\n"
        )

    def _write_package(self, *, body="先回应感受，再表达需要。") -> Path:
        directory = self.root / str(self.owner_id) / "warm-reply"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "SKILL.md").write_text(self._document(body), encoding="utf-8")
        return directory

    def _import(self):
        result = self.library.import_package(
            self.owner_id, self._write_package()
        )
        self.assertEqual(
            [entry.name for entry in self.port.catalog(self.scope).entries],
            ["warm-reply"],
        )
        return result

    def _synchronize(self):
        return synchronize_skill_library(
            self.database_url, self.owner_id
        )

    def test_root_read_failure_preserves_last_valid_catalog_state(self) -> None:
        result = self._import()

        with patch(
            "notalone.persistence.skill_directory._package_directories",
            side_effect=PermissionError("合成根目录不可读"),
        ):
            with self.assertLogs(
                "notalone.persistence.skill_files", level="WARNING"
            ) as captured:
                self._synchronize()

        self.assertIn("skill_file_sync_failed", "\n".join(captured.output))
        catalog = self.port.catalog(self.scope)
        self.assertEqual([entry.name for entry in catalog.entries], ["warm-reply"])
        self.assertEqual(catalog.entries[0].version_id, result.version_id)
        health = self.library.skill_file_health(self.owner_id)
        self.assertEqual(health["state"], "degraded")
        failure = health["failures"][0]
        self.assertEqual(failure["operation"], "directory_discovery")
        self.assertEqual(failure["code"], "permission_denied")

        self._synchronize()

        self.assertEqual(
            [entry.name for entry in self.port.catalog(self.scope).entries],
            ["warm-reply"],
        )
        self.assertEqual(self.library.skill_file_health(self.owner_id)["state"], "ok")

    def test_invalid_package_is_unavailable_with_queryable_reason_and_recovers(self) -> None:
        result = self._import()
        document = self.root / str(self.owner_id) / "warm-reply" / "SKILL.md"
        original = document.read_text(encoding="utf-8")
        document.write_text("格式不完整。", encoding="utf-8")

        with self.assertLogs(
            "notalone.persistence.skill_files", level="WARNING"
        ):
            self._synchronize()

        self.assertEqual(self.port.catalog(self.scope).entries, ())
        health = self.library.skill_file_health(self.owner_id)
        self.assertEqual(health["state"], "degraded")
        self.assertEqual(health["failures"][0]["code"], "invalid_package")

        document.write_text(original, encoding="utf-8")
        self._synchronize()

        catalog = self.port.catalog(self.scope)
        self.assertEqual(
            [entry.version_id for entry in catalog.entries], [result.version_id]
        )
        self.assertEqual(self.library.skill_file_health(self.owner_id)["state"], "ok")

    def test_symlink_package_directory_is_rejected_without_importing_outside_content(self) -> None:
        result = self._import()
        working = self.root / str(self.owner_id) / "warm-reply"
        outside = self.root.parent / f"notalone-outside-{uuid4().hex}"
        self.addCleanup(shutil.rmtree, outside, True)
        outside.mkdir()
        (outside / "SKILL.md").write_text(
            "---\nname: warm-reply\ndescription: 外部合成包。\n---\n\n外部内容不得导入。\n",
            encoding="utf-8",
        )
        shutil.rmtree(working)
        working.symlink_to(outside, target_is_directory=True)

        with self.assertLogs(
            "notalone.persistence.skill_files", level="WARNING"
        ):
            self._synchronize()

        catalog = self.port.catalog(self.scope)
        self.assertEqual([entry.version_id for entry in catalog.entries], [result.version_id])
        self.assertEqual(len(self.library.list_versions(self.owner_id, result.skill_id)), 1)
        self.assertNotIn(
            "外部内容", self.port.load_version(self.scope, result.version_id).content
        )
        health = self.library.skill_file_health(self.owner_id)
        self.assertEqual(health["state"], "degraded")
        self.assertEqual(health["failures"][0]["code"], "symlink_rejected")

        working.unlink()
        self._write_package()
        self._synchronize()
        self.assertEqual(self.library.skill_file_health(self.owner_id)["state"], "ok")

    def test_cleanup_path_validation_rejects_parent_and_final_segment_escape(self) -> None:
        outside = self.root.parent / f"notalone-cleanup-outside-{uuid4().hex}"
        self.addCleanup(shutil.rmtree, outside, True)
        outside.mkdir()
        keeper = outside / "keep.txt"
        keeper.write_text("保留。", encoding="utf-8")
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.reply_skill_file_cleanup(relative_path) VALUES (%s)",
                (f"{self.owner_id}/../{outside.name}",),
            )
            connection.execute(
                "INSERT INTO public.reply_skill_file_cleanup(relative_path) VALUES (%s)",
                (f"../{outside.name}",),
            )
            connection.execute(
                "INSERT INTO public.reply_skill_file_cleanup(relative_path) VALUES (%s)",
                (f"{self.owner_id}/..",),
            )

        with self.assertLogs(
            "notalone.persistence.skill_files", level="WARNING"
        ):
            self._synchronize()

        self.assertTrue(outside.is_dir())
        self.assertTrue(keeper.is_file())
        self.assertTrue(self.root.is_dir())
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.reply_skill_file_cleanup"
            ).fetchone()[0], 3)
        health = self.library.skill_file_health(self.owner_id)
        self.assertEqual(health["state"], "degraded")
        # 健康状态只统计可归属当前 owner 的待清理行；无法归属的异常行保持原样待人工核对。
        self.assertEqual(health["pending_cleanup_files"], 2)
        self.assertEqual(health["failures"][0]["operation"], "cleanup")
        self.assertEqual(health["failures"][0]["code"], "file_unavailable")


if __name__ == "__main__":
    unittest.main()
