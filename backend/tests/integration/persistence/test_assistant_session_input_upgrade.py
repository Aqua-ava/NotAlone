"""真实 001–050 前缀经正式 runner 升级 051，并验证稳定输入公共接口。"""

from __future__ import annotations

import hashlib
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row, tuple_row
from psycopg.types.json import Jsonb

from notalone.database_migrations import migrate
from notalone.application.assistant_session_service import (
    AssistantSessionConflict, AssistantSessionNotFound, AssistantSessionRejected,
)
from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.memory.models import (
    AdoptionMethod, ConfirmedMemoryStatus, FactSubject,
    MemoryCandidate, MemoryCategory, MemoryTopic, OwnerMemory,
)
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.locks import lock_owner_scope
from notalone.scopes import ContactScope


ROOT = Path(__file__).resolve().parents[3]


class AssistantSessionInputUpgradeTest(unittest.TestCase):
    def setUp(self) -> None:
        instance_url = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")
        if not instance_url:
            self.skipTest("必须显式指定隔离 PostgreSQL 测试实例。")
        self.database_name = f"notalone_input_upgrade_{uuid4().hex}_test"
        self.database_url = make_conninfo(instance_url, dbname=self.database_name)
        self.admin = psycopg.connect(instance_url, dbname="postgres", autocommit=True)
        self.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(
            sql.Identifier(self.database_name),
        ))
        self.addCleanup(self._drop_database)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.migrations = Path(directory.name)
        for migration in (ROOT / "database/migrations").glob("*.sql"):
            if int(migration.name[:3]) <= 50:
                shutil.copyfile(migration, self.migrations / migration.name)
        self.assertEqual(migrate(self.database_url, self.migrations),
                         tuple(sorted(path.name for path in self.migrations.glob("*.sql"))))
        self.owner_id, self.contact_id = uuid4(), uuid4()
        self.scope = ContactScope(self.owner_id, self.contact_id)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.owner (id, display_name) VALUES (%s, '合成升级用户')", (self.owner_id,))
            connection.execute(
                "INSERT INTO public.contact (id, owner_id, display_name) VALUES (%s, %s, '合成升级联系人')",
                (self.contact_id, self.owner_id),
            )
        self.binding = PostgresConversationBindingRepository(self.database_url).create_binding(
            owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
            account_scope="synthetic-input-upgrade", conversation_locator=f"synthetic-{uuid4()}",
        )
        self.session_id = PostgresAssistantSessionStore(self.database_url).default(self.scope)

    def _drop_database(self) -> None:
        try:
            self.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                sql.Identifier(self.database_name),
            ))
        finally:
            self.admin.close()

    def _upgrade(self, *, current_runtime: bool = False) -> None:
        migration_path = ROOT / "database/migrations/051_assistant_session_inputs.sql"
        shutil.copyfile(migration_path, self.migrations / migration_path.name)
        self.assertEqual(migrate(self.database_url, self.migrations), (migration_path.name,))
        with psycopg.connect(self.database_url) as connection:
            ledger = connection.execute(
                "SELECT name, checksum FROM public.notalone_schema_migration ORDER BY name",
            ).fetchall()
        self.assertEqual(ledger, [
            (path.name, hashlib.sha256(path.read_bytes()).hexdigest())
            for path in sorted(self.migrations.glob("*.sql"))
        ])
        self.assertEqual(migrate(self.database_url, self.migrations), ())
        if current_runtime:
            # 来源证明覆盖现行闭包，不能让只到051的结构冒充已具备058准备上下文。
            remaining = tuple(sorted(path.name for path in (ROOT / "database/migrations").glob("*.sql")
                                     if int(path.name[:3]) > 51))
            for name in remaining:
                shutil.copyfile(ROOT / "database/migrations" / name, self.migrations / name)
            self.assertEqual(migrate(self.database_url, self.migrations), remaining)
            self.assertEqual(migrate(self.database_url, self.migrations), ())

    def test_upgrade_preserves_generation_input_identity_without_copying_its_body(self) -> None:
        turn_id, input_version_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.assistant_session_turn "
                "(id, session_id, owner_id, contact_id, input_version_id, idempotency_key, "
                "conversation_binding_id, input_digest, input_payload) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (turn_id, self.session_id, self.owner_id, self.contact_id, input_version_id,
                 uuid4(), self.binding.binding_id, "0" * 64,
                 Jsonb({"content": {"type": "rewrite_draft", "draft_text": "升级前合成输入"}})),
            )
        self._upgrade()
        from notalone.persistence.assistant_session_inputs import PostgresAssistantSessionInputs
        inputs = PostgresAssistantSessionInputs(self.database_url)
        saved = inputs.read_inputs(self.scope, self.session_id)
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0].input_version_id, input_version_id)
        self.assertEqual(saved[0].turn_id, turn_id)
        self.assertEqual(saved[0].type, "generation")
        self.assertIsNone(saved[0].content)
        self.assertTrue(inputs.is_current_input(self.scope, self.session_id, input_version_id))
        turns = PostgresAssistantSessionStore(self.database_url).read(self.scope, self.session_id)
        self.assertEqual(turns[0].input["content"]["draft_text"], "升级前合成输入")

    def test_discussion_versions_keep_the_current_pointer_and_reject_stale_correction(self) -> None:
        self._upgrade()
        from notalone.persistence.assistant_session_inputs import PostgresAssistantSessionInputs
        inputs = PostgresAssistantSessionInputs(self.database_url)
        first = inputs.record_discussion_input(self.scope, self.session_id, {
            "type": "purpose_exploration", "purpose_hint": "合成问候目的",
        })
        second = inputs.record_discussion_input(self.scope, self.session_id, {
            "type": "purpose_exploration", "purpose_hint": "合成问候目的", "correction": "简短一点",
        }, expected_input_version_id=first)
        with self.assertRaises(AssistantSessionConflict):
            inputs.record_discussion_input(self.scope, self.session_id, {
                "type": "purpose_exploration", "purpose_hint": "迟到的旧纠正",
            }, expected_input_version_id=first)
        self.assertNotEqual(first, second)
        self.assertFalse(inputs.is_current_input(self.scope, self.session_id, first))
        self.assertTrue(inputs.is_current_input(self.scope, self.session_id, second))
        self.assertEqual([record.content["purpose_hint"] for record in inputs.read_inputs(self.scope, self.session_id)],
                         ["合成问候目的", "合成问候目的"])
        self.assertEqual(PostgresAssistantSessionStore(self.database_url).read(self.scope, self.session_id), ())

    def test_discussion_recording_reuses_the_callers_owner_transaction_and_rolls_back(self) -> None:
        self._upgrade()
        from notalone.persistence.assistant_session_inputs import (
            PostgresAssistantSessionInputs, record_discussion_input_in_transaction,
        )
        inputs = PostgresAssistantSessionInputs(self.database_url)
        for factory in (tuple_row, dict_row):
            with self.subTest(factory=factory.__name__):
                before = inputs.read_inputs(self.scope, self.session_id)
                previous = inputs.current_input_version_id(self.scope, self.session_id)
                # 外层 pool 确保失败时先释放事务锁，避免测试自身等候线程形成锁环。
                with ThreadPoolExecutor(max_workers=1) as pool:
                    with psycopg.connect(self.database_url, row_factory=factory) as connection:
                        lock_owner_scope(connection, owner_id=self.scope.owner_id)
                        pending = pool.submit(record_discussion_input_in_transaction,
                                              connection, self.scope, self.session_id, {
                            "type": "purpose_exploration", "purpose_hint": "合成事务内讨论",
                        }, previous)
                        version = pending.result(timeout=3)
                        self.assertIs(connection.row_factory, factory)
                        with connection.cursor(row_factory=dict_row) as cursor:
                            self.assertEqual(cursor.execute(
                                "SELECT current_input_version_id FROM public.assistant_session WHERE id = %s",
                                (self.session_id,),
                            ).fetchone()["current_input_version_id"], version)
                        connection.rollback()
                self.assertEqual(inputs.read_inputs(self.scope, self.session_id), before)
                self.assertEqual(inputs.current_input_version_id(self.scope, self.session_id), previous)
                with psycopg.connect(self.database_url, row_factory=factory) as connection:
                    lock_owner_scope(connection, owner_id=self.scope.owner_id)
                    committed = record_discussion_input_in_transaction(connection, self.scope, self.session_id, {
                        "type": "purpose_exploration", "purpose_hint": "合成事务完整提交",
                    }, previous)
                self.assertTrue(inputs.is_current_input(self.scope, self.session_id, committed))

    def test_discussion_inputs_follow_session_and_contact_erasure(self) -> None:
        self._upgrade()
        from notalone.persistence.assistant_session_inputs import PostgresAssistantSessionInputs
        inputs = PostgresAssistantSessionInputs(self.database_url)
        version = inputs.record_discussion_input(self.scope, self.session_id, {
            "type": "purpose_exploration", "purpose_hint": "合成独立讨论",
        })
        with psycopg.connect(self.database_url) as connection:
            connection.execute("DELETE FROM public.assistant_session WHERE id = %s", (self.session_id,))
        self.assertFalse(inputs.is_current_input(self.scope, self.session_id, version))
        with self.assertRaises(AssistantSessionNotFound):
            inputs.read_inputs(self.scope, self.session_id)
        session_id = PostgresAssistantSessionStore(self.database_url).default(self.scope)
        version = inputs.record_discussion_input(self.scope, session_id, {
            "type": "purpose_exploration", "purpose_hint": "联系人删除前合成讨论",
        })
        with psycopg.connect(self.database_url) as connection:
            connection.execute("DELETE FROM public.contact WHERE owner_id = %s AND id = %s",
                               (self.owner_id, self.contact_id))
        self.assertFalse(inputs.is_current_input(self.scope, session_id, version))
        with self.assertRaises(AssistantSessionNotFound):
            inputs.read_inputs(self.scope, session_id)

    def test_response_discussion_rechecks_target_scope_and_source_status(self) -> None:
        self._upgrade(current_runtime=True)
        from notalone.persistence.assistant_session_inputs import PostgresAssistantSessionInputs
        inputs = PostgresAssistantSessionInputs(self.database_url)
        source_id, target_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.source_document "
                "(id, owner_id, contact_id, source_type, file_name, content_sha256, record_count) "
                "VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic-input.jsonl', %s, 1)",
                (source_id, self.owner_id, self.contact_id, "0" * 64),
            )
            connection.execute(
                "INSERT INTO public.message (id, owner_id, contact_id, speaker, message_type, text_content) "
                "VALUES (%s, %s, %s, 'contact', 'text', '合成目标消息')",
                (target_id, self.owner_id, self.contact_id),
            )
            connection.execute(
                "INSERT INTO public.message_source_ref "
                "(message_id, owner_id, contact_id, source_kind, source_document_id, source_locator, raw_payload) "
                "VALUES (%s, %s, %s, 'source_document', %s, 'synthetic-line-1', '{}'::jsonb)",
                (target_id, self.owner_id, self.contact_id, source_id),
            )
        version = inputs.record_discussion_input(self.scope, self.session_id, {
            "type": "response_exploration", "target_message_id": str(target_id), "correction": "更自然一点",
        })
        self.assertTrue(inputs.is_current_input(self.scope, self.session_id, version))
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET status = 'delete_requested' WHERE id = %s",
                               (source_id,))
        self.assertFalse(inputs.is_current_input(self.scope, self.session_id, version))
        saved = inputs.read_inputs(self.scope, self.session_id)
        self.assertEqual(saved[0].state, "unavailable")
        self.assertIsNone(saved[0].content)
        with self.assertRaises(AssistantSessionRejected):
            inputs.record_discussion_input(self.scope, self.session_id, {
                "type": "response_exploration", "target_message_id": str(target_id),
            })

    def test_concurrent_corrections_from_one_version_only_advance_once(self) -> None:
        self._upgrade()
        from notalone.persistence.assistant_session_inputs import PostgresAssistantSessionInputs
        inputs = PostgresAssistantSessionInputs(self.database_url)
        version = inputs.record_discussion_input(self.scope, self.session_id, {
            "type": "purpose_exploration", "purpose_hint": "合成并发讨论",
        })
        barrier = threading.Barrier(2)

        def correct(correction: str):
            barrier.wait(timeout=5)
            try:
                return inputs.record_discussion_input(self.scope, self.session_id, {
                    "type": "purpose_exploration", "purpose_hint": "合成并发讨论", "correction": correction,
                }, expected_input_version_id=version)
            except AssistantSessionConflict:
                return None

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(correct, ("更简短", "更自然")))
        winners = [result for result in results if result is not None]
        self.assertEqual(len(winners), 1)
        self.assertTrue(inputs.is_current_input(self.scope, self.session_id, winners[0]))
        self.assertFalse(inputs.is_current_input(self.scope, self.session_id, version))
        self.assertEqual(len(inputs.read_inputs(self.scope, self.session_id)), 2)

    def test_discussion_preserves_confirmed_fields_and_explicit_skill_choice(self) -> None:
        self._upgrade()
        from notalone.persistence.assistant_session_inputs import PostgresAssistantSessionInputs
        inputs = PostgresAssistantSessionInputs(self.database_url)
        skill_version_id = uuid4()
        content = {
            "type": "purpose_exploration", "purpose_hint": "合成聊天目的",
            "correction": "", "requirements": "暂不约见面", "answer": "只想轻松问候",
            "confirmed_intent": "表达关心但不许诺", "skill_mode": "user",
            "skill_version_id": str(skill_version_id),
        }
        version = inputs.record_discussion_input(self.scope, self.session_id, content)
        self.assertTrue(inputs.is_current_input(self.scope, self.session_id, version))
        self.assertEqual(inputs.read_inputs(self.scope, self.session_id)[0].content, content)
        self.assertEqual(PostgresAssistantSessionStore(self.database_url).read(self.scope, self.session_id), ())

    def test_verified_dependencies_reject_arbitrary_other_contact_sources(self) -> None:
        self._upgrade()
        from notalone.persistence.assistant_session_inputs import PostgresAssistantSessionInputs
        inputs = PostgresAssistantSessionInputs(self.database_url)
        other_contact, foreign_source = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.contact (id, owner_id, display_name) VALUES (%s, %s, '合成其他联系人')",
                (other_contact, self.owner_id),
            )
            connection.execute(
                "INSERT INTO public.source_document "
                "(id, owner_id, contact_id, source_type, file_name, content_sha256, record_count) "
                "VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic-foreign-input.jsonl', %s, 1)",
                (foreign_source, self.owner_id, other_contact, "0" * 64),
            )
        content = {"type": "purpose_exploration", "purpose_hint": "合成依赖复验"}
        with self.assertRaises(AssistantSessionRejected):
            inputs.record_discussion_input(self.scope, self.session_id, content,
                                           verified_dependencies=(foreign_source,))
        self.assertIsNone(inputs.current_input_version_id(self.scope, self.session_id))
        self.assertEqual(inputs.read_inputs(self.scope, self.session_id), ())

    def test_personal_memory_proves_its_actual_other_contact_raw_source(self) -> None:
        self._upgrade(current_runtime=True)
        from notalone.persistence.assistant_session_inputs import PostgresAssistantSessionInputs
        inputs = PostgresAssistantSessionInputs(self.database_url)
        other_contact, source_id, memory_id = uuid4(), uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.contact (id, owner_id, display_name) VALUES (%s, %s, '合成本人记忆来源联系人')",
                (other_contact, self.owner_id),
            )
            connection.execute(
                "INSERT INTO public.source_document "
                "(id, owner_id, contact_id, source_type, file_name, content_sha256, record_count) "
                "VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic-owner-reference.jsonl', %s, 1)",
                (source_id, self.owner_id, other_contact, "0" * 64),
            )
        PostgresOwnerMemoryStore(self.database_url).create(OwnerMemory(
            memory_id=memory_id, owner_id=self.owner_id, text="合成本人喜欢散步",
            category=MemoryCategory.PREFERENCE, topic=MemoryTopic.OTHER,
            source_ids=(source_id,), adoption_method=AdoptionMethod.AUTO,
            status=ConfirmedMemoryStatus.ACTIVE,
        ))
        version = inputs.record_discussion_input(self.scope, self.session_id, {
            "type": "purpose_exploration", "purpose_hint": "合成来源讨论",
        }, verified_dependencies=(memory_id, source_id))
        self.assertTrue(inputs.is_current_input(self.scope, self.session_id, version))
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET status = 'delete_requested' WHERE id = %s",
                               (source_id,))
        self.assertFalse(inputs.is_current_input(self.scope, self.session_id, version))
        self.assertIsNone(inputs.read_inputs(self.scope, self.session_id)[0].content)

    def test_current_input_can_be_required_inside_an_existing_owner_transaction(self) -> None:
        self._upgrade()
        from notalone.persistence.assistant_session_inputs import (
            PostgresAssistantSessionInputs, require_current_input,
        )
        inputs = PostgresAssistantSessionInputs(self.database_url)
        version = inputs.record_discussion_input(self.scope, self.session_id, {
            "type": "purpose_exploration", "purpose_hint": "合成事务内有效输入",
        })
        for options in ({}, {"row_factory": dict_row}):
            with self.subTest(options=tuple(options)):
                with psycopg.connect(self.database_url, **options) as connection:
                    initial_factory = connection.row_factory
                    lock_owner_scope(connection, owner_id=self.owner_id)
                    connection.execute("SET LOCAL statement_timeout = '2s'")
                    self.assertEqual(require_current_input(connection, self.scope, self.session_id, version), ())
                    with self.assertRaises(AssistantSessionRejected):
                        require_current_input(connection, self.scope, self.session_id, uuid4())
                    self.assertIs(connection.row_factory, initial_factory)

    def test_manual_personal_memory_uses_real_memory_identity_and_rejects_owner_sentinel(self) -> None:
        self._upgrade(current_runtime=True)
        from notalone.persistence.assistant_session_inputs import PostgresAssistantSessionInputs
        inputs = PostgresAssistantSessionInputs(self.database_url)
        memory_id = uuid4()
        PostgresOwnerMemoryStore(self.database_url).create(OwnerMemory(
            memory_id=memory_id, owner_id=self.owner_id, text="合成本人手动记忆",
            category=MemoryCategory.PREFERENCE, topic=MemoryTopic.OTHER,
            source_ids=(self.owner_id,), adoption_method=AdoptionMethod.MANUAL,
            status=ConfirmedMemoryStatus.ACTIVE,
        ))
        content = {"type": "purpose_exploration", "purpose_hint": "合成无聊天来源讨论"}
        version = inputs.record_discussion_input(self.scope, self.session_id, content,
                                                verified_dependencies=(memory_id,))
        self.assertTrue(inputs.is_current_input(self.scope, self.session_id, version))
        with self.assertRaises(AssistantSessionRejected):
            inputs.record_discussion_input(self.scope, self.session_id, content,
                                           verified_dependencies=(memory_id, self.owner_id))
        self.assertEqual(inputs.current_input_version_id(self.scope, self.session_id), version)

    def test_discussion_content_rejects_unknown_types_and_overlong_values_without_truncation(self) -> None:
        self._upgrade()
        from notalone.persistence.assistant_session_inputs import PostgresAssistantSessionInputs
        inputs = PostgresAssistantSessionInputs(self.database_url)
        base = {"type": "purpose_exploration", "purpose_hint": "合成边界讨论"}
        boundary = " " + "字" * 4094 + " "
        inputs.record_discussion_input(self.scope, self.session_id, {**base, "requirements": boundary,
                                                                   "skill_mode": "disabled"})
        saved = inputs.read_inputs(self.scope, self.session_id)[0].content
        self.assertEqual(saved["requirements"], boundary)
        self.assertEqual(saved["correction"], "")
        self.assertEqual(saved["answer"], "")
        self.assertEqual(saved["confirmed_intent"], "")
        self.assertEqual(saved["skill_mode"], "disabled")
        self.assertIsNone(saved["skill_version_id"])
        invalid_fields = (
            {"requirements": "字" * 4097}, {"requirements": []}, {"answer": None},
            {"target_message_id": str(uuid4())}, {"source_ids": []}, {"verified_dependencies": []},
            {"skill_mode": "user"}, {"skill_mode": "disabled", "skill_version_id": str(uuid4())},
        )
        for fields in invalid_fields:
            with self.subTest(fields=tuple(fields)), self.assertRaises(AssistantSessionRejected):
                inputs.record_discussion_input(self.scope, self.session_id, {**base, **fields})
        self.assertEqual(len(inputs.read_inputs(self.scope, self.session_id)), 1)

    def test_contact_memory_cannot_validate_its_deleted_original_source(self) -> None:
        self._upgrade()
        from notalone.persistence.assistant_session_inputs import PostgresAssistantSessionInputs
        inputs = PostgresAssistantSessionInputs(self.database_url)
        source_id, memory_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.source_document "
                "(id, owner_id, contact_id, source_type, file_name, content_sha256, record_count) "
                "VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic-contact-memory.jsonl', %s, 1)",
                (source_id, self.owner_id, self.contact_id, "0" * 64),
            )
        memories = PostgresMemoryStore(self.database_url)
        candidate = memories.create_candidate(MemoryCandidate(
            candidate_id=memory_id, scope=self.scope, text="合成联系人喜欢散步",
            category=MemoryCategory.PREFERENCE, source_ids=(source_id,), subject=FactSubject.CONTACT,
        ))
        memory = memories.confirm(scope=self.scope, candidate_id=candidate.candidate_id,
                                  adoption_method=AdoptionMethod.MANUAL)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET status = 'delete_requested' WHERE id = %s",
                               (source_id,))
        with self.assertRaises(AssistantSessionRejected):
            inputs.record_discussion_input(self.scope, self.session_id, {
                "type": "purpose_exploration", "purpose_hint": "合成过期来源讨论",
            }, verified_dependencies=(memory.memory_id,))
        self.assertEqual(inputs.read_inputs(self.scope, self.session_id), ())

    def test_discussion_captures_declared_message_originals_before_one_of_two_sources_is_removed(self) -> None:
        self._upgrade(current_runtime=True)
        from notalone.persistence.assistant_session_inputs import PostgresAssistantSessionInputs
        inputs = PostgresAssistantSessionInputs(self.database_url)
        message_id = uuid4()
        source_ids = (uuid4(), uuid4())
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.message (id, owner_id, contact_id, speaker, message_type, text_content) "
                "VALUES (%s, %s, %s, 'contact', 'text', '合成双来源近期消息')",
                (message_id, self.owner_id, self.contact_id),
            )
            for source_id in source_ids:
                connection.execute(
                    "INSERT INTO public.source_document "
                    "(id, owner_id, contact_id, source_type, file_name, content_sha256, record_count) "
                    "VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic-multiple-input.jsonl', %s, 1)",
                    (source_id, self.owner_id, self.contact_id, uuid4().hex * 2),
                )
                connection.execute(
                    "INSERT INTO public.message_source_ref "
                    "(message_id, owner_id, contact_id, source_kind, source_document_id, source_locator, raw_payload) "
                    "VALUES (%s, %s, %s, 'source_document', %s, %s, '{}'::jsonb)",
                    (message_id, self.owner_id, self.contact_id, source_id, str(source_id)),
                )
        version = inputs.record_discussion_input(self.scope, self.session_id, {
            "type": "purpose_exploration", "purpose_hint": "结合合成近期讨论",
        }, verified_dependencies=(message_id,))
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET status = 'delete_requested' WHERE id = %s",
                               (source_ids[0],))
        self.assertFalse(inputs.is_current_input(self.scope, self.session_id, version))
        self.assertIsNone(inputs.read_inputs(self.scope, self.session_id)[0].content)
