"""后台任务 Worker：领取一个步骤并执行确定性状态迁移。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from enum import StrEnum
from threading import Event, Thread
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
    BackgroundTaskLeaseError,
    BackgroundTaskPersistenceError,
    PostgresBackgroundTaskRepository,
)
from notalone.persistence.contact_memory_index import (
    ContactMemoryIndexError,
    ContactMemoryIndexPersistenceError,
    PostgresContactMemoryIndexRepository,
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


class _LeaseHeartbeat:
    """在长步骤执行期间续期，避免模型调用占满租约。"""

    __slots__ = (
        "_claim",
        "_error",
        "_interval_seconds",
        "_repository",
        "_stop",
        "_thread",
    )

    def __init__(
        self,
        repository: PostgresBackgroundTaskRepository,
        claim: ClaimedBackgroundTaskStep,
        lease_duration: timedelta,
    ) -> None:
        self._repository = repository
        self._claim = claim
        self._interval_seconds = min(
            10.0,
            max(0.05, lease_duration.total_seconds() / 3.0),
        )
        self._stop = Event()
        self._thread: Thread | None = None
        self._error: Exception | None = None

    def __enter__(self) -> _LeaseHeartbeat:
        self._thread = Thread(
            target=self._run,
            name="notalone-worker-lease-heartbeat",
            daemon=True,
        )
        self._thread.start()
        return self

    def __exit__(self, exception_type, exception, traceback) -> bool:
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
        if exception_type is None:
            self.raise_if_failed()
        return False

    def raise_if_failed(self) -> None:
        if self._error is not None:
            raise self._error

    def _run(self) -> None:
        while not self._stop.wait(self._interval_seconds):
            try:
                self._repository.renew_step_lease(
                    self._claim,
                    lease_duration=timedelta(
                        seconds=self._interval_seconds * 3.0
                    ),
                )
            except Exception as error:  # pragma: no cover - timing dependent
                self._error = error
                self._stop.set()
                return


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
        if (
            not isinstance(batch_size, int)
            or not 0 < batch_size <= EXTRACTION_BATCH_SIZE
        ):
            raise ValueError(
                f"记忆提取批次大小必须在 1 到 {EXTRACTION_BATCH_SIZE} 之间。"
            )
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
        "_index_repository",
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
        index_repository: PostgresContactMemoryIndexRepository | None = None,
    ) -> None:
        if repository is None or extraction_runner is None:
            raise TypeError("Worker 必须显式注入任务仓储和提取执行器。")
        if lease_duration <= timedelta(0):
            raise ValueError("Worker 租约必须是正时间段。")
        self._repository = repository
        self._extraction_runner = extraction_runner
        self._index_repository = index_repository
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

        supported_steps = (
            BackgroundTaskStepName.PARSE,
            BackgroundTaskStepName.NORMALIZE,
            BackgroundTaskStepName.EXTRACT_MEMORY,
        )
        if self._index_repository is not None:
            supported_steps += (
                BackgroundTaskStepName.INDEX,
                BackgroundTaskStepName.VERIFY,
            )
        claim = self._repository.claim_next_step(
            owner_id=owner_id,
            contact_id=contact_id,
            worker_id=worker_id,
            lease_duration=self._lease_duration,
            supported_steps=supported_steps,
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

        if claim.name is BackgroundTaskStepName.INDEX:
            try:
                result = self._index_repository.rebuild(
                    ContactScope(claim.owner_id, claim.contact_id)
                )
            except ContactMemoryIndexPersistenceError:
                return self._record_failure(
                    claim,
                    "index_rebuild_failed",
                    retryable=True,
                )
            except ContactMemoryIndexError:
                return self._record_failure(
                    claim,
                    "index_rebuild_failed",
                    retryable=False,
                )
            except (TimeoutError, ConnectionError):
                return self._record_failure(
                    claim,
                    "index_rebuild_failed",
                    retryable=True,
                )
            except Exception:
                return self._record_failure(
                    claim,
                    "index_rebuild_failed",
                    retryable=False,
                )
            self._repository.complete_step(
                claim,
                processed_count=len(result.topics),
                total_count=20,
            )
            return WorkerRunResult(
                outcome=WorkerRunOutcome.SUCCEEDED,
                task_id=claim.task_id,
                step_name=claim.name,
                processed_count=len(result.topics),
                attempt_count=claim.attempt_count,
            )

        if claim.name is BackgroundTaskStepName.VERIFY:
            try:
                verification = self._index_repository.verify(
                    ContactScope(claim.owner_id, claim.contact_id)
                )
            except ContactMemoryIndexPersistenceError:
                return self._record_failure(
                    claim,
                    "index_verification_failed",
                    retryable=True,
                )
            except ContactMemoryIndexError:
                return self._record_failure(
                    claim,
                    "index_verification_failed",
                    retryable=False,
                )
            except (TimeoutError, ConnectionError):
                return self._record_failure(
                    claim,
                    "index_verification_failed",
                    retryable=True,
                )
            except Exception:
                return self._record_failure(
                    claim,
                    "index_verification_failed",
                    retryable=False,
                )
            if not verification.valid:
                return self._record_failure(
                    claim,
                    verification.error_code or "index_verification_failed",
                    retryable=True,
                )
            self._repository.complete_step(
                claim,
                processed_count=verification.topics_count,
                total_count=20,
            )
            return WorkerRunResult(
                outcome=WorkerRunOutcome.SUCCEEDED,
                task_id=claim.task_id,
                step_name=claim.name,
                processed_count=verification.topics_count,
                attempt_count=claim.attempt_count,
            )

        try:
            with _LeaseHeartbeat(
                self._repository,
                claim,
                self._lease_duration,
            ) as heartbeat:
                stats = self._extraction_runner.run(
                    scope=ContactScope(claim.owner_id, claim.contact_id)
                )
                heartbeat.raise_if_failed()
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
    if isinstance(
        error,
        (BackgroundTaskLeaseError, BackgroundTaskPersistenceError),
    ):
        return "temporary_failure", True
    if isinstance(error, ExtractionRuntimeError):
        return "memory_extraction_failed", True
    if isinstance(error, (TimeoutError, ConnectionError)):
        return "temporary_failure", True
    if isinstance(error, MemoryExtractionError):
        return "memory_extraction_failed", False
    return "worker_step_failed", False
