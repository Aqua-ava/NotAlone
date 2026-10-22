"""Skill 读路径只读化与显式目录同步入口的回归测试。"""

from __future__ import annotations

import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import psycopg

from notalone.persistence.skill_directory import synchronize_skill_library
from notalone.persistence.skill_files import SkillFileError
from notalone.persistence.skill_port import (
    PostgresSkillPort,
    SkillPortPersistenceError,
    require_reply_skill_current,
)
from notalone.scopes import ContactScope
from tests.integration.persistence.skill_fixture import insert_file_skill


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresSkillReadPathTest(unittest.TestCase):
    """只使用合成 Skill 与临时管理目录。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
                has_table = connection.execute(
                    "SELECT to_regclass('public.reply_skill')"
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest("本地 PostgreSQL 测试库不可用。") from error
        if not database_name.endswith("_test"):
            raise RuntimeError("集成测试只允许连接名称以 _test 结尾的数据库。")
        if has_table is None:
            raise unittest.SkipTest("测试库尚未应用 Skill 迁移。")

    def setUp(self) -> None:
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        environment = patch.dict(
            os.environ, {"NOTALONE_SKILLS_DIR": str(self.root)}
        )
        environment.start()
        self.addCleanup(environment.stop)
        self.owner_id, self.contact_id = uuid4(), uuid4()
        self.scope = ContactScope(self.owner_id, self.contact_id)
        self.skill_id, self.version_id = uuid4(), uuid4()
        self.resource_path = "references/example.md"
        resource = "先表达理解，再邀请对方选择。".encode("utf-8")
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner(id,display_name) VALUES (%s,'合成读路径用户')",
                (self.owner_id,),
            )
            connection.execute(
                "INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,'合成读路径联系人')",
                (self.owner_id, self.contact_id),
            )
            connection.execute(
                "INSERT INTO public.skill_library(owner_id,revision) VALUES (%s,5)",
                (self.owner_id,),
            )
            insert_file_skill(connection, owner_id=self.owner_id, skill_id=self.skill_id,
                              version_id=self.version_id, name="legacy-reply", content="先表示理解。",
                              description="旧版合成描述。", resources={self.resource_path: resource})
        self.original_files = {str(path.relative_to(self.root)): path.read_bytes()
                               for path in self.root.rglob("*") if path.is_file()}
        self.port = PostgresSkillPort(TEST_DATABASE_URL)

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s", (self.owner_id,)
            )

    def _package(self, *, name="directory-reply", body="先确认感受，再表达需要。") -> Path:
        directory = self.root / str(self.owner_id) / name
        (directory / "references").mkdir(parents=True, exist_ok=True)
        (directory / "SKILL.md").write_text(
            "---\n" f"name: {name}\n" "description: 适合目录读路径测试。\n"
            "---\n\n" f"{body}\n",
            encoding="utf-8",
        )
        (directory / "references" / "example.md").write_text(
            "可以先表达理解，再邀请对方选择。\n", encoding="utf-8"
        )
        return directory

    def _forbid_directory_writes(self) -> None:
        targets = (
            "notalone.persistence.skill_directory.synchronize_skill_directory",
            "notalone.persistence.skill_files.synchronize_working_copies",
            "notalone.persistence.skill_files.cleanup_pending_files",
            "notalone.persistence.skill_files.cleanup_unreferenced_snapshots",
        )
        for target in targets:
            patcher = patch(target, side_effect=AssertionError(f"读路径不得调用 {target}"))
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_read_operations_do_not_migrate_synchronize_or_write_files(self) -> None:
        self._forbid_directory_writes()

        catalog = self.port.catalog(self.scope)
        loaded = self.port.load_version(self.scope, self.version_id)
        resource = self.port.load_resource(self.scope, self.version_id, self.resource_path)

        self.assertEqual([entry.name for entry in catalog.entries], ["legacy-reply"])
        self.assertEqual(catalog.revision, 5)
        self.assertEqual(loaded.content, "先表示理解。")
        self.assertEqual(resource.content.decode("utf-8"), "先表达理解，再邀请对方选择。")
        self.assertEqual({str(path.relative_to(self.root)): path.read_bytes()
                          for path in self.root.rglob("*") if path.is_file()}, self.original_files)

    def test_directory_discovery_happens_only_at_explicit_synchronize_entry(self) -> None:
        self._package()

        before = self.port.catalog(self.scope)

        self.assertEqual([entry.name for entry in before.entries], ["legacy-reply"])
        revision = synchronize_skill_library(TEST_DATABASE_URL, self.owner_id)

        after = self.port.catalog(self.scope)
        self.assertEqual(
            [entry.name for entry in after.entries], ["directory-reply", "legacy-reply"]
        )
        self.assertEqual(after.revision, revision)
        self.assertGreater(after.revision, before.revision)
        # 显式入口同步已有文件版本的工作副本；读路径本身不落盘。
        legacy_document = (
            self.root
            / ".versions"
            / str(self.owner_id)
            / str(self.skill_id)
            / str(self.version_id)
            / "legacy-reply"
            / "SKILL.md"
        )
        self.assertTrue(legacy_document.is_file())
        self.assertEqual(
            synchronize_skill_library(TEST_DATABASE_URL, self.owner_id), revision
        )
        selected = self.port.load_version(self.scope, after.entries[0].version_id)
        self.assertEqual(selected.content, "先确认感受，再表达需要。\n")
        self.assertEqual(selected.resource_paths, ("references/example.md",))
        loaded_resource = self.port.load_resource(
            self.scope, selected.version_id, "references/example.md"
        )
        self.assertEqual(
            loaded_resource.content.decode("utf-8"), "可以先表达理解，再邀请对方选择。\n"
        )

    def test_catalog_maps_skill_file_error_to_domain_error_without_paths(self) -> None:
        self._package()
        synchronize_skill_library(TEST_DATABASE_URL, self.owner_id)

        with patch(
            "notalone.persistence.skill_port.project_skill_metadata",
            side_effect=SkillFileError("Skill 文件不可用。"),
        ):
            with self.assertRaises(SkillPortPersistenceError) as caught:
                self.port.catalog(self.scope)

        message = str(caught.exception)
        self.assertEqual(message, "Skill 目录读取失败。")
        self.assertNotIn(str(self.root), message)

    def test_final_verification_without_skill_does_not_scan_directory(self) -> None:
        context = SimpleNamespace(
            scope=self.scope,
            skill_library_revision=5,
            command=SimpleNamespace(scene=None),
        )
        with patch(
            "notalone.persistence.skill_directory.synchronize_skill_directory",
            side_effect=AssertionError("最终复验不得扫描目录"),
        ):
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                require_reply_skill_current(connection, context, None)


if __name__ == "__main__":
    unittest.main()
