"""CLI 绑定匹配证据字段的 PostgreSQL 持久化测试。"""

from __future__ import annotations

import os
import unittest
from uuid import uuid4

import psycopg

from notalone.persistence.conversation_repository import (
    ConversationBindingConflictError,
    ConversationBindingNotFoundError,
    PostgresConversationBindingRepository,
)


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresBindingCliMetadataTest(unittest.TestCase):
    """只验证合成绑定证据字段，不连接桌面会话或读取聊天内容。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
                has_column = connection.execute(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'conversation_binding'
                      AND column_name = 'display_name'
                    """
                ).fetchone()
        except psycopg.OperationalError as error:
            raise unittest.SkipTest(
                "本地 PostgreSQL 测试库不可用。"
            ) from error

        if not database_name.endswith("_test"):
            raise RuntimeError(
                "集成测试只允许连接名称以 _test 结尾的数据库。"
            )
        if has_column is None:
            raise unittest.SkipTest("测试库尚未应用 019 绑定证据迁移。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        self.other_contact_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "合成绑定用户"),
            )
            with connection.cursor() as cursor:
                cursor.executemany(
                    "INSERT INTO public.contact (owner_id, id, display_name) "
                    "VALUES (%s, %s, %s)",
                    (
                        (self.owner_id, self.contact_id, "合成联系人甲"),
                        (self.owner_id, self.other_contact_id, "合成联系人乙"),
                    ),
                )
        self.repository = PostgresConversationBindingRepository(TEST_DATABASE_URL)

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    def test_binding_persists_matching_evidence_fields(self) -> None:
        created = self.repository.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="wxid_synthetic_001",
            display_name="合成展示名",
            metadata_summary={"time_text": "19:59", "preview_digest": "a" * 64},
            visual_fingerprint="sha256:synthetic-avatar",
        )

        stored = self.repository.read_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            binding_id=created.binding_id,
        )

        self.assertEqual(stored.display_name, "合成展示名")
        self.assertEqual(stored.metadata_summary["time_text"], "19:59")
        self.assertNotIn("预览原文", str(stored.metadata_summary))
        self.assertEqual(stored.visual_fingerprint, "sha256:synthetic-avatar")

    def test_same_locator_cannot_bind_two_active_contacts(self) -> None:
        self.repository.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="wxid_synthetic_002",
            display_name="合成展示名",
        )

        with self.assertRaises(ConversationBindingConflictError):
            self.repository.create_binding(
                owner_id=self.owner_id,
                contact_id=self.other_contact_id,
                channel="wechat",
                account_scope="synthetic-account",
                conversation_locator="wxid_synthetic_002",
                display_name="合成展示名",
            )

    def test_revoked_locator_allows_rebinding_and_locator_lookup(self) -> None:
        first = self.repository.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="wxid_synthetic_003",
        )
        self.repository.revoke_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            binding_id=first.binding_id,
        )

        # 撤销后的定位符不再被 active 查询返回。
        self.assertIsNone(
            self.repository.read_active_by_locator(
                owner_id=self.owner_id,
                channel="wechat",
                account_scope="synthetic-account",
                conversation_locator="wxid_synthetic_003",
            )
        )

        second = self.repository.create_binding(
            owner_id=self.owner_id,
            contact_id=self.other_contact_id,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="wxid_synthetic_003",
            display_name="合成展示名",
        )

        active = self.repository.read_active_by_locator(
            owner_id=self.owner_id,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="wxid_synthetic_003",
        )
        self.assertIsNotNone(active)
        self.assertEqual(active.binding_id, second.binding_id)
        self.assertEqual(active.scope.contact_id, self.other_contact_id)

    def test_list_active_bindings_is_owner_scoped(self) -> None:
        self.repository.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="wxid_synthetic_004",
        )
        revoked = self.repository.create_binding(
            owner_id=self.owner_id,
            contact_id=self.other_contact_id,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="wxid_synthetic_005",
        )
        self.repository.revoke_binding(
            owner_id=self.owner_id,
            contact_id=self.other_contact_id,
            binding_id=revoked.binding_id,
        )

        active_bindings = self.repository.list_active_bindings(
            owner_id=self.owner_id,
            channel="wechat",
            account_scope="synthetic-account",
        )

        self.assertEqual(len(active_bindings), 1)
        self.assertEqual(active_bindings[0].scope.contact_id, self.contact_id)

        other_owner_bindings = self.repository.list_active_bindings(
            owner_id=uuid4(),
        )
        self.assertEqual(other_owner_bindings, ())

    def test_update_matching_metadata_after_reconfirmation(self) -> None:
        created = self.repository.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="wxid_synthetic_006",
            display_name="旧展示名",
        )

        updated = self.repository.update_matching_metadata(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            binding_id=created.binding_id,
            display_name="新展示名",
            metadata_summary={"time_text": "20:30"},
        )

        self.assertEqual(updated.display_name, "新展示名")
        self.assertEqual(updated.metadata_summary["time_text"], "20:30")
        # 未传入的字段保持不变。
        self.assertIsNone(updated.visual_fingerprint)

    def test_update_matching_metadata_requires_full_scope(self) -> None:
        created = self.repository.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="wxid_synthetic_007",
        )

        with self.assertRaises(ConversationBindingNotFoundError):
            self.repository.update_matching_metadata(
                owner_id=self.owner_id,
                contact_id=self.other_contact_id,
                binding_id=created.binding_id,
                display_name="其他联系人尝试改绑",
            )

        with self.assertRaises(ValueError):
            self.repository.update_matching_metadata(
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                binding_id=created.binding_id,
            )


if __name__ == "__main__":
    unittest.main()
