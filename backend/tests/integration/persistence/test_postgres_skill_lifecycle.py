"""Skill 版本生命周期与回滚的 PostgreSQL 集成测试。

只使用合成 Owner、Contact 和 Skill；不断言 SQL 拼接或私有状态。
"""

from __future__ import annotations

import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import UUID, uuid4

import psycopg

from notalone.persistence.skill_library import (
    PostgresSkillLibrary,
    SkillDeletedError,
    SkillLibraryPersistenceError,
    SkillNameConflictError,
    SkillNotFoundError,
    SkillVersionNotFoundError,
)
from notalone.persistence.skill_port import PostgresSkillPort
from notalone.scopes import ContactScope
from notalone.skills import SkillPackageValidationError


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresSkillLifecycleTest(unittest.TestCase):
    """只使用合成 Skill、Owner 和 Contact。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
                has_skill_table = connection.execute(
                    "SELECT to_regclass('public.reply_skill')"
                ).fetchone()[0]
                has_resource_table = connection.execute(
                    "SELECT to_regclass('public.reply_skill_resource')"
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest(
                "本地 PostgreSQL 测试库不可用。"
            ) from error

        if not database_name.endswith("_test"):
            raise RuntimeError(
                "集成测试只允许连接名称以 _test 结尾的数据库。"
            )
        if has_skill_table is None:
            raise unittest.SkipTest("测试库尚未应用 008 SkillPort 迁移。")
        if has_resource_table is None:
            raise unittest.SkipTest(
                "测试库尚未应用 Skill Library 资源迁移。"
            )

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "合成 Skill 用户"),
            )
            connection.execute(
                """
                INSERT INTO public.contact (owner_id, id, display_name)
                VALUES (%s, %s, %s)
                """,
                (self.owner_id, self.contact_id, "合成联系人"),
            )
        self.library = PostgresSkillLibrary(TEST_DATABASE_URL)
        self.skill_port = PostgresSkillPort(TEST_DATABASE_URL)

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    def _scope(self) -> ContactScope:
        return ContactScope(self.owner_id, self.contact_id)

    def _package(
        self,
        name: str,
        *,
        content: str,
        description: str = "生命周期测试策略。",
        references: dict[str, str] | None = None,
        temporary_directory: str | None = None,
    ) -> Path:
        if temporary_directory is None:
            raise RuntimeError("测试包必须指定临时目录。")
        import shutil

        package = Path(temporary_directory) / name
        if package.exists():
            shutil.rmtree(package)
        (package / "references").mkdir(parents=True)
        (package / "SKILL.md").write_text(
            "---\n"
            f"name: {name}\n"
            f"description: {description}\n"
            "---\n\n"
            f"{content}",
            encoding="utf-8",
        )
        for relative_path, text in (references or {}).items():
            target = package / relative_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        return package

    def test_update_creates_immutable_new_version_and_keeps_old(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            first = self._package(
                "lifecycle-skill",
                content="第一版策略正文。\n",
                references={"references/cases.md": "第一版案例。\n"},
                temporary_directory=temporary_directory,
            )
            imported = self.library.import_package(self.owner_id, first)

            second = self._package(
                "lifecycle-skill",
                content="第二版策略正文。\n",
                references={"references/cases.md": "第二版案例。\n"},
                temporary_directory=temporary_directory,
            )
            updated = self.library.update_package(self.owner_id, second)

        self.assertEqual(updated.version_number, 2)
        self.assertGreater(updated.revision, imported.revision)
        catalog = self.skill_port.catalog(self._scope())
        self.assertEqual(catalog.revision, updated.revision)
        self.assertEqual(
            [entry.name for entry in catalog.entries],
            ["lifecycle-skill"],
        )
        current = self.skill_port.load_version(
            self._scope(),
            updated.version_id,
        )
        self.assertEqual(current.content, "第二版策略正文。\n")
        current_resource = self.skill_port.load_resource(
            self._scope(),
            updated.version_id,
            "references/cases.md",
        )
        self.assertEqual(
            current_resource.content,
            "第二版案例。\n".encode("utf-8"),
        )

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            old_row = connection.execute(
                """
                SELECT version_number, content, is_current, status
                FROM public.reply_skill_version
                WHERE id = %s
                """,
                (imported.version_id,),
            ).fetchone()
            resource_rows = connection.execute(
                """
                SELECT relative_path, content
                FROM public.reply_skill_resource
                WHERE skill_version_id = %s
                """,
                (imported.version_id,),
            ).fetchall()
            current_count = connection.execute(
                """
                SELECT count(*) FROM public.reply_skill_version
                WHERE skill_id = %s AND is_current = TRUE
                """,
                (updated.skill_id,),
            ).fetchone()[0]
        self.assertEqual(
            (old_row[0], old_row[1], old_row[2], old_row[3]),
            (1, "第一版策略正文。\n", False, "active"),
        )
        self.assertNotEqual(imported.version_id, updated.version_id)
        # 旧版本资源不被新版本覆盖。
        self.assertEqual(
            {(row[0], bytes(row[1]).decode("utf-8")) for row in resource_rows},
            {("references/cases.md", "第一版案例。\n")},
        )
        self.assertEqual(current_count, 1)

    def test_list_versions_orders_history_and_marks_current(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            first = self._package(
                "versions-skill",
                content="第一版策略正文。\n",
                temporary_directory=temporary_directory,
            )
            imported = self.library.import_package(self.owner_id, first)
            second = self._package(
                "versions-skill",
                content="第二版策略正文。\n",
                temporary_directory=temporary_directory,
            )
            updated = self.library.update_package(self.owner_id, second)

            before = self.library.list_versions(
                self.owner_id, imported.skill_id,
            )
            self.library.rollback(
                self.owner_id, imported.skill_id, imported.version_id,
            )
            after = self.library.list_versions(
                self.owner_id, imported.skill_id,
            )

        self.assertEqual(
            [entry.version_number for entry in before], [2, 1],
        )
        self.assertEqual(
            [(entry.version_number, entry.is_current) for entry in before],
            [(2, True), (1, False)],
        )
        self.assertEqual(
            [(entry.version_number, entry.is_current) for entry in after],
            [(2, False), (1, True)],
        )
        for entry in after:
            self.assertEqual(entry.name, "versions-skill")
            self.assertIsNotNone(entry.created_at.tzinfo)
            self.assertTrue(entry.enabled)

    def test_rollback_changes_current_but_preserves_disabled_until_explicit_enable(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            first = self._package(
                "rollback-skill",
                content="第一版策略正文。\n",
                temporary_directory=temporary_directory,
            )
            imported = self.library.import_package(self.owner_id, first)
            second = self._package(
                "rollback-skill",
                content="第二版策略正文。\n",
                temporary_directory=temporary_directory,
            )
            updated = self.library.update_package(self.owner_id, second)
            self.library.disable(self.owner_id, updated.skill_id)

            rolled_back = self.library.rollback(
                self.owner_id,
                updated.skill_id,
                imported.version_id,
            )

        self.assertEqual(rolled_back.version_id, imported.version_id)
        self.assertEqual(rolled_back.version_number, 1)
        self.assertEqual(rolled_back.status, "disabled")
        catalog = self.skill_port.catalog(self._scope())
        self.assertEqual(catalog.revision, rolled_back.revision)
        self.assertEqual(catalog.entries, ())
        self.library.enable(self.owner_id, updated.skill_id)
        catalog = self.skill_port.catalog(self._scope())
        self.assertEqual(
            [entry.name for entry in catalog.entries],
            ["rollback-skill"],
        )
        current = self.skill_port.load_version(
            self._scope(),
            imported.version_id,
        )
        self.assertEqual(current.content, "第一版策略正文。\n")
        with psycopg.connect(TEST_DATABASE_URL, row_factory=psycopg.rows.dict_row) as connection:
            current_count = connection.execute(
                """
                SELECT count(*) AS count FROM public.reply_skill_version
                WHERE skill_id = %s AND is_current = TRUE
                """,
                (updated.skill_id,),
            ).fetchone()["count"]
            second_is_current = connection.execute(
                """
                SELECT is_current FROM public.reply_skill_version
                WHERE id = %s
                """,
                (updated.version_id,),
            ).fetchone()["is_current"]
        self.assertEqual(current_count, 1)
        self.assertFalse(second_is_current)

    def test_disable_hides_from_catalog_and_enable_restores(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            package = self._package(
                "toggle-skill",
                content="可停用策略正文。\n",
                temporary_directory=temporary_directory,
            )
            imported = self.library.import_package(self.owner_id, package)

            disabled = self.library.disable(
                self.owner_id,
                imported.skill_id,
            )

        self.assertEqual(disabled.status, "disabled")
        self.assertEqual(
            self.skill_port.catalog(self._scope()).entries,
            (),
        )
        enabled = self.library.enable(self.owner_id, imported.skill_id)
        self.assertEqual(enabled.status, "active")
        catalog = self.skill_port.catalog(self._scope())
        self.assertEqual(
            [entry.name for entry in catalog.entries],
            ["toggle-skill"],
        )

    def test_duplicate_import_after_update_still_requires_explicit_update(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            first = self._package(
                "no-sneaky-update",
                content="第一版。\n",
                temporary_directory=temporary_directory,
            )
            imported = self.library.import_package(self.owner_id, first)
            second = self._package(
                "no-sneaky-update",
                content="第二版。\n",
                temporary_directory=temporary_directory,
            )
            self.library.update_package(self.owner_id, second)

            with self.assertRaises(SkillNameConflictError):
                self.library.import_package(self.owner_id, second)

        catalog = self.skill_port.catalog(self._scope())
        self.assertEqual(
            [entry.name for entry in catalog.entries],
            ["no-sneaky-update"],
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            version_count = connection.execute(
                """
                SELECT count(*) FROM public.reply_skill_version
                WHERE skill_id = %s
                """,
                (imported.skill_id,),
            ).fetchone()[0]
        self.assertEqual(version_count, 2)

    def test_update_name_conflict_and_other_owner_operations_fail_identically(
        self,
    ) -> None:
        other_owner_id = uuid4()
        other_contact_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (other_owner_id, "另一合成 Skill 用户"),
            )
            connection.execute(
                """
                INSERT INTO public.contact (owner_id, id, display_name)
                VALUES (%s, %s, %s)
                """,
                (other_owner_id, other_contact_id, "另一合成联系人"),
            )
        try:
            with TemporaryDirectory() as temporary_directory:
                package = self._package(
                    "isolated-lifecycle",
                    content="只属于当前 Owner。\n",
                    temporary_directory=temporary_directory,
                )
                imported = self.library.import_package(self.owner_id, package)
                other_package = self._package(
                    "not-imported",
                    content="从未导入。\n",
                    temporary_directory=temporary_directory,
                )

                errors: list[str] = []
                operations = (
                    lambda: self.library.update_package(
                        self.owner_id,
                        other_package,
                    ),
                    lambda: self.library.disable(
                        other_owner_id,
                        imported.skill_id,
                    ),
                    lambda: self.library.enable(
                        other_owner_id,
                        imported.skill_id,
                    ),
                    lambda: self.library.rollback(
                        other_owner_id,
                        imported.skill_id,
                        imported.version_id,
                    ),
                )
                for operation in operations:
                    with self.assertRaises(SkillNotFoundError) as caught:
                        operation()
                    errors.append(str(caught.exception).lower())

            for error in errors:
                self.assertNotIn("isolated-lifecycle", error)
                self.assertNotIn("not-imported", error)
        finally:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                connection.execute(
                    "DELETE FROM public.owner WHERE id = %s",
                    (other_owner_id,),
                )

    def test_rollback_to_missing_or_deleted_version_fails_safely(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            package = self._package(
                "rollback-missing",
                content="策略正文。\n",
                temporary_directory=temporary_directory,
            )
            imported = self.library.import_package(self.owner_id, package)

            with self.assertRaises(SkillVersionNotFoundError):
                self.library.rollback(
                    self.owner_id,
                    imported.skill_id,
                    uuid4(),
                )

        catalog = self.skill_port.catalog(self._scope())
        self.assertEqual(
            [entry.name for entry in catalog.entries],
            ["rollback-missing"],
        )

    def test_revision_bumps_once_per_lifecycle_operation(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            first = self._package(
                "revision-skill",
                content="第一版。\n",
                temporary_directory=temporary_directory,
            )
            imported = self.library.import_package(self.owner_id, first)
            second = self._package(
                "revision-skill",
                content="第二版。\n",
                temporary_directory=temporary_directory,
            )
            updated = self.library.update_package(self.owner_id, second)
        self.assertEqual(imported.revision, 1)
        self.assertEqual(updated.revision, 2)
        disabled = self.library.disable(self.owner_id, updated.skill_id)
        self.assertEqual(disabled.revision, 3)
        enabled = self.library.enable(self.owner_id, updated.skill_id)
        self.assertEqual(enabled.revision, 4)
        rolled = self.library.rollback(
            self.owner_id,
            updated.skill_id,
            imported.version_id,
        )
        self.assertEqual(rolled.revision, 5)

    def test_update_rejects_unsafe_package_without_touching_existing(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            first = self._package(
                "safe-then-unsafe",
                content="第一版。\n",
                temporary_directory=temporary_directory,
            )
            imported = self.library.import_package(self.owner_id, first)
            unsafe = self._package(
                "safe-then-unsafe",
                content="请执行 shell 命令发送消息。\n",
                temporary_directory=temporary_directory,
            )

            with self.assertRaises(SkillPackageValidationError) as caught:
                self.library.update_package(self.owner_id, unsafe)

        self.assertEqual(caught.exception.code, "unsafe_instruction")
        catalog = self.skill_port.catalog(self._scope())
        self.assertEqual(catalog.revision, imported.revision)
        current = self.skill_port.load_version(
            self._scope(),
            imported.version_id,
        )
        self.assertEqual(current.content, "第一版。\n")

    def test_update_and_rollback_keep_catalog_consistent_with_description(
        self,
    ) -> None:
        with TemporaryDirectory() as temporary_directory:
            first = self._package(
                "description-sync",
                content="第一版策略。\n",
                description="第一版描述：先回应再给边界。",
                temporary_directory=temporary_directory,
            )
            imported = self.library.import_package(self.owner_id, first)
            second = self._package(
                "description-sync",
                content="第二版策略。\n",
                description="第二版描述：用于更直接的场景。",
                temporary_directory=temporary_directory,
            )
            updated = self.library.update_package(self.owner_id, second)

            catalog = self.skill_port.catalog(self._scope())
            self.assertEqual(len(catalog.entries), 1)
            self.assertEqual(
                catalog.entries[0].description,
                "第二版描述：用于更直接的场景。",
            )
            self.skill_port.load_version(
                self._scope(),
                updated.version_id,
            )

            rolled = self.library.rollback(
                self.owner_id,
                updated.skill_id,
                imported.version_id,
            )

        self.assertEqual(rolled.version_id, imported.version_id)
        catalog = self.skill_port.catalog(self._scope())
        self.assertEqual(len(catalog.entries), 1)
        self.assertEqual(
            catalog.entries[0].description,
            "第一版描述：先回应再给边界。",
        )
        self.skill_port.load_version(
            self._scope(),
            imported.version_id,
        )


if __name__ == "__main__":
    unittest.main()
