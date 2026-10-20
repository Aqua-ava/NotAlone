"""后台 Worker 的合成 PostgreSQL 生命周期测试。"""

from __future__ import annotations

import os
import time
import unittest
from datetime import timedelta
from pathlib import Path
from uuid import UUID, uuid4

import psycopg

from notalone.ingest.jsonl_reader import read_jsonl
from notalone.ingest.models import (
    ExistingContactSelection,
    ImportConfirmationRequest,
)
from notalone.ingest.normalizer import normalize_document
from notalone.memory_extraction.command import ExtractionRunStats
from notalone.memory_extraction.dimensions import RELEASE_ALL_DIMENSIONS
from notalone.persistence.background_tasks import (
    PostgresBackgroundTaskRepository,
)
from notalone.persistence.contact_memory_index import (
    PostgresContactMemoryIndexRepository,
)
from notalone.persistence.locks import (
    release_global_worker_lock,
    try_acquire_global_worker_lock,
)
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.postgres_repository import PostgresIngestRepository
from notalone.scopes import ContactScope
from notalone.tasks.worker import (
    BackgroundTaskWorker,
    PostgresMemoryExtractionRunner,
    WorkerRunOutcome,
)
from tests.unit.memory_extraction.verification_helpers import (
    SyntheticSupportingVerifier,
)


FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"
TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class ScriptedExtractionRunner:
    """不调用模型的提取执行替身。"""

    def __init__(self, outcomes: list[ExtractionRunStats]) -> None:
        self.outcomes = outcomes
        self.calls: list[ContactScope] = []

    def run(self, *, scope: ContactScope, **task_context: object) -> ExtractionRunStats:
        self.calls.append(scope)
        if not self.outcomes:
            raise AssertionError("没有预置 Worker 提取结果。")
        return self.outcomes.pop(0)


class FakeExtractionRuntime:
    """返回一条当前窗口内有证据的结构化候选。"""

    def extract(self, window: object) -> tuple[dict, ...]:
        message_id = window.messages[0].message_id
        return (
            {
                "text": "联系人下周去上海出差",
                "category": "recent_state",
                "subject": "contact",
                "topic": "work",
                "source_message_ids": [str(message_id)],
                "confidence": 0.9,
                "risk_flags": [],
                "valid_at": None,
                "invalid_at": None,
                "speech_act": "assertion",
                "assertion_status": "asserted",
                "figurative_type": "literal",
                "alternatives": [],
                "interpretation_reason": "消息明确描述了联系人的近期安排。",
            },
            {
                "text": "联系人可能喜欢早起",
                "category": "preference",
                "subject": "contact",
                "topic": "other",
                "source_message_ids": [str(message_id)],
                "confidence": 0.3,
                "risk_flags": [],
                "valid_at": None,
                "invalid_at": None,
                "speech_act": "assertion",
                "assertion_status": "hypothetical",
                "figurative_type": "literal",
                "alternatives": [],
                "interpretation_reason": "消息使用了可能，不能视为确定事实。",
            },
            {
                "text": "越界证据必须拒绝",
                "category": "preference",
                "subject": "contact",
                "topic": "other",
                "source_message_ids": [str(uuid4())],
                "confidence": 0.9,
                "risk_flags": [],
                "valid_at": None,
                "invalid_at": None,
                "speech_act": "assertion",
                "assertion_status": "asserted",
                "figurative_type": "literal",
                "alternatives": [],
                "interpretation_reason": "证据 ID 不在当前窗口。",
            },
            {
                "text": "结构错误必须拒绝",
                "category": "not-a-category",
                "subject": "contact",
                "topic": "other",
                "source_message_ids": [str(message_id)],
                "confidence": 0.9,
                "risk_flags": [],
                "valid_at": None,
                "invalid_at": None,
                "speech_act": "assertion",
                "assertion_status": "asserted",
                "figurative_type": "literal",
                "alternatives": [],
                "interpretation_reason": "分类字段非法。",
            },
        )


class PermanentFailureRunner:
    """模拟不可重试的结构错误。"""

    def run(self, *, scope: ContactScope, **task_context: object) -> ExtractionRunStats:  # noqa: ARG002
        raise ValueError("synthetic invalid worker output")


class SlowExtractionRunner:
    """模拟超过租约时长的模型提取。"""

    def run(self, *, scope: ContactScope, **task_context: object) -> ExtractionRunStats:  # noqa: ARG002
        time.sleep(1.2)
        return ExtractionRunStats(batches=1, processed_messages=6)


class BackgroundTaskWorkerTest(unittest.TestCase):
    """只使用合成导入和 fake 提取器。"""

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
        self.worker_repository = PostgresBackgroundTaskRepository(
            TEST_DATABASE_URL
        )
        self.ingest_repository = PostgresIngestRepository(TEST_DATABASE_URL)
        self.batch = normalize_document(
            read_jsonl(FIXTURES_DIR / "valid_single_contact.jsonl")
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "合成 Worker 用户"),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, %s)",
                (self.owner_id, self.contact_id, "合成 Worker 联系人"),
            )
            connection.execute(
                "INSERT INTO public.owner_channel_identity "
                "(owner_id, channel, external_id, observed_name) "
                "VALUES (%s, 'wechat', %s, %s)",
                (self.owner_id, "wxid_synthetic_owner", "合成 Worker 用户"),
            )

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    def _import(self) -> UUID:
        result = self.ingest_repository.import_document(
            owner_id=self.owner_id,
            document=self.batch,
            confirmation=ImportConfirmationRequest(
                selection=ExistingContactSelection(contact_id=self.contact_id)
            ),
        )
        return result.task_id

    def _worker(
        self,
        runner: ScriptedExtractionRunner,
        *,
        lease_duration: timedelta = timedelta(seconds=30),
        index_repository: PostgresContactMemoryIndexRepository | None = None,
    ) -> BackgroundTaskWorker:
        return BackgroundTaskWorker(
            repository=self.worker_repository,
            extraction_runner=runner,
            lease_duration=lease_duration,
            index_repository=index_repository,
        )

    def test_worker_runs_steps_in_order_and_extracts_once(self) -> None:
        task_id = self._import()
        runner = ScriptedExtractionRunner(
            [
                ExtractionRunStats(
                    batches=1,
                    processed_messages=6,
                    extracted=1,
                    adopted=1,
                )
            ]
        )
        worker = self._worker(runner)
        worker_id = uuid4()

        parse = worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )
        normalize = worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )
        extract = worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )

        self.assertEqual(parse.outcome, WorkerRunOutcome.SUCCEEDED)
        self.assertEqual(parse.step_name, "parse")
        self.assertEqual(normalize.step_name, "normalize")
        self.assertEqual(extract.step_name, "extract_memory")
        self.assertEqual(extract.processed_count, 6)
        self.assertEqual(len(runner.calls), 1)
        task = self.worker_repository.get_task(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            task_id=task_id,
        )
        self.assertEqual(
            tuple(step.status.value for step in task.steps[:3]),
            ("succeeded", "succeeded", "succeeded"),
        )
        self.assertEqual(task.steps[3].status.value, "pending")
        self.assertEqual(task.current_step.value, "index")

    def test_active_lease_blocks_second_worker_and_expiry_allows_takeover(self) -> None:
        task_id = self._import()
        first_worker = uuid4()
        second_worker = uuid4()

        first_claim = self.worker_repository.claim_next_step(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=first_worker,
            lease_duration=timedelta(minutes=1),
        )
        self.assertIsNotNone(first_claim)
        blocked = self.worker_repository.claim_next_step(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=second_worker,
            lease_duration=timedelta(minutes=1),
        )
        self.assertIsNone(blocked)

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                """
                UPDATE public.background_task_step
                SET lease_expires_at = now() - interval '1 second'
                WHERE task_id = %s AND step_name = 'parse'
                """,
                (task_id,),
            )
        takeover = self.worker_repository.claim_next_step(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=second_worker,
            lease_duration=timedelta(minutes=1),
        )
        self.assertIsNotNone(takeover)
        assert takeover is not None
        self.assertEqual(takeover.worker_id, second_worker)
        self.assertEqual(takeover.attempt_count, 2)

    def test_global_worker_lock_is_exclusive_across_sessions(self) -> None:
        with (
            psycopg.connect(TEST_DATABASE_URL, autocommit=True) as first,
            psycopg.connect(TEST_DATABASE_URL, autocommit=True) as second,
        ):
            self.assertTrue(try_acquire_global_worker_lock(first))
            self.assertFalse(try_acquire_global_worker_lock(second))
            release_global_worker_lock(first)
            self.assertTrue(try_acquire_global_worker_lock(second))
            release_global_worker_lock(second)

    def test_step_lease_can_be_renewed_before_completion(self) -> None:
        task_id = self._import()
        worker_id = uuid4()
        claim = self.worker_repository.claim_next_step(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
            lease_duration=timedelta(seconds=1),
        )
        self.assertIsNotNone(claim)
        assert claim is not None

        renewed = self.worker_repository.renew_step_lease(
            claim,
            lease_duration=timedelta(minutes=1),
        )

        self.assertGreater(renewed, claim.lease_expires_at)
        self.worker_repository.complete_step(
            claim,
            processed_count=claim.message_count,
            total_count=claim.message_count,
        )

    def test_worker_renews_lease_while_extraction_runs(self) -> None:
        task_id = self._import()
        worker = self._worker(
            SlowExtractionRunner(),
            lease_duration=timedelta(seconds=1),
        )
        worker_id = uuid4()

        worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )
        worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )
        extracted = worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )

        self.assertEqual(extracted.outcome, WorkerRunOutcome.SUCCEEDED)
        self.assertEqual(
            self.worker_repository.get_task(
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                task_id=task_id,
            ).steps[2].status.value,
            "succeeded",
        )

    def test_lease_loss_during_extraction_is_reported_not_raised(self) -> None:
        # 租约在提取中失效（或任务被来源删除取消）时，fail_step 的
        # 租约校验也会失败；这个失败必须折叠成 RETRYABLE 结果返回，
        # 让 worker 循环存活，而不是把异常逃逸到 run_worker 崩溃退出。
        task_id = self._import()

        class LeaseExpiringRunner:
            def run(self, *, scope: ContactScope, **task_context: object) -> ExtractionRunStats:
                del scope
                with psycopg.connect(TEST_DATABASE_URL) as connection:
                    connection.execute(
                        """
                        UPDATE public.background_task_step
                        SET lease_expires_at = now() - interval '1 second'
                        WHERE task_id = %s AND step_name = 'extract_memory'
                        """,
                        (task_id,),
                    )
                raise RuntimeError("提取过程中租约已失效")

        worker = self._worker(LeaseExpiringRunner())  # type: ignore[arg-type]
        worker_id = uuid4()
        worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )
        worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )
        result = worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )

        self.assertEqual(result.step_name, "extract_memory")
        self.assertEqual(result.outcome, WorkerRunOutcome.RETRYABLE)
        self.assertEqual(result.error_code, "temporary_failure")

    def test_postgres_runner_reuses_extraction_and_watermark_boundaries(self) -> None:
        task_id = self._import()
        runner = PostgresMemoryExtractionRunner(
            TEST_DATABASE_URL,
            runtime=FakeExtractionRuntime(),
            verification_runtime=SyntheticSupportingVerifier(),
            model_name="fake-memory-model",
            # 本用例验证 runner 复用的提取与水位边界，显式放行全部维度；
            # 默认收紧（空放行表）由 tests/unit 的 test_adoption 覆盖。
            dimension_release=RELEASE_ALL_DIMENSIONS,
        )
        worker = self._worker(runner)
        worker_id = uuid4()
        worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )
        worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )
        extracted = worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )

        self.assertEqual(extracted.outcome, WorkerRunOutcome.SUCCEEDED)
        self.assertEqual(extracted.processed_count, 5)
        task = self.worker_repository.get_task(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            task_id=task_id,
        )
        self.assertEqual(task.model_version, "fake-memory-model")
        self.assertEqual(task.rule_version, "memory-extraction-v1")
        self.assertEqual(task.retry_count, 0)
        memories = PostgresMemoryStore(TEST_DATABASE_URL).list_confirmed(
            ContactScope(self.owner_id, self.contact_id)
        )
        self.assertEqual(len(memories), 1)
        self.assertEqual(memories[0].adoption_method.value, "auto")
        self.assertEqual(memories[0].text, "联系人下周去上海出差")
        # 默认自动流程终结未通过的候选，不把不确定内容转为人工待办。
        self.assertEqual(
            self._scalar(
                """
                SELECT count(*)
                FROM public.memory_candidate
                WHERE owner_id = %s AND contact_id = %s AND status = 'pending'
                """,
                (self.owner_id, self.contact_id),
            ),
            0,
        )
        watermark = self._scalar(
            """
            SELECT last_message_id
            FROM public.memory_extraction_watermark
            WHERE owner_id = %s AND contact_id = %s
            """,
            (self.owner_id, self.contact_id),
        )
        self.assertIsNotNone(watermark)

    def test_worker_runs_index_and_verify_after_extraction(self) -> None:
        task_id = self._import()
        runner = ScriptedExtractionRunner(
            [ExtractionRunStats(batches=1, processed_messages=5)]
        )
        index_repository = PostgresContactMemoryIndexRepository(
            TEST_DATABASE_URL
        )
        worker = self._worker(
            runner,
            index_repository=index_repository,
        )
        worker_id = uuid4()
        for _ in range(5):
            result = worker.run_once(
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                worker_id=worker_id,
            )

        self.assertEqual(result.step_name.value, "verify")
        self.assertEqual(result.outcome, WorkerRunOutcome.SUCCEEDED)
        task = self.worker_repository.get_task(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            task_id=task_id,
        )
        self.assertEqual(task.status.value, "succeeded")
        self.assertTrue(
            index_repository.get(
                ContactScope(self.owner_id, self.contact_id)
            ).is_current
        )

    def test_three_failures_terminally_fail_and_manual_retry_reuses_task(self) -> None:
        task_id = self._import()
        runner = ScriptedExtractionRunner(
            [
                ExtractionRunStats(
                    batches=1,
                    failed_batches=1,
                ),
                ExtractionRunStats(
                    batches=1,
                    failed_batches=1,
                ),
                ExtractionRunStats(
                    batches=1,
                    failed_batches=1,
                ),
                ExtractionRunStats(
                    batches=1,
                    processed_messages=6,
                ),
            ]
        )
        worker = self._worker(runner)
        worker_id = uuid4()

        worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )
        worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )
        first_failure = worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )
        second_failure = worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )
        third_failure = worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )

        self.assertEqual(first_failure.outcome, WorkerRunOutcome.RETRYABLE)
        self.assertEqual(second_failure.outcome, WorkerRunOutcome.RETRYABLE)
        self.assertEqual(third_failure.outcome, WorkerRunOutcome.FAILED)
        task = self.worker_repository.get_task(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            task_id=task_id,
        )
        self.assertEqual(task.status.value, "failed")
        self.assertEqual(task.steps[2].attempt_count, 3)
        self.assertEqual(task.steps[2].last_error_code, "memory_extraction_failed")

        retried = self.worker_repository.retry_failed_task(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            task_id=task_id,
        )
        self.assertEqual(retried.task_id, task_id)
        resumed = worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=uuid4(),
        )
        self.assertEqual(resumed.outcome, WorkerRunOutcome.SUCCEEDED)
        self.assertEqual(resumed.step_name, "extract_memory")

    def test_permanent_worker_error_does_not_auto_retry(self) -> None:
        task_id = self._import()
        worker = self._worker(PermanentFailureRunner())
        worker_id = uuid4()
        worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )
        worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )
        failed = worker.run_once(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            worker_id=worker_id,
        )
        self.assertEqual(failed.outcome, WorkerRunOutcome.FAILED)
        self.assertEqual(failed.error_code, "worker_step_failed")
        self.assertEqual(
            self.worker_repository.get_task(
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                task_id=task_id,
            ).steps[2].attempt_count,
            1,
        )
        self.assertEqual(
            worker.run_once(
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                worker_id=worker_id,
            ).outcome,
            WorkerRunOutcome.IDLE,
        )

    @staticmethod
    def _scalar(query: str, parameters: tuple[object, ...]) -> object:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            return connection.execute(query, parameters).fetchone()[0]


if __name__ == "__main__":
    unittest.main()
