"""Skill 导出可移植包与资料排除的 PostgreSQL 集成测试。

只使用合成 Owner、Contact 和 Skill；导出目标只写入包内容，不带走资料。
"""

from __future__ import annotations

import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

import psycopg

from notalone.persistence.skill_library import (
    PostgresSkillLibrary,
    SkillNotFoundError,
    SkillVersionNotFoundError,
)
from notalone.persistence.skill_port import PostgresSkillPort
from notalone.scopes import ContactScope
from notalone.skills import LocalSkillPackageReader, SkillPackage
from notalone.skills.package import SkillPackageValidator


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresSkillExportTest(unittest.TestCase):
    """只使用合成 Skill、Owner 和 Contact。"""

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
            raise unittest.SkipTest(
                "本地 PostgreSQL 测试库不可用。"
            ) from error

        if not database_name.endswith("_test"):
            raise RuntimeError(
                "集成测试只允许连接名称以 _test 结尾的数据库。"
            )
        if has_table is None:
            raise unittest.SkipTest("测试库尚未应用 008 SkillPort 迁移。")

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
        temporary_directory: str,
        content: str,
        description: str = "可移植导出策略。",
        references: dict[str, str] | None = None,
        assets: dict[str, str] | None = None,
    ) -> Path:
        import shutil

        package = Path(temporary_directory) / name
        if package.exists():
            shutil.rmtree(package)
        (package / "references").mkdir(parents=True)
        (package / "assets").mkdir(parents=True)
        (package / "SKILL.md").write_text(
            "---\n"
            f"name: {name}\n"
            f"description: {description}\n"
            "---\n\n"
            f"{content}",
            encoding="utf-8",
        )
        for relative_path, text in (references or {}).items():
            (package / relative_path).write_text(text, encoding="utf-8")
        for relative_path, text in (assets or {}).items():
            (package / relative_path).write_text(text, encoding="utf-8")
        return package

    def test_export_rebuilds_valid_package_importable_by_another_owner(self) -> None:
        with TemporaryDirectory() as source_directory:
            source = self._package(
                "portable-skill",
                temporary_directory=source_directory,
                content="先回应，再给出边界。\n",
                references={"references/cases.md": "案例正文。\n"},
                assets={"assets/opening.txt": "模板正文。\n"},
            )
            imported = self.library.import_package(self.owner_id, source)

        with TemporaryDirectory() as export_directory:
            # 导出目标目录名与 Skill 名称一致时可被原样重新导入。
            target = Path(export_directory) / "portable-skill"

            exported = self.library.export_package(
                self.owner_id,
                imported.skill_id,
                target,
            )

            self.assertEqual(exported.name, "portable-skill")
            self.assertEqual(
                exported.resource_paths,
                ("assets/opening.txt", "references/cases.md"),
            )
            self.assertEqual(
                {path.name for path in target.rglob("*") if path.is_file()},
                {"SKILL.md", "cases.md", "opening.txt"},
            )
            skill_md = (target / "SKILL.md").read_text(encoding="utf-8")
            self.assertIn("name: portable-skill", skill_md)
            self.assertIn("先回应，再给出边界。", skill_md)
            self.assertIn(
                "案例正文。",
                (target / "references" / "cases.md").read_text(encoding="utf-8"),
            )
            self.assertIn(
                "模板正文。",
                (target / "assets" / "opening.txt").read_text(encoding="utf-8"),
            )

            # 导出包经过同一套校验后可移植到另一个 Owner。
            other_owner_id = uuid4()
            other_contact_id = uuid4()
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                connection.execute(
                    "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                    (other_owner_id, "另一合成 Owner"),
                )
                connection.execute(
                    """
                    INSERT INTO public.contact (owner_id, id, display_name)
                    VALUES (%s, %s, %s)
                    """,
                    (other_owner_id, other_contact_id, "另一合成联系人"),
                )
            try:
                validator = SkillPackageValidator()
                raw = LocalSkillPackageReader().read(target)
                package: SkillPackage = validator.validate(raw)
                self.assertEqual(package.name, "portable-skill")
                self.assertEqual(
                    tuple(
                        resource.relative_path for resource in package.resources
                    ),
                    ("assets/opening.txt", "references/cases.md"),
                )
                relocated = self.library.import_package(other_owner_id, target)
                self.assertEqual(relocated.name, "portable-skill")
            finally:
                with psycopg.connect(TEST_DATABASE_URL) as connection:
                    connection.execute(
                        "DELETE FROM public.owner WHERE id = %s",
                        (other_owner_id,),
                    )

    def test_export_uses_current_version_and_excludes_contact_data(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            source = self._package(
                "current-version-export",
                temporary_directory=temporary_directory,
                content="第一版。\n",
            )
            imported = self.library.import_package(self.owner_id, source)
            updated_source = self._package(
                "current-version-export",
                temporary_directory=temporary_directory,
                content="第二版。\n",
                references={"references/cases.md": "第二版案例。\n"},
            )
            updated = self.library.update_package(
                self.owner_id,
                updated_source,
            )
            target = Path(temporary_directory) / "exported"

            exported = self.library.export_package(
                self.owner_id,
                imported.skill_id,
                target,
            )

            self.assertEqual(exported.version_number, 2)
            self.assertEqual(exported.skill_id, updated.skill_id)
            self.assertIn(
                "第二版。",
                (target / "SKILL.md").read_text(encoding="utf-8"),
            )
            self.assertIn(
                "第二版案例。",
                (target / "references" / "cases.md").read_text(encoding="utf-8"),
            )
            # 导出目录只有包内容，没有联系人、聊天、候选或日志数据。
            exported_names = {
                path.relative_to(target).as_posix()
                for path in target.rglob("*")
                if path.is_file()
            }
            self.assertEqual(
                exported_names,
                {"SKILL.md", "references/cases.md"},
            )

    def test_export_missing_deleted_or_foreign_skill_fails_safely(self) -> None:
        other_owner_id = uuid4()
        other_contact_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (other_owner_id, "另一合成 Owner"),
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
                source = self._package(
                    "guard-export",
                    temporary_directory=temporary_directory,
                    content="策略正文。\n",
                )
                imported = self.library.import_package(self.owner_id, source)
                deleted = self.library.delete(
                    self.owner_id,
                    imported.skill_id,
                )
                target = Path(temporary_directory) / "target"

                errors: list[str] = []
                attempts = (
                    lambda: self.library.export_package(
                        uuid4(),
                        imported.skill_id,
                        target / "missing",
                    ),
                    lambda: self.library.export_package(
                        other_owner_id,
                        imported.skill_id,
                        target / "foreign",
                    ),
                    lambda: self.library.export_package(
                        self.owner_id,
                        imported.skill_id,
                        target / "deleted",
                    ),
                )
                for attempt in attempts:
                    with self.assertRaises(SkillNotFoundError) as caught:
                        attempt()
                    errors.append(str(caught.exception).lower())
            for error in errors:
                self.assertNotIn("guard-export", error)
                self.assertEqual(deleted.skill_id, imported.skill_id)
        finally:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                connection.execute(
                    "DELETE FROM public.owner WHERE id IN (%s, %s)",
                    (self.owner_id, other_owner_id),
                )


if __name__ == "__main__":
    unittest.main()
