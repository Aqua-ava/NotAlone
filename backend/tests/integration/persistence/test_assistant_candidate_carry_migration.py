"""携候选输入的真实055迁移：新装、054升级及账本失败整体回滚。"""

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
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository


DATABASE_URL = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")
MIGRATIONS = Path(__file__).resolve().parents[3] / "database" / "migrations"
CARRY_MIGRATION = "055_assistant_candidate_carry_input.sql"


class AssistantCandidateCarryMigrationTest(unittest.TestCase):
    def setUp(self) -> None:
        if not DATABASE_URL:
            self.skipTest("必须显式指定隔离 PostgreSQL 实例。")
        self.name = f"notalone_carry_migration_{uuid4().hex}_test"
        self.database_url = make_conninfo(DATABASE_URL, dbname=self.name)
        self.admin = psycopg.connect(DATABASE_URL, dbname="postgres", autocommit=True)
        self.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(self.name)))
        self.addCleanup(self._drop_database)
        directory = tempfile.TemporaryDirectory(prefix="notalone-carry-real-055-")
        self.addCleanup(directory.cleanup)
        self.migrations = Path(directory.name)
        for source in MIGRATIONS.glob("*.sql"):
            if int(source.name[:3]) <= 55:
                shutil.copyfile(source, self.migrations / source.name)

    def _drop_database(self) -> None:
        try:
            self.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(self.name)))
            self.assertEqual(self.admin.execute("SELECT count(*) FROM pg_database WHERE datname=%s",
                                                (self.name,)).fetchone()[0], 0)
            print("carry_schema_cleanup: owned database remaining=0", flush=True)
        finally:
            self.admin.close()

    def _before_carry(self) -> None:
        directory = tempfile.TemporaryDirectory(prefix="notalone-carry-real-054-")
        self.addCleanup(directory.cleanup)
        prefix = Path(directory.name)
        for source in self.migrations.glob("*.sql"):
            if int(source.name[:3]) <= 54:
                shutil.copyfile(source, prefix / source.name)
        self.assertEqual(len(migrate(self.database_url, prefix)), 54)

    def _discussion(self):
        owner_id, contact_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.owner (id,display_name) VALUES (%s,'合成携入迁移用户')", (owner_id,))
            connection.execute("INSERT INTO public.contact (id,owner_id,display_name) VALUES (%s,%s,'合成携入迁移联系人')",
                               (contact_id, owner_id))
        binding = PostgresConversationBindingRepository(self.database_url).create_binding(
            owner_id=owner_id, contact_id=contact_id, channel="wechat", account_scope="synthetic-carry-schema",
            conversation_locator=f"synthetic-{uuid4()}",
        )
        # 这里固定验证054旧库；当前存储适配器依赖后续迁移，不能用于构造历史状态。
        with psycopg.connect(self.database_url) as connection:
            session_id = connection.execute(
                "INSERT INTO public.assistant_session (owner_id, contact_id) VALUES (%s, %s) RETURNING id",
                (owner_id, contact_id),
            ).fetchone()[0]
            input_id = connection.execute(
                "INSERT INTO public.assistant_session_input "
                "(session_id, owner_id, contact_id, conversation_binding_id, input_type, content) "
                "VALUES (%s, %s, %s, %s, 'purpose_exploration', %s) RETURNING id",
                (session_id, owner_id, contact_id, binding.binding_id, Jsonb({
                    "type": "purpose_exploration", "purpose_hint": "合成升级前讨论，完整保留",
                })),
            ).fetchone()[0]
            connection.execute(
                "UPDATE public.assistant_session SET current_input_version_id = %s WHERE id = %s",
                (input_id, session_id),
            )
        return session_id

    def _discussion_snapshot(self, session_id):
        with psycopg.connect(self.database_url) as connection:
            return (
                connection.execute("SELECT * FROM public.assistant_session WHERE id = %s", (session_id,)).fetchall(),
                connection.execute("SELECT * FROM public.assistant_session_input WHERE session_id = %s ORDER BY id",
                                   (session_id,)).fetchall(),
            )

    def _constraint(self, connection):
        return connection.execute(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conrelid='public.assistant_session_input'::regclass "
            "AND conname='assistant_session_input_input_type_check'",
        ).fetchone()[0]

    def test_fresh_actual_001_to_055_and_repeat_zero(self) -> None:
        installed = migrate(self.database_url, self.migrations)
        self.assertEqual((len(installed), installed[-1]), (55, CARRY_MIGRATION))
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute("SELECT count(*),max(name) FROM public.notalone_schema_migration")
                             .fetchone(), (55, CARRY_MIGRATION))
            self.assertIn("candidate_carry", self._constraint(connection))
        self.assertEqual(migrate(self.database_url, self.migrations), ())

    def test_actual_054_upgrades_once_and_preserves_old_discussion(self) -> None:
        self._before_carry()
        session_id = self._discussion()
        before = self._discussion_snapshot(session_id)
        self.assertEqual(migrate(self.database_url, self.migrations), (CARRY_MIGRATION,))
        self.assertEqual(self._discussion_snapshot(session_id), before)
        self.assertEqual(migrate(self.database_url, self.migrations), ())

    def test_055_ledger_failure_rolls_back_the_real_constraint_and_retries(self) -> None:
        self._before_carry()
        session_id = self._discussion()
        before = self._discussion_snapshot(session_id)
        with psycopg.connect(self.database_url) as connection:
            old_constraint = self._constraint(connection)
            connection.execute(sql.SQL("ALTER TABLE public.notalone_schema_migration "
                                       "ADD CONSTRAINT synthetic_carry_ledger_failure CHECK (name <> {})")
                               .format(sql.Literal(CARRY_MIGRATION)))
        with self.assertRaises(MigrationError):
            migrate(self.database_url, self.migrations)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(self._constraint(connection), old_constraint)
            self.assertEqual(connection.execute("SELECT count(*),max(name) FROM public.notalone_schema_migration")
                             .fetchone(), (54, "054_assistant_generation_interruption.sql"))
            connection.execute("ALTER TABLE public.notalone_schema_migration DROP CONSTRAINT synthetic_carry_ledger_failure")
        self.assertEqual(self._discussion_snapshot(session_id), before)
        self.assertEqual(migrate(self.database_url, self.migrations), (CARRY_MIGRATION,))
        self.assertEqual(migrate(self.database_url, self.migrations), ())
