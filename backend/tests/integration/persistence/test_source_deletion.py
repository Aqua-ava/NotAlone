"""PostgreSQL 来源删除与不可检索验证。"""

from __future__ import annotations

import os
import unittest
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import psycopg

from notalone.ingest.jsonl_reader import read_jsonl
from notalone.ingest.models import (
    ExistingContactSelection,
    ImportConfirmationRequest,
)
from notalone.ingest.normalizer import normalize_document
from notalone.memory import (
    AdoptionMethod,
    ConfirmedMemoryStatus,
    MemoryCandidate,
    MemoryCategory,
    MemoryTopic,
    OwnerMemory,
)
from notalone.persistence.contact_memory_index import (
    PostgresContactMemoryIndexRepository,
)
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.postgres_repository import PostgresIngestRepository
from notalone.persistence.background_tasks import (
    PostgresBackgroundTaskRepository,
)
from notalone.persistence.source_deletion import (
    PostgresSourceDeletionRepository,
    SourceDeletionError,
    SourceNotFoundError,
)
from notalone.scopes import ContactScope


FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"
TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresSourceDeletionRepositoryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            database_name = connection.execute("SELECT current_database()").fetchone()[0]
        if not database_name.endswith("_test"):
            raise RuntimeError("集成测试只允许连接名称以 _test 结尾的数据库。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "合成删除用户"),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, %s)",
                (self.owner_id, self.contact_id, "合成删除联系人"),
            )
            connection.execute(
                "INSERT INTO public.owner_channel_identity "
                "(owner_id, channel, external_id, observed_name) "
                "VALUES (%s, 'wechat', %s, %s)",
                (self.owner_id, "wxid_synthetic_owner", "合成删除用户"),
            )
        self.ingest_repository = PostgresIngestRepository(TEST_DATABASE_URL)
        self.deletion_repository = PostgresSourceDeletionRepository(TEST_DATABASE_URL)
        self.batch = normalize_document(
            read_jsonl(FIXTURES_DIR / "valid_single_contact.jsonl")
        )

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    def test_legacy_deleted_receipt_does_not_create_false_success_task(self) -> None:
        from notalone.persistence.source_tasks import PostgresSourceTasks, SourceDeletionHistoryUnverified

        imported = self.ingest_repository.import_document(
            owner_id=self.owner_id, document=self.batch,
            confirmation=ImportConfirmationRequest(selection=ExistingContactSelection(contact_id=self.contact_id)),
        )
        self.deletion_repository.delete_source(owner_id=self.owner_id, contact_id=self.contact_id,
                                               source_document_id=imported.source_document_id)
        sources = PostgresSourceTasks(TEST_DATABASE_URL)
        with self.assertRaises(SourceDeletionHistoryUnverified):
            sources.request_delete(self.owner_id, self.contact_id, imported.source_document_id)
        row = sources.list_sources(self.owner_id, self.contact_id)[0]
        self.assertIsNone(row["task_id"])
        self.assertEqual(row["error_code"], "legacy_deletion_unverified")

    def test_failed_delete_exposes_safe_reason_and_can_resume(self) -> None:
        from notalone.persistence.source_tasks import PostgresSourceTasks
        from notalone.tasks.models import BackgroundTaskStatus
        from notalone.tasks.worker import BackgroundTaskWorker

        imported = self.ingest_repository.import_document(
            owner_id=self.owner_id, document=self.batch,
            confirmation=ImportConfirmationRequest(selection=ExistingContactSelection(contact_id=self.contact_id)),
        )
        sources = PostgresSourceTasks(TEST_DATABASE_URL)
        task_id = sources.request_delete(self.owner_id, self.contact_id, imported.source_document_id)
        repository = PostgresBackgroundTaskRepository(TEST_DATABASE_URL)

        class FailingDeletion:
            def delete_source(self, **kwargs):
                raise SourceDeletionError("合成底层详情不可返回")

        worker = BackgroundTaskWorker(repository=repository, deletion_repository=FailingDeletion())
        for _ in range(4):
            worker.run_once(owner_id=self.owner_id, contact_id=self.contact_id, worker_id=uuid4())
        task = repository.get_task(owner_id=self.owner_id, contact_id=self.contact_id, task_id=task_id)
        self.assertEqual(task.status, BackgroundTaskStatus.FAILED)
        row = sources.list_sources(self.owner_id, self.contact_id)[0]
        self.assertEqual(row["error_code"], "source_delete_failed")
        self.assertNotIn("底层", str(row))
        repository.retry_failed_task(owner_id=self.owner_id, contact_id=self.contact_id, task_id=task_id)
        resumed = BackgroundTaskWorker(repository=repository, deletion_repository=self.deletion_repository)
        for _ in range(4):
            resumed.run_once(owner_id=self.owner_id, contact_id=self.contact_id, worker_id=uuid4())
        row = sources.list_sources(self.owner_id, self.contact_id)[0]
        self.assertEqual(row["task_status"], "succeeded")
        self.assertIsNone(row["error_code"])

    def test_worker_resumes_after_delete_committed_before_step_receipt(self) -> None:
        from notalone.persistence.source_tasks import PostgresSourceTasks
        from notalone.tasks.models import BackgroundTaskStepName, BackgroundTaskStatus, DELETE_TASK_STEPS
        from notalone.tasks.worker import BackgroundTaskWorker

        imported = self.ingest_repository.import_document(
            owner_id=self.owner_id, document=self.batch,
            confirmation=ImportConfirmationRequest(selection=ExistingContactSelection(contact_id=self.contact_id)),
        )
        task_id = PostgresSourceTasks(TEST_DATABASE_URL).request_delete(
            self.owner_id, self.contact_id, imported.source_document_id,
        )
        repository = PostgresBackgroundTaskRepository(TEST_DATABASE_URL)
        worker_id = uuid4()
        kwargs = dict(owner_id=self.owner_id, contact_id=self.contact_id, worker_id=worker_id,
                      lease_duration=timedelta(seconds=30), supported_steps=tuple(name for _, name in DELETE_TASK_STEPS))
        mark = repository.claim_next_step(**kwargs)
        repository.complete_step(mark, processed_count=0)
        interrupted = repository.claim_next_step(**kwargs)
        self.assertEqual(interrupted.name, BackgroundTaskStepName.DELETE_DERIVED)
        self.deletion_repository.delete_source(owner_id=self.owner_id, contact_id=self.contact_id,
                                               source_document_id=imported.source_document_id)
        # 模拟清理事务已提交，而 Worker 尚未写步骤完成便退出。
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute("UPDATE public.background_task_step SET lease_expires_at = now() - interval '1 second' WHERE id = %s",
                               (interrupted.step_id,))
        resumed = BackgroundTaskWorker(repository=repository, deletion_repository=self.deletion_repository)
        for _ in range(5):
            resumed.run_once(owner_id=self.owner_id, contact_id=self.contact_id, worker_id=uuid4())
        task = repository.get_task(owner_id=self.owner_id, contact_id=self.contact_id, task_id=task_id)
        self.assertEqual(task.status, BackgroundTaskStatus.SUCCEEDED)
        self.assertEqual(task.steps[1].attempt_count, 2)
        self.assertEqual(task_id, PostgresSourceTasks(TEST_DATABASE_URL).request_delete(
            self.owner_id, self.contact_id, imported.source_document_id,
        ))

    def test_http_delete_is_durable_idempotent_and_scoped(self) -> None:
        import time
        from notalone.server.app import create_app
        from notalone.server.testing import InProcessClient

        imported = self.ingest_repository.import_document(
            owner_id=self.owner_id, document=self.batch,
            confirmation=ImportConfirmationRequest(selection=ExistingContactSelection(contact_id=self.contact_id)),
        )
        client = InProcessClient(create_app(database_url=TEST_DATABASE_URL, owner_id=self.owner_id, token="synthetic"))
        headers = {"Authorization": "Bearer synthetic"}
        path = f"/api/contacts/{self.contact_id}/sources"
        listed = client.get(path, headers=headers)
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.json()["sources"][0]["source_id"], str(imported.source_document_id))
        target = f"{path}/{imported.source_document_id}"
        foreign = target.replace(str(self.contact_id), str(uuid4()))
        self.assertEqual(client.request("DELETE", foreign, headers=headers).status_code, 404)
        first = client.request("DELETE", target, headers=headers)
        self.assertEqual(first.status_code, 202)
        repeated = client.request("DELETE", target, headers=headers)
        self.assertEqual(first.json()["task_id"], repeated.json()["task_id"])
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            source = client.get(path, headers=headers).json()["sources"][0]
            if source["task_status"] == "succeeded":
                break
            time.sleep(0.02)
        self.assertEqual(source["task_status"], "succeeded", source)
        self.assertEqual(source["status"], "deleted")
        self.assertIsNone(source["file_name"])
        restarted = InProcessClient(create_app(database_url=TEST_DATABASE_URL, owner_id=self.owner_id, token="synthetic"))
        self.assertEqual(restarted.get(path, headers=headers).json()["sources"][0]["task_id"], first.json()["task_id"])

    def test_delete_erases_rejected_candidate_and_old_memory_versions(self) -> None:
        imported = self.ingest_repository.import_document(
            owner_id=self.owner_id, document=self.batch,
            confirmation=ImportConfirmationRequest(selection=ExistingContactSelection(contact_id=self.contact_id)),
        )
        candidate_id, old_id, new_id = uuid4(), uuid4(), uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.memory_candidate (id, owner_id, contact_id, text_content, category, source_ids, status) "
                "VALUES (%s, %s, %s, '合成拒绝正文', 'preference', %s, 'rejected')",
                (candidate_id, self.owner_id, self.contact_id, [imported.source_document_id]),
            )
            for memory_id, supersedes in ((old_id, None), (new_id, old_id)):
                connection.execute(
                    "INSERT INTO public.confirmed_memory (id, owner_id, contact_id, text_content, category, source_ids, "
                    "status, adoption_method, supersedes_memory_id) "
                    "VALUES (%s, %s, %s, '合成历史版本正文', 'preference', %s, 'invalidated', 'manual', %s)",
                    (memory_id, self.owner_id, self.contact_id, [imported.source_document_id], supersedes),
                )
            connection.execute(
                "INSERT INTO public.outbound_ledger_entry (id, owner_id, contact_id, provider, model_name, outcome, called_at) "
                "VALUES (%s, %s, %s, 'synthetic', 'synthetic', 'succeeded', now())",
                (uuid4(), self.owner_id, self.contact_id),
            )
        try:
            self.deletion_repository.delete_source(owner_id=self.owner_id, contact_id=self.contact_id,
                                                   source_document_id=imported.source_document_id)
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                for table in ("memory_candidate", "confirmed_memory"):
                    self.assertEqual(connection.execute(
                        f"SELECT count(*) FROM public.{table} WHERE owner_id = %s", (self.owner_id,),
                    ).fetchone()[0], 0)
                self.assertEqual(connection.execute("SELECT count(*) FROM public.outbound_ledger_entry WHERE owner_id = %s",
                                                    (self.owner_id,)).fetchone()[0], 1)
        finally:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                connection.execute("DELETE FROM public.outbound_ledger_entry WHERE owner_id = %s", (self.owner_id,))

    def test_delete_source_removes_all_retrievable_content(self) -> None:
        imported = self.ingest_repository.import_document(
            owner_id=self.owner_id,
            document=self.batch,
            confirmation=ImportConfirmationRequest(
                selection=ExistingContactSelection(contact_id=self.contact_id)
            ),
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            message_ids = tuple(
                row[0]
                for row in connection.execute(
                    """
                    SELECT message_id
                    FROM public.message_source_ref
                    WHERE owner_id = %s AND contact_id = %s
                      AND source_document_id = %s
                    """,
                    (
                        self.owner_id,
                        self.contact_id,
                        imported.source_document_id,
                    ),
                ).fetchall()
            )

        result = self.deletion_repository.delete_source(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            source_document_id=imported.source_document_id,
        )

        self.assertEqual(result.outcome, "deleted")
        self.assertIsNotNone(result.deleted_at)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            source = connection.execute(
                """
                SELECT status, file_name, content_sha256, record_count, deleted_at
                FROM public.source_document
                WHERE owner_id = %s AND contact_id = %s AND id = %s
                """,
                (self.owner_id, self.contact_id, imported.source_document_id),
            ).fetchone()
            remaining = connection.execute(
                """
                SELECT
                    (SELECT count(*) FROM public.message
                     WHERE owner_id = %s AND contact_id = %s
                       AND id = ANY(%s::uuid[])),
                    (SELECT count(*) FROM public.message_source_ref
                     WHERE owner_id = %s AND contact_id = %s
                       AND source_document_id = %s),
                    (SELECT count(*) FROM public.wechat_message_metadata
                     WHERE message_id = ANY(%s::uuid[])),
                    (SELECT count(*) FROM public.import_confirmation
                     WHERE source_document_id = %s)
                """,
                (
                    self.owner_id,
                    self.contact_id,
                    list(message_ids),
                    self.owner_id,
                    self.contact_id,
                    imported.source_document_id,
                    list(message_ids),
                    imported.source_document_id,
                ),
            ).fetchone()

        self.assertEqual(source[:4], ("deleted", None, None, 0))
        self.assertIsNotNone(source[4])
        self.assertEqual(remaining, (0, 0, 0, 0))

    def test_delete_source_cancels_pending_worker_steps(self) -> None:
        imported = self.ingest_repository.import_document(
            owner_id=self.owner_id,
            document=self.batch,
            confirmation=ImportConfirmationRequest(
                selection=ExistingContactSelection(contact_id=self.contact_id)
            ),
        )

        self.deletion_repository.delete_source(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            source_document_id=imported.source_document_id,
        )

        task_repository = PostgresBackgroundTaskRepository(TEST_DATABASE_URL)
        task = task_repository.get_task(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            task_id=imported.task_id,
        )
        self.assertEqual(task.status.value, "cancelled")
        self.assertEqual(
            tuple(step.status.value for step in task.steps),
            ("cancelled",) * 5,
        )
        self.assertIsNone(
            task_repository.claim_next_step(
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                worker_id=uuid4(),
                lease_duration=timedelta(seconds=30),
            )
        )

    def test_delete_source_cleans_confirmed_memory_and_index_projection(self) -> None:
        imported = self.ingest_repository.import_document(
            owner_id=self.owner_id,
            document=self.batch,
            confirmation=ImportConfirmationRequest(
                selection=ExistingContactSelection(contact_id=self.contact_id)
            ),
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            message_id = connection.execute(
                """
                SELECT message_id
                FROM public.message_source_ref
                WHERE owner_id = %s AND contact_id = %s
                  AND source_document_id = %s
                ORDER BY message_id LIMIT 1
                """,
                (
                    self.owner_id,
                    self.contact_id,
                    imported.source_document_id,
                ),
            ).fetchone()[0]

        memory_store = PostgresMemoryStore(TEST_DATABASE_URL)
        candidate = memory_store.create_candidate(
            MemoryCandidate(
                candidate_id=uuid4(),
                scope=ContactScope(self.owner_id, self.contact_id),
                text="来源删除后必须清理的合成记忆",
                category=MemoryCategory.PREFERENCE,
                source_ids=(message_id,),
            )
        )
        memory = memory_store.confirm(
            scope=ContactScope(self.owner_id, self.contact_id),
            candidate_id=candidate.candidate_id,
        )
        index_repository = PostgresContactMemoryIndexRepository(
            TEST_DATABASE_URL
        )
        index_repository.rebuild(ContactScope(self.owner_id, self.contact_id))

        self.deletion_repository.delete_source(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            source_document_id=imported.source_document_id,
        )

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            stored_memory = connection.execute(
                "SELECT status FROM public.confirmed_memory WHERE id = %s",
                (memory.memory_id,),
            ).fetchone()
        self.assertIsNone(stored_memory)
        remaining_index = index_repository.get(
            ContactScope(self.owner_id, self.contact_id)
        )
        self.assertIsNotNone(remaining_index)
        assert remaining_index is not None
        self.assertEqual(remaining_index.status.value, "stale")
        self.assertEqual(remaining_index.topics, ())

    def test_delete_source_keeps_memory_supported_by_another_source(self) -> None:
        imported = self.ingest_repository.import_document(
            owner_id=self.owner_id,
            document=self.batch,
            confirmation=ImportConfirmationRequest(
                selection=ExistingContactSelection(contact_id=self.contact_id)
            ),
        )
        second_source_id = uuid4()
        second_message_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            first_message_id = connection.execute(
                """
                SELECT message_id
                FROM public.message_source_ref
                WHERE owner_id = %s AND contact_id = %s
                  AND source_document_id = %s
                ORDER BY message_id LIMIT 1
                """,
                (
                    self.owner_id,
                    self.contact_id,
                    imported.source_document_id,
                ),
            ).fetchone()[0]
            connection.execute(
                """
                INSERT INTO public.source_document (
                    id, owner_id, contact_id, source_type, file_name,
                    content_sha256, record_count, status
                ) VALUES (%s, %s, %s, 'wechat_jsonl', 'second.jsonl', %s, 1, 'active')
                """,
                (
                    second_source_id,
                    self.owner_id,
                    self.contact_id,
                    "e" * 64,
                ),
            )
            connection.execute(
                """
                INSERT INTO public.message (
                    id, owner_id, contact_id,
                    speaker, message_type, text_content
                ) VALUES (%s, %s, %s, 'contact', 'text', %s)
                """,
                (
                    second_message_id,
                    self.owner_id,
                    self.contact_id,
                    "第二来源的合成消息",
                ),
            )
            connection.execute(
                """
                INSERT INTO public.message_source_ref (
                    id, message_id, owner_id, contact_id,
                    source_kind, source_document_id, source_locator, raw_payload
                ) VALUES (gen_random_uuid(), %s, %s, %s,
                          'source_document', %s, 'second:1', '{}'::jsonb)
                """,
                (
                    second_message_id,
                    self.owner_id,
                    self.contact_id,
                    second_source_id,
                ),
            )
        scope = ContactScope(self.owner_id, self.contact_id)
        memory_store = PostgresMemoryStore(TEST_DATABASE_URL)
        candidate = memory_store.create_candidate(
            MemoryCandidate(
                candidate_id=uuid4(),
                scope=scope,
                text="两个来源共同支持的合成记忆",
                category=MemoryCategory.COMMON_FACT,
                source_ids=(first_message_id, second_message_id),
            )
        )
        memory = memory_store.confirm(scope=scope, candidate_id=candidate.candidate_id)

        self.deletion_repository.delete_source(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            source_document_id=imported.source_document_id,
        )

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            stored = connection.execute(
                "SELECT status, source_ids FROM public.confirmed_memory "
                "WHERE id = %s",
                (memory.memory_id,),
            ).fetchone()
        self.assertEqual(stored[0], "active")
        self.assertEqual(tuple(stored[1]), (second_message_id,))
        self.assertEqual(len(memory_store.list_confirmed(scope)), 1)

    def test_delete_source_removes_only_its_reference_until_all_sources_gone(self) -> None:
        imported = self.ingest_repository.import_document(
            owner_id=self.owner_id,
            document=self.batch,
            confirmation=ImportConfirmationRequest(
                selection=ExistingContactSelection(contact_id=self.contact_id)
            ),
        )
        second_source_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            message_id = connection.execute(
                """
                SELECT message_id
                FROM public.message_source_ref
                WHERE owner_id = %s AND contact_id = %s
                  AND source_document_id = %s
                ORDER BY message_id LIMIT 1
                """,
                (
                    self.owner_id,
                    self.contact_id,
                    imported.source_document_id,
                ),
            ).fetchone()[0]
            connection.execute(
                """
                INSERT INTO public.source_document (
                    id, owner_id, contact_id, source_type, file_name,
                    content_sha256, record_count, status
                ) VALUES (%s, %s, %s, 'wechat_jsonl', 'dedup.jsonl', %s, 1, 'active')
                """,
                (
                    second_source_id,
                    self.owner_id,
                    self.contact_id,
                    "f" * 64,
                ),
            )
            # 同一条规范消息的第二条来源引用：跨来源去重后的形态。
            connection.execute(
                """
                INSERT INTO public.message_source_ref (
                    id, message_id, owner_id, contact_id,
                    source_kind, source_document_id, source_locator, raw_payload
                ) VALUES (gen_random_uuid(), %s, %s, %s,
                          'source_document', %s, 'dedup:1', '{}'::jsonb)
                """,
                (
                    message_id,
                    self.owner_id,
                    self.contact_id,
                    second_source_id,
                ),
            )
        scope = ContactScope(self.owner_id, self.contact_id)
        memory_store = PostgresMemoryStore(TEST_DATABASE_URL)
        candidate = memory_store.create_candidate(
            MemoryCandidate(
                candidate_id=uuid4(),
                scope=scope,
                text="被两个来源共同支持的合成记忆",
                category=MemoryCategory.COMMON_FACT,
                source_ids=(message_id,),
            )
        )
        memory = memory_store.confirm(scope=scope, candidate_id=candidate.candidate_id)

        # 删除导入来源：只移除其引用，消息与派生资料保留。
        self.deletion_repository.delete_source(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            source_document_id=imported.source_document_id,
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            kept = connection.execute(
                """
                SELECT
                    (SELECT count(*) FROM public.message WHERE id = %s),
                    (SELECT count(*) FROM public.message_source_ref
                     WHERE message_id = %s),
                    (SELECT count(*) FROM public.wechat_message_metadata
                     WHERE message_id = %s)
                """,
                (message_id, message_id, message_id),
            ).fetchone()
            stored_memory = connection.execute(
                "SELECT status, source_ids FROM public.confirmed_memory "
                "WHERE id = %s",
                (memory.memory_id,),
            ).fetchone()
        self.assertEqual(kept, (1, 1, 1))
        self.assertEqual(stored_memory[0], "active")
        self.assertEqual(tuple(stored_memory[1]), (message_id,))

        # 删除最后一个来源：消息、微信身份与派生资料全部清理。
        self.deletion_repository.delete_source(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            source_document_id=second_source_id,
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            cleaned = connection.execute(
                """
                SELECT
                    (SELECT count(*) FROM public.message WHERE id = %s),
                    (SELECT count(*) FROM public.message_source_ref
                     WHERE message_id = %s),
                    (SELECT count(*) FROM public.wechat_message_metadata
                     WHERE message_id = %s)
                """,
                (message_id, message_id, message_id),
            ).fetchone()
            final_memory = connection.execute(
                "SELECT status FROM public.confirmed_memory WHERE id = %s",
                (memory.memory_id,),
            ).fetchone()
        self.assertEqual(cleaned, (0, 0, 0))
        self.assertIsNone(final_memory)

    def test_delete_source_cleans_owner_memory_supported_by_source(self) -> None:
        imported = self.ingest_repository.import_document(
            owner_id=self.owner_id,
            document=self.batch,
            confirmation=ImportConfirmationRequest(
                selection=ExistingContactSelection(contact_id=self.contact_id)
            ),
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            message_id = connection.execute(
                """
                SELECT message_id
                FROM public.message_source_ref
                WHERE owner_id = %s AND contact_id = %s
                  AND source_document_id = %s
                ORDER BY message_id LIMIT 1
                """,
                (
                    self.owner_id,
                    self.contact_id,
                    imported.source_document_id,
                ),
            ).fetchone()[0]
        owner_store = PostgresOwnerMemoryStore(TEST_DATABASE_URL)
        memory = owner_store.create(
            OwnerMemory(
                memory_id=uuid4(),
                owner_id=self.owner_id,
                text="来源支持的 owner 合成记忆",
                category=MemoryCategory.COMMON_FACT,
                topic=MemoryTopic.OTHER,
                source_ids=(message_id,),
                adoption_method=AdoptionMethod.AUTO,
                status=ConfirmedMemoryStatus.ACTIVE,
            )
        )

        self.deletion_repository.delete_source(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            source_document_id=imported.source_document_id,
        )

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            stored = connection.execute(
                "SELECT status FROM public.owner_memory WHERE id = %s",
                (memory.memory_id,),
            ).fetchone()
        self.assertIsNone(stored)
        self.assertEqual(owner_store.list_active(self.owner_id), ())

    def test_delete_failure_is_recorded_without_losing_content(self) -> None:
        imported = self.ingest_repository.import_document(
            owner_id=self.owner_id,
            document=self.batch,
            confirmation=ImportConfirmationRequest(
                selection=ExistingContactSelection(contact_id=self.contact_id)
            ),
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                """
                CREATE FUNCTION public.block_synthetic_message_delete()
                RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    RAISE EXCEPTION 'synthetic deletion failure';
                END
                $$
                """
            )
            connection.execute(
                """
                CREATE TRIGGER block_synthetic_message_delete
                BEFORE DELETE ON public.message
                FOR EACH ROW EXECUTE FUNCTION public.block_synthetic_message_delete()
                """
            )

        try:
            with self.assertRaises(SourceDeletionError):
                self.deletion_repository.delete_source(
                    owner_id=self.owner_id,
                    contact_id=self.contact_id,
                    source_document_id=imported.source_document_id,
                )
        finally:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                connection.execute(
                    "DROP TRIGGER block_synthetic_message_delete ON public.message"
                )
                connection.execute(
                    "DROP FUNCTION public.block_synthetic_message_delete()"
                )

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            source = connection.execute(
                """
                SELECT status, deletion_error_code
                FROM public.source_document
                WHERE id = %s
                """,
                (imported.source_document_id,),
            ).fetchone()
            message_count = connection.execute(
                """
                SELECT count(*)
                FROM public.message_source_ref
                WHERE owner_id = %s AND contact_id = %s
                  AND source_document_id = %s
                """,
                (
                    self.owner_id,
                    self.contact_id,
                    imported.source_document_id,
                ),
            ).fetchone()[0]

        self.assertEqual(source, ("delete_failed", "storage_delete_failed"))
        self.assertEqual(message_count, 6)

    def test_delete_source_is_idempotent(self) -> None:
        imported = self.ingest_repository.import_document(
            owner_id=self.owner_id,
            document=self.batch,
            confirmation=ImportConfirmationRequest(
                selection=ExistingContactSelection(contact_id=self.contact_id)
            ),
        )

        first = self.deletion_repository.delete_source(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            source_document_id=imported.source_document_id,
        )
        second = self.deletion_repository.delete_source(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            source_document_id=imported.source_document_id,
        )

        self.assertEqual(first.outcome, "deleted")
        self.assertEqual(second.outcome, "already_deleted")
        self.assertEqual(second.source_document_id, first.source_document_id)
        self.assertEqual(second.deleted_at, first.deleted_at)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            state = connection.execute(
                """
                SELECT status,
                       (SELECT count(*) FROM public.message_source_ref
                        WHERE owner_id = %s AND contact_id = %s
                          AND source_document_id = %s)
                FROM public.source_document
                WHERE id = %s
                """,
                (
                    self.owner_id,
                    self.contact_id,
                    imported.source_document_id,
                    imported.source_document_id,
                ),
            ).fetchone()
        self.assertEqual(state, ("deleted", 0))

    def test_deleted_file_is_reimported_as_a_new_source(self) -> None:
        confirmation = ImportConfirmationRequest(
            selection=ExistingContactSelection(contact_id=self.contact_id)
        )
        first = self.ingest_repository.import_document(
            owner_id=self.owner_id,
            document=self.batch,
            confirmation=confirmation,
        )
        self.deletion_repository.delete_source(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            source_document_id=first.source_document_id,
        )

        second = self.ingest_repository.import_document(
            owner_id=self.owner_id,
            document=self.batch,
            confirmation=confirmation,
        )

        self.assertEqual(second.outcome, "imported")
        self.assertNotEqual(first.source_document_id, second.source_document_id)
        self.assertNotEqual(first.confirmation_id, second.confirmation_id)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            sources = connection.execute(
                """
                SELECT id, status
                FROM public.source_document
                WHERE owner_id = %s AND contact_id = %s
                ORDER BY imported_at, id
                """,
                (self.owner_id, self.contact_id),
            ).fetchall()
            message_count = connection.execute(
                """
                SELECT count(*)
                FROM public.message_source_ref
                WHERE owner_id = %s AND contact_id = %s
                  AND source_document_id = %s
                """,
                (
                    self.owner_id,
                    self.contact_id,
                    second.source_document_id,
                ),
            ).fetchone()[0]

        self.assertEqual(set(sources), {
            (first.source_document_id, "deleted"),
            (second.source_document_id, "active"),
        })
        self.assertEqual(message_count, 6)

    def test_wrong_contact_cannot_delete_source(self) -> None:
        imported = self.ingest_repository.import_document(
            owner_id=self.owner_id,
            document=self.batch,
            confirmation=ImportConfirmationRequest(
                selection=ExistingContactSelection(contact_id=self.contact_id)
            ),
        )

        with self.assertRaises(SourceNotFoundError):
            self.deletion_repository.delete_source(
                owner_id=self.owner_id,
                contact_id=uuid4(),
                source_document_id=imported.source_document_id,
            )

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            state = connection.execute(
                """
                SELECT status,
                       (SELECT count(*) FROM public.message_source_ref
                        WHERE owner_id = %s AND contact_id = %s
                          AND source_document_id = %s)
                FROM public.source_document
                WHERE id = %s
                """,
                (
                    self.owner_id,
                    self.contact_id,
                    imported.source_document_id,
                    imported.source_document_id,
                ),
            ).fetchone()
        self.assertEqual(state, ("active", 6))


if __name__ == "__main__":
    unittest.main()
