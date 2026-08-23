"""后台任务 Worker：领取一个步骤并执行确定性状态迁移。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from enum import StrEnum
from typing import Protocol
from uuid import UUID

from notalone.ledger.ports import OutboundLedgerPort
from notalone.memory.ports import MemoryPort, OwnerMemoryPort
from notalone.memory_extraction.adjudication import AdjudicationRuntime
from notalone.memory_extraction.adjudication_adapters import (
    LangChainAdjudicationRuntime,
)
from notalone.memory_extraction.command import (
    EXTRACTION_BATCH_SIZE,
    ExtractionRunStats,
    run_extraction,
)
from notalone.memory_extraction.errors import (
    ExtractionRuntimeError,
    MemoryExtractionError,
)
from notalone.memory_extraction.runtime import MemoryExtractionRuntime
from notalone.persistence.background_tasks import (
    PostgresBackgroundTaskRepository,
)
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.outbound_ledger import PostgresOutboundLedger
from notalone.persistence.watermark_store import PostgresWatermarkStore
from notalone.scopes import ContactScope
from notalone.tasks.models import (
    BackgroundTaskStepName,
    BackgroundTaskStepStatus,
    ClaimedBackgroundTaskStep,
)


class ExtractionTaskRunner(Protocol):
    """Worker 调用的记忆提取执行 seam。"""

    def run(self, *, scope: ContactScope) -> ExtractionRunStats: ...


class WorkerRunOutcome(StrEnum):
    """一次 Worker 调用的非正文结果。"""

    IDLE = "idle"
    SUCCEEDED = "succeeded"
    RETRYABLE = "retryable"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class WorkerRunResult:
    """一次 Worker 调用返回的状态、步骤和计数。"""

    outcome: WorkerRunOutcome
    task_id: UUID | None = None
    step_name: BackgroundTaskStepName | None = None
    processed_count: int = 0
    attempt_count: int = 0
    error_code: str | None = None


class PostgresMemoryExtractionRunner:
    """复用既有提取、采纳、台账和水位 port 的 PostgreSQL 执行器。"""

    __slots__ = (
        "_adjudication_runtime",
        "_batch_size",
        "_database_url",
        "_ledger",
        "_memory_port",
        "_model_name",
        "_owner_memory_port",
        "_provider",
        "_runtime",
        "_watermark_port",
    )

    def __init__(
        self,
        database_url: str,
        *,
        runtime: MemoryExtractionRuntime | None = None,
        memory_port: MemoryPort | None = None,
        owner_memory_port: OwnerMemoryPort | None = None,
        adjudication_runtime: AdjudicationRuntime | None = None,
        ledger: OutboundLedgerPort | None = None,
        watermark_port: PostgresWatermarkStore | None = None,
        batch_size: int = EXTRACTION_BATCH_SIZE,
        provider: str = "deepseek",
        model_name: str | None = None,
    ) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        if batch_size < 1:
            raise ValueError("记忆提取批次大小必须为正整数。")
        self._database_url = database_url
        if runtime is None:
            from notalone.memory_extraction.adapters import (
                LangChainExtractionRuntime,
            )
            from notalone.memory_extraction.cli_support import (
                build_extraction_components,
            )

            components = build_extraction_components(database_url)
            runtime = LangChainExtractionRuntime(model=components.model)
            if adjudication_runtime is None:
                adjudication_runtime = LangChainAdjudicationRuntime(
                    model=components.model
                )
            if model_name is None:
                model_name = components.model_name
            if ledger is None:
                ledger = components.ledger
            if watermark_port is None:
                watermark_port = components.watermark
        self._runtime = runtime
        self._memory_port = memory_port or PostgresMemoryStore(database_url)
        self._owner_memory_port = owner_memory_port or PostgresOwnerMemoryStore(
            database_url
        )
        self._ledger = ledger or PostgresOutboundLedger(database_url)
        self._watermark_port = watermark_port or PostgresWatermarkStore(database_url)
        self._adjudication_runtime = adjudication_runtime
        self._batch_size = batch_size
        self._provider = provider
        self._model_name = model_name or "unreported"

    @property
    def model_version(self) -> str:
        return self._model_name

    def run(self, *, scope: ContactScope) -> ExtractionRunStats:
        from notalone.memory_extraction.cli_support import load_contact_messages

        messages = load_contact_messages(scope, self._database_url)
        if not messages:
            return ExtractionRunStats()
        return run_extraction(
            scope=scope,
            messages=messages,
            watermark_message_id=self._watermark_port.get(scope),
            runtime=self._runtime,
            memory_port=self._memory_port,
            owner_memory_port=self._owner_memory_port,
            adjudication_runtime=self._adjudication_runtime,
            ledger=self._ledger,
            watermark_port=self._watermark_port,
            batch_size=self._batch_size,
            provider=self._provider,
            model_name=self._model_name,
        )


class BackgroundTaskWorker:
    """一次只领取一个联系人步骤的后台 Worker。"""

    __slots__ = (
        "_extraction_runner",
        "_lease_duration",
        "_model_version",
        "_repository",
        "_rule_version",
    )

    def __init__(
        self,
        *,
        repository: PostgresBackgroundTaskRepository,
        extraction_runner: ExtractionTaskRunner,
        lease_duration: timedelta = timedelta(seconds=30),
        rule_version: str = "memory-extraction-v1",
    ) -> None:
        if repository is None or extraction_runner is None:
            raise TypeError("Worker 必须显式注入任务仓储和提取执行器。")
        if lease_duration <= timedelta(0):
            raise ValueError("Worker 租约必须是正时间段。")
        self._repository = repository
        self._extraction_runner = extraction_runner
        self._lease_duration = lease_duration
        self._model_version = getattr(extraction_runner, "model_version", None)
        self._rule_version = rule_version

    def run_once(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        worker_id: UUID,
    ) -> WorkerRunResult:
        """领取并执行一个支持的步骤；没有可领取步骤时返回 idle。"""

        claim = self._repository.claim_next_step(
            owner_id=owner_id,
            contact_id=contact_id,
            worker_id=worker_id,
            lease_duration=self._lease_duration,
            model_version=self._model_version,
            rule_version=self._rule_version,
        )
        if claim is None:
            return WorkerRunResult(outcome=WorkerRunOutcome.IDLE)

        if claim.name in {
            BackgroundTaskStepName.PARSE,
            BackgroundTaskStepName.NORMALIZE,
        }:
            self._repository.complete_step(
                claim,
                processed_count=claim.message_count,
                total_count=claim.message_count,
            )
            return WorkerRunResult(
                outcome=WorkerRunOutcome.SUCCEEDED,
                task_id=claim.task_id,
                step_name=claim.name,
                processed_count=claim.message_count,
                attempt_count=claim.attempt_count,
            )

        try:
            stats = self._extraction_runner.run(
                scope=ContactScope(claim.owner_id, claim.contact_id)
            )
        except Exception as error:
            error_code, retryable = _failure_info(error)
            return self._record_failure(
                claim,
                error_code,
                retryable=retryable,
            )
        if stats.failed_batches:
            return self._record_failure(
                claim,
                "memory_extraction_failed",
                retryable=True,
            )

        self._repository.complete_step(
            claim,
            processed_count=stats.processed_messages,
            total_count=claim.message_count,
        )
        return WorkerRunResult(
            outcome=WorkerRunOutcome.SUCCEEDED,
            task_id=claim.task_id,
            step_name=claim.name,
            processed_count=stats.processed_messages,
            attempt_count=claim.attempt_count,
        )

    def _record_failure(
        self,
        claim: ClaimedBackgroundTaskStep,
        error_code: str,
        *,
        retryable: bool,
    ) -> WorkerRunResult:
        status = self._repository.fail_step(
            claim,
            error_code=error_code,
            retryable=retryable,
        )
        outcome = (
            WorkerRunOutcome.RETRYABLE
            if status is BackgroundTaskStepStatus.RETRYABLE
            else WorkerRunOutcome.FAILED
        )
        return WorkerRunResult(
            outcome=outcome,
            task_id=claim.task_id,
            step_name=claim.name,
            attempt_count=claim.attempt_count,
            error_code=error_code,
        )


def _failure_info(error: Exception) -> tuple[str, bool]:
    if isinstance(error, ExtractionRuntimeError):
        return "memory_extraction_failed", True
    if isinstance(error, (TimeoutError, ConnectionError)):
        return "temporary_failure", True
    if isinstance(error, MemoryExtractionError):
        return "memory_extraction_failed", False
    return "worker_step_failed", False
