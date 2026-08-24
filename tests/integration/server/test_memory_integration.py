"""记忆管理 API 与真实持久化的整链集成测试。

真实 PostgreSQL + PostgresMemoryStore/PostgresOwnerMemoryStore +
MemoryService + InProcessClient：手动录入、列表、pending 确认与
丢弃、删除指纹与 owner 隔离全链路。
"""

from __future__ import annotations

import os
import unittest
from uuid import uuid4

import psycopg

from notalone.application.memory_service import MemoryService
from notalone.memory.models import MemoryCandidate, MemoryCategory
from notalone.persistence import (
    PostgresMemoryStore,
    PostgresOwnerMemoryStore,
)
from notalone.scopes import ContactScope
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class MemoryApiIntegrationTest(unittest.TestCase):
    """只使用合成 owner/contact，验证记忆管理 API 全链路。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
                has_table = connection.execute(
                    "SELECT to_regclass('public.memory_candidate')"
                ).fetchone()[0]
                manual_ok = connection.execute(
                    """
                    SELECT count(*)
                    FROM pg_constraint
                    WHERE conrelid = 'public.source_document'::regclass
                      AND conname = 'source_document_source_type_check'
                      AND pg_get_constraintdef(oid) LIKE '%manual%'
                    """
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest("本地 PostgreSQL 测试库不可用。") from error
        if not database_name.endswith("_test"):
            raise RuntimeError("集成测试只允许连接名称以 _test 结尾的数据库。")
        if has_table is None:
            raise unittest.SkipTest("测试库尚未应用 009 Memory 迁移。")
        if manual_ok == 0:
            raise unittest.SkipTest("测试库尚未应用 025 手动来源迁移。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        self.other_owner_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "记忆整链用户"),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, %s)",
                (self.owner_id, self.contact_id, "记忆整链联系人"),
            )
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.other_owner_id, "另一记忆用户"),
            )
        service = MemoryService(
            contact_memory=PostgresMemoryStore(TEST_DATABASE_URL),
            owner_memory=PostgresOwnerMemoryStore(TEST_DATABASE_URL),
        )
        self.app = create_app(
            database_url=TEST_DATABASE_URL,
            owner_id=self.owner_id,
            token="test-token",
            memory_service=service,
        )
        self.client = InProcessClient(self.app)
        self.headers = {"Authorization": "Bearer test-token"}
        self._headers_other = {"Authorization": "Bearer test-token"}

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id IN (%s, %s)",
                (self.owner_id, self.other_owner_id),
            )

    def _post(self, path: str, body: dict | None = None):
        return self.client.request(
            "POST",
            path,
            headers={"Authorization": "Bearer test-token"},
            body=(
                __import__("json").dumps(body).encode("utf-8")
                if body is not None
                else b""
            ),
        )

    def test_manual_entry_then_list_and_delete(self) -> None:
        response = self._post(
            "/api/memories/manual-contact",
            {
                "contact_id": str(self.contact_id),
                "text": "记忆整链：对方偏爱早起。",
                "category": "preference",
            },
        )
        self.assertEqual(response.status_code, 200)
        memory = response.json()["memory"]
        self.assertEqual(memory["adoption_method"], "manual")
        self.assertEqual(memory["level"], "contact")

        listed = self.client.get(
            f"/api/contacts/{self.contact_id}/memories",
            headers=self.headers,
        )
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(
            [item["text"] for item in listed.json()["memories"]],
            ["记忆整链：对方偏爱早起。"],
        )

        deleted = self._post(
            f"/api/contacts/{self.contact_id}/memories/"
            f"{memory['memory_id']}/delete"
        )
        self.assertEqual(deleted.status_code, 200)

        after = self.client.get(
            f"/api/contacts/{self.contact_id}/memories",
            headers=self.headers,
        )
        self.assertEqual(after.json()["memories"], [])

    def test_pending_confirm_and_discard(self) -> None:
        # 先插入一个 pending 候选（直接经 store 创建，来源用 contact 关联的
        # manual 来源行；这里走 create_manual_candidate 复用整链语义）。
        store = PostgresMemoryStore(TEST_DATABASE_URL)
        candidate = store.create_manual_candidate(
            MemoryCandidate(
                candidate_id=uuid4(),
                scope=ContactScope(self.owner_id, self.contact_id),
                text="整链待确认候选",
                category=MemoryCategory.RECENT_STATE,
                source_ids=(self.contact_id,),
            )
        )

        pending = self.client.get(
            f"/api/contacts/{self.contact_id}/memory-candidates",
            headers=self.headers,
        )
        self.assertEqual(pending.status_code, 200)
        self.assertEqual(
            [item["text"] for item in pending.json()["candidates"]],
            ["整链待确认候选"],
        )

        confirmed = self._post(
            f"/api/contacts/{self.contact_id}/memory-candidates/"
            f"{candidate.candidate_id}/confirm"
        )
        self.assertEqual(confirmed.status_code, 200)
        self.assertEqual(
            confirmed.json()["memory"]["adoption_method"], "manual"
        )

        after = self.client.get(
            f"/api/contacts/{self.contact_id}/memory-candidates",
            headers=self.headers,
        )
        self.assertEqual(after.json()["candidates"], [])

        # 丢弃路径：新候选 → discard → 不再出现在 pending。
        second = store.create_manual_candidate(
            MemoryCandidate(
                candidate_id=uuid4(),
                scope=ContactScope(self.owner_id, self.contact_id),
                text="整链待丢弃候选",
                category=MemoryCategory.RECENT_STATE,
                source_ids=(self.contact_id,),
            )
        )
        discarded = self._post(
            f"/api/contacts/{self.contact_id}/memory-candidates/"
            f"{second.candidate_id}/discard"
        )
        self.assertEqual(discarded.status_code, 200)

        pending2 = self.client.get(
            f"/api/contacts/{self.contact_id}/memory-candidates",
            headers=self.headers,
        )
        self.assertEqual(pending2.json()["candidates"], [])

    def test_owner_level_isolation_and_manual(self) -> None:
        own = self._post(
            "/api/memories/manual-owner",
            {"text": "整链用户偏好早起。", "category": "preference"},
        )
        self.assertEqual(own.status_code, 200)
        self.assertEqual(own.json()["memory"]["level"], "owner")

        listed = self.client.get("/api/memories/owner", headers=self.headers)
        self.assertEqual(
            [item["text"] for item in listed.json()["memories"]],
            ["整链用户偏好早起。"],
        )

        # 另一个 owner 看不到这条记忆（owner 隔离由 owner 级端口保证）。
        app_other = create_app(
            database_url=TEST_DATABASE_URL,
            owner_id=self.other_owner_id,
            token="test-token-other",
            memory_service=MemoryService(
                contact_memory=PostgresMemoryStore(TEST_DATABASE_URL),
                owner_memory=PostgresOwnerMemoryStore(TEST_DATABASE_URL),
            ),
        )
        client_other = InProcessClient(app_other)
        other_listed = client_other.get(
            "/api/memories/owner",
            headers={"Authorization": "Bearer test-token-other"},
        )
        self.assertEqual(other_listed.json()["memories"], [])


if __name__ == "__main__":
    unittest.main()