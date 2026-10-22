"""Skill 删除与隐私清理的 PostgreSQL 集成测试。

只使用合成 Owner、Contact 和 Skill；断言正文、资源和来源不可检索。
"""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row

from notalone.persistence.skill_library import (
    PostgresSkillLibrary,
    SkillLibraryPersistenceError,
    SkillNotFoundError,
)
from notalone.persistence.skill_port import PostgresSkillPort
from notalone.persistence.skill_manifest import read_package_manifest
from notalone.scopes import ContactScope


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresSkillDeletionTest(unittest.TestCase):
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
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        environment = patch.dict(os.environ, {"NOTALONE_SKILLS_DIR": str(self.root)})
        environment.start()
        self.addCleanup(environment.stop)
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

    def _import(
        self,
        name: str,
        *,
        owner_id: UUID | None = None,
        version_count: int = 1,
        temporary_directory: str,
    ) -> tuple[UUID, UUID]:
        import shutil

        owner = owner_id or self.owner_id
        package = Path(temporary_directory) / name
        if package.exists():
            shutil.rmtree(package)
        (package / "references").mkdir(parents=True)
        (package / "SKILL.md").write_text(
            "---\n"
            f"name: {name}\n"
            "description: 删除清理测试策略。\n"
            "---\n\n"
            "只保存受控文字资料。\n"
            f"第 1 版正文。\n",
            encoding="utf-8",
        )
        (package / "references" / "cases.md").write_text(
            "第 1 版案例。\n",
            encoding="utf-8",
        )
        first = self.library.import_package(owner, package)
        skill_id = first.skill_id
        if version_count > 1:
            (package / "SKILL.md").write_text(
                "---\n"
                f"name: {name}\n"
                "description: 删除清理测试策略。\n"
                "---\n\n"
                "只保存受控文字资料。\n"
                f"第 2 版正文。\n",
                encoding="utf-8",
            )
            (package / "references" / "cases.md").write_text(
                "第 2 版案例。\n",
                encoding="utf-8",
            )
            self.library.update_package(owner, package)
        return skill_id, skill_id

    def test_delete_scrubs_all_versions_source_and_resources(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            skill_id, _ = self._import(
                "cleanup-skill",
                version_count=2,
                temporary_directory=temporary_directory,
            )
            catalog_before = self.skill_port.catalog(self._scope())
            version_id = catalog_before.entries[0].version_id
            with psycopg.connect(TEST_DATABASE_URL, row_factory=dict_row) as connection:
                resource_path = read_package_manifest(connection, version_id)["resources"][0]["relative_path"]

            credential = self.library.delete(self.owner_id, skill_id)

        self.assertEqual(credential.skill_id, skill_id)
        self.assertIsNotNone(credential.deletion_operation_id)
        self.assertGreater(credential.revision, catalog_before.revision)
        catalog = self.skill_port.catalog(self._scope())
        self.assertEqual(catalog.entries, ())
        self.assertEqual(catalog.revision, credential.revision)

        # 运行侧不可再加载版本或资源。
        with self.assertRaises(PermissionError):
            self.skill_port.load_version(self._scope(), version_id)
        with self.assertRaises(PermissionError):
            self.skill_port.load_resource(
                self._scope(),
                version_id,
                resource_path,
            )

        with psycopg.connect(TEST_DATABASE_URL, row_factory=dict_row) as connection:
            skill_row = connection.execute(
                """
                SELECT status, deleted_at, deletion_operation_id,
                       deletion_error_code
                FROM public.reply_skill
                WHERE id = %s
                """,
                (skill_id,),
            ).fetchone()
            version_rows = connection.execute(
                """
                SELECT content_path, document_sha256, manifest_sha256, content_sha256, source_locator, enabled,
                       is_current, status, deleted_at
                FROM public.reply_skill_version
                WHERE skill_id = %s
                """,
                (skill_id,),
            ).fetchall()
        self.assertEqual(skill_row["status"], "deleted")
        self.assertIsNotNone(skill_row["deleted_at"])
        self.assertEqual(
            skill_row["deletion_operation_id"],
            credential.deletion_operation_id,
        )
        self.assertIsNone(skill_row["deletion_error_code"])
        self.assertTrue(len(version_rows) >= 2)
        for row in version_rows:
            self.assertIsNone(row["content_path"])
            self.assertIsNone(row["document_sha256"])
            self.assertIsNone(row["manifest_sha256"])
            self.assertIsNone(row["content_sha256"])
            self.assertIsNone(row["source_locator"])
            self.assertFalse(row["enabled"])
            self.assertFalse(row["is_current"])
            self.assertEqual(row["status"], "deleted")
            self.assertIsNotNone(row["deleted_at"])
        self.assertFalse((self.root / ".versions" / str(self.owner_id) / str(skill_id)).exists())
        self.assertIsNotNone(catalog_before.entries[0].name)

    def test_repeat_delete_is_idempotent_and_returns_stable_credential(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            skill_id, _ = self._import(
                "idempotent-delete",
                temporary_directory=temporary_directory,
            )
            first = self.library.delete(self.owner_id, skill_id)

            second = self.library.delete(self.owner_id, skill_id)

        self.assertEqual(second.skill_id, first.skill_id)
        self.assertEqual(
            second.deletion_operation_id,
            first.deletion_operation_id,
        )
        self.assertEqual(second.revision, first.revision)
        self.assertNotIn(
            "idempotent-delete",
            [entry.name for entry in self.skill_port.catalog(self._scope()).entries],
        )

    def test_delete_other_owner_skill_fails_without_existence_leak(self) -> None:
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
                skill_id, _ = self._import(
                    "owner-isolated-delete",
                    temporary_directory=temporary_directory,
                )
                with self.assertRaises(SkillNotFoundError) as caught:
                    self.library.delete(other_owner_id, skill_id)
                error = str(caught.exception).lower()
            self.assertNotIn("owner-isolated-delete", error)
            self.assertIn(
                "owner-isolated-delete",
                [entry.name for entry in self.skill_port.catalog(self._scope()).entries],
            )
        finally:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                connection.execute(
                    "DELETE FROM public.owner WHERE id = %s",
                    (other_owner_id,),
                )

    def test_delete_failure_rolls_back_keeping_retryable_state(self) -> None:
        trigger_name = f"block_skill_version_delete_{uuid4().hex}"
        function_name = f"block_skill_version_delete_fn_{uuid4().hex}"
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                f"""
                CREATE FUNCTION public.{function_name}()
                RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    RAISE EXCEPTION 'synthetic skill version delete failure';
                END
                $$
                """
            )
            connection.execute(
                f"""
                CREATE TRIGGER {trigger_name}
                BEFORE UPDATE OF status ON public.reply_skill_version
                FOR EACH ROW EXECUTE FUNCTION public.{function_name}()
                """
            )
        try:
            with TemporaryDirectory() as temporary_directory:
                skill_id, _ = self._import(
                    "atomic-delete",
                    temporary_directory=temporary_directory,
                )
                catalog_before = self.skill_port.catalog(self._scope())
                with self.assertRaises(SkillLibraryPersistenceError):
                    self.library.delete(self.owner_id, skill_id)
        finally:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                connection.execute(
                    f"DROP TRIGGER {trigger_name} "
                    "ON public.reply_skill_version"
                )
                connection.execute(f"DROP FUNCTION public.{function_name}()")

        # 事务回滚：Skill 仍可用，正文、资源和修订保持一致。
        catalog = self.skill_port.catalog(self._scope())
        self.assertEqual(catalog.revision, catalog_before.revision)
        self.assertEqual(
            [entry.name for entry in catalog.entries],
            ["atomic-delete"],
        )
        loaded = self.skill_port.load_version(
            self._scope(),
            catalog.entries[0].version_id,
        )
        self.assertIn("第 1 版正文", loaded.content)

    def test_delete_does_not_affect_other_skill_or_other_owner(self) -> None:
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
                deleted_id, _ = self._import(
                    "to-delete",
                    temporary_directory=temporary_directory,
                )
                kept_id, _ = self._import(
                    "to-keep",
                    temporary_directory=temporary_directory,
                )
                other_id, _ = self._import(
                    "other-owner-keep",
                    owner_id=other_owner_id,
                    temporary_directory=temporary_directory,
                )
                self.library.delete(self.owner_id, deleted_id)

            catalog = self.skill_port.catalog(self._scope())
            self.assertEqual(
                [entry.name for entry in catalog.entries],
                ["to-keep"],
            )
            other_catalog = self.skill_port.catalog(
                ContactScope(other_owner_id, other_contact_id)
            )
            self.assertEqual(
                [entry.name for entry in other_catalog.entries],
                ["other-owner-keep"],
            )
            self.assertNotEqual(kept_id, deleted_id)
            self.assertNotEqual(other_id, deleted_id)
        finally:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                connection.execute(
                    "DELETE FROM public.owner WHERE id IN (%s, %s)",
                    (self.owner_id, other_owner_id),
                )

    def test_delete_leaves_no_content_hash_recoverable_from_db(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            skill_id, _ = self._import(
                "hash-wipe",
                version_count=2,
                temporary_directory=temporary_directory,
            )
            self.library.delete(self.owner_id, skill_id)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            leaked_content = connection.execute(
                """
                SELECT count(*) FROM public.reply_skill_version
                WHERE skill_id = %s AND (content_path IS NOT NULL OR document_sha256 IS NOT NULL OR manifest_sha256 IS NOT NULL)
                """,
                (skill_id,),
            ).fetchone()[0]
            leaked_hashes = connection.execute(
                """
                SELECT count(*) FROM public.reply_skill_version
                WHERE skill_id = %s AND content_sha256 IS NOT NULL
                """,
                (skill_id,),
            ).fetchone()[0]
            leaked_locators = connection.execute(
                """
                SELECT count(*) FROM public.reply_skill_version
                WHERE skill_id = %s AND source_locator IS NOT NULL
                """,
                (skill_id,),
            ).fetchone()[0]
        self.assertEqual(leaked_content, 0)
        self.assertEqual(leaked_hashes, 0)
        self.assertEqual(leaked_locators, 0)
        self.assertFalse((self.root / ".versions" / str(self.owner_id) / str(skill_id)).exists())


if __name__ == "__main__":
    unittest.main()
