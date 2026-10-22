"""经公开目录与读取接口验证本机 Skill 目录；只使用自有合成库。"""

import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.persistence.skill_library import PostgresSkillLibrary, SkillLibraryPersistenceError
from notalone.persistence.skill_directory import SkillDirectorySyncError, synchronize_skill_library
from notalone.persistence.skill_files import SkillFileError
from notalone.persistence.contact_deletion import delete_contact
from notalone.persistence.skill_port import PostgresSkillPort, SkillPortPersistenceError
from notalone.persistence.skill_history import PostgresSkillHistory
from notalone.persistence.skill_policies import PostgresSkillPolicies
from notalone.persistence.skill_learning_generation import capture_generation
from notalone.persistence.skill_learning import SkillLearningNotFound
from notalone.scopes import ContactScope
from tests.integration.persistence.skill_fixture import insert_file_skill


class PostgresSkillDirectoryTest(unittest.TestCase):
    """测试既不读取业务资料，也不把 Skill 写入用户默认根。"""

    @classmethod
    def setUpClass(cls):
        instance = os.environ.get("NOTALONE_TEST_DATABASE_URL", "host=/tmp dbname=notalone_test")
        cls.database_name = f"notalone_skill_directory_{uuid4().hex}_test"
        cls.database_url = make_conninfo(instance, dbname=cls.database_name)
        cls.admin = psycopg.connect(instance, dbname="postgres", autocommit=True)
        cls.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(cls.database_name)))
        cls.addClassCleanup(cls._drop_database)
        result = subprocess.run(
            [sys.executable, "-m", "notalone.database_migrations", "--migrations", "database/migrations"],
            cwd=Path(__file__).resolve().parents[3],
            env={**os.environ, "NOTALONE_DATABASE_URL": cls.database_url},
            capture_output=True, text=True, timeout=90,
        )
        if result.returncode:
            raise RuntimeError("合成 Skill 测试库迁移失败：" + result.stderr[-1000:])

    @classmethod
    def _drop_database(cls):
        try:
            cls.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(cls.database_name)))
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
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES (%s,'合成目录用户')", (self.owner_id,))
            connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,'合成目录联系人')",
                               (self.owner_id, self.contact_id))
        self.port = PostgresSkillPort(self.database_url)
        self.library = PostgresSkillLibrary(self.database_url)

    def _refresh(self, scope=None):
        """显式同步入口；SkillPort 读路径不再迁移或扫描目录。"""
        return synchronize_skill_library(self.database_url, (scope or self.scope).owner_id)

    def test_database_keeps_only_business_state_and_catalog_is_lazy(self):
        self._package()
        self._refresh()
        with psycopg.connect(self.database_url) as connection:
            self.assertIsNone(connection.execute(
                "SELECT to_regclass('public.reply_skill_resource')").fetchone()[0])
            for table, removed in (
                ("reply_skill", {"description", "directory_managed"}),
                ("reply_skill_version", {"name", "description", "content", "validation_warnings"}),
                ("reply_skill_method", {"title", "instruction"}),
            ):
                columns = {row[0] for row in connection.execute(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema='public' AND table_name=%s", (table,))}
                self.assertFalse(columns & removed)
        with patch("notalone.persistence.skill_files._read_document",
                   side_effect=AssertionError("目录阶段不能读取正文")), patch(
                "notalone.persistence.skill_files.read_resource_content",
                side_effect=AssertionError("目录阶段不能读取资源正文")):
            catalog = self.port.catalog(self.scope)
        self.assertEqual(len(catalog.entries), 1)
        entry = catalog.entries[0]
        self.assertEqual(entry.description, "适合温暖回应时使用。")
        version = self.port.load_version(self.scope, entry.version_id)
        self.assertIn("先回应感受", version.content)
        resource = self.port.load_resource(self.scope, entry.version_id, "references/example.md")
        self.assertIn("表达理解", resource.content.decode("utf-8"))

    def _package(self, *, name="warm-reply", body="先回应感受，再表达需要。", owner_id=None):
        directory = self.root / str(owner_id or self.owner_id) / name
        (directory / "references").mkdir(parents=True, exist_ok=True)
        (directory / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: 适合温暖回应时使用。\n---\n\n{body}\n", encoding="utf-8")
        (directory / "references" / "example.md").write_text("可以先表达理解，再邀请对方选择。\n", encoding="utf-8")
        return directory

    def test_corrupt_package_manifest_cannot_republish_unchanged_working_directory(self):
        self._package()
        self._refresh()
        catalog = self.port.catalog(self.scope)
        entry = catalog.entries[0]
        manifest = self.root / ".versions" / str(self.owner_id) / str(entry.skill_id) / str(entry.version_id) / "manifest.json"
        original = manifest.read_bytes()
        manifest.write_bytes(b'{"schema_version":0}')

        for body in ("先回应感受，再表达需要。", "先检查清单，再表达修改后的需要。"):
            with self.subTest(body=body):
                self._package(body=body)
                with self.assertRaises(SkillDirectorySyncError):
                    self._refresh()
                with psycopg.connect(self.database_url) as connection:
                    self.assertEqual(connection.execute("SELECT revision FROM public.skill_library WHERE owner_id=%s",
                        (self.owner_id,)).fetchone()[0], catalog.revision)
                    self.assertEqual(connection.execute("SELECT count(*) FROM public.reply_skill_version WHERE skill_id=%s",
                        (entry.skill_id,)).fetchone()[0], 1)
                with self.assertRaises(SkillPortPersistenceError):
                    self.port.catalog(self.scope)
                with self.assertRaises(PermissionError):
                    self.port.load_version(self.scope, entry.version_id)

        self._package()
        manifest.write_bytes(original)
        self.assertEqual(self._refresh(), catalog.revision)
        self.assertEqual(self.port.catalog(self.scope), catalog)
        self.assertIn("先回应感受", self.port.load_version(self.scope, entry.version_id).content)

    def _reviewed(self):
        skill_id, draft_id, first, second = (uuid4() for _ in range(4))
        methods = [{"method_id": str(identifier), "logical_skill_id": str(skill_id),
                    "title": title, "instruction": instruction, "replaces_method_ids": []}
                   for identifier, title, instruction in (
                       (first, "回应感受", "先表示理解对方。"), (second, "提供选择", "询问对方希望获得的支持。"))]
        document = "---\nname: reviewed-reply\ndescription: 适合共情支持时使用。\n---\n\n先表示理解对方。\n询问对方希望获得的支持。\n"
        with psycopg.connect(self.database_url) as connection:
            generation = capture_generation(connection, self.scope, [])
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            connection.execute("INSERT INTO public.conversation_binding(owner_id,contact_id,channel,account_scope,conversation_locator,last_verified_at) "
                               "VALUES (%s,%s,'wechat','synthetic-account','synthetic-conversation',now())",
                               (self.owner_id, self.contact_id))
            connection.execute("INSERT INTO public.skill_draft(id,owner_id,contact_id,logical_skill_id,proposal_kind,strategy,batch_key) "
                               "VALUES (%s,%s,%s,%s,'create',%s,'synthetic-method-manifest')",
                               (draft_id, self.owner_id, self.contact_id, skill_id, Jsonb({"methods": methods})))
            result = self.library.publish_reviewed(
                connection, scope=self.scope,
                draft={"draft_id": str(draft_id), "logical_skill_id": str(skill_id), "target_versions": [],
                       "proposal_kind": "create", "sanitized_strategy": {"name": "reviewed-reply", "document": document, "methods": methods}},
                confirmed_scope={"kind": "contact", "contact_id": str(self.contact_id), "scene": None},
                dependency_ids=[], source_generation={"sources": generation},
            )
        self._refresh()
        return skill_id, UUID(result["version_id"]), first, second

    def test_reviewed_methods_load_from_files_for_history_and_scoped_policy(self):
        skill_id, version_id, first, second = self._reviewed()

        history = PostgresSkillHistory(self.database_url).read(self.scope, skill_id)
        self.assertEqual([item["instruction"] for item in history["versions"][0]["methods"]],
                         ["先表示理解对方。", "询问对方希望获得的支持。"])
        PostgresSkillPolicies(self.database_url).change(
            self.scope, skill_id=skill_id, version_id=version_id, method_id=first,
            scope_confirmation={"kind": "contact", "contact_id": str(self.contact_id), "scene": None},
            disabled=True, expected_revision=0, operation_key=uuid4(),
        )
        catalog = self.port.catalog(self.scope)
        self.assertEqual(catalog.entries[0].version_id, version_id)
        loaded = self.port.load_version(self.scope, version_id)
        self.assertNotIn("先表示理解对方", loaded.content)
        self.assertIn("询问对方希望获得的支持", loaded.content)
        self.assertEqual(loaded.execution_view.method_ids, (second,))

    def test_method_identity_storage_has_no_teaching_content_columns(self):
        skill_id, version_id, _, _ = self._reviewed()
        with psycopg.connect(self.database_url) as connection:
            columns = {row[0] for row in connection.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema='public' AND table_name='reply_skill_method'").fetchall()}
        self.assertTrue({"method_id", "logical_skill_id", "replaces_method_ids", "mapping_state"} <= columns)
        self.assertTrue({"title", "instruction"}.isdisjoint(columns))
        history = PostgresSkillHistory(self.database_url).read(self.scope, skill_id)
        self.assertEqual(history["versions"][0]["methods"][1]["instruction"], "询问对方希望获得的支持。")
        self.assertIn("先表示理解对方", self.port.load_version(self.scope, version_id).content)

    def test_method_manifest_missing_or_corrupt_cannot_fall_back_to_database(self):
        skill_id, version_id, first, second = self._reviewed()
        PostgresSkillPolicies(self.database_url).change(
            self.scope, skill_id=skill_id, version_id=version_id, method_id=first,
            scope_confirmation={"kind": "contact", "contact_id": str(self.contact_id), "scene": None},
            disabled=True, expected_revision=0, operation_key=uuid4(),
        )
        manifest = self.root / ".versions" / str(self.owner_id) / str(skill_id) / str(version_id) / "methods.json"
        for corruption in (b"[]", None):
            if corruption is None:
                manifest.unlink()
            else:
                manifest.write_bytes(corruption)
            with self.subTest(corruption=corruption):
                with self.assertRaises(PermissionError):
                    self.port.load_version(self.scope, version_id)
                with self.assertRaises(SkillLearningNotFound):
                    PostgresSkillHistory(self.database_url).read(self.scope, skill_id)

    def test_catalog_with_method_policy_only_reads_manifest_metadata(self):
        skill_id, version_id, first, _ = self._reviewed()
        PostgresSkillPolicies(self.database_url).change(
            self.scope, skill_id=skill_id, version_id=version_id, method_id=first,
            scope_confirmation={"kind": "contact", "contact_id": str(self.contact_id), "scene": None},
            disabled=True, expected_revision=0, operation_key=uuid4(),
        )
        with patch("notalone.persistence.skill_methods.read_method_manifest", side_effect=AssertionError("目录阶段不能读取方法正文")):
            catalog = self.port.catalog(self.scope)
        self.assertEqual(catalog.entries[0].version_id, version_id)
        self.assertIn("询问对方希望获得的支持", self.port.load_version(self.scope, version_id).content)

    def test_filtered_load_reads_only_selected_method_file_and_rejects_its_corruption(self):
        skill_id, version_id, first, second = self._reviewed()
        PostgresSkillPolicies(self.database_url).change(
            self.scope, skill_id=skill_id, version_id=version_id, method_id=first,
            scope_confirmation={"kind": "contact", "contact_id": str(self.contact_id), "scene": None},
            disabled=True, expected_revision=0, operation_key=uuid4(),
        )
        methods = self.root / ".versions" / str(self.owner_id) / str(skill_id) / str(version_id) / "methods"
        # 被停用方法的正文即使损坏，本轮也不读取或解析它。
        (methods / f"{first}.json").write_bytes(b"invalid blocked method")
        self.assertIn("询问对方希望获得的支持", self.port.load_version(self.scope, version_id).content)
        (methods / f"{second}.json").write_bytes(b"invalid selected method")
        with self.assertRaises(PermissionError):
            self.port.load_version(self.scope, version_id)

    def test_catalog_discovers_directory_and_selected_version_reads_resource(self):
        self._package()
        self._refresh()

        catalog = self.port.catalog(self.scope)

        self.assertEqual([item.name for item in catalog.entries], ["warm-reply"])
        selected = self.port.load_version(self.scope, catalog.entries[0].version_id)
        self.assertEqual(selected.content, "先回应感受，再表达需要。\n")
        self.assertEqual(selected.resource_paths, ("references/example.md",))
        resource = self.port.load_resource(self.scope, selected.version_id, "references/example.md")
        self.assertEqual(resource.content.decode("utf-8"), "可以先表达理解，再邀请对方选择。\n")

    def test_management_refresh_registers_edit_once_and_old_version_cannot_load(self):
        self._package()
        self._refresh()
        before = self.port.catalog(self.scope)
        old_version = before.entries[0].version_id
        self._package(body="先承认对方的感受，再询问希望获得什么支持。")

        refreshed = self.library.list_owner_skills(self.owner_id)
        after = self.port.catalog(self.scope)

        self.assertEqual(refreshed[0].current_version_number, 2)
        self.assertEqual(after.revision, before.revision + 1)
        self.assertNotEqual(after.entries[0].version_id, old_version)
        self.assertEqual(self.port.catalog(self.scope).revision, after.revision)
        self.assertIn("希望获得什么支持", self.port.load_version(self.scope, after.entries[0].version_id).content)
        with self.assertRaises(PermissionError):
            self.port.load_version(self.scope, old_version)
        versions = self.library.list_versions(self.owner_id, refreshed[0].skill_id)
        self.assertEqual([version.version_number for version in versions], [2, 1])

    def test_invalid_or_missing_working_package_blocks_old_content_and_resources(self):
        directory = self._package()
        self._refresh()
        first = self.port.catalog(self.scope)
        version_id = first.entries[0].version_id
        original = (directory / "SKILL.md").read_text(encoding="utf-8")
        (directory / "SKILL.md").write_text("格式不完整。", encoding="utf-8")
        self._refresh()

        invalid = self.port.catalog(self.scope)

        self.assertEqual(invalid.entries, ())
        self.assertEqual(invalid.revision, first.revision + 1)
        self.assertEqual(self.port.catalog(self.scope).revision, invalid.revision)
        with self.assertRaises(PermissionError):
            self.port.load_version(self.scope, version_id)
        with self.assertRaises(PermissionError):
            self.port.load_resource(self.scope, version_id, "references/example.md")
        (directory / "SKILL.md").write_text(original, encoding="utf-8")
        self._refresh()
        self.assertEqual(self.port.catalog(self.scope).entries[0].version_id, version_id)
        (directory / "SKILL.md").unlink()
        self._refresh()
        self.assertEqual(self.port.catalog(self.scope).entries, ())

    def test_directory_edits_cannot_restore_disabled_or_deleted_skill(self):
        self._package()
        self._refresh()
        first = self.port.catalog(self.scope).entries[0]
        self.library.disable(self.owner_id, first.skill_id)
        self._package(body="先回应，再说明自己的需要。")
        self._refresh()

        self.assertEqual(self.port.catalog(self.scope).entries, ())
        disabled = self.library.list_owner_skills(self.owner_id)[0]
        self.assertEqual(disabled.status, "disabled")
        self.assertEqual(disabled.current_version_number, 2)
        self.library.delete(self.owner_id, first.skill_id)
        self._package(body="删除后新写入的同名包也不能恢复资格。")
        self._refresh()

        self.assertEqual(self.port.catalog(self.scope).entries, ())
        self.assertEqual(self.library.list_owner_skills(self.owner_id)[0].status, "deleted")
        with self.assertRaises(PermissionError):
            self.port.load_version(self.scope, first.version_id)

    def test_only_current_owner_directory_and_nonhidden_packages_are_discovered(self):
        self._package()
        self._package(name="other-reply", owner_id=uuid4())
        hidden = self.root / str(self.owner_id) / ".history" / "hidden-reply"
        hidden.mkdir(parents=True)
        (hidden / "SKILL.md").write_text("---\nname: hidden-reply\ndescription: 适合隐藏历史测试。\n---\n\n保持历史。", encoding="utf-8")
        linked = self.root / str(self.owner_id) / "linked-reply"
        linked.symlink_to(self.root / str(self.owner_id) / "warm-reply", target_is_directory=True)
        self._refresh()

        self.assertEqual([entry.name for entry in self.port.catalog(self.scope).entries], ["warm-reply"])

    def test_resource_edit_publishes_new_version_and_old_resource_is_unavailable(self):
        directory = self._package()
        self._refresh()
        before = self.port.catalog(self.scope)
        (directory / "references" / "example.md").write_text("先倾听对方，再确认需要。\n", encoding="utf-8")
        self._refresh()

        after = self.port.catalog(self.scope)

        self.assertNotEqual(after.entries[0].version_id, before.entries[0].version_id)
        self.assertEqual(after.entries[0].version_number, 2)
        resource = self.port.load_resource(self.scope, after.entries[0].version_id, "references/example.md")
        self.assertEqual(resource.content.decode("utf-8"), "先倾听对方，再确认需要。\n")
        with self.assertRaises(PermissionError):
            self.port.load_resource(self.scope, before.entries[0].version_id, "references/example.md")

    def test_unchanged_mixed_chinese_and_english_resource_paths_do_not_create_versions(self):
        directory = self._package()
        for name in ("Zebra.md", "alpha.md", "中文案例.md", "案例2.md", "case-10.md", "case-2.md"):
            (directory / "references" / name).write_text("先回应感受，再提供选择。\n", encoding="utf-8")
        self._refresh()
        first = self.port.catalog(self.scope)

        for _ in range(3):
            refreshed = self.port.catalog(self.scope)
            self.assertEqual(refreshed.entries[0].version_id, first.entries[0].version_id)
            self.assertEqual(refreshed.revision, first.revision)
        self.assertEqual(len(self.library.list_versions(self.owner_id, first.entries[0].skill_id)), 1)

    def test_failed_working_copy_update_cannot_republish_old_directory(self):
        directory = self._package()
        self._refresh()
        initial = self.port.catalog(self.scope).entries[0]
        with TemporaryDirectory() as source_root:
            source = Path(source_root) / "warm-reply"
            source.mkdir()
            (source / "SKILL.md").write_text(
                "---\nname: warm-reply\ndescription: 适合温暖回应时使用。\n---\n\n先确认对方需要，再提供选择。\n", encoding="utf-8")
            original_replace = os.replace

            def fail_working_replacement(source_path, target_path):
                if Path(source_path) == directory and Path(target_path).name == "previous":
                    raise PermissionError("合成工作副本更新失败")
                return original_replace(source_path, target_path)

            with patch("notalone.persistence.skill_files.os.replace", side_effect=fail_working_replacement):
                try:
                    self.library.update_package(self.owner_id, source)
                except SkillLibraryPersistenceError:
                    pass
                versions = self.library.list_versions(self.owner_id, initial.skill_id)
                self.assertEqual([item.version_number for item in versions], [2, 1])
                for _ in range(3):
                    self.assertEqual(self.port.catalog(self.scope).entries, ())
                with self.assertRaises(PermissionError):
                    self.port.load_version(self.scope, versions[0].version_id)
                self.assertEqual(len(self.library.list_versions(self.owner_id, initial.skill_id)), 2)

        self._refresh()
        restored = self.port.catalog(self.scope)
        self.assertEqual(restored.entries[0].version_number, 2)
        self.assertIn("先确认对方需要", self.port.load_version(self.scope, restored.entries[0].version_id).content)

    def test_failed_contact_file_cleanup_cannot_rediscover_residual_directory_as_owner_skill(self):
        import shutil

        directory = self._package()
        self._refresh()
        initial = self.port.catalog(self.scope).entries[0]
        other_contact = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,'保留的合成联系人')",
                               (self.owner_id, other_contact))
            connection.execute("UPDATE public.reply_skill SET contact_id=%s WHERE id=%s", (self.contact_id, initial.skill_id))
        other_scope = ContactScope(self.owner_id, other_contact)
        original_rmtree = shutil.rmtree

        def fail_working_cleanup(path, *args, **kwargs):
            if Path(path) == directory:
                raise PermissionError("合成工作副本删除失败")
            return original_rmtree(path, *args, **kwargs)

        with patch("notalone.persistence.skill_files.shutil.rmtree", side_effect=fail_working_cleanup):
            with self.assertRaises(SkillFileError):
                delete_contact(self.database_url, self.scope)
            self.assertTrue(directory.exists())
            for _ in range(3):
                self.assertEqual(self.port.catalog(other_scope).entries, ())
            self.assertEqual(self.library.list_owner_skills(self.owner_id), ())
            with self.assertRaises(PermissionError):
                self.port.load_version(other_scope, initial.version_id)

        self._refresh(other_scope)
        self.assertEqual(self.port.catalog(other_scope).entries, ())
        self.assertFalse(directory.exists())

    def test_stale_load_cannot_rollback_new_directory_version_registration(self):
        self._package()
        self._refresh()
        original = self.port.catalog(self.scope).entries[0]
        self._package(body="先确认感受，再询问支持方式。")
        self._refresh()

        with self.assertRaises(PermissionError):
            self.port.load_version(self.scope, original.version_id)

        versions = self.library.list_versions(self.owner_id, original.skill_id)
        self.assertEqual([item.version_number for item in versions], [2, 1])
        self.assertTrue(versions[0].is_current)

    def test_first_catalog_refresh_restores_working_copy_from_published_files(self):
        skill_id, version_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            insert_file_skill(connection, owner_id=self.owner_id, skill_id=skill_id,
                              version_id=version_id, name="legacy-reply", content="先表达理解。",
                              description="适合旧版回应场景。", write_working=False)

        self._refresh()
        catalog = self.port.catalog(self.scope)

        self.assertEqual(catalog.entries[0].version_id, version_id)
        document = self.root / str(self.owner_id) / "legacy-reply" / "SKILL.md"
        self.assertTrue(document.is_file())
        self.assertEqual(self.port.load_version(self.scope, version_id).content, "先表达理解。")
        document.write_text(document.read_text(encoding="utf-8") + "\n再询问需要。", encoding="utf-8")
        self.assertEqual(self.library.list_owner_skills(self.owner_id)[0].current_version_number, 2)

    def test_first_management_refresh_restores_working_copy_before_directory_edit(self):
        skill_id, version_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            insert_file_skill(connection, owner_id=self.owner_id, skill_id=skill_id,
                              version_id=version_id, name="legacy-reply", content="先表达理解。",
                              description="适合旧版回应场景。", write_working=False)

        self.assertEqual(self.library.list_owner_skills(self.owner_id)[0].current_version_id, version_id)
        document = self.root / str(self.owner_id) / "legacy-reply" / "SKILL.md"
        self.assertTrue(document.is_file())
        document.write_text(document.read_text(encoding="utf-8") + "\n再询问需要。", encoding="utf-8")
        self.assertEqual(self.library.list_owner_skills(self.owner_id)[0].current_version_number, 2)

    def test_history_page_refresh_directly_discovers_new_and_edited_directories(self):
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.conversation_binding(owner_id,contact_id,channel,account_scope,conversation_locator,last_verified_at) "
                               "VALUES (%s,%s,'wechat','synthetic-account','synthetic-conversation',now())", (self.owner_id, self.contact_id))
        self._package()

        history = PostgresSkillHistory(self.database_url).read(self.scope)

        self.assertEqual(history["skills"][0]["versions"][0]["version_number"], 1)
        self._package(body="先确认感受，再提供选择。")
        refreshed = PostgresSkillHistory(self.database_url).read(self.scope)
        self.assertEqual(refreshed["skills"][0]["versions"][0]["version_number"], 2)
        self.assertIn("先确认感受", refreshed["skills"][0]["versions"][0]["document"])

    def test_directory_edit_preserves_contact_scope_and_cannot_republish_review_origin(self):
        self._package()
        self._refresh()
        original = self.port.catalog(self.scope).entries[0]
        other_contact = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,'另一位合成联系人')",
                               (self.owner_id, other_contact))
            connection.execute("UPDATE public.reply_skill SET contact_id=%s WHERE id=%s", (self.contact_id, original.skill_id))
        self._package(body="先确认对方需要，再表达自己的想法。")
        self._refresh()
        updated = self.port.catalog(self.scope).entries[0]
        self.assertEqual(updated.contact_id, self.contact_id)
        self.assertEqual(self.port.catalog(ContactScope(self.owner_id, other_contact)).entries, ())
        with psycopg.connect(self.database_url) as connection:
            # 缺失审核来源证明等同于来源失效；文件编辑不得重新发布为普通包。
            connection.execute("UPDATE public.reply_skill_version SET review_origin=true WHERE id=%s", (updated.version_id,))
        self._package(body="新编辑仍必须等待合法审核来源。")
        self._refresh()

        self.assertEqual(self.port.catalog(self.scope).entries, ())
        self.assertEqual(self.port.catalog(ContactScope(self.owner_id, other_contact)).entries, ())
        self.assertEqual(len(self.library.list_versions(self.owner_id, original.skill_id)), 2)
        with self.assertRaises(PermissionError):
            self.port.load_version(self.scope, updated.version_id)


if __name__ == "__main__":
    unittest.main()
