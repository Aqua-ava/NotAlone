"""后台 Worker 启动命令的编排行为测试。"""

from __future__ import annotations

import contextlib
import io
import os
import unittest
from dataclasses import replace
from unittest.mock import patch
from uuid import uuid4

import psycopg
from langchain_core.messages import AIMessage

from notalone.ledger.adapters import InMemoryOutboundLedger
from notalone.ledger.models import LedgerOutcome
from notalone.memory.adapters import InMemoryMemoryStore
from notalone.scopes import ContactScope
from notalone.tasks.command import (
    WorkerCommandStatus,
    run_worker,
    worker_main,
)
from notalone.tasks.models import BackgroundTaskStepName, IMPORT_TASK_STEPS
from notalone.tasks.worker import (
    PostgresMemoryExtractionRunner,
    WorkerRunOutcome,
    WorkerRunResult,
    _failure_info,
)
from tests.unit.memory_extraction.test_command import (
    RecordingOwnerPort,
    RecordingWatermark,
    _messages,
    _payload,
)
from tests.unit.memory_extraction.verification_helpers import verification_result
from tests.unit.reply.test_langchain_vertical_slice import ToolCallingFakeModel


class FakeWorker:
    def __init__(self, results: list[WorkerRunResult]) -> None:
        self.results = results
        self.calls = 0

    def run_once(self, **kwargs: object) -> WorkerRunResult:
        self.calls += 1
        if not self.results:
            return WorkerRunResult(outcome=WorkerRunOutcome.IDLE)
        return self.results.pop(0)


class WorkerCommandTest(unittest.TestCase):
    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        self.worker_id = uuid4()
        self.task_id = uuid4()
        self.claim_kwargs = {
            "owner_id": self.owner_id,
            "contact_id": self.contact_id,
            "worker_id": self.worker_id,
        }

    def test_busy_global_lock_does_not_claim_a_step(self) -> None:
        worker = FakeWorker([])

        with patch(
            "notalone.tasks.command.try_acquire_global_worker_lock",
            return_value=False,
        ):
            result = run_worker(
                worker=worker,
                lock_connection=object(),
                **self.claim_kwargs,
            )

        self.assertEqual(result.status, WorkerCommandStatus.BUSY)
        self.assertEqual(worker.calls, 0)

    def test_success_runs_one_task_serially_through_verify(self) -> None:
        worker = FakeWorker(
            [
                WorkerRunResult(
                    outcome=WorkerRunOutcome.SUCCEEDED,
                    task_id=self.task_id,
                    step_name=step,
                    processed_count=1,
                )
                for step, _ in IMPORT_TASK_STEPS
            ]
        )
        sleeps: list[float] = []

        with patch(
            "notalone.tasks.command.try_acquire_global_worker_lock",
            return_value=True,
        ), patch(
            "notalone.tasks.command.release_global_worker_lock"
        ) as release:
            result = run_worker(
                worker=worker,
                lock_connection=object(),
                sleep=sleeps.append,
                **self.claim_kwargs,
            )

        self.assertEqual(result.status, WorkerCommandStatus.SUCCEEDED)
        self.assertEqual(worker.calls, len(IMPORT_TASK_STEPS))
        self.assertEqual(result.last_step, BackgroundTaskStepName.VERIFY)
        self.assertEqual(result.processed_count, 1)
        self.assertEqual(sleeps, [])
        release.assert_called_once()

    def test_retryable_step_is_retried_with_backoff(self) -> None:
        worker = FakeWorker(
            [
                WorkerRunResult(
                    outcome=WorkerRunOutcome.SUCCEEDED,
                    task_id=self.task_id,
                    step_name=BackgroundTaskStepName.PARSE,
                ),
                WorkerRunResult(
                    outcome=WorkerRunOutcome.SUCCEEDED,
                    task_id=self.task_id,
                    step_name=BackgroundTaskStepName.NORMALIZE,
                ),
                WorkerRunResult(
                    outcome=WorkerRunOutcome.RETRYABLE,
                    task_id=self.task_id,
                    step_name=BackgroundTaskStepName.EXTRACT_MEMORY,
                    attempt_count=1,
                ),
                WorkerRunResult(
                    outcome=WorkerRunOutcome.SUCCEEDED,
                    task_id=self.task_id,
                    step_name=BackgroundTaskStepName.EXTRACT_MEMORY,
                ),
                WorkerRunResult(
                    outcome=WorkerRunOutcome.SUCCEEDED,
                    task_id=self.task_id,
                    step_name=BackgroundTaskStepName.INDEX,
                ),
                WorkerRunResult(
                    outcome=WorkerRunOutcome.SUCCEEDED,
                    task_id=self.task_id,
                    step_name=BackgroundTaskStepName.VERIFY,
                ),
            ]
        )
        sleeps: list[float] = []

        with patch(
            "notalone.tasks.command.try_acquire_global_worker_lock",
            return_value=True,
        ), patch("notalone.tasks.command.release_global_worker_lock"):
            result = run_worker(
                worker=worker,
                lock_connection=object(),
                sleep=sleeps.append,
                **self.claim_kwargs,
            )

        self.assertEqual(result.status, WorkerCommandStatus.SUCCEEDED)
        self.assertEqual(sleeps, [1.0])
        self.assertEqual(result.retry_count, 1)
        self.assertEqual(result.last_step, BackgroundTaskStepName.VERIFY)

    def test_permanent_failure_returns_failed_without_retry(self) -> None:
        worker = FakeWorker(
            [
                WorkerRunResult(
                    outcome=WorkerRunOutcome.FAILED,
                    task_id=self.task_id,
                    step_name=BackgroundTaskStepName.EXTRACT_MEMORY,
                    error_code="worker_step_failed",
                )
            ]
        )
        sleeps: list[float] = []

        with patch(
            "notalone.tasks.command.try_acquire_global_worker_lock",
            return_value=True,
        ), patch("notalone.tasks.command.release_global_worker_lock"):
            result = run_worker(
                worker=worker,
                lock_connection=object(),
                sleep=sleeps.append,
                **self.claim_kwargs,
            )

        self.assertEqual(result.status, WorkerCommandStatus.FAILED)
        self.assertEqual(result.error_code, "worker_step_failed")
        self.assertEqual(result.last_step, BackgroundTaskStepName.EXTRACT_MEMORY)
        self.assertEqual(worker.calls, 1)
        self.assertEqual(sleeps, [])

    def test_no_pending_task_returns_idle(self) -> None:
        worker = FakeWorker([])

        with patch(
            "notalone.tasks.command.try_acquire_global_worker_lock",
            return_value=True,
        ), patch("notalone.tasks.command.release_global_worker_lock"):
            result = run_worker(
                worker=worker,
                lock_connection=object(),
                **self.claim_kwargs,
            )

        self.assertEqual(result.status, WorkerCommandStatus.IDLE)

    def test_missing_database_configuration_fails_before_worker_setup(self) -> None:
        stderr = io.StringIO()
        with patch.dict(
            os.environ,
            {
                "NOTALONE_DISABLE_DOTENV": "1",
            },
            clear=True,
        ), contextlib.redirect_stderr(stderr):
            exit_code = worker_main(["--contact-id", str(self.contact_id)])

        self.assertEqual(exit_code, 2)
        self.assertIn("NOTALONE_DATABASE_URL", stderr.getvalue())
        self.assertNotIn(str(self.contact_id), stderr.getvalue())


class FailureInfoTest(unittest.TestCase):
    """失败分类必须把连接类数据库故障判为可重试。"""

    def test_psycopg_operational_error_is_retryable(self) -> None:
        # psycopg 3 的 OperationalError 不是内建 ConnectionError 子类；
        # load_contact_messages 等裸连接路径的瞬断必须重试，不能把
        # 任务永久置为 FAILED。
        error_code, retryable = _failure_info(
            psycopg.OperationalError("connection refused")
        )

        self.assertEqual(error_code, "temporary_failure")
        self.assertTrue(retryable)


class PostgresMemoryExtractionRunnerTest(unittest.TestCase):
    """用合成模型和存储边界验证 Worker 的默认生产装配。"""

    def test_default_runner_verification_rejects_unsupported_claim(self) -> None:
        scope = ContactScope(uuid4(), uuid4())
        message = replace(_messages(1)[0], text="我不喝酒")
        payload = {**_payload(message.message_id), "text": "他喜欢喝酒"}
        model = ToolCallingFakeModel(responses=[
            AIMessage(content="", tool_calls=[{
                "name": "MemoryExtractionOutput", "id": "extract-1",
                "args": {"facts": [payload]},
            }]),
            AIMessage(content="", tool_calls=[{
                "name": "SourceVerificationOutput", "id": "verify-1",
                "args": {"results": [verification_result(
                    verdict="unsupported", issues=("negation",),
                    evidence=((message.message_id, "不喝酒"),),
                )]},
            }]),
        ])
        store = InMemoryMemoryStore()
        ledger = InMemoryOutboundLedger()
        watermark = RecordingWatermark()
        with patch(
            "notalone.memory_extraction.cli_support.build_deepseek_model",
            return_value=model,
        ), patch(
            "notalone.memory_extraction.cli_support.load_contact_messages",
            return_value=(message,),
        ):
            runner = PostgresMemoryExtractionRunner(
                "postgresql:///synthetic_unused_test",
                memory_port=store,
                owner_memory_port=RecordingOwnerPort(),
                ledger=ledger,
                watermark_port=watermark,
            )
            stats = runner.run(scope=scope)

        self.assertEqual(stats.failed_batches, 0)
        self.assertEqual(stats.rejected_by_contract, 1)
        self.assertEqual(stats.pending, 0)
        self.assertEqual(store.list_confirmed(scope), ())
        self.assertEqual(store.list_pending_candidates(scope), ())
        self.assertEqual(watermark.values, [message.message_id])
        self.assertEqual(runner.model_version, "fake-chat-model")
        self.assertEqual(
            [entry.outcome for entry in ledger.list_by_owner(scope.owner_id)],
            [LedgerOutcome.SUCCEEDED, LedgerOutcome.SUCCEEDED],
        )


if __name__ == "__main__":
    unittest.main()
