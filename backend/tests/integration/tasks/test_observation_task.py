"""观察记忆任务的 PostgreSQL 状态与 Worker 接缝测试。"""

from __future__ import annotations

import os
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import psycopg

from notalone.persistence.background_tasks import (
    BackgroundTaskLeaseError,
    BackgroundTaskNotFoundError,
    BackgroundTaskStateError,
    PostgresBackgroundTaskRepository,
)
from notalone.application.task_service import TaskService
from notalone.ingest.models import NormalizedMessage, WechatMessageMetadata
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.observation_store import ObservationMode, PostgresObservationStore
from notalone.persistence.watermark_store import PostgresWatermarkStore
from notalone.persistence.conversation_repository import (
    PostgresConversationBindingRepository,
)
from notalone.memory_extraction.command import ExtractionRunStats
from notalone.persistence.contact_memory_index import (
    PostgresContactMemoryIndexRepository,
)
from notalone.scopes import ContactScope
from notalone.tasks.worker import (
    BackgroundTaskWorker, PostgresMemoryExtractionRunner, WorkerRunOutcome,
)
from notalone.tasks.models import (
    BackgroundTaskStatus, BackgroundTaskType, OBSERVATION_TASK_STEPS,
    ClaimedBackgroundTaskStep,
)
from tests.unit.memory_extraction.verification_helpers import SyntheticSupportingVerifier


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
                      AND column_name = 'observation_pending'
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
        self.bindings = PostgresConversationBindingRepository(TEST_DATABASE_URL)
        self.binding = self.bindings.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator=f"wxid_observation_task_{self.contact_id}",
        )
        self.repository = PostgresBackgroundTaskRepository(TEST_DATABASE_URL)

    def _create_task(self) -> UUID:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            return self.repository.create_observation_task(
                connection, owner_id=self.owner_id, contact_id=self.contact_id,
            )

    def _claim(
        self, task_id: UUID, *, worker_id: UUID | None = None,
    ) -> ClaimedBackgroundTaskStep:
        claim = self.repository.claim_next_step(
            owner_id=self.owner_id, contact_id=self.contact_id, task_id=task_id,
            worker_id=worker_id or uuid4(), lease_duration=timedelta(seconds=30),
            supported_steps=tuple(name for name, _ in OBSERVATION_TASK_STEPS),
        )
        self.assertIsNotNone(claim)
        assert claim is not None
        return claim

    def _revoke_binding(self) -> None:
        self.bindings.revoke_binding(
            owner_id=self.owner_id, contact_id=self.contact_id,
            binding_id=self.binding.binding_id,
        )

    def test_real_runner_uses_observation_watermark_and_source_deletion(self) -> None:
        scope = ContactScope(self.owner_id, self.contact_id)
        locator = f"wxid_observation_task_{self.contact_id}"
        observations = PostgresObservationStore(TEST_DATABASE_URL)
        batch = observations.record_batch_with_messages(
            owner_id=self.owner_id, contact_id=self.contact_id,
            binding_id=self.binding.binding_id, mode=ObservationMode.LIVE,
            cli_version="synthetic-test", conversation_locator=locator,
            last_local_id=10, last_cursor="cursor-10", record_count=1,
            messages=(NormalizedMessage(
                source_locator="cli:10", speaker="contact", message_type="text",
                text_content="我喜欢看科幻小说", media_placeholder=None,
                occurred_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
                wechat_metadata=WechatMessageMetadata(
                    external_local_id=10, external_server_id="synthetic-10",
                    external_talker=locator, source_create_time=1790812800,
                    raw_payload_json='{"text":"我喜欢看科幻小说"}',
                ),
            ),),
        )
        seen = []

        class SyntheticModel:
            def extract(self, window):
                seen.extend(message.message_id for message in window.messages)
                return ({
                    "text": "联系人喜欢看科幻小说", "category": "preference",
                    "subject": "contact", "topic": "other",
                    "source_message_ids": [str(window.messages[0].message_id)],
                    "confidence": 0.9, "risk_flags": [],
                    "valid_at": None, "invalid_at": None,
                    "speech_act": "assertion", "assertion_status": "asserted",
                    "figurative_type": "literal", "alternatives": [],
                    "interpretation_reason": "合成消息明确表达阅读偏好。",
                },)

        worker = BackgroundTaskWorker(
            repository=self.repository,
            extraction_runner=PostgresMemoryExtractionRunner(
                TEST_DATABASE_URL, runtime=SyntheticModel(),
                verification_runtime=SyntheticSupportingVerifier(),
                model_name="synthetic-observation-model",
            ),
            index_repository=PostgresContactMemoryIndexRepository(TEST_DATABASE_URL),
        )
        task_id = self._create_task()
        args = dict(owner_id=self.owner_id, contact_id=self.contact_id,
                    task_id=task_id, worker_id=uuid4())
        for _ in range(3):
            self.assertEqual(worker.run_once(**args).outcome, WorkerRunOutcome.SUCCEEDED)
        self.assertEqual(seen, list(batch.message_ids))
        memories = PostgresMemoryStore(TEST_DATABASE_URL)
        self.assertEqual(len(memories.list_pending_candidates(scope)), 1)
        self.assertEqual(memories.list_confirmed(scope), ())
        self.assertEqual(PostgresWatermarkStore(TEST_DATABASE_URL).get(scope),
                         batch.message_ids[0])

        # 重排同一联系人仍沿用水位；不把已有消息重复送给模型。
        self.assertEqual(self._create_task(), task_id)
        for _ in range(3):
            self.assertEqual(worker.run_once(**args).outcome, WorkerRunOutcome.SUCCEEDED)
        self.assertEqual(seen, list(batch.message_ids))

        observations.delete_observation(
            owner_id=self.owner_id, contact_id=self.contact_id,
            observation_id=batch.observation.observation_id,
        )
        self.assertEqual(memories.list_pending_candidates(scope), ())
        self.assertEqual(self._create_task(), task_id)
        for _ in range(3):
            self.assertEqual(worker.run_once(**args).outcome, WorkerRunOutcome.SUCCEEDED)
        self.assertEqual(seen, list(batch.message_ids))
        self.assertEqual(memories.list_pending_candidates(scope), ())

    def test_concurrent_creation_reuses_one_task_and_running_lease(self) -> None:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first, second = tuple(pool.map(lambda _: self._create_task(), range(2)))
        self.assertEqual(first, second)
        claim = self._claim(first)
        self.assertEqual(self._create_task(), first)
        self.repository.check_step_lease(claim)
        task = self.repository.get_task(
            owner_id=self.owner_id, contact_id=self.contact_id, task_id=first,
        )
        self.assertEqual(task.steps[0].worker_id, claim.worker_id)
        self.assertEqual(task.steps[0].lease_expires_at, claim.lease_expires_at)
        self.assertIsNone(self.repository.claim_next_step(
            owner_id=self.owner_id, contact_id=self.contact_id, task_id=first,
            worker_id=uuid4(), lease_duration=timedelta(seconds=30),
        ))

    def test_failed_observation_recovery_preserves_success_and_rejects_revocation(self) -> None:
        task_id = self._create_task()
        self.repository.complete_step(self._claim(task_id), processed_count=1)
        self.repository.fail_step(
            self._claim(task_id), error_code="index_unavailable", retryable=False,
        )
        service = TaskService(repository=self.repository)
        scope = dict(owner_id=self.owner_id, contact_id=self.contact_id, task_id=task_id)
        self.assertEqual(service.retry(**scope)["status"], "queued")
        status = service.status(**scope)
        self.assertEqual(status["steps"][0]["status"], "succeeded")
        self.assertEqual(status["steps"][1]["attempt_count"], 0)
        recovered = self._claim(task_id)
        self.assertEqual(recovered.name.value, "index")
        self.repository.fail_step(recovered, error_code="index_unavailable", retryable=False)
        self._revoke_binding()
        with self.assertRaises(BackgroundTaskStateError):
            service.retry(**scope)
        self.assertEqual(service.status(**scope)["status"], "failed")
        with self.assertRaises(BackgroundTaskStateError):
            self._create_task()

    def test_revocation_rejects_running_result_and_renewal(self) -> None:
        claim = self._claim(self._create_task())
        self._revoke_binding()
        with self.assertRaises(BackgroundTaskNotFoundError):
            self.repository.complete_step(claim, processed_count=1)
        with self.assertRaises(BackgroundTaskNotFoundError):
            self.repository.renew_step_lease(claim, lease_duration=timedelta(seconds=30))

    def test_expired_claim_cannot_write_after_same_worker_takes_over(self) -> None:
        task_id = self._create_task()
        worker_id = uuid4()
        scope = dict(owner_id=self.owner_id, contact_id=self.contact_id, task_id=task_id)
        old = self.repository.claim_next_step(
            **scope, worker_id=worker_id, lease_duration=timedelta(milliseconds=50),
        )
        self.assertIsNotNone(old)
        while datetime.now(timezone.utc) <= old.lease_expires_at:
            time.sleep(0.01)
        current = self._claim(task_id, worker_id=worker_id)
        self.assertEqual(current.attempt_count, 2)
        with self.assertRaises(BackgroundTaskLeaseError):
            self.repository.renew_step_lease(old, lease_duration=timedelta(seconds=30))
        with self.assertRaises(BackgroundTaskLeaseError):
            self.repository.fail_step(old, error_code="late_failure", retryable=False)
        self.repository.renew_step_lease(current, lease_duration=timedelta(seconds=30))
        self.repository.complete_step(current, processed_count=1)

    def test_contact_deletion_and_foreign_scope_cannot_recover_task(self) -> None:
        task_id = self._create_task()
        scope = dict(owner_id=self.owner_id, contact_id=self.contact_id, task_id=task_id)
        service = TaskService(repository=self.repository)
        for foreign in ({**scope, "owner_id": uuid4()}, {**scope, "contact_id": uuid4()}):
            with self.assertRaises(BackgroundTaskNotFoundError):
                service.status(**foreign)
            with self.assertRaises(BackgroundTaskNotFoundError):
                service.retry(**foreign)
        claim = self._claim(task_id)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.contact WHERE owner_id = %s AND id = %s",
                (self.owner_id, self.contact_id),
            )
        with self.assertRaises(BackgroundTaskNotFoundError):
            self.repository.complete_step(claim, processed_count=1)
        with self.assertRaises(BackgroundTaskStateError):
            self._create_task()

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

    def test_queued_observation_exposes_configuration_failure(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            task_id = self.repository.create_observation_task(
                connection, owner_id=self.owner_id, contact_id=self.contact_id,
            )
        service = TaskService(repository=self.repository)
        scope = dict(owner_id=self.owner_id, contact_id=self.contact_id, task_id=task_id)
        service.defer(**scope, error_code="model_configuration_unavailable")
        status = service.status(**scope)
        self.assertEqual(status["error_code"], "model_configuration_unavailable")
        self.assertEqual(status["status"], "queued")
        self.assertEqual(status["retry_count"], 0)

    def test_previous_round_claim_cannot_complete_new_round_for_same_worker(self) -> None:
        scope = dict(owner_id=self.owner_id, contact_id=self.contact_id)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            task_id = self.repository.create_observation_task(connection, **scope)
        worker_id = uuid4()
        claims = []
        for _ in range(3):
            claim = self.repository.claim_next_step(
                **scope, worker_id=worker_id, task_id=task_id,
                lease_duration=timedelta(seconds=30),
                supported_steps=tuple(name for name, _ in OBSERVATION_TASK_STEPS),
            )
            self.assertIsNotNone(claim)
            claims.append(claim)
            self.repository.complete_step(claim, processed_count=0)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            self.repository.create_observation_task(connection, **scope)
        current = self.repository.claim_next_step(
            **scope, worker_id=worker_id, task_id=task_id,
            lease_duration=timedelta(seconds=30),
        )
        self.assertIsNotNone(current)
        with self.assertRaises(BackgroundTaskLeaseError):
            self.repository.complete_step(claims[0], processed_count=100)
        self.repository.check_step_lease(current)

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
        repository = self.repository

        class ScriptedRunner:
            model_version = "synthetic-observation-model"

            def run(self, *, scope: ContactScope) -> ExtractionRunStats:
                with psycopg.connect(TEST_DATABASE_URL) as connection:
                    repository.create_observation_task(
                        connection, owner_id=scope.owner_id, contact_id=scope.contact_id,
                    )
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
