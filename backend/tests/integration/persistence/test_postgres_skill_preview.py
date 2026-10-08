"""Skill 试用预览的 PostgreSQL 管理集成测试。

只使用合成 Owner、Contact、Skill 和预览执行器；验证范围、回退和无副作用。
"""

from __future__ import annotations

import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import UUID, uuid4

import psycopg

from notalone.persistence.skill_library import PostgresSkillLibrary
from notalone.scopes import ContactScope
from notalone.skills import PreviewCandidate, SkillCatalog, SkillPreview


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class RecordingPreviewEngine:
    """记录调用并使用固定合成预览的预览执行器。"""

    def __init__(
        self,
        *,
        preview: SkillPreview,
        fail_with: Exception | None = None,
    ) -> None:
        self.preview = preview
        self.fail_with = fail_with
        self.calls: list[tuple[object, SkillCatalog]] = []

    def generate(
        self,
        *,
        scope: ContactScope,
        context: object,
        catalog: SkillCatalog,
    ) -> SkillPreview:
        del scope
        self.calls.append((context, catalog))
        if self.fail_with is not None:
            raise self.fail_with
        return self.preview


class PostgresSkillPreviewTest(unittest.TestCase):
    """只使用合成数据；试用不修改任何长期资料。"""

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

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    def _scope(self) -> ContactScope:
        return ContactScope(self.owner_id, self.contact_id)

    def _import(self, name: str, temporary_directory: str) -> UUID:
        import shutil

        package = Path(temporary_directory) / name
        if package.exists():
            shutil.rmtree(package)
        (package / "references").mkdir(parents=True)
        (package / "SKILL.md").write_text(
            "---\n"
            f"name: {name}\n"
            "description: 试用预览测试策略。\n"
            "---\n\n"
            "只用于合成试用。\n",
            encoding="utf-8",
        )
        result = self.library.import_package(self.owner_id, package)
        return result.skill_id

    def _loaded_preview(self, scope: ContactScope) -> SkillPreview:
        return SkillPreview(
            scope=scope,
            skill_id=UUID("00000000-0000-0000-0000-000000000001"),
            version_id=UUID("00000000-0000-0000-0000-000000000002"),
            name="preview-skill",
            candidates=(
                PreviewCandidate(
                    text="可以呀，明天见。",
                    basis="合成试用预览",
                    risk_notes=("请核实时间。",),
                ),
            ),
            selection_reason="用户指定 Skill 试用。",
            resource_paths=(),
            load_state="loaded",
        )

    def test_preview_passes_single_skill_catalog_to_engine(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            skill_id = self._import(
                "preview-skill",
                temporary_directory,
            )
            scope = self._scope()
            context = object()
            engine = RecordingPreviewEngine(
                preview=self._loaded_preview(scope),
            )

            preview = self.library.preview(
                scope=scope,
                skill_id=skill_id,
                context=context,
                engine=engine,
            )

        self.assertEqual(len(engine.calls), 1)
        seen_catalog = engine.calls[0][1]
        self.assertEqual(seen_catalog.scope, scope)
        self.assertEqual(
            [entry.name for entry in seen_catalog.entries],
            ["preview-skill"],
        )
        self.assertEqual(seen_catalog.revision, 1)
        self.assertEqual(preview.candidates[0].text, "可以呀，明天见。")
        self.assertEqual(preview.name, "preview-skill")

    def test_preview_does_not_change_revision_or_skill(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            skill_id = self._import(
                "preview-noop",
                temporary_directory,
            )
            scope = self._scope()
            engine = RecordingPreviewEngine(preview=self._loaded_preview(scope))

            with psycopg.connect(TEST_DATABASE_URL) as connection:
                before = connection.execute(
                    "SELECT revision FROM public.skill_library WHERE owner_id = %s",
                    (self.owner_id,),
                ).fetchone()[0]
            self.library.preview(
                scope=scope,
                skill_id=skill_id,
                context=object(),
                engine=engine,
            )
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                after = connection.execute(
                    "SELECT revision FROM public.skill_library WHERE owner_id = %s",
                    (self.owner_id,),
                ).fetchone()[0]
                version_count = connection.execute(
                    "SELECT count(*) FROM public.reply_skill_version "
                    "WHERE skill_id = %s",
                    (skill_id,),
                ).fetchone()[0]

        self.assertEqual(after, before)
        self.assertEqual(version_count, 1)

    def test_preview_unavailable_skill_returns_no_skill_without_calling_engine(
        self,
    ) -> None:
        with TemporaryDirectory() as temporary_directory:
            skill_id = self._import(
                "then-disable",
                temporary_directory,
            )
            self.library.disable(self.owner_id, skill_id)
            disabled_engine = RecordingPreviewEngine(
                preview=self._loaded_preview(self._scope()),
            )

            disabled_preview = self.library.preview(
                scope=self._scope(),
                skill_id=skill_id,
                context=object(),
                engine=disabled_engine,
            )

            self.assertEqual(disabled_engine.calls, [])
            self.assertEqual(disabled_preview.load_state, "not_used")
            self.assertEqual(disabled_preview.skill_id, None)
            self.assertTrue(disabled_preview.fallback_reason)

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
                skill_id = self._import(
                    "owner-other",
                    temporary_directory,
                )
                foreign_engine = RecordingPreviewEngine(
                    preview=self._loaded_preview(
                        ContactScope(other_owner_id, other_contact_id)
                    ),
                )
                foreign_preview = self.library.preview(
                    scope=ContactScope(other_owner_id, other_contact_id),
                    skill_id=skill_id,
                    context=object(),
                    engine=foreign_engine,
                )
            self.assertEqual(foreign_engine.calls, [])
            self.assertEqual(foreign_preview.load_state, "not_used")
            self.assertNotIn("owner-other", foreign_preview.fallback_reason)
        finally:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                connection.execute(
                    "DELETE FROM public.owner WHERE id = %s",
                    (other_owner_id,),
                )

    def test_preview_engine_failure_returns_controlled_no_skill_preview(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            skill_id = self._import(
                "engine-fail",
                temporary_directory,
            )
            scope = self._scope()
            engine = RecordingPreviewEngine(
                preview=self._loaded_preview(scope),
                fail_with=RuntimeError("synthetic engine outage"),
            )

            preview = self.library.preview(
                scope=scope,
                skill_id=skill_id,
                context=object(),
                engine=engine,
            )

        self.assertEqual(preview.load_state, "not_used")
        self.assertEqual(preview.skill_id, None)
        self.assertTrue(preview.fallback_reason)
        self.assertNotIn("engine", preview.candidates)


if __name__ == "__main__":
    unittest.main()
