"""退出中断的正式迁移与同事务接缝；只使用自有合成 PostgreSQL 库。"""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import tempfile
import unittest
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.types.json import Jsonb

from notalone.database_migrations import MigrationError, migrate
from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.scopes import ContactScope


DATABASE_URL = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")
MIGRATIONS = Path(__file__).resolve().parents[3] / "database" / "migrations"
INTERRUPTION_MIGRATION = "054_assistant_generation_interruption.sql"


class AssistantGenerationInterruptionMigrationTest(unittest.TestCase):
    """DDL 与迁移账本是已约定接缝；升级夹具只复制真实正式前缀。"""

    def setUp(self) -> None:
        if not DATABASE_URL:
            self.skipTest("必须显式指定本票隔离 PostgreSQL 测试库。")
        self.name = f"notalone_interruption_migration_{uuid4().hex}_test"
        self.database_url = make_conninfo(DATABASE_URL, dbname=self.name)
        self.admin = psycopg.connect(DATABASE_URL, dbname="postgres", autocommit=True)
        self.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(self.name)))
        self.addCleanup(self._drop_database)

    def _drop_database(self) -> None:
        try:
            self.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(self.name)))
            remaining = self.admin.execute("SELECT count(*) FROM pg_database WHERE datname = %s", (self.name,)).fetchone()[0]
            if remaining:
                raise AssertionError("自有退出迁移测试库未完整清理。")
        finally:
            self.admin.close()

    def _before_interruption(self) -> None:
        directory = tempfile.TemporaryDirectory(prefix="notalone-interruption-prefix-")
        self.addCleanup(directory.cleanup)
        prefix = Path(directory.name)
        for source in MIGRATIONS.glob("*.sql"):
            if int(source.name[:3]) <= 53:
                shutil.copyfile(source, prefix / source.name)
        self.assertEqual(len(migrate(self.database_url, prefix)), 53)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute(
                "SELECT count(*), max(name) FROM public.notalone_schema_migration",
            ).fetchone(), (53, "053_assistant_candidate_versions.sql"))

    def _reserved_turn(self):
        owner_id, contact_id = uuid4(), uuid4()
        scope = ContactScope(owner_id, contact_id)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.owner (id, display_name) VALUES (%s, '合成退出用户')", (owner_id,))
            connection.execute("INSERT INTO public.contact (owner_id, id, display_name) VALUES (%s, %s, '合成退出联系人')",
                               (owner_id, contact_id))
        binding = PostgresConversationBindingRepository(self.database_url).create_binding(
            owner_id=owner_id, contact_id=contact_id, channel="wechat",
            account_scope="synthetic-interruption-migration", conversation_locator=f"synthetic-{uuid4()}",
        )
        store = PostgresAssistantSessionStore(self.database_url)
        session_id = store.default(scope)
        turn_id, version_id = uuid4(), uuid4()
        # 升级夹具使用 048/051 的真实列，避免要求旧库先具有新代码依赖的 054 列。
        payload = {"content": {"type": "rewrite_draft", "draft_text": "合成迁移前用户草稿",
                               "include_relationship_context": False},
                   "continued_from_candidate_id": None, "skill_version_id": None, "skill_disabled": False}
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.assistant_session_turn "
                "(id, session_id, owner_id, contact_id, input_version_id, idempotency_key, "
                "conversation_binding_id, input_digest, input_payload) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (turn_id, session_id, owner_id, contact_id, version_id, uuid4(), binding.binding_id, "a" * 64, Jsonb(payload)),
            )
            connection.execute(
                "INSERT INTO public.assistant_session_input "
                "(id, session_id, owner_id, contact_id, conversation_binding_id, input_type, turn_id) "
                "VALUES (%s, %s, %s, %s, %s, 'generation', %s)",
                (version_id, session_id, owner_id, contact_id, binding.binding_id, turn_id),
            )
            connection.execute("UPDATE public.assistant_session SET current_input_version_id = %s WHERE id = %s", (version_id, session_id))
        return store, scope, session_id, turn_id

    def test_fresh_install_can_record_a_body_free_interruption(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute(
                "SELECT count(*), max(name) FROM public.notalone_schema_migration",
            ).fetchone(), (54, INTERRUPTION_MIGRATION))
        _, _, _, turn_id = self._reserved_turn()
        with psycopg.connect(self.database_url) as connection:
            self.assertIsNone(connection.execute(
                "SELECT interruption_reason FROM public.assistant_session_turn WHERE id = %s", (turn_id,),
            ).fetchone()[0])
            before = connection.execute("SELECT input_digest, input_payload FROM public.assistant_session_turn WHERE id = %s", (turn_id,)).fetchone()
            connection.execute("UPDATE public.assistant_session_turn SET state = 'failed', interruption_reason = 'app_quit' WHERE id = %s", (turn_id,))
            after = connection.execute("SELECT input_digest, input_payload FROM public.assistant_session_turn WHERE id = %s", (turn_id,)).fetchone()
            self.assertEqual(after, before)
        self.assertEqual(migrate(self.database_url, MIGRATIONS), ())

    def test_upgrade_preserves_old_rows_and_enforces_only_the_quit_classification(self) -> None:
        self._before_interruption()
        store, scope, session_id, turn_id = self._reserved_turn()
        store.fail(scope, turn_id)
        before = store.read_session(scope, session_id)
        self.assertEqual(migrate(self.database_url, MIGRATIONS), (INTERRUPTION_MIGRATION,))
        after = store.read_session(scope, session_id)
        self.assertEqual(after, before)
        with psycopg.connect(self.database_url) as connection:
            self.assertIsNone(connection.execute("SELECT interruption_reason FROM public.assistant_session_turn WHERE id = %s", (turn_id,)).fetchone()[0])
            connection.execute("UPDATE public.assistant_session_turn SET interruption_reason = 'app_quit' WHERE id = %s", (turn_id,))
            for state, reason in (("running", "app_quit"), ("completed", "app_quit"), ("failed", "synthetic-body")):
                with self.subTest(state=state, reason=reason), self.assertRaises(psycopg.errors.CheckViolation):
                    with connection.transaction():
                        connection.execute("UPDATE public.assistant_session_turn SET state = %s, interruption_reason = %s WHERE id = %s", (state, reason, turn_id))
            # 来源擦除仍可保持无正文占位，无需另改共享删除 writer。
            connection.execute("UPDATE public.assistant_session_turn SET state = 'redacted', input_payload = NULL, input_digest = NULL, reply_request_id = NULL, dependency_ids = '{}' WHERE id = %s", (turn_id,))

    def test_version_record_failure_rolls_back_the_column_and_retries_the_real_054(self) -> None:
        self._before_interruption()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(sql.SQL(
                "ALTER TABLE public.notalone_schema_migration ADD CONSTRAINT "
                "synthetic_interruption_ledger_failure CHECK (name <> {})"
            ).format(sql.Literal(INTERRUPTION_MIGRATION)))
        with self.assertRaises(MigrationError):
            migrate(self.database_url, MIGRATIONS)
        with psycopg.connect(self.database_url) as connection:
            self.assertIsNone(connection.execute("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'assistant_session_turn' AND column_name = 'interruption_reason'").fetchone())
            connection.execute("ALTER TABLE public.notalone_schema_migration DROP CONSTRAINT synthetic_interruption_ledger_failure")
        self.assertEqual(migrate(self.database_url, MIGRATIONS), (INTERRUPTION_MIGRATION,))


if __name__ == "__main__":
    unittest.main()
