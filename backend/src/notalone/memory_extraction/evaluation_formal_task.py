"""正式任务评测的PG及Worker适配；只操作调用者指定的隔离任务。"""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, TYPE_CHECKING
from uuid import UUID, uuid4

from .evaluation import EvaluationResult, _task_trace_facts, evaluate_outcome
from .evaluation_cases import EvaluationCase
from .models import ExtractionWindow
from .runtime import MemoryExtractionRuntime
from .verification import SourceVerificationRuntime

if TYPE_CHECKING:
    from notalone.tasks.models import BackgroundTask
    from notalone.tasks.worker import WorkerRunResult


@dataclass(frozen=True)
class TaskEvaluationResult:
    """正式任务的实际结果与原件；matcher不代表独立语义或逐维放行。"""

    result: EvaluationResult
    window: ExtractionWindow
    task: BackgroundTask
    trace: dict[str, Any]
    worker_results: tuple[WorkerRunResult, ...]


def evaluate_task(
    case: EvaluationCase, window: ExtractionWindow, runtime: MemoryExtractionRuntime, *,
    database_url: str, task_id: UUID, verification_runtime: SourceVerificationRuntime,
    provider: str = "deepseek", model_name: str = "unreported",
) -> TaskEvaluationResult:
    """执行已固定的单批正式任务；首次失败即停，不重领、不重跑Flow。"""
    from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
    from notalone.persistence.extraction_trace import PostgresExtractionTraceStore
    from notalone.scopes import ContactScope
    from notalone.tasks.extraction_runtime import runtime_config_for_mode
    from notalone.tasks.models import (
        BackgroundTaskStatus, BackgroundTaskStepName, BackgroundTaskStepStatus,
        BackgroundTaskType, ExtractionRuntimeMode,
    )
    from notalone.tasks.worker import BackgroundTaskWorker, PostgresMemoryExtractionRunner, WorkerRunOutcome
    from notalone.memory_extraction.dimensions import DimensionRelease

    if not isinstance(task_id, UUID) or not isinstance(window, ExtractionWindow):
        raise ValueError("正式任务评测须绑定实际任务和完整窗口。")
    scope = ContactScope(window.owner_id, window.contact_id)
    repository = PostgresBackgroundTaskRepository(database_url)
    task = repository.get_task(owner_id=scope.owner_id, contact_id=scope.contact_id, task_id=task_id)
    config = runtime_config_for_mode(ExtractionRuntimeMode.BOUNDED_RUNTIME_V1)
    extraction = [step for step in task.steps if step.name is BackgroundTaskStepName.EXTRACT_MEMORY]
    if (task.extraction_runtime_config != config or task.retry_count != 0
            or task.task_type not in {BackgroundTaskType.IMPORT, BackgroundTaskType.OBSERVATION}
            or task.status not in {BackgroundTaskStatus.QUEUED, BackgroundTaskStatus.RUNNING}
            or len(extraction) != 1 or extraction[0].status is not BackgroundTaskStepStatus.PENDING
            or extraction[0].attempt_count != 0):
        raise ValueError("正式任务评测只接受当前有限配置的首次提取。")
    actual = _task_window(database_url, window, case)
    traces = PostgresExtractionTraceStore(database_url)
    if traces.list_batches(scope, limit=1):
        raise ValueError("正式任务评测范围已有追踪，不能混用旧批次。")
    runner = PostgresMemoryExtractionRunner(
        database_url, runtime=runtime, verification_runtime=verification_runtime,
        provider=provider, model_name=model_name, dimension_release=DimensionRelease(),
    )
    worker = BackgroundTaskWorker(repository=repository, extraction_runner=runner)
    worker_results = []
    for expected in (BackgroundTaskStepName.PARSE, BackgroundTaskStepName.NORMALIZE,
                     BackgroundTaskStepName.EXTRACT_MEMORY):
        step = next((item for item in task.steps if item.name is expected), None)
        if step is None or step.status is BackgroundTaskStepStatus.SUCCEEDED:
            continue
        if step.status is not BackgroundTaskStepStatus.PENDING or step.attempt_count != 0:
            raise ValueError("正式任务评测不恢复已尝试步骤。")
        if expected is BackgroundTaskStepName.EXTRACT_MEMORY:
            actual = _task_window(database_url, window, case)
        result = worker.run_once(owner_id=scope.owner_id, contact_id=scope.contact_id,
                                 task_id=task_id, worker_id=uuid4())
        worker_results.append(result)
        if result.outcome is not WorkerRunOutcome.SUCCEEDED or result.step_name is not expected:
            raise ValueError("正式任务评测首次步骤失败，已停止且不重新领取。")
        task = repository.get_task(owner_id=scope.owner_id, contact_id=scope.contact_id, task_id=task_id)
        if expected is BackgroundTaskStepName.EXTRACT_MEMORY:
            break
    batches = traces.list_batches(scope, limit=2)
    if len(batches) != 1:
        raise ValueError("正式任务评测必须产生唯一实际追踪。")
    trace = traces.get_batch(scope, batches[0]["trace_id"])
    try:
        facts, rejected = _task_trace_facts(trace, actual, task_id, config.to_payload())
    except (KeyError, TypeError, IndexError):
        raise ValueError("正式任务追踪缺少完整必需字段。") from None
    return TaskEvaluationResult(
        evaluate_outcome(case, facts, rejected_count=rejected, verification_enabled=True),
        actual, task, trace, tuple(worker_results),
    )


def _task_window(database_url: str, expected: ExtractionWindow, case: EvaluationCase) -> ExtractionWindow:
    """沿生产loader、原偏移、水位与默认批次界限核完整窗口，不选片段。"""
    from notalone.memory_extraction.cli_support import load_contact_messages
    from notalone.memory_extraction.command import (
        EXTRACTION_BATCH_SIZE, EXTRACTION_CONTEXT_BEFORE, EXTRACTION_CONTEXT_AFTER,
    )
    from notalone.memory_extraction.source_proof import bounded_source_occurred_at
    from notalone.memory_trace.context import snapshot
    from notalone.persistence.watermark_store import PostgresWatermarkStore
    from notalone.scopes import ContactScope

    scope = ContactScope(expected.owner_id, expected.contact_id)
    messages = tuple(replace(item, occurred_at=bounded_source_occurred_at(item))
                     for item in load_contact_messages(scope, database_url))
    watermark = PostgresWatermarkStore(database_url).get(scope)
    positions = [index for index, item in enumerate(messages) if item.message_id == watermark]
    start = positions[0] + 1 if positions else 0
    pending = messages[start:]
    if not pending or len(pending) > EXTRACTION_BATCH_SIZE:
        raise ValueError("正式任务评测只接受一个非空生产批次。")
    actual = ExtractionWindow(
        scope.owner_id, scope.contact_id,
        messages[max(0, start - EXTRACTION_CONTEXT_BEFORE):min(len(messages), start + len(pending) + EXTRACTION_CONTEXT_AFTER)],
        target_message_ids=tuple(item.message_id for item in pending),
    )
    if (any(type(index) is not int or not 0 <= index < len(actual.messages) for index in case.targets)
            or len(actual.messages) > 4 or any(len(item.text) > 4096 for item in actual.messages)
            or snapshot(actual) != snapshot(expected)
            or tuple((item.sender.value, item.text) for item in actual.messages) != case.messages
            or tuple(actual.messages[index].message_id for index in case.targets) != actual.target_message_ids):
        raise ValueError("正式任务窗口与冻结输入、目标或有限范围不符。")
    return actual
