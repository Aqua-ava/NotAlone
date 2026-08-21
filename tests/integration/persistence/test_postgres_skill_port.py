"""PostgreSQL SkillPort 的公共合同与联系人范围集成测试。"""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone
from uuid import UUID, uuid4

import psycopg

from notalone.persistence.skill_port import (
    PostgresSkillPort,
    SkillPortPersistenceError,
)
from notalone.scopes import ContactScope
from notalone.skills import SkillCatalog, SkillVersion


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresSkillPortTest(unittest.TestCase):
    """只使用合成 Skill、owner 和联系人。"""

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
            raise unittest.SkipTest("测试库尚未应用 008 SkillPort 迁移。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        self.other_contact_id = uuid4()
        self.other_owner_id = uuid4()
        self.other_owner_contact_id = uuid4()
        self.empty_owner_id = uuid4()
        self.empty_contact_id = uuid4()
        self.global_skill_id = uuid4()
        self.global_version_id = uuid4()
        self.global_old_version_id = uuid4()
        self.contact_skill_id = uuid4()
        self.contact_version_id = uuid4()
        self.other_contact_skill_id = uuid4()
        self.other_contact_version_id = uuid4()
        self.disabled_skill_id = uuid4()
        self.disabled_version_id = uuid4()
        self.deleted_skill_id = uuid4()
        self.deleted_version_id = uuid4()
        self.other_owner_skill_id = uuid4()
        self.other_owner_version_id = uuid4()

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            with connection.cursor() as cursor:
                cursor.executemany(
                    "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                    (
                        (self.owner_id, "合成 Skill 用户"),
                        (self.other_owner_id, "另一个合成用户"),
                        (self.empty_owner_id, "空目录合成用户"),
                    ),
                )
                cursor.executemany(
                    "INSERT INTO public.contact (owner_id, id, display_name) "
                    "VALUES (%s, %s, %s)",
                    (
                        (self.owner_id, self.contact_id, "合成联系人甲"),
                        (self.owner_id, self.other_contact_id, "合成联系人乙"),
                        (
                            self.other_owner_id,
                            self.other_owner_contact_id,
                            "另一个合成联系人",
                        ),
                        (self.empty_owner_id, self.empty_contact_id, "空目录联系人"),
                    ),
                )
            connection.execute(
                "INSERT INTO public.skill_library (owner_id, revision) VALUES (%s, %s)",
                (self.owner_id, 7),
            )
            self._insert_skill(
                connection,
                skill_id=self.global_skill_id,
                contact_id=None,
                owner_id=self.owner_id,
                name="gentle-reply",
                version_id=self.global_version_id,
                content="全局策略正文。",
            )
            self._insert_version(
                connection,
                skill_id=self.global_skill_id,
                version_id=self.global_old_version_id,
                name="gentle-reply",
                content="旧版本正文。",
                is_current=False,
                version_number=1,
            )
            self._insert_skill(
                connection,
                skill_id=self.contact_skill_id,
                contact_id=self.contact_id,
                owner_id=self.owner_id,
                name="direct-reply",
                version_id=self.contact_version_id,
                content="联系人专属策略正文。",
            )
            self._insert_skill(
                connection,
                skill_id=self.other_contact_skill_id,
                contact_id=self.other_contact_id,
                owner_id=self.owner_id,
                name="other-contact-reply",
                version_id=self.other_contact_version_id,
                content="另一联系人的策略正文。",
            )
            self._insert_skill(
                connection,
                skill_id=self.disabled_skill_id,
                contact_id=None,
                owner_id=self.owner_id,
                name="disabled-reply",
                version_id=self.disabled_version_id,
                content="禁用策略正文。",
                skill_status="disabled",
            )
            self._insert_skill(
                connection,
                skill_id=self.deleted_skill_id,
                contact_id=None,
                owner_id=self.owner_id,
                name="deleted-reply",
                version_id=self.deleted_version_id,
                content=None,
                skill_status="deleted",
                version_status="deleted",
                enabled=False,
            )
            self._insert_skill(
                connection,
                skill_id=self.other_owner_skill_id,
                owner_id=self.other_owner_id,
                contact_id=None,
                name="other-owner-reply",
                version_id=self.other_owner_version_id,
                content="另一用户的策略正文。",
            )
        self.port = PostgresSkillPort(TEST_DATABASE_URL)

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id IN (%s, %s, %s)",
                (self.owner_id, self.other_owner_id, self.empty_owner_id),
            )

    def _scope(self, contact_id: UUID | None = None) -> ContactScope:
        return ContactScope(self.owner_id, contact_id or self.contact_id)

    @staticmethod
    def _insert_skill(
        connection: psycopg.Connection,
        *,
        skill_id: UUID,
        version_id: UUID,
        name: str,
        content: str | None,
        contact_id: UUID | None,
        owner_id: UUID | None = None,
        skill_status: str = "active",
        version_status: str = "active",
        enabled: bool = True,
        version_number: int = 2,
    ) -> None:
        if owner_id is None:
            raise ValueError("Skill 测试夹具必须明确 owner_id。")
        connection.execute(
            """
            INSERT INTO public.reply_skill (
                id, owner_id, contact_id, name, description, status, deleted_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                skill_id,
                owner_id,
                contact_id,
                name,
                f"{name} 合成描述",
                skill_status,
                datetime.now(timezone.utc) if skill_status == "deleted" else None,
            ),
        )
        PostgresSkillPortTest._insert_version(
            connection,
            skill_id=skill_id,
            version_id=version_id,
            name=name,
            content=content,
            status=version_status,
            enabled=enabled,
            version_number=version_number,
        )

    @staticmethod
    def _insert_version(
        connection: psycopg.Connection,
        *,
        skill_id: UUID,
        version_id: UUID,
        name: str,
        content: str | None,
        status: str = "active",
        enabled: bool = True,
        is_current: bool = True,
        version_number: int = 1,
    ) -> None:
        connection.execute(
            """
            INSERT INTO public.reply_skill_version (
                id, skill_id, version_number, name, description, content,
                enabled, is_current, status, deleted_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                version_id,
                skill_id,
                version_number,
                name,
                f"{name} 合成描述",
                content,
                enabled,
                is_current,
                status,
                datetime.now(timezone.utc) if status == "deleted" else None,
            ),
        )

    def test_catalog_returns_global_and_contact_skill_but_not_other_scope(self) -> None:
        catalog = self.port.catalog(self._scope())

        self.assertIsInstance(catalog, SkillCatalog)
        self.assertEqual(catalog.revision, 7)
        self.assertEqual(
            tuple(entry.name for entry in catalog.entries),
            ("gentle-reply", "direct-reply"),
        )
        self.assertNotIn("other-contact-reply", [entry.name for entry in catalog.entries])
        self.assertNotIn("disabled-reply", [entry.name for entry in catalog.entries])
        self.assertNotIn("deleted-reply", [entry.name for entry in catalog.entries])

    def test_empty_owner_without_library_row_returns_empty_revision_zero_catalog(self) -> None:
        catalog = self.port.catalog(
            ContactScope(self.empty_owner_id, self.empty_contact_id)
        )

        self.assertEqual(catalog, SkillCatalog(catalog.scope, 0, ()))

    def test_load_version_returns_current_immutable_body(self) -> None:
        loaded = self.port.load_version(
            self._scope(),
            self.global_version_id,
        )

        self.assertIsInstance(loaded, SkillVersion)
        self.assertEqual(loaded.version_id, self.global_version_id)
        self.assertEqual(loaded.content, "全局策略正文。")
        self.assertTrue(loaded.enabled)

    def test_unknown_disabled_deleted_old_or_foreign_version_fails_identically(self) -> None:
        version_ids = (
            uuid4(),
            self.disabled_version_id,
            self.deleted_version_id,
            self.global_old_version_id,
            self.other_owner_version_id,
            self.other_contact_version_id,
        )
        errors: list[str] = []
        for version_id in version_ids:
            with self.assertRaises(PermissionError) as caught:
                self.port.load_version(self._scope(), version_id)
            errors.append(str(caught.exception))

        self.assertEqual(errors, ["Skill 不可用。"] * len(version_ids))

    def test_revision_change_is_visible_and_skill_names_are_unique_per_owner(self) -> None:
        before = self.port.catalog(self._scope())
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.skill_library SET revision = revision + 1 "
                "WHERE owner_id = %s",
                (self.owner_id,),
            )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            with self.assertRaises(psycopg.errors.UniqueViolation):
                connection.execute(
                    """
                    INSERT INTO public.reply_skill (
                        id, owner_id, contact_id, name, description, status
                    )
                    VALUES (%s, %s, %s, %s, %s, 'active')
                    """,
                    (
                        uuid4(),
                        self.owner_id,
                        self.other_contact_id,
                        "gentle-reply",
                        "重复名称合成描述",
                    ),
                )
        after = self.port.catalog(self._scope())

        self.assertEqual(before.revision, 7)
        self.assertEqual(after.revision, 8)
        self.assertNotEqual(before.revision, after.revision)

    def test_port_exposes_only_read_operations_and_hides_database_failure(self) -> None:
        self.assertFalse(hasattr(self.port, "create"))
        self.assertFalse(hasattr(self.port, "install"))
        self.assertFalse(hasattr(self.port, "update"))
        self.assertFalse(hasattr(self.port, "delete"))
        self.assertFalse(hasattr(self.port, "send"))

        broken = PostgresSkillPort(
            "postgresql:///notalone_skill_port_error_test"
        )
        with self.assertRaises(SkillPortPersistenceError) as caught:
            broken.catalog(self._scope())

        self.assertEqual(str(caught.exception), "Skill 目录读取失败。")
        self.assertNotIn("postgresql", str(caught.exception))

if __name__ == "__main__":
    unittest.main()
