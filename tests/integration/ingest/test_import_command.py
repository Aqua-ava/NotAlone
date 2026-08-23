"""正式导入命令的 PostgreSQL 集成测试。"""

from __future__ import annotations

import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import psycopg

from notalone.ingest.import_command import main


FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"
TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class ImportCommandIntegrationTest(unittest.TestCase):
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
        self.contact_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "合成用户"),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, %s)",
                (self.owner_id, self.contact_id, "已选合成联系人"),
            )
            connection.execute(
                "INSERT INTO public.owner_channel_identity "
                "(owner_id, channel, external_id, observed_name) "
                "VALUES (%s, 'wechat', %s, %s)",
                (self.owner_id, "wxid_synthetic_owner", "合成用户"),
            )

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            database_name = connection.execute(
                "SELECT current_database()"
            ).fetchone()[0]
            if not database_name.endswith("_test"):
                raise RuntimeError("拒绝清理非测试数据库。")
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    def test_command_imports_and_outputs_only_non_sensitive_counts(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        arguments = [
            str(FIXTURES_DIR / "valid_single_contact.jsonl"),
            "--contact-id",
            str(self.contact_id),
        ]

        with patch.dict(
            os.environ,
            {
                "NOTALONE_DATABASE_URL": TEST_DATABASE_URL,
                "NOTALONE_OWNER_ID": str(self.owner_id),
            },
        ):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exit_code = main(arguments)

        output = stdout.getvalue()
        self.assertEqual(exit_code, 0)
        self.assertEqual(stderr.getvalue(), "")
        self.assertIn("导入完成", output)
        self.assertIn("消息：6", output)
        self.assertNotIn("匿名合成消息一", output)
        self.assertNotIn("wxid_synthetic_contact", output)
        self.assertNotIn(str(self.owner_id), output)
        self.assertNotIn(TEST_DATABASE_URL, output)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            message_count = connection.execute(
                "SELECT count(*) FROM public.message WHERE owner_id = %s",
                (self.owner_id,),
            ).fetchone()[0]
        self.assertEqual(message_count, 6)

    def test_missing_selected_contact_does_not_write_import_data(self) -> None:
        stderr = io.StringIO()
        missing_contact_id = uuid4()
        arguments = [
            str(FIXTURES_DIR / "valid_single_contact.jsonl"),
            "--contact-id",
            str(missing_contact_id),
        ]

        with patch.dict(
            os.environ,
            {
                "NOTALONE_DATABASE_URL": TEST_DATABASE_URL,
                "NOTALONE_OWNER_ID": str(self.owner_id),
            },
        ):
            with contextlib.redirect_stderr(stderr):
                exit_code = main(arguments)

        self.assertEqual(exit_code, 1)
        self.assertIn("选择的联系人不存在", stderr.getvalue())
        self.assertNotIn(str(missing_contact_id), stderr.getvalue())
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            contact_count = connection.execute(
                "SELECT count(*) FROM public.contact WHERE owner_id = %s",
                (self.owner_id,),
            ).fetchone()[0]
            source_count = connection.execute(
                "SELECT count(*) FROM public.source_document WHERE owner_id = %s",
                (self.owner_id,),
            ).fetchone()[0]
            message_count = connection.execute(
                "SELECT count(*) FROM public.message WHERE owner_id = %s",
                (self.owner_id,),
            ).fetchone()[0]
        self.assertEqual((contact_count, source_count, message_count), (1, 0, 0))

    def test_command_creates_contact_for_first_import(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.contact WHERE owner_id = %s",
                (self.owner_id,),
            )
        stdout = io.StringIO()
        stderr = io.StringIO()
        arguments = [
            str(FIXTURES_DIR / "valid_single_contact.jsonl"),
            "--new-contact-name",
            "首次导入合成联系人",
        ]

        with patch.dict(
            os.environ,
            {
                "NOTALONE_DATABASE_URL": TEST_DATABASE_URL,
                "NOTALONE_OWNER_ID": str(self.owner_id),
            },
        ):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exit_code = main(arguments)

        output = stdout.getvalue()
        self.assertEqual(exit_code, 0)
        self.assertEqual(stderr.getvalue(), "")
        self.assertIn("导入完成", output)
        self.assertNotIn("首次导入合成联系人", output)
        self.assertNotIn("wxid_synthetic_contact", output)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            imported = connection.execute(
                """
                SELECT c.display_name, ic.method, count(m.id)
                FROM public.contact AS c
                JOIN public.import_confirmation AS ic
                  ON ic.owner_id = c.owner_id AND ic.contact_id = c.id
                JOIN public.message AS m
                  ON m.source_document_id = ic.source_document_id
                WHERE c.owner_id = %s
                GROUP BY c.display_name, ic.method
                """,
                (self.owner_id,),
            ).fetchone()
        self.assertEqual(imported, ("首次导入合成联系人", "manual_create", 6))

    def test_initialize_owner_creates_binding_and_persists_owner_id(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

        stdout = io.StringIO()
        stderr = io.StringIO()
        arguments = [
            str(FIXTURES_DIR / "valid_single_contact.jsonl"),
            "--initialize-owner",
            "--new-contact-name",
            "首次初始化合成联系人",
        ]
        with tempfile.TemporaryDirectory() as directory:
            env_path = Path(directory) / ".env"
            with patch.dict(
                os.environ,
                {
                    "NOTALONE_DATABASE_URL": TEST_DATABASE_URL,
                    "NOTALONE_ENV_FILE": str(env_path),
                    "NOTALONE_DISABLE_DOTENV": "1",
                },
                clear=True,
            ):
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(
                    stderr
                ):
                    exit_code = main(arguments)

            self.assertEqual(exit_code, 0)
            self.assertEqual(stderr.getvalue(), "")
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                owner = connection.execute(
                    """
                    SELECT o.id, o.display_name, oi.external_id,
                           c.display_name, count(m.id)
                    FROM public.owner AS o
                    JOIN public.owner_channel_identity AS oi
                      ON oi.owner_id = o.id
                    JOIN public.contact AS c
                      ON c.owner_id = o.id
                    JOIN public.message AS m
                      ON m.owner_id = c.owner_id AND m.contact_id = c.id
                    WHERE oi.external_id = %s
                    GROUP BY o.id, o.display_name, oi.external_id, c.display_name
                    """,
                    ("wxid_synthetic_owner",),
                ).fetchone()
            self.assertIsNotNone(owner)
            self.owner_id = owner[0]
            self.assertEqual(owner[1:], (
                "合成用户",
                "wxid_synthetic_owner",
                "首次初始化合成联系人",
                6,
            ))
            self.assertIn(
                f"NOTALONE_OWNER_ID={self.owner_id}",
                env_path.read_text(encoding="utf-8"),
            )


if __name__ == "__main__":
    unittest.main()
