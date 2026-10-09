"""观察记忆任务的 PostgreSQL 状态与 Worker 接缝测试。"""

from __future__ import annotations

import os
import unittest
from datetime import timedelta
from uuid import uuid4

import psycopg

from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.persistence.conversation_repository import (
    PostgresConversationBindingRepository,
)
from notalone.memory_extraction.command import ExtractionRunStats
from notalone.persistence.contact_memory_index import (
    PostgresContactMemoryIndexRepository,
)
from notalone.scopes import ContactScope
from notalone.tasks.worker import BackgroundTaskWorker, WorkerRunOutcome
from notalone.tasks.models import BackgroundTaskStatus, BackgroundTaskType


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL", "postgresql:///notalone_test"
)


class ObservationTaskPersistenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
                has_task_source_column = connection.execute(
                    """
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'background_task'
                      AND column_name = 'source_document_id'
                    """
                ).fetchone()
        except psycopg.OperationalError as error:
            raise unittest.SkipTest("本地 PostgreSQL 测试库不可用。") from error
        if not database_name.endswith("_test"):
            raise RuntimeError("集成测试只允许连接名称以 _test 结尾的数据库。")
        if has_task_source_column is None:
            raise unittest.SkipTest("测试库尚未应用观察任务迁移。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "观察任务用户"),
            )
            connection.execute(
                """
                INSERT INTO public.contact (owner_id, id, display_name)
                VALUES (%s, %s, %s)
                """,
                (self.owner_id, self.contact_id, "观察任务联系人"),
            )
        PostgresConversationBindingRepository(TEST_DATABASE_URL).create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator=f"wxid_observation_task_{self.contact_id}",
        )
        self.repository = PostgresBackgroundTaskRepository(TEST_DATABASE_URL)

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s", (self.owner_id,)
            )

    def test_observation_task_is_contact_scoped_and_idempotent(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            first_id = self.repository.create_observation_task(
                connection,
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                message_count=4,
            )
            second_id = self.repository.create_observation_task(
                connection,
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                message_count=2,
            )

        self.assertEqual(first_id, second_id)
        task = self.repository.get_task(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            task_id=first_id,
        )
        self.assertEqual(task.task_type, BackgroundTaskType.OBSERVATION)
        self.assertIsNone(task.source_document_id)
        self.assertEqual(task.status, BackgroundTaskStatus.QUEUED)
        self.assertEqual(tuple(step.name.value for step in task.steps), (
            "extract_memory", "index", "verify",
        ))
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            self.assertFalse(connection.execute(
                "SELECT observation_pending FROM public.background_task WHERE id = %s",
                (first_id,),
            ).fetchone()[0])

    def test_observation_task_can_be_claimed_without_source_document(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            task_id = self.repository.create_observation_task(
                connection,
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                message_count=0,
            )
        claim = self.repository.claim_next_step(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=uuid4(),
            task_id=task_id,
            lease_duration=timedelta(seconds=30),
        )
        self.assertIsNotNone(claim)
        assert claim is not None
        self.assertEqual(claim.task_id, task_id)
        self.assertIsNone(claim.source_document_id)

    def test_terminal_observation_task_is_requeued_for_new_observation(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            task_id = self.repository.create_observation_task(
                connection,
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                message_count=3,
            )
            connection.execute(
                """
                UPDATE public.background_task
                SET status = 'succeeded', finished_at = now()
                WHERE id = %s
                """,
                (task_id,),
            )
            connection.execute(
                """
                UPDATE public.background_task_step
                SET status = 'succeeded', attempt_count = 1
                WHERE task_id = %s
                """,
                (task_id,),
            )
            requeued_id = self.repository.create_observation_task(
                connection,
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                message_count=5,
            )
        self.assertEqual(task_id, requeued_id)
        task = self.repository.get_task(
            owner_id=self.owner_id, contact_id=self.contact_id, task_id=task_id
        )
        self.assertEqual(task.status, BackgroundTaskStatus.QUEUED)
        self.assertEqual(tuple(step.status.value for step in task.steps), (
            "pending", "pending", "pending",
        ))

    def test_revoked_binding_cannot_claim_observation_task(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            task_id = self.repository.create_observation_task(
                connection,
                owner_id=self.owner_id,
                contact_id=self.contact_id,
            )
            connection.execute(
                """
                UPDATE public.conversation_binding
                SET status = 'revoked', revoked_at = now()
                WHERE owner_id = %s AND contact_id = %s
                """,
                (self.owner_id, self.contact_id),
            )
        claim = self.repository.claim_next_step(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=uuid4(),
            task_id=task_id,
            lease_duration=timedelta(seconds=30),
        )
        self.assertIsNone(claim)

    def test_worker_reuses_extraction_index_and_verify_for_observation(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            task_id = self.repository.create_observation_task(
                connection,
                owner_id=self.owner_id,
                contact_id=self.contact_id,
            )

        class ScriptedRunner:
            model_version = "synthetic-observation-model"

            def __init__(self) -> None:
                self.scopes: list[ContactScope] = []

            def run(self, *, scope: ContactScope) -> ExtractionRunStats:
                self.scopes.append(scope)
                return ExtractionRunStats(batches=1, processed_messages=2)

        runner = ScriptedRunner()
        worker = BackgroundTaskWorker(
            repository=self.repository,
            extraction_runner=runner,
            index_repository=PostgresContactMemoryIndexRepository(TEST_DATABASE_URL),
        )
        worker_id = uuid4()
        self.assertEqual(
            worker.run_once(
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                worker_id=worker_id,
                task_id=task_id,
            ).outcome,
            WorkerRunOutcome.SUCCEEDED,
        )
        self.assertEqual(len(runner.scopes), 1)
        self.assertEqual(
            worker.run_once(
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                worker_id=worker_id,
                task_id=task_id,
            ).outcome,
            WorkerRunOutcome.SUCCEEDED,
        )
        self.assertEqual(
            worker.run_once(
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                worker_id=worker_id,
                task_id=task_id,
            ).outcome,
            WorkerRunOutcome.SUCCEEDED,
        )
        task = self.repository.get_task(
            owner_id=self.owner_id, contact_id=self.contact_id, task_id=task_id
        )
        self.assertEqual(task.status, BackgroundTaskStatus.SUCCEEDED)

    def test_new_observation_during_run_is_requeued_after_verify(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            task_id = self.repository.create_observation_task(
                connection,
                owner_id=self.owner_id,
                contact_id=self.contact_id,
            )
            # 模拟 Worker 已经领取后，新一批可靠观察在同一联系人到达。
            connection.execute(
                """
                UPDATE public.background_task
                SET status = 'running', observation_pending = true
                WHERE id = %s
                """,
                (task_id,),
            )

        class ScriptedRunner:
            model_version = "synthetic-observation-model"

            def run(self, *, scope: ContactScope) -> ExtractionRunStats:
                return ExtractionRunStats(batches=1, processed_messages=1)

        worker = BackgroundTaskWorker(
            repository=self.repository,
            extraction_runner=ScriptedRunner(),
            index_repository=PostgresContactMemoryIndexRepository(TEST_DATABASE_URL),
        )
        for _ in range(3):
            result = worker.run_once(
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                worker_id=uuid4(),
                task_id=task_id,
            )
            self.assertEqual(result.outcome, WorkerRunOutcome.SUCCEEDED)
        task = self.repository.get_task(
            owner_id=self.owner_id, contact_id=self.contact_id, task_id=task_id
        )
        self.assertEqual(task.status, BackgroundTaskStatus.QUEUED)
        self.assertEqual(tuple(step.status.value for step in task.steps), (
            "pending", "pending", "pending",
        ))


if __name__ == "__main__":
    unittest.main()
