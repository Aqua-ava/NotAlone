"""本地后端服务的进程内 HTTP seam 集成测试。"""

from __future__ import annotations

import os
import unittest
from uuid import uuid4

import psycopg

from notalone.server.app import create_app
from notalone.server.app import BackendServer
from notalone.server.testing import InProcessClient


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class BackendServiceAppTest(unittest.TestCase):
    """通过进程内客户端验证 API 的外部行为。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest("本地 PostgreSQL 测试库不可用。") from error
        if not database_name.endswith("_test"):
            raise RuntimeError("集成测试只允许连接名称以 _test 结尾的数据库。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.other_owner_id = uuid4()
        self.contact_id = uuid4()
        self.other_contact_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s), (%s, %s)",
                (self.owner_id, "合成用户甲", self.other_owner_id, "合成用户乙"),
            )
            connection.execute(
                """
                INSERT INTO public.contact (owner_id, id, display_name)
                VALUES (%s, %s, %s), (%s, %s, %s)
                """,
                (
                    self.owner_id,
                    self.contact_id,
                    "合成联系人甲",
                    self.other_owner_id,
                    self.other_contact_id,
                    "合成联系人乙",
                ),
            )
        self.app = create_app(
            database_url=TEST_DATABASE_URL,
            owner_id=self.owner_id,
            token="test-token",
        )
        self.client = InProcessClient(self.app)

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id IN (%s, %s)",
                (self.owner_id, self.other_owner_id),
            )

    def test_contacts_requires_token(self) -> None:
        response = self.client.get("/api/contacts")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"error": "unauthorized"})

    def test_unsupported_method_still_requires_token(self) -> None:
        response = self.client.request("POST", "/api/contacts")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"error": "unauthorized"})

        response = self.client.request(
            "POST",
            "/api/contacts",
            headers={"Authorization": "Bearer test-token"},
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json(), {"error": "not_found"})

    def test_contacts_rejects_wrong_token_without_echoing_it(self) -> None:
        response = self.client.get(
            "/api/contacts",
            headers={"Authorization": "Bearer wrong-secret"},
        )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"error": "unauthorized"})
        self.assertNotIn("wrong-secret", response.body.decode("utf-8"))

    def test_contacts_returns_only_current_owner_with_data_status(self) -> None:
        response = self.client.get(
            "/api/contacts",
            headers={"Authorization": "Bearer test-token"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "contacts": [
                    {
                        "contact_id": str(self.contact_id),
                        "display_name": "合成联系人甲",
                        "data_status": {
                            "message_count": 0,
                            "source_count": 0,
                        },
                    }
                ]
            },
        )

    def test_contacts_data_status_counts_only_active_sources(self) -> None:
        source_id = uuid4()
        message_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                """
                INSERT INTO public.source_document (
                    id, owner_id, contact_id, source_type, file_name,
                    content_sha256, record_count
                )
                VALUES (%s, %s, %s, 'wechat_jsonl', %s, %s, 1)
                """,
                (
                    source_id,
                    self.owner_id,
                    self.contact_id,
                    "synthetic.jsonl",
                    "a" * 64,
                ),
            )
            connection.execute(
                """
                INSERT INTO public.message (
                    id, owner_id, contact_id, speaker, message_type,
                    text_content, occurred_at
                )
                VALUES (%s, %s, %s, 'contact', 'text', %s, now())
                """,
                (
                    message_id,
                    self.owner_id,
                    self.contact_id,
                    "合成消息正文",
                ),
            )
            connection.execute(
                """
                INSERT INTO public.message_source_ref (
                    message_id, owner_id, contact_id, source_kind,
                    source_document_id, source_locator, raw_payload
                )
                VALUES (%s, %s, %s, 'source_document', %s, %s, '{}'::jsonb)
                """,
                (
                    message_id,
                    self.owner_id,
                    self.contact_id,
                    source_id,
                    "synthetic:1",
                ),
            )

        response = self.client.get(
            "/api/contacts",
            headers={"Authorization": "Bearer test-token"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["contacts"][0]["data_status"],
            {"message_count": 1, "source_count": 1},
        )

    def test_token_is_generated_and_non_loopback_binding_is_rejected(self) -> None:
        first = create_app(database_url=TEST_DATABASE_URL, owner_id=self.owner_id)
        second = create_app(database_url=TEST_DATABASE_URL, owner_id=self.owner_id)

        self.assertTrue(first.token)
        self.assertNotEqual(first.token, second.token)
        with self.assertRaises(ValueError):
            BackendServer(first, host="0.0.0.0")


if __name__ == "__main__":
    unittest.main()
