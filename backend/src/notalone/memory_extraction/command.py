"""记忆提取与记忆管理的命令入口。"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from notalone.ledger.models import LedgerEntry, LedgerOutcome
from notalone.ledger.ports import OutboundLedgerPort
from notalone.memory.models import (
    AdoptionMethod,
    MemoryCategory,
    MemoryTopic,
)
from notalone.memory_extraction.adoption import AdoptionStats, MemoryAdoption
from notalone.memory_extraction.dimensions import DimensionRelease
from notalone.memory_extraction.errors import ExtractionRuntimeError
from notalone.memory_extraction.flow import ExtractionFlow, ExtractionOutcome
from notalone.memory_extraction.models import (
    MAX_TARGET_MESSAGES_PER_WINDOW,
    ExtractionFailureKind,
    ExtractionWindow,
)
from notalone.memory_extraction.recovery import (
    FailureRange,
    record_batch_failure,
)
from notalone.memory_extraction.runtime import (
    ExtractionPayload,
    MemoryExtractionRuntime,
)
from notalone.memory_extraction.verification import SourceVerificationRuntime
from notalone.memory_trace import (
    TracePort,
    TraceSession,
    TraceWriteError,
    snapshot,
)
from notalone.memory_trace.context import event_payload, record_ledger_entry
from notalone.runtime_config import load_project_env
from notalone.scopes import ContactScope
from notalone.tasks.models import ExtractionRuntimeConfig, ExtractionRuntimeMode

EXTRACTION_BATCH_SIZE = 10
MAX_CONTEXT_MESSAGES_PER_SIDE = 20
EXTRACTION_CONTEXT_BEFORE = 5
EXTRACTION_CONTEXT_AFTER = 0


@dataclass(slots=True)
class _TimedExtractionRuntime:
    """只测量首次提取调用，避免核验和采纳耗时重复进入其台账。"""

    runtime: MemoryExtractionRuntime
    called_at: datetime = field(init=False)
    latency_ms: int = field(init=False)

    def __post_init__(self) -> None:
        if self.runtime is None:
            raise TypeError("ExtractionFlow 必须显式注入运行时。")

    def extract(self, window: ExtractionWindow) -> ExtractionPayload:
        self.called_at = datetime.now(timezone.utc)
        started = time.perf_counter()
        try:
            return self.runtime.extract(window)
        finally:
            self.latency_ms = max(
                0, int((time.perf_counter() - started) * 1000)
            )


@dataclass(frozen=True, slots=True)
class ExtractionRunStats:
    """一次提取命令的聚合统计。"""

    batches: int = 0
    processed_messages: int = 0
    extracted: int = 0
    adopted: int = 0
    updated: int = 0
    pending: int = 0
    skipped_duplicate: int = 0
    skipped_deleted: int = 0
    rejected_by_contract: int = 0
    failed_batches: int = 0
    skipped_batches: int = 0
    skipped_non_memory: int = 0
    skipped_ranges: tuple[FailureRange, ...] = ()


@dataclass(frozen=True, slots=True)
class _PlannedBatch:
    """A 段构建的批次窗口与过程记录起始数据；B 段只读。"""

    batch: tuple
    window: ExtractionWindow
    window_payload: dict[str, Any]
    batch_key: str
    next_watermark: UUID | None
    previous_watermark: UUID | None


@dataclass(frozen=True, slots=True)
class _BatchExtraction:
    """A 段的提取与来源核验结果，以及 B 段记账所需数据。"""

    outcome: ExtractionOutcome
    extraction_completed: bool
    extracted: int
    latency_ms: int
    called_at: datetime


@dataclass(frozen=True, slots=True)
class _BatchStep:
    """主线程预计算的批序与水位链；不提前构建窗口载荷。"""

    index: int
    batch: tuple
    next_watermark: UUID | None
    previous_watermark: UUID | None


@dataclass(slots=True)
class _RunProgress:
    """B 段串行累计的状态；水位只在成功或跳过提交后前进。"""

    previous_watermark: UUID | None
    batches: int = 0
    processed_messages: int = 0
    extracted: int = 0
    adopted: int = 0
    updated: int = 0
    pending: int = 0
    skipped_duplicate: int = 0
    skipped_deleted: int = 0
    rejected_by_contract: int = 0
    failed_batches: int = 0
    skipped_batches: int = 0
    skipped_non_memory: int = 0
    skipped_ranges: list[FailureRange] = field(default_factory=list)

    def finish(self) -> ExtractionRunStats:
        return ExtractionRunStats(
            batches=self.batches,
            processed_messages=self.processed_messages,
            extracted=self.extracted,
            adopted=self.adopted,
            updated=self.updated,
            pending=self.pending,
            skipped_duplicate=self.skipped_duplicate,
            skipped_deleted=self.skipped_deleted,
            rejected_by_contract=self.rejected_by_contract,
            failed_batches=self.failed_batches,
            skipped_batches=self.skipped_batches,
            skipped_non_memory=self.skipped_non_memory,
            skipped_ranges=tuple(self.skipped_ranges),
        )


def _plan_batch_steps(
    *,
    pending_messages: tuple,
    batch_size: int,
    initial_watermark: UUID | None,
) -> tuple[_BatchStep, ...]:
    """按批序预计算批次与水位链，避免主线程提前构建整轮窗口载荷。"""

    steps: list[_BatchStep] = []
    previous = initial_watermark
    for index, offset in enumerate(
        range(0, len(pending_messages), batch_size)
    ):
        batch = pending_messages[offset : offset + batch_size]
        next_watermark = _next_watermark(batch, previous)
        steps.append(
            _BatchStep(
                index=index,
                batch=batch,
                next_watermark=next_watermark,
                previous_watermark=previous,
            )
        )
        previous = next_watermark
    return tuple(steps)


class _BatchWriteGate:
    """单写队列的批序闸门：前序批未提交时后批等待，中止时全部唤醒。"""

    def __init__(self, initial_watermark: UUID | None) -> None:
        self._condition = threading.Condition()
        self._next_index = 0
        self._aborted = False
        self._committed_watermark = initial_watermark

    def is_aborted(self) -> bool:
        with self._condition:
            return self._aborted

    def committed_watermark(self) -> UUID | None:
        """实际已提交的水位；停止批只按该值收尾，不使用预计算链。"""

        with self._condition:
            return self._committed_watermark

    def wait_for_turn(self, index: int) -> bool:
        """等到本批可提交；整轮已中止时返回 False 以便收为停止。"""

        with self._condition:
            while not self._aborted and self._next_index != index:
                self._condition.wait()
            return not self._aborted

    def finish(
        self,
        index: int,
        *,
        abort: bool,
        watermark: UUID | None,
    ) -> None:
        """提交完成后推进批序；失败时先置中止再唤醒所有等待者。"""

        with self._condition:
            if abort:
                self._aborted = True
            elif self._next_index == index:
                self._committed_watermark = watermark
            if self._next_index == index:
                self._next_index += 1
            self._condition.notify_all()

    def abort(self) -> None:
        """未预期异常时先唤醒等待者，避免线程池收尾死锁。"""

        with self._condition:
            self._aborted = True
            self._condition.notify_all()


def _next_watermark(batch: tuple, previous: UUID | None) -> UUID | None:
    """批内最后一条有时间消息的水位；无时间消息时保持不前移。"""

    return next(
        (
            message.message_id
            for message in reversed(batch)
            if message.occurred_at is not None
        ),
        previous,
    )


def _plan_batch(
    *,
    batch: tuple,
    messages: tuple,
    message_positions: dict[UUID, int],
    scope: ContactScope,
    context_before: int,
    context_after: int,
    batch_size: int,
    provider: str,
    model_name: str | None,
    task_metadata: dict[str, Any],
    selection_receipts: tuple[dict[str, Any], ...],
    previous_watermark: UUID | None,
) -> _PlannedBatch:
    """A 段：构建本批窗口、窗口载荷与批次键；不产生写入。"""

    next_watermark = _next_watermark(batch, previous_watermark)
    absolute_start = message_positions[batch[0].message_id]
    absolute_end = message_positions[batch[-1].message_id] + 1
    context_start = max(0, absolute_start - context_before)
    context_end = min(len(messages), absolute_end + context_after)
    window = ExtractionWindow(
        owner_id=scope.owner_id,
        contact_id=scope.contact_id,
        messages=(
            tuple(messages[context_start:absolute_start])
            + tuple(batch)
            + tuple(messages[absolute_end:context_end])
        ),
        target_message_ids=tuple(message.message_id for message in batch),
    )
    window_payload = {
        **task_metadata,
        "messages": [
            {
                **snapshot(message),
                "role": (
                    "target"
                    if message.message_id in window.target_message_id_set
                    else (
                        "context_before"
                        if index < absolute_start - context_start
                        else "context_after"
                    )
                ),
            }
            for index, message in enumerate(window.messages)
        ],
        "target_count": len(batch),
        "context_before_count": absolute_start - context_start,
        "context_after_count": context_end - absolute_end,
        "target_message_ids": snapshot(window.target_message_ids),
        "watermark_before": snapshot(previous_watermark),
        "watermark_planned": snapshot(next_watermark),
        "configuration": {
            "batch_size": batch_size,
            "context_before": context_before,
            "context_after": context_after,
            "provider": provider,
            "model_name": model_name or "unreported",
        },
        "sources_status": (
            "recorded"
            if all(
                message.source_snapshots
                and all(
                    item.get("processing_status") == "recorded"
                    for item in message.source_snapshots
                )
                for message in window.messages
            )
            else "processing_missing"
        ),
        "versions": _trace_versions(),
        "selection_receipts": selection_receipts,
    }
    batch_key = hashlib.sha256(
        "|".join(str(message.message_id) for message in batch).encode()
    ).hexdigest()
    return _PlannedBatch(
        batch=batch,
        window=window,
        window_payload=window_payload,
        batch_key=batch_key,
        next_watermark=next_watermark,
        previous_watermark=previous_watermark,
    )


def _extract_batch(
    plan: _PlannedBatch,
    *,
    flow: ExtractionFlow,
    timed_runtime: _TimedExtractionRuntime,
) -> _BatchExtraction:
    """A 段：执行提取与来源核验；只产出 B 段需要的结果。"""

    outcome = flow.run(plan.window)
    return _BatchExtraction(
        outcome=outcome,
        extraction_completed=outcome.extraction_completed,
        extracted=len(outcome.accepted),
        latency_ms=timed_runtime.latency_ms,
        called_at=timed_runtime.called_at,
    )


def _commit_batch(
    plan: _PlannedBatch,
    extraction: _BatchExtraction,
    *,
    trace: TraceSession,
    progress: _RunProgress,
    adoption: MemoryAdoption,
    scope: ContactScope,
    ledger: OutboundLedgerPort | None,
    watermark_port,
    provider: str,
    model_name: str | None,
) -> bool:
    """B 段：裁决与采纳、失败／跳过处理、完成过程记录并提交水位。

    返回 True 表示本批失败且整轮停止；返回 False 表示继续下一批。
    """

    outcome = extraction.outcome
    adoption_stats = AdoptionStats()
    try:
        if outcome.failure_reason is None:
            adoption_stats = adoption.adopt(scope, outcome)
    except ExtractionRuntimeError as error:
        # 写入裁决等批次级模型调用失败：与提取失败同一策略，
        # 分类后计数或停止，不让整轮无记录地中断。失败发生在采纳
        # 阶段，必须保留 flow 已给出的本批统计，不能用一个空 outcome
        # 覆盖掉已通过的提取与拒绝计数。
        preserved_rejections = outcome.rejected_count
        outcome = ExtractionOutcome(
            accepted=(),
            rejected_count=preserved_rejections,
            failure_reason=str(error),
            failure_kind=error.failure_kind,
            extraction_completed=extraction.extraction_completed,
        )
    progress.processed_messages += len(plan.batch)
    progress.batches += 1
    _record_extraction_ledger(
        ledger,
        scope,
        (
            LedgerOutcome.SUCCEEDED
            if outcome.extraction_completed
            else LedgerOutcome.RUN_FAILED
        ),
        latency_ms=extraction.latency_ms,
        called_at=extraction.called_at,
        provider=provider,
        model_name=model_name,
    )
    if outcome.failure_reason is None:
        progress.extracted += extraction.extracted
        progress.adopted += adoption_stats.adopted
        progress.updated += adoption_stats.updated
        progress.pending += adoption_stats.pending
        progress.skipped_duplicate += adoption_stats.skipped_duplicate
        progress.skipped_deleted += adoption_stats.skipped_deleted
        progress.rejected_by_contract += adoption_stats.rejected_by_contract
        progress.skipped_non_memory += adoption_stats.skipped_non_memory
        trace.complete(
            status="succeeded",
            payload={
                "extracted": extraction.extracted,
                "adoption": snapshot(adoption_stats),
                "watermark_before": snapshot(plan.previous_watermark),
                "watermark_planned": snapshot(plan.next_watermark),
                "watermark_after": (
                    snapshot(plan.next_watermark)
                    if watermark_port is not None
                    else None
                ),
                "watermark_commit": (
                    "committed_with_trace"
                    if watermark_port is not None
                    else "not_configured"
                ),
            },
            watermark_port=watermark_port,
            watermark_message_id=plan.next_watermark or plan.batch[-1].message_id,
        )
        progress.previous_watermark = plan.next_watermark
        return False
    # 失败批次里已经通过提取或已被判定为契约拒绝的候选仍要计数，
    # 这样采纳阶段失败不会让本批统计凭空归零。
    progress.extracted += extraction.extracted
    progress.rejected_by_contract += outcome.rejected_count
    if (
        outcome.failure_kind is ExtractionFailureKind.INVALID_OUTPUT
        and watermark_port is not None
    ):
        failure_range = FailureRange(
            from_message_id=plan.batch[0].message_id,
            to_message_id=plan.batch[-1].message_id,
            code=outcome.failure_kind,
        )
        previous = watermark_port.get_failure(scope)
        state, reached = record_batch_failure(
            previous,
            failure_range=failure_range,
        )
        if reached:
            trace.complete(
                status="skipped",
                payload={
                    "failure_kind": outcome.failure_kind.value,
                    "failure_count": state.count,
                    "extracted": extraction.extracted,
                    "rejected": outcome.rejected_count,
                    "watermark_before": snapshot(plan.previous_watermark),
                    "watermark_after": snapshot(plan.next_watermark),
                    "watermark_commit": "committed_with_trace",
                    "skipped_range": snapshot(failure_range),
                    "not_executed": [
                        "remaining_adoption",
                        "remaining_write",
                    ],
                },
                watermark_port=watermark_port,
                skipped_range=failure_range,
                watermark_message_id=plan.next_watermark or plan.batch[-1].message_id,
            )
            progress.previous_watermark = plan.next_watermark
            progress.skipped_batches += 1
            progress.skipped_ranges.append(failure_range)
            return False
        trace.complete(
            status="model_failed",
            payload={
                "failure_kind": outcome.failure_kind.value,
                "failure_count": state.count,
                "extracted": extraction.extracted,
                "rejected": outcome.rejected_count,
                "watermark_before": snapshot(plan.previous_watermark),
                "watermark_after": snapshot(plan.previous_watermark),
                "watermark_commit": "not_advanced",
                "not_executed": [
                    "remaining_adoption",
                    "remaining_write",
                ],
            },
            watermark_port=watermark_port,
            failure_state=state,
        )
    else:
        trace.complete(
            status="model_failed",
            payload={
                "failure_kind": (
                    outcome.failure_kind.value
                    if outcome.failure_kind
                    else None
                ),
                "extracted": extraction.extracted,
                "rejected": outcome.rejected_count,
                "watermark_before": snapshot(plan.previous_watermark),
                "watermark_after": snapshot(plan.previous_watermark),
                "watermark_commit": "not_advanced",
                "not_executed": [
                    "remaining_adoption",
                    "remaining_write",
                ],
            },
        )
    progress.failed_batches += 1
    return True


def _complete_stopped_batch(
    trace: TraceSession, *, watermark: UUID | None
) -> None:
    """预取批在整轮中止后收尾：不采纳、不写入、不推进水位、不计数。"""

    current = snapshot(watermark)
    trace.complete(
        status="stopped",
        payload={
            "reason": "aborted_after_batch_failure",
            "watermark_before": current,
            "watermark_planned": current,
            "watermark_after": current,
            "watermark_commit": "not_advanced",
            "not_executed": [
                "extraction",
                "verification",
                "adoption",
                "write",
            ],
        },
    )


def _run_batch_pipeline(
    *,
    steps: tuple[_BatchStep, ...],
    messages: tuple,
    message_positions: dict[UUID, int],
    scope: ContactScope,
    batch_size: int,
    context_before: int,
    context_after: int,
    provider: str,
    model_name: str | None,
    task_metadata: dict[str, Any],
    selection_receipts: tuple[dict[str, Any], ...],
    trace_store: TracePort,
    run_id: UUID,
    runtime,
    verification_runtime: SourceVerificationRuntime | None,
    adoption: MemoryAdoption,
    ledger: OutboundLedgerPort | None,
    watermark_port,
    progress: _RunProgress,
    batch_concurrency: int,
) -> ExtractionRunStats:
    """批次流水线：A 段按并发度并行，B 段在单写队列中按批序提交。

    并发度 1 不走本函数，保持原有逐批 A → B 的串行路径。
    """

    gate = _BatchWriteGate(progress.previous_watermark)
    # 内存适配器的 begin 会回查同批历史；串行化起点写入，避免并发迭代
    # 共享容器；提取与核验事件仍由各批自己的线程写入。
    trace_begin_lock = threading.Lock()

    def run_one(step: _BatchStep) -> None:
        # 轮次失败后排队中的批不再开始 A 段，也不创建过程记录。
        if gate.is_aborted():
            return
        try:
            window_started_at = datetime.now(timezone.utc)
            plan = _plan_batch(
                batch=step.batch,
                messages=messages,
                message_positions=message_positions,
                scope=scope,
                context_before=context_before,
                context_after=context_after,
                batch_size=batch_size,
                provider=provider,
                model_name=model_name,
                task_metadata=task_metadata,
                selection_receipts=selection_receipts,
                previous_watermark=step.previous_watermark,
            )
            with trace_begin_lock:
                trace_id = trace_store.begin(
                    scope,
                    run_id=run_id,
                    batch_key=plan.batch_key,
                    payload=event_payload(
                        plan.window_payload,
                        started_at=window_started_at,
                        rule_version=str(
                            plan.window_payload["versions"]["command"]
                        ),
                    ),
                )
            # 计时运行时记录本批 called_at/latency，不能跨线程共享。
            timed_runtime = _TimedExtractionRuntime(runtime)
            flow = ExtractionFlow(
                runtime=timed_runtime,
                verification_runtime=verification_runtime,
            )
            with TraceSession(
                trace_store,
                scope,
                trace_id,
                versions=plan.window_payload["versions"],
                ledger=ledger,
                provider=provider,
                model_name=model_name,
            ) as trace:
                extraction = _extract_batch(
                    plan, flow=flow, timed_runtime=timed_runtime
                )
                if not gate.wait_for_turn(step.index):
                    _complete_stopped_batch(
                        trace, watermark=gate.committed_watermark()
                    )
                    return
                # B 段：只有轮到本批的单写线程才裁决、采纳与提交水位。
                stop = _commit_batch(
                    plan,
                    extraction,
                    trace=trace,
                    progress=progress,
                    adoption=adoption,
                    scope=scope,
                    ledger=ledger,
                    watermark_port=watermark_port,
                    provider=provider,
                    model_name=model_name,
                )
            gate.finish(
                step.index,
                abort=stop,
                watermark=step.next_watermark,
            )
        except BaseException:
            # TraceSession 已在异常路径标记本批失败；先唤醒所有等待者，
            # 再把异常交给调用方，避免线程池收尾时互相等待。
            gate.abort()
            raise

    failure: BaseException | None = None
    executor = ThreadPoolExecutor(
        max_workers=batch_concurrency,
        thread_name_prefix="notalone-extract",
    )
    try:
        futures: list[Future] = [
            executor.submit(run_one, step) for step in steps
        ]
        for future in futures:
            try:
                future.result()
            except BaseException as error:
                if failure is None:
                    failure = error
    finally:
        executor.shutdown(wait=True, cancel_futures=True)
    if failure is not None:
        raise failure
    return progress.finish()


def run_extraction(
    *,
    scope: ContactScope,
    messages: tuple,
    watermark_message_id: UUID | None,
    runtime,
    memory_port,
    owner_memory_port,
    verification_runtime: SourceVerificationRuntime | None = None,
    adjudication_runtime=None,
    ledger: OutboundLedgerPort | None = None,
    watermark_port=None,
    batch_size: int = EXTRACTION_BATCH_SIZE,
    context_before: int = EXTRACTION_CONTEXT_BEFORE,
    context_after: int = EXTRACTION_CONTEXT_AFTER,
    provider: str = "deepseek",
    model_name: str | None = None,
    dimension_release: DimensionRelease | None = None,
    trace_store: TracePort | None = None,
    selection_receipts: tuple[dict[str, Any], ...] = (),
    task_id: UUID | None = None,
    extraction_runtime_config: ExtractionRuntimeConfig | None = None,
    automatic: bool = True,
    task_lease_generation: int | None = None,
    target_message_ids: tuple[UUID, ...] | None = None,
    batch_concurrency: int = 1,
) -> ExtractionRunStats:
    """按水位分批提取并采纳；输出不可用的批次连续失败后跳过。

    并发度 1 为原有逐批串行路径；大于 1 时 A 段按批并行、B 段单写队列
    按批序提交。
    """

    task_metadata = _task_runtime_metadata(
        task_id, extraction_runtime_config, verification_runtime,
    )
    if task_lease_generation is not None and task_id is not None:
        task_metadata["task_runtime"]["lease_generation"] = task_lease_generation
    if (
        not isinstance(batch_size, int)
        or not 0 < batch_size <= MAX_TARGET_MESSAGES_PER_WINDOW
    ):
        raise ValueError(
            f"单次模型调用最多处理 {MAX_TARGET_MESSAGES_PER_WINDOW} 条目标消息。"
        )
    if (
        not isinstance(context_before, int)
        or not 0 <= context_before <= MAX_CONTEXT_MESSAGES_PER_SIDE
    ):
        raise ValueError(
            "前置上下文条数必须在 0 到 "
            f"{MAX_CONTEXT_MESSAGES_PER_SIDE} 之间。"
        )
    if (
        not isinstance(context_after, int)
        or not 0 <= context_after <= MAX_CONTEXT_MESSAGES_PER_SIDE
    ):
        raise ValueError(
            "后置上下文条数必须在 0 到 "
            f"{MAX_CONTEXT_MESSAGES_PER_SIDE} 之间。"
        )
    if (
        isinstance(batch_concurrency, bool)
        or not isinstance(batch_concurrency, int)
        or batch_concurrency < 1
    ):
        raise ValueError("批次并发度必须是大于或等于 1 的整数。")

    if watermark_message_id is not None:
        positions = [
            index
            for index, message in enumerate(messages)
            if message.message_id == watermark_message_id
        ]
        start = positions[0] + 1 if positions else 0
    else:
        start = 0
    pending_messages = messages[start:]
    if target_message_ids is not None:
        target_set = frozenset(target_message_ids)
        pending_messages = tuple(message for message in messages if message.message_id in target_set)
    message_positions = {message.message_id: index for index, message in enumerate(messages)}

    if trace_store is None:
        from notalone.memory.adapters import InMemoryMemoryStore
        from notalone.memory_trace.adapters import InMemoryTraceStore
        from notalone.persistence.extraction_trace import (
            PostgresExtractionTraceStore,
        )
        from notalone.persistence.memory_store import PostgresMemoryStore

        if isinstance(memory_port, PostgresMemoryStore):
            trace_store = PostgresExtractionTraceStore(
                memory_port.database_url
            )
        elif isinstance(memory_port, InMemoryMemoryStore):
            trace_store = InMemoryTraceStore()
        else:
            raise TraceWriteError("trace_configuration")
    run_id = uuid4()
    previous_watermark = (watermark_port.get(scope) if task_id is not None and watermark_port is not None
                          else watermark_message_id)
    from notalone.memory_extraction.merge import MemoryMergeVerifier
    from notalone.memory_extraction.cli_support import load_contact_messages
    source_database_url = getattr(memory_port, "database_url", None)
    adoption = MemoryAdoption(
        automatic=automatic,
        source_messages=messages,
        source_loader=(lambda scope, identifiers: load_contact_messages(scope, source_database_url, message_ids=identifiers)) if source_database_url else None,
        memory_port=memory_port,
        owner_memory_port=owner_memory_port,
        merge_verifier=MemoryMergeVerifier(messages=messages, verification_runtime=verification_runtime,
            source_loader=(lambda scope, identifiers: load_contact_messages(scope, source_database_url, message_ids=identifiers)) if source_database_url else None),
        adjudication_runtime=adjudication_runtime,
        ledger=ledger,
        dimension_release=dimension_release,
    )
    timed_runtime = _TimedExtractionRuntime(runtime)
    flow = ExtractionFlow(
        runtime=timed_runtime,
        verification_runtime=verification_runtime,
    )

    progress = _RunProgress(previous_watermark=previous_watermark)
    if not pending_messages:
        versions = _trace_versions()
        trace_id = trace_store.begin(
            scope,
            run_id=run_id,
            batch_key=hashlib.sha256(
                f"empty:{progress.previous_watermark}".encode()
            ).hexdigest(),
            payload=event_payload(
                {
                    **task_metadata,
                    "messages": [],
                    "target_count": 0,
                    "target_message_ids": [],
                    "context_before_count": 0,
                    "context_after_count": 0,
                    "watermark_before": snapshot(progress.previous_watermark),
                    "watermark_planned": snapshot(progress.previous_watermark),
                    "selection_receipts": selection_receipts,
                    "versions": versions,
                }
            ),
        )
        with TraceSession(
            trace_store, scope, trace_id, versions=versions
        ) as trace:
            trace.complete(
                status="skipped",
                payload={
                    "reason": (
                        "up_to_date" if messages else "no_eligible_messages"
                    ),
                    "not_executed": [
                        "extraction",
                        "verification",
                        "adoption",
                        "write",
                    ],
                    "watermark_after": snapshot(progress.previous_watermark),
                    "watermark_commit": "not_advanced",
                },
            )
    if batch_concurrency > 1:
        # 并发路径按批新建计时运行时与流程对象；上面创建的串行对象
        # 不跨线程共享。
        return _run_batch_pipeline(
            steps=_plan_batch_steps(
                pending_messages=pending_messages,
                batch_size=batch_size,
                initial_watermark=progress.previous_watermark,
            ),
            messages=messages,
            message_positions=message_positions,
            scope=scope,
            batch_size=batch_size,
            context_before=context_before,
            context_after=context_after,
            provider=provider,
            model_name=model_name,
            task_metadata=task_metadata,
            selection_receipts=selection_receipts,
            trace_store=trace_store,
            run_id=run_id,
            runtime=runtime,
            verification_runtime=verification_runtime,
            adoption=adoption,
            ledger=ledger,
            watermark_port=watermark_port,
            progress=progress,
            batch_concurrency=batch_concurrency,
        )
    for offset in range(0, len(pending_messages), batch_size):
        batch = pending_messages[offset : offset + batch_size]
        # A 段：构建批次窗口与过程记录载荷，进入 TraceSession 并执行提取与
        # 来源核验；只产出结果，不写记忆、不推进水位。
        window_started_at = datetime.now(timezone.utc)
        plan = _plan_batch(
            batch=batch,
            messages=messages,
            message_positions=message_positions,
            scope=scope,
            context_before=context_before,
            context_after=context_after,
            batch_size=batch_size,
            provider=provider,
            model_name=model_name,
            task_metadata=task_metadata,
            selection_receipts=selection_receipts,
            previous_watermark=progress.previous_watermark,
        )
        trace_id = trace_store.begin(
            scope,
            run_id=run_id,
            batch_key=plan.batch_key,
            payload=event_payload(
                plan.window_payload,
                started_at=window_started_at,
                rule_version=str(plan.window_payload["versions"]["command"]),
            ),
        )
        with TraceSession(
            trace_store,
            scope,
            trace_id,
            versions=plan.window_payload["versions"],
            ledger=ledger,
            provider=provider,
            model_name=model_name,
        ) as trace:
            extraction = _extract_batch(
                plan, flow=flow, timed_runtime=timed_runtime
            )
            # B 段：裁决与采纳、失败／跳过处理、完成过程记录、提交水位并
            # 累计统计；串行路径逐批 A → B，失败即停止整轮。
            stop = _commit_batch(
                plan,
                extraction,
                trace=trace,
                progress=progress,
                adoption=adoption,
                scope=scope,
                ledger=ledger,
                watermark_port=watermark_port,
                provider=provider,
                model_name=model_name,
            )
        if stop:
            break
    return progress.finish()


def _task_runtime_metadata(
    task_id: UUID | None,
    config: ExtractionRuntimeConfig | None,
    verification_runtime: SourceVerificationRuntime | None,
) -> dict[str, Any]:
    """记录实际已选合同；不在记录入口重新选V或生成调用。"""
    if task_id is not None and not isinstance(task_id, UUID):
        raise ValueError("提取追踪的任务标识无效。")
    if config is not None:
        if task_id is None:
            raise ValueError("显式提取配置必须绑定指定任务。")
        from notalone.tasks.extraction_runtime import validate_runtime_config
        from notalone.memory_extraction.verification import SourceVerificationMode

        validate_runtime_config(config)
        expected = (
            SourceVerificationMode.LEGACY_V4
            if config.mode is ExtractionRuntimeMode.LEGACY
            else SourceVerificationMode.NULLABLE_PROOF_V3
        )
        if (verification_runtime is None
                and config.mode is not ExtractionRuntimeMode.LEGACY):
            raise ValueError("有限运行配置缺少实际同次V。")
        if (verification_runtime is not None
                and getattr(verification_runtime, "verification_mode", SourceVerificationMode.LEGACY_V4) != expected):
            raise ValueError("任务配置与实际来源核验模式不符。")
    if task_id is None:
        return {}
    return {"task_runtime": {
        "task_id": task_id,
        "mode": config.mode.value if config is not None else ExtractionRuntimeMode.LEGACY.value,
        "config_version": config.version if config is not None else None,
        "rule_set_sha256": config.rule_set_sha256 if config is not None else None,
    }}


def _trace_versions() -> dict[str, str | int]:
    """记录实际执行代码版本，不能用发布版本推测尚未提交的规则。"""
    directory = Path(__file__).parent
    return {
        "trace_schema": 1,
        **{
            name: hashlib.sha256(
                (directory / f"{name}.py").read_bytes()
            ).hexdigest()
            for name in (
                "command",
                "flow",
                "adoption",
                "pragmatics",
                "dimensions",
                "verification",
                "adjudication",
                "cli_support",
                "models",
                "adapters",
                "grounded",
                "grounded_adapter",
                "direct_adapter",
                "json_recovery",
                "merge",
                "verification_isolation",
                "adjudication_adapters",
                "verification_adapters",
            )
        },
        "transport": hashlib.sha256(
            (directory.parent / "memory_trace" / "transport.py").read_bytes()
        ).hexdigest(),
        "memory_timing": hashlib.sha256(
            (directory.parent / "memory" / "timing.py").read_bytes()
        ).hexdigest(),
        "memory_conditions": hashlib.sha256(
            (directory.parent / "memory" / "conditions.py").read_bytes()
        ).hexdigest(),
        "memory_events": hashlib.sha256(
            (directory.parent / "memory" / "events.py").read_bytes()
        ).hexdigest(),
    }


def _record_extraction_ledger(
    ledger: OutboundLedgerPort | None,
    scope: ContactScope,
    outcome: LedgerOutcome,
    *,
    latency_ms: int,
    called_at: datetime,
    provider: str,
    model_name: str | None,
) -> None:
    if ledger is None:
        return
    entry = LedgerEntry(
        entry_id=uuid4(),
        owner_id=scope.owner_id,
        contact_id=scope.contact_id,
        provider=provider,
        model_name=model_name or "unreported",
        input_tokens=None,
        output_tokens=None,
        latency_ms=latency_ms,
        outcome=outcome,
        called_at=called_at,
    )
    started_at = datetime.now(timezone.utc)
    record_ledger_entry("extraction", ledger, entry, started_at=started_at)


def _fail(message: str) -> int:
    print(message)
    return 1


class OwnerConfigError(ValueError):
    """owner 环境变量不可用；入口负责转成稳定退出码与文案。"""


def _owner_uuid_from_env(owner_id: str) -> UUID:
    """解析已确认的 owner 配置；非法值给出稳定错误而不是裸 traceback。"""

    try:
        return UUID(owner_id)
    except ValueError:
        raise OwnerConfigError("NOTALONE_OWNER_ID 不是合法 UUID。") from None


def extract_main(argv: list[str] | None = None) -> int:
    """默认记录全部执行；故障只打印安全状态与查询标识。"""
    try:
        return _extract_main(argv)
    except TraceWriteError as error:
        print(
            f"trace_write_failed stage={error.stage} trace_id={error.trace_id} commit_outcome={error.commit_outcome}"
        )
        return 1


def _extract_main(argv: list[str] | None = None) -> int:
    """提取命令入口：自动全量/增量，断点续跑，输出统计与跳过区间。"""

    load_project_env()
    parser = argparse.ArgumentParser(
        prog="notalone-extract-memory",
        description="对已确认联系人执行记忆提取（自动全量或增量）。",
    )
    parser.add_argument("--contact-id", required=True, type=UUID)
    parser.add_argument(
        "--batch-size",
        type=int,
        default=EXTRACTION_BATCH_SIZE,
        help=(
            "单次模型调用的目标消息上限（默认 20）；"
            "同一联系人前后各补充最多 20 条上下文。"
        ),
    )
    args = parser.parse_args(argv)
    if not 0 < args.batch_size <= MAX_TARGET_MESSAGES_PER_WINDOW:
        return _fail(
            f"--batch-size 必须在 1 到 {MAX_TARGET_MESSAGES_PER_WINDOW} 之间。"
        )

    database_url = os.environ.get("NOTALONE_DATABASE_URL", "").strip()
    owner_id = os.environ.get("NOTALONE_OWNER_ID", "").strip()
    if not database_url:
        return _fail("缺少 NOTALONE_DATABASE_URL 环境变量。")
    if not owner_id:
        return _fail("缺少 NOTALONE_OWNER_ID 环境变量。")
    try:
        owner_uuid = _owner_uuid_from_env(owner_id)
    except OwnerConfigError as error:
        return _fail(str(error))

    from notalone.memory_extraction.direct_adapter import DirectExtractionRuntime
    from notalone.memory_extraction.adjudication_adapters import (
        LangChainAdjudicationRuntime,
    )
    from notalone.memory_extraction.cli_support import (
        build_extraction_components,
        contact_exists,
        load_contact_messages,
    )
    from notalone.memory_extraction.verification_adapters import (
        LangChainSourceVerificationRuntime,
    )

    scope = ContactScope(owner_uuid, args.contact_id)
    try:
        components = build_extraction_components(database_url)
    except Exception:
        return _fail("记忆提取准备失败：数据库不可用。")
    try:
        if not contact_exists(scope, database_url):
            return _fail("联系人不存在或不在当前用户范围内。")
        selection_receipts: list[dict[str, Any]] = []
        messages = load_contact_messages(
            scope, database_url, selection_receipts=selection_receipts
        )
    except Exception:
        return _fail("记忆提取准备失败：数据库不可用或联系人不存在。")
    watermark_message_id = components.watermark.get(scope)
    stats = run_extraction(
        scope=scope,
        messages=messages,
        watermark_message_id=watermark_message_id,
        runtime=DirectExtractionRuntime(model=components.model),
        verification_runtime=LangChainSourceVerificationRuntime(
                    isolate_items=True,
            model=components.model,
            ledger=components.ledger,
        ),
        memory_port=components.memory_store,
        owner_memory_port=components.owner_store,
        adjudication_runtime=LangChainAdjudicationRuntime(
            model=components.model
        ),
        ledger=components.ledger,
        watermark_port=components.watermark,
        batch_size=args.batch_size,
        model_name=components.model_name,
        trace_store=components.trace_store,
        selection_receipts=tuple(selection_receipts),
    )
    print(
        f"batches={stats.batches} extracted={stats.extracted}"
        f" adopted={stats.adopted} updated={stats.updated}"
        f" pending={stats.pending} duplicate={stats.skipped_duplicate}"
        f" deleted_skip={stats.skipped_deleted}"
        f" rejected={stats.rejected_by_contract}"
        f" skipped_non_memory={stats.skipped_non_memory}"
        f" failed_batches={stats.failed_batches}"
        f" skipped_batches={stats.skipped_batches}"
    )
    for skipped_range in stats.skipped_ranges:
        print(
            f"skipped_range from={skipped_range.from_message_id}"
            f" to={skipped_range.to_message_id}"
            f" code={skipped_range.code.value}"
        )
    return 0 if stats.failed_batches == 0 else 1


def memory_add_main(argv: list[str] | None = None) -> int:
    """手动录入记忆：标记 manual，支持联系人级与 owner 级。"""

    load_project_env()
    parser = argparse.ArgumentParser(
        prog="notalone-memory-add", description="手动录入一条记忆（manual）。"
    )
    parser.add_argument("--text", required=True)
    parser.add_argument(
        "--category",
        required=True,
        choices=[item.value for item in MemoryCategory],
    )
    parser.add_argument(
        "--topic",
        default="other",
        choices=[item.value for item in MemoryTopic],
    )
    parser.add_argument("--contact-id", type=UUID, default=None)
    args = parser.parse_args(argv)

    database_url = os.environ.get("NOTALONE_DATABASE_URL", "").strip()
    owner_id = os.environ.get("NOTALONE_OWNER_ID", "").strip()
    if not database_url or not owner_id:
        return _fail("缺少 NOTALONE_DATABASE_URL 或 NOTALONE_OWNER_ID。")
    try:
        owner_uuid = _owner_uuid_from_env(owner_id)
    except OwnerConfigError as error:
        return _fail(str(error))

    from notalone.memory.models import (
        ConfirmedMemoryStatus,
        MemoryCandidate,
        OwnerMemory,
    )
    from notalone.memory_extraction.cli_support import (
        contact_exists,
        owner_exists,
    )
    from notalone.persistence import (
        PostgresMemoryStore,
        PostgresOwnerMemoryStore,
    )

    if not owner_exists(owner_uuid, database_url):
        return _fail("owner 不存在。")
    if args.contact_id is not None:
        scope = ContactScope(owner_uuid, args.contact_id)
        if not contact_exists(scope, database_url):
            return _fail("联系人不存在。")
        store = PostgresMemoryStore(database_url)
        # 手动录入不依赖提取来源：走 manual 来源 + 候选路径（迁移 025）。
        candidate = store.create_manual_candidate(
            MemoryCandidate(
                candidate_id=uuid4(),
                scope=scope,
                text=args.text,
                category=MemoryCategory(args.category),
                topic=MemoryTopic(args.topic),
                source_ids=(args.contact_id,),
            )
        )
        store.confirm(
            scope=scope,
            candidate_id=candidate.candidate_id,
            adoption_method=AdoptionMethod.MANUAL,
        )
        print("status=confirmed level=contact")
    else:
        owner_store = PostgresOwnerMemoryStore(database_url)
        owner_store.create(
            OwnerMemory(
                memory_id=uuid4(),
                owner_id=owner_uuid,
                text=args.text,
                category=MemoryCategory(args.category),
                topic=MemoryTopic(args.topic),
                source_ids=(owner_uuid,),
                adoption_method=AdoptionMethod.MANUAL,
                status=ConfirmedMemoryStatus.ACTIVE,
            )
        )
        print("status=confirmed level=owner")
    return 0


def memory_list_main(argv: list[str] | None = None) -> int:
    """列出记忆：只输出状态、分类、主题与采纳标记，不输出正文。"""

    load_project_env()
    parser = argparse.ArgumentParser(
        prog="notalone-memory-list", description="列出记忆的状态概览。"
    )
    parser.add_argument("--contact-id", type=UUID, default=None)
    parser.add_argument("--owner", action="store_true")
    args = parser.parse_args(argv)

    database_url = os.environ.get("NOTALONE_DATABASE_URL", "").strip()
    owner_id = os.environ.get("NOTALONE_OWNER_ID", "").strip()
    if not database_url or not owner_id:
        return _fail("缺少 NOTALONE_DATABASE_URL 或 NOTALONE_OWNER_ID。")
    try:
        owner_uuid = _owner_uuid_from_env(owner_id)
    except OwnerConfigError as error:
        return _fail(str(error))

    from notalone.persistence import (
        PostgresMemoryStore,
        PostgresOwnerMemoryStore,
    )

    if args.contact_id is not None:
        scope = ContactScope(owner_uuid, args.contact_id)
        memories = PostgresMemoryStore(database_url).list_confirmed(scope)
        for memory in memories:
            print(
                f"memory_id={memory.memory_id}"
                f" category={memory.category.value}"
                f" topic={memory.topic.value}"
                f" adoption={memory.adoption_method.value}"
                f" revision={memory.revision}"
            )
        print(f"total={len(memories)}")
    elif args.owner:
        owner_memories = PostgresOwnerMemoryStore(database_url).list_active(
            owner_uuid
        )
        for owner_memory in owner_memories:
            print(
                f"memory_id={owner_memory.memory_id}"
                f" category={owner_memory.category.value}"
                f" topic={owner_memory.topic.value}"
                f" adoption={owner_memory.adoption_method.value}"
                f" revision={owner_memory.revision}"
            )
        print(f"total={len(owner_memories)}")
    else:
        return _fail("需要 --contact-id 或 --owner 之一。")
    return 0


def memory_delete_main(argv: list[str] | None = None) -> int:
    """软删除一条记忆（保留删除指纹）。"""

    load_project_env()
    parser = argparse.ArgumentParser(
        prog="notalone-memory-delete", description="软删除一条记忆。"
    )
    parser.add_argument("--memory-id", required=True, type=UUID)
    parser.add_argument("--contact-id", type=UUID, default=None)
    parser.add_argument("--owner", action="store_true")
    args = parser.parse_args(argv)

    database_url = os.environ.get("NOTALONE_DATABASE_URL", "").strip()
    owner_id = os.environ.get("NOTALONE_OWNER_ID", "").strip()
    if not database_url or not owner_id:
        return _fail("缺少 NOTALONE_DATABASE_URL 或 NOTALONE_OWNER_ID。")
    try:
        owner_uuid = _owner_uuid_from_env(owner_id)
    except OwnerConfigError as error:
        return _fail(str(error))

    from notalone.persistence import (
        PostgresMemoryStore,
        PostgresOwnerMemoryStore,
    )

    if args.contact_id is not None:
        scope = ContactScope(owner_uuid, args.contact_id)
        PostgresMemoryStore(database_url).delete(
            scope=scope, memory_id=args.memory_id
        )
        print("status=deleted level=contact")
    elif args.owner:
        PostgresOwnerMemoryStore(database_url).delete(
            owner_uuid, args.memory_id
        )
        print("status=deleted level=owner")
    else:
        return _fail("需要 --contact-id 或 --owner 之一。")
    return 0
