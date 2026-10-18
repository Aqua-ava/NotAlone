"""后台任务 Worker：领取一个步骤并执行确定性状态迁移。"""

from __future__ import annotations

from dataclasses import dataclass, replace
from contextlib import nullcontext
from datetime import timedelta
from enum import StrEnum
from threading import Event, Thread
from typing import Any, Literal, Protocol
from uuid import UUID

import psycopg

from notalone.application.model_priority import ModelPriorityControl, ModelWorkStopped

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
from notalone.memory_extraction.dimensions import DimensionRelease
from notalone.memory_extraction.errors import (
    ExtractionRuntimeError,
    MemoryExtractionError,
)
from notalone.memory_extraction.runtime import MemoryExtractionRuntime
from notalone.memory_extraction.verification import SourceVerificationRuntime
from notalone.memory_trace import TracePort, TraceWriteError
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
from notalone.persistence.memory_store import (
    MemoryPersistenceError,
    PostgresMemoryStore,
)
from notalone.persistence.outbound_ledger import (
    OutboundLedgerPersistenceError,
    PostgresOutboundLedger,
)
from notalone.persistence.owner_memory_store import (
    OwnerMemoryPersistenceError,
    PostgresOwnerMemoryStore,
)
from notalone.persistence.source_deletion import (
    PostgresSourceDeletionRepository,
    SourceDeletionError,
    SourceBackupCleanupError,
)
from notalone.persistence.watermark_store import (
    PostgresWatermarkStore,
    WatermarkPersistenceError,
)
from notalone.scopes import ContactScope
from notalone.skills.learning import SkillLearningInvalid, SkillLearningUnavailable
from notalone.skills.learning_runtime import SkillLearningRuntimeError
from notalone.tasks.models import (
    DELETE_TASK_STEPS,
    BackgroundTaskStepName,
    BackgroundTaskStepStatus,
    ClaimedBackgroundTaskStep,
    ExtractionRuntimeConfig,
    ExtractionRuntimeMode,
)
from notalone.tasks.extraction_runtime import verification_runtime_for_config, extraction_runtime_for_config

class ExtractionTaskRunner(Protocol):
    """Worker 调用的记忆提取执行 seam。"""

    def run(
        self, *, scope: ContactScope, task_id: UUID | None = None,
        extraction_runtime_config: ExtractionRuntimeConfig | None = None,
    ) -> ExtractionRunStats: ...


class LearningTaskRunner(Protocol):
    """现有Worker内的有限学习步骤，不具备发布接口。"""

    def run(self, *, scope: ContactScope, claim: ClaimedBackgroundTaskStep) -> int: ...
    def verify(self, *, scope: ContactScope) -> None: ...


class WorkerRunOutcome(StrEnum):
    """一次 Worker 调用的非正文结果。"""

    IDLE = "idle"
    SUCCEEDED = "succeeded"
    RETRYABLE = "retryable"
    FAILED = "failed"
    STOPPED = "stopped"


@dataclass(frozen=True, slots=True)
class WorkerRunResult:
    """一次 Worker 调用返回的状态、步骤和计数。"""

    outcome: WorkerRunOutcome
    task_id: UUID | None = None
    step_name: BackgroundTaskStepName | None = None
    processed_count: int = 0
    attempt_count: int = 0
    error_code: str | None = None
    failure_state_commit: str | None = None


class _LeaseHeartbeat:
    """在长步骤执行期间续期，避免模型调用占满租约。"""

    __slots__ = (
        "_claim",
        "_error",
        "_interval_seconds",
        "_repository",
        "_stop",
        "_thread",
        "_external_stop",
    )

    def __init__(
        self,
        repository: PostgresBackgroundTaskRepository,
        claim: ClaimedBackgroundTaskStep,
        lease_duration: timedelta,
        stop_event: Event | None = None,
    ) -> None:
        self._repository = repository
        self._claim = claim
        self._interval_seconds = min(
            10.0,
            max(0.05, lease_duration.total_seconds() / 3.0),
        )
        self._stop = Event()
        self._external_stop = stop_event
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

    def __exit__(self, exception_type, exception, traceback) -> Literal[False]:
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
            if self._external_stop is not None and self._external_stop.is_set():
                return
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
        "_dimension_release",
        "_ledger",
        "_memory_port",
        "_model_name",
        "_owner_memory_port",
        "_provider",
        "_runtime",
        "_verification_runtime",
        "_watermark_port",
        "_trace_store",
    )

    def __init__(
        self,
        database_url: str,
        *,
        runtime: MemoryExtractionRuntime | None = None,
        verification_runtime: SourceVerificationRuntime | None = None,
        memory_port: MemoryPort | None = None,
        owner_memory_port: OwnerMemoryPort | None = None,
        adjudication_runtime: AdjudicationRuntime | None = None,
        ledger: OutboundLedgerPort | None = None,
        watermark_port: PostgresWatermarkStore | None = None,
        batch_size: int = EXTRACTION_BATCH_SIZE,
        provider: str = "deepseek",
        model_name: str | None = None,
        dimension_release: DimensionRelease | None = None,
        trace_store: TracePort | None = None,
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
        # None 表示沿用运维开关与默认空放行表（ADR-036），不是"全部放行"。
        dimension_release = DimensionRelease.resolve(dimension_release)
        self._dimension_release = dimension_release
        self._database_url = database_url
        if runtime is None:
            from notalone.memory_extraction.grounded_adapter import (
                GroundedExtractionRuntime,
            )
            from notalone.memory_extraction.cli_support import (
                build_extraction_components,
            )
            from notalone.memory_extraction.verification_adapters import (
                LangChainSourceVerificationRuntime,
            )

            components = build_extraction_components(database_url)
            runtime = GroundedExtractionRuntime(model=components.model)
            if adjudication_runtime is None:
                adjudication_runtime = LangChainAdjudicationRuntime(
                    model=components.model
                )
            if model_name is None:
                model_name = components.model_name
            if ledger is None:
                ledger = components.ledger
            if verification_runtime is None:
                verification_runtime = LangChainSourceVerificationRuntime(
                    model=components.model, ledger=ledger, provider=provider,
                )
            if watermark_port is None:
                watermark_port = components.watermark
        self._runtime = runtime
        self._verification_runtime = verification_runtime
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
        from notalone.persistence.extraction_trace import (
            PostgresExtractionTraceStore,
        )

        self._trace_store = (
            trace_store
            if trace_store is not None
            else PostgresExtractionTraceStore(database_url)
        )

    @property
    def model_version(self) -> str:
        return self._model_name

    def run(
        self, *, scope: ContactScope, task_id: UUID | None = None,
        extraction_runtime_config: ExtractionRuntimeConfig | None = None,
    ) -> ExtractionRunStats:
        from notalone.memory_extraction.cli_support import (
            load_contact_messages,
        )

        if extraction_runtime_config is not None and not isinstance(task_id, UUID):
            raise ValueError("指定提取配置必须绑定实际任务。")
        verification_runtime = verification_runtime_for_config(self._verification_runtime, extraction_runtime_config)
        runtime = extraction_runtime_for_config(self._runtime, extraction_runtime_config)
        selection_receipts: list[dict[str, Any]] = []
        messages = load_contact_messages(
            scope, self._database_url, selection_receipts=selection_receipts
        )
        if (extraction_runtime_config is not None
                and extraction_runtime_config.mode is ExtractionRuntimeMode.BOUNDED_RUNTIME_V1):
            from notalone.memory_extraction.source_proof import bounded_source_occurred_at

            messages = tuple(replace(message, occurred_at=bounded_source_occurred_at(message)) for message in messages)
        task_options: dict[str, Any] = {}
        if task_id is not None or extraction_runtime_config is not None:
            task_options = {"task_id": task_id, "extraction_runtime_config": extraction_runtime_config}
        return run_extraction(
            scope=scope,
            messages=messages,
            watermark_message_id=self._watermark_port.get(scope),
            runtime=runtime,
            verification_runtime=verification_runtime,
            memory_port=self._memory_port,
            owner_memory_port=self._owner_memory_port,
            adjudication_runtime=self._adjudication_runtime,
            ledger=self._ledger,
            watermark_port=self._watermark_port,
            batch_size=self._batch_size,
            provider=self._provider,
            model_name=self._model_name,
            dimension_release=self._dimension_release,
            trace_store=self._trace_store,
            selection_receipts=tuple(selection_receipts),
            **task_options,
        )


class BackgroundTaskWorker:
    """一次只领取一个联系人步骤的后台 Worker。"""

    __slots__ = (
        "_extraction_runner",
        "_deletion_repository",
        "_index_repository",
        "_lease_duration",
        "_model_version",
        "_repository",
        "_rule_version",
        "_model_priority",
        "_learning_runner",
        "_upgrade_runner",
        "_organization_runner",
    )

    def __init__(
        self,
        *,
        repository: PostgresBackgroundTaskRepository,
        extraction_runner: ExtractionTaskRunner | None = None,
        deletion_repository: PostgresSourceDeletionRepository | None = None,
        lease_duration: timedelta = timedelta(seconds=30),
        rule_version: str = "memory-extraction-v1",
        index_repository: PostgresContactMemoryIndexRepository | None = None,
        model_priority: ModelPriorityControl | None = None,
        learning_runner: LearningTaskRunner | None = None,
        upgrade_runner=None,
        organization_runner=None,
    ) -> None:
        if repository is None or (extraction_runner is None and deletion_repository is None and learning_runner is None and upgrade_runner is None and organization_runner is None):
            raise TypeError("Worker 必须注入任务仓储及至少一个有限任务执行器。")
        if lease_duration <= timedelta(0):
            raise ValueError("Worker 租约必须是正时间段。")
        self._repository = repository
        self._extraction_runner = extraction_runner
        self._deletion_repository = deletion_repository
        self._index_repository = index_repository
        self._lease_duration = lease_duration
        self._model_version = getattr(extraction_runner, "model_version", None)
        self._rule_version = rule_version
        self._model_priority = model_priority
        self._learning_runner = learning_runner
        self._upgrade_runner = upgrade_runner
        self._organization_runner = organization_runner

    def run_once(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        worker_id: UUID,
        task_id: UUID | None = None,
    ) -> WorkerRunResult:
        """领取并执行一个支持的步骤；没有可领取步骤时返回 idle。"""

        if self._stopping():
            return WorkerRunResult(outcome=WorkerRunOutcome.STOPPED)

        supported_steps: tuple[BackgroundTaskStepName, ...] = ()
        if self._extraction_runner is not None:
            supported_steps += (
                BackgroundTaskStepName.PARSE,
                BackgroundTaskStepName.NORMALIZE,
                BackgroundTaskStepName.EXTRACT_MEMORY,
            )
        if self._deletion_repository is not None:
            supported_steps += tuple(name for _, name in DELETE_TASK_STEPS)
        if self._learning_runner is not None:
            supported_steps += (BackgroundTaskStepName.PROPOSE_SKILL, BackgroundTaskStepName.VERIFY_SKILL_DRAFTS)
        if self._upgrade_runner is not None:
            supported_steps += (BackgroundTaskStepName.PREVIEW_UPGRADE, BackgroundTaskStepName.VERIFY_UPGRADE_PREVIEW,
                                BackgroundTaskStepName.APPLY_UPGRADE, BackgroundTaskStepName.VERIFY_UPGRADE_APPLY)
        if self._index_repository is not None:
            supported_steps += (
                BackgroundTaskStepName.INDEX,
                BackgroundTaskStepName.VERIFY,
            )
        if self._organization_runner is not None:
            supported_steps += (BackgroundTaskStepName.ORGANIZE_MEMORY,)
        runtime_rule_set_sha256 = None
        if self._extraction_runner is not None:
            from notalone.memory_extraction.source_proof import bounded_runtime_rule_set_sha256

            runtime_rule_set_sha256 = bounded_runtime_rule_set_sha256()
        claim = self._repository.claim_next_step(
            owner_id=owner_id,
            contact_id=contact_id,
            worker_id=worker_id,
            lease_duration=self._lease_duration,
            supported_steps=supported_steps,
            model_version=self._model_version,
            rule_version=self._rule_version if self._extraction_runner is not None else None,
            task_id=task_id,
            runtime_rule_set_sha256=runtime_rule_set_sha256,
        )
        if claim is None:
            return WorkerRunResult(outcome=WorkerRunOutcome.IDLE)
        if self._stopping():
            return self._stopped_result(claim)

        if claim.name is BackgroundTaskStepName.ORGANIZE_MEMORY:
            try:
                with _LeaseHeartbeat(self._repository, claim, self._lease_duration,
                        self._model_priority.stop_event if self._model_priority else None) as heartbeat:
                    count = self._organization_runner.run_batch(claim)
                    heartbeat.raise_if_failed()
            except ModelWorkStopped:
                return self._stopped_result(claim)
            except Exception:
                result=self._record_failure(claim, "layered_memory_temporary_failure", retryable=True)
                if result.outcome is WorkerRunOutcome.FAILED:
                    self._organization_runner.worker_failed(claim)
                return result
            if not self._complete_step(claim, processed_count=count, total_count=claim.message_count):
                return self._temporary_failure_result(claim)
            return WorkerRunResult(outcome=WorkerRunOutcome.SUCCEEDED, task_id=claim.task_id,
                step_name=claim.name, processed_count=count, attempt_count=claim.attempt_count)

        if claim.name in {name for _, name in DELETE_TASK_STEPS}:
            if self._deletion_repository is None or claim.source_document_id is None:
                return self._record_failure(
                    claim,
                    "source_delete_failed",
                    retryable=False,
                )
            try:
                scope_args = dict(owner_id=claim.owner_id, contact_id=claim.contact_id,
                                  source_document_id=claim.source_document_id)
                if claim.name is BackgroundTaskStepName.DELETE_DERIVED:
                    # 派生资料、索引与数据库快照在同一事务清除；后续步骤复核凭证。
                    self._deletion_repository.delete_source(**scope_args)
                elif claim.name is not BackgroundTaskStepName.MARK_DELETED:
                    self._deletion_repository.verify_deleted(**scope_args)
            except SourceDeletionError as error:
                code = "update_backup_cleanup_required" if isinstance(error, SourceBackupCleanupError) else "source_delete_failed"
                return self._record_failure(claim, code, retryable=True)
            if not self._complete_step(claim, processed_count=0, total_count=0):
                return self._temporary_failure_result(claim)
            return WorkerRunResult(
                outcome=WorkerRunOutcome.SUCCEEDED, task_id=claim.task_id,
                step_name=claim.name, attempt_count=claim.attempt_count,
            )

        if claim.name in {
            BackgroundTaskStepName.PARSE,
            BackgroundTaskStepName.NORMALIZE,
        }:
            if not self._complete_step(
                claim,
                processed_count=claim.message_count,
                total_count=claim.message_count,
            ):
                return self._temporary_failure_result(claim)
            return WorkerRunResult(
                outcome=WorkerRunOutcome.SUCCEEDED,
                task_id=claim.task_id,
                step_name=claim.name,
                processed_count=claim.message_count,
                attempt_count=claim.attempt_count,
            )

        if claim.name in (BackgroundTaskStepName.PREVIEW_UPGRADE, BackgroundTaskStepName.VERIFY_UPGRADE_PREVIEW,
                           BackgroundTaskStepName.APPLY_UPGRADE, BackgroundTaskStepName.VERIFY_UPGRADE_APPLY):
            from notalone.memory.upgrade import UpgradeConflict, UpgradeBudgetExceeded, UpgradeAlgorithmChanged
            try:
                guard = self._model_priority.background_scope(
                    lambda: self._repository.check_step_lease(claim),
                ) if self._model_priority else nullcontext()
                with guard, _LeaseHeartbeat(self._repository, claim, self._lease_duration,
                        self._model_priority.stop_event if self._model_priority else None) as heartbeat:
                    if claim.name is BackgroundTaskStepName.PREVIEW_UPGRADE:
                        count = self._upgrade_runner.preview(claim)
                    elif claim.name is BackgroundTaskStepName.APPLY_UPGRADE:
                        count = self._upgrade_runner.apply(claim)
                    else:
                        self._upgrade_runner.verify(claim)
                        count = 0
                    heartbeat.raise_if_failed()
            except ModelWorkStopped:
                return self._stopped_result(claim)
            except Exception as error:
                code = ('budget_exhausted' if isinstance(error, UpgradeBudgetExceeded)
                        else 'algorithm_changed' if isinstance(error, UpgradeAlgorithmChanged)
                        else 'sources_changed' if isinstance(error, UpgradeConflict)
                        else 'trace_write_failed' if isinstance(error, TraceWriteError) else 'temporary_failure')
                _, retryable = _failure_info(error)
                task_code = code if code == 'trace_write_failed' else 'memory_upgrade_' + code
                result = self._record_failure(claim, task_code,
                    retryable=retryable and not isinstance(error, UpgradeConflict))
                if result.outcome is WorkerRunOutcome.FAILED:
                    self._upgrade_runner.failed(claim, code)
                return result
            if not self._complete_step(claim, processed_count=count, total_count=claim.message_count):
                return self._temporary_failure_result(claim)
            return WorkerRunResult(outcome=WorkerRunOutcome.SUCCEEDED, task_id=claim.task_id,
                step_name=claim.name, processed_count=count, attempt_count=claim.attempt_count)

        if claim.name in (BackgroundTaskStepName.PROPOSE_SKILL, BackgroundTaskStepName.VERIFY_SKILL_DRAFTS):
            try:
                guard = self._model_priority.background_scope(
                    lambda: self._repository.check_step_lease(claim),
                ) if self._model_priority is not None else nullcontext()
                with guard, _LeaseHeartbeat(self._repository, claim, self._lease_duration,
                        self._model_priority.stop_event if self._model_priority else None) as heartbeat:
                    scope = ContactScope(claim.owner_id, claim.contact_id)
                    if claim.name is BackgroundTaskStepName.PROPOSE_SKILL:
                        count = self._learning_runner.run(scope=scope, claim=claim)
                    else:
                        self._learning_runner.verify(scope=scope)
                        count = 0
                    heartbeat.raise_if_failed()
            except ModelWorkStopped:
                return self._stopped_result(claim)
            except (SkillLearningInvalid, SkillLearningUnavailable):
                return self._record_failure(claim, 'skill_learning_stale_or_disabled', retryable=False)
            except (SkillLearningRuntimeError, psycopg.Error, TimeoutError, ConnectionError, BackgroundTaskPersistenceError):
                return self._record_failure(claim, 'skill_learning_temporary_failure', retryable=True)
            except Exception:
                return self._record_failure(claim, 'skill_learning_failed', retryable=False)
            if not self._complete_step(claim, processed_count=count, total_count=claim.message_count):
                return self._temporary_failure_result(claim)
            return WorkerRunResult(outcome=WorkerRunOutcome.SUCCEEDED, task_id=claim.task_id,
                step_name=claim.name, processed_count=count, attempt_count=claim.attempt_count)

        if claim.name is BackgroundTaskStepName.INDEX:
            try:
                assert self._index_repository is not None
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
            if not self._complete_step(
                claim,
                processed_count=len(result.topics),
                total_count=20,
            ):
                return self._temporary_failure_result(claim)
            return WorkerRunResult(
                outcome=WorkerRunOutcome.SUCCEEDED,
                task_id=claim.task_id,
                step_name=claim.name,
                processed_count=len(result.topics),
                attempt_count=claim.attempt_count,
            )

        if claim.name is BackgroundTaskStepName.VERIFY:
            try:
                assert self._index_repository is not None
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
            if not self._complete_step(
                claim,
                processed_count=verification.topics_count,
                total_count=20,
            ):
                return self._temporary_failure_result(claim)
            return WorkerRunResult(
                outcome=WorkerRunOutcome.SUCCEEDED,
                task_id=claim.task_id,
                step_name=claim.name,
                processed_count=verification.topics_count,
                attempt_count=claim.attempt_count,
            )

        try:
            assert self._extraction_runner is not None
            guard = (
                self._model_priority.background_scope(
                    lambda: self._repository.check_step_lease(claim),
                ) if self._model_priority is not None else nullcontext()
            )
            with guard, _LeaseHeartbeat(
                self._repository,
                claim,
                self._lease_duration,
                self._model_priority.stop_event if self._model_priority is not None else None,
            ) as heartbeat:
                stats = self._extraction_runner.run(
                    scope=ContactScope(claim.owner_id, claim.contact_id),
                    task_id=claim.task_id,
                    extraction_runtime_config=claim.extraction_runtime_config,
                )
                heartbeat.raise_if_failed()
        except ModelWorkStopped:
            return self._stopped_result(claim)
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
        if self._stopping():
            return self._stopped_result(claim)

        if not self._complete_step(
            claim,
            processed_count=stats.processed_messages,
            total_count=claim.message_count,
        ):
            return self._temporary_failure_result(claim)
        return WorkerRunResult(
            outcome=WorkerRunOutcome.SUCCEEDED,
            task_id=claim.task_id,
            step_name=claim.name,
            processed_count=stats.processed_messages,
            attempt_count=claim.attempt_count,
        )

    def _complete_step(
        self,
        claim: ClaimedBackgroundTaskStep,
        *,
        processed_count: int,
        total_count: int,
    ) -> bool:
        if self._stopping():
            return False
        try:
            self._repository.complete_step(
                claim,
                processed_count=processed_count,
                total_count=total_count,
            )
        except BackgroundTaskPersistenceError:
            # 与 _record_failure 相同：租约失效或任务被取消时不再
            # 写完成状态，返回 False 让调用方按临时失败处理。
            return False
        return True

    def _temporary_failure_result(
        self,
        claim: ClaimedBackgroundTaskStep,
    ) -> WorkerRunResult:
        if self._stopping():
            return self._stopped_result(claim)
        return WorkerRunResult(
            outcome=WorkerRunOutcome.RETRYABLE,
            task_id=claim.task_id,
            step_name=claim.name,
            attempt_count=claim.attempt_count,
            error_code="temporary_failure",
        )

    def _stopping(self) -> bool:
        return self._model_priority is not None and self._model_priority.stop_event.is_set()

    def _stopped_result(self, claim: ClaimedBackgroundTaskStep) -> WorkerRunResult:
        attempts = claim.attempt_count
        try:
            if self._repository.pause_step(claim):
                attempts -= 1
        except BackgroundTaskPersistenceError:
            # 来源删除或租约已失效时不复活旧工作；恢复仍由数据库决定。
            pass
        return WorkerRunResult(
            outcome=WorkerRunOutcome.STOPPED, task_id=claim.task_id,
            step_name=claim.name, attempt_count=max(0, attempts),
        )

    def _record_failure(
        self,
        claim: ClaimedBackgroundTaskStep,
        error_code: str,
        *,
        retryable: bool,
    ) -> WorkerRunResult:
        try:
            status = self._repository.fail_step(
                claim,
                error_code=error_code,
                retryable=retryable,
            )
        except BackgroundTaskPersistenceError:
            # 租约在步骤执行中失效、任务被来源删除取消或状态写入
            # 暂时不可用时，失败状态已无法落库；按可重试的临时失败
            # 返回，让 worker 循环存活，由租约收尸与下次认领决定
            # 任务去向，而不是让异常逃逸 run_once 崩溃整个进程。
            if error_code == "trace_write_failed":
                # 主追踪故障必须向运行状态暴露；失败状态的提交回执未知。
                return WorkerRunResult(
                    outcome=(
                        WorkerRunOutcome.STOPPED
                        if self._stopping()
                        else WorkerRunOutcome.RETRYABLE
                    ),
                    task_id=claim.task_id,
                    step_name=claim.name,
                    attempt_count=claim.attempt_count,
                    error_code=error_code,
                    failure_state_commit="unknown",
                )
            if self._stopping():
                # 已知失败的记账暂不可用时不能当协作停止退款。
                return WorkerRunResult(
                    outcome=WorkerRunOutcome.STOPPED, task_id=claim.task_id,
                    step_name=claim.name, attempt_count=claim.attempt_count,
                    error_code=error_code,
                )
            return self._temporary_failure_result(claim)
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
            failure_state_commit=(
                "committed" if error_code == "trace_write_failed" else None
            ),
        )


def _failure_info(error: Exception) -> tuple[str, bool]:
    if isinstance(error, TraceWriteError):
        return "trace_write_failed", True
    if isinstance(
        error,
        (
            BackgroundTaskLeaseError,
            BackgroundTaskPersistenceError,
            MemoryPersistenceError,
            OwnerMemoryPersistenceError,
            OutboundLedgerPersistenceError,
            WatermarkPersistenceError,
        ),
    ):
        # 持久层与任务层的暂时性故障（连接中断、锁等待、租约抖动）
        # 必须可重试，否则一次数据库抖动就会把整个提取任务永久置为
        # FAILED，自动重试上限形同虚设。
        return "temporary_failure", True
    if isinstance(error, ExtractionRuntimeError):
        return "memory_extraction_failed", True
    if isinstance(error, (TimeoutError, ConnectionError)):
        return "temporary_failure", True
    if isinstance(error, psycopg.OperationalError):
        # psycopg 3 的 OperationalError 不是内建 ConnectionError 子类；
        # load_contact_messages 等裸连接路径抛出的连接类故障同样按
        # 临时失败重试，不能落进 worker_step_failed 不可重试。
        return "temporary_failure", True
    if isinstance(error, MemoryExtractionError):
        return "memory_extraction_failed", False
    return "worker_step_failed", False
