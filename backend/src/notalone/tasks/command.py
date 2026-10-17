"""后台任务维护命令。"""

from __future__ import annotations

import argparse
import os
import sys
import time
from dataclasses import dataclass
from datetime import timedelta
from enum import StrEnum
from threading import Event
from typing import Callable
from uuid import UUID, uuid4

import psycopg

from notalone.memory_extraction.cli_support import contact_exists, owner_exists
from notalone.persistence.background_tasks import (
    TERMINAL_TASK_RETENTION,
    BackgroundTaskPersistenceError,
    BackgroundTaskNotFoundError,
    BackgroundTaskStateError,
    PostgresBackgroundTaskRepository,
)
from notalone.persistence.contact_memory_index import (
    PostgresContactMemoryIndexRepository,
)
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
from notalone.persistence.locks import (
    release_global_worker_lock,
    try_acquire_global_worker_lock,
)
from notalone.runtime_config import load_project_env
from notalone.tasks.models import BackgroundTaskStepName, ExtractionRuntimeMode, VERIFY_STEPS
from notalone.tasks.extraction_runtime import runtime_config_for_mode
from notalone.tasks.worker import (
    BackgroundTaskWorker,
    PostgresMemoryExtractionRunner,
    WorkerRunOutcome,
    WorkerRunResult,
)


DEFAULT_WORKER_LEASE_DURATION = timedelta(seconds=30)
WORKER_RETRY_BACKOFF_SECONDS = (1.0, 2.0, 4.0)


class WorkerCommandStatus(StrEnum):
    """一次 Worker 启动命令的非正文结果。"""

    BUSY = "busy"
    IDLE = "idle"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    STOPPED = "stopped"


@dataclass(frozen=True, slots=True)
class WorkerCommandResult:
    """启动命令返回的非正文统计。"""

    status: WorkerCommandStatus
    completed_steps: int = 0
    last_step: BackgroundTaskStepName | None = None
    processed_count: int = 0
    attempt_count: int = 0
    retry_count: int = 0
    error_code: str | None = None
    task_id: UUID | None = None
    failure_state_commit: str | None = None


def run_worker(
    *,
    worker: BackgroundTaskWorker,
    lock_connection: psycopg.Connection,
    owner_id: UUID,
    contact_id: UUID,
    worker_id: UUID,
    task_id: UUID | None = None,
    retry_repository: PostgresBackgroundTaskRepository | None = None,
    extraction_runtime_mode: ExtractionRuntimeMode | None = None,
    configuration_repository: PostgresBackgroundTaskRepository | None = None,
    sleep: Callable[[float], None] = time.sleep,
    progress_callback: Callable[[WorkerRunResult, int], None] | None = None,
    stop_event: Event | None = None,
) -> WorkerCommandResult:
    """在一个全局锁内串行执行一个联系人任务。

    ``progress_callback(result, retry_count)`` 在每步结果产生后调用
    一次（结果含步骤名与计数，附带截至当前的累计重试数），供进程内
    宿主实时推送进度；CLI 调用方不传则保持原行为。
    指定 ``task_id`` 时只领取原任务；``retry_repository`` 只用于在
    已取得全局锁后显式恢复该失败任务，不自动恢复其他任务。
    """

    if retry_repository is not None and task_id is None:
        raise ValueError("恢复任务必须明确指定 task_id。")
    if extraction_runtime_mode is not None:
        if (not isinstance(extraction_runtime_mode, ExtractionRuntimeMode) or task_id is None
                or configuration_repository is None or retry_repository is not None):
            raise ValueError("指定任务模式须绑定配置仓储和任务，且不能用于失败恢复。")
    elif configuration_repository is not None:
        raise ValueError("配置仓储必须与显式运行模式一起提供。")
    if stop_event is not None and stop_event.is_set():
        return WorkerCommandResult(status=WorkerCommandStatus.STOPPED, task_id=task_id)
    if not try_acquire_global_worker_lock(lock_connection):
        return WorkerCommandResult(status=WorkerCommandStatus.BUSY)

    completed_steps = 0
    last_step: BackgroundTaskStepName | None = None
    processed_count = 0
    attempt_count = 0
    retry_count = 0
    current_task_id = task_id
    try:
        if extraction_runtime_mode is not None:
            assert configuration_repository is not None and task_id is not None
            configuration_repository.configure_extraction_runtime(
                owner_id=owner_id, contact_id=contact_id, task_id=task_id,
                config=runtime_config_for_mode(extraction_runtime_mode),
            )
        if retry_repository is not None:
            # CLI 完成配置预检查且拿到全局锁后，才改变失败原任务状态。
            assert task_id is not None
            retry_repository.retry_failed_task(
                owner_id=owner_id, contact_id=contact_id, task_id=task_id,
            )
        while True:
            if stop_event is not None and stop_event.is_set():
                return WorkerCommandResult(
                    status=WorkerCommandStatus.STOPPED, completed_steps=completed_steps,
                    last_step=last_step, processed_count=processed_count,
                    attempt_count=attempt_count, retry_count=retry_count,
                    task_id=current_task_id,
                )
            result = worker.run_once(
                owner_id=owner_id,
                contact_id=contact_id,
                worker_id=worker_id,
                task_id=current_task_id,
            )
            current_task_id = result.task_id or current_task_id
            last_step = result.step_name
            processed_count = result.processed_count
            attempt_count = result.attempt_count
            if progress_callback is not None:
                progress_callback(result, retry_count)
            if (
                result.error_code == "trace_write_failed"
                and result.failure_state_commit == "unknown"
            ):
                # 原租约可能仍有效；结束本次运行，不能下一轮 idle 覆盖主错误。
                return WorkerCommandResult(
                    status=(
                        WorkerCommandStatus.STOPPED
                        if result.outcome is WorkerRunOutcome.STOPPED
                        else WorkerCommandStatus.FAILED
                    ),
                    completed_steps=completed_steps,
                    last_step=last_step,
                    processed_count=processed_count,
                    attempt_count=attempt_count,
                    retry_count=retry_count,
                    task_id=current_task_id,
                    error_code=result.error_code,
                    failure_state_commit="unknown",
                )
            if result.outcome is WorkerRunOutcome.STOPPED:
                return WorkerCommandResult(
                    status=WorkerCommandStatus.STOPPED, completed_steps=completed_steps,
                    last_step=last_step, processed_count=processed_count,
                    attempt_count=attempt_count, retry_count=retry_count,
                    task_id=current_task_id,
                )
            if result.outcome is WorkerRunOutcome.IDLE:
                return WorkerCommandResult(
                    status=WorkerCommandStatus.IDLE,
                    completed_steps=completed_steps,
                    last_step=last_step,
                    processed_count=processed_count,
                    attempt_count=attempt_count,
                    retry_count=retry_count,
                    task_id=current_task_id,
                )
            if result.outcome is WorkerRunOutcome.SUCCEEDED:
                completed_steps += 1
                if result.step_name in VERIFY_STEPS:
                    return WorkerCommandResult(
                        status=WorkerCommandStatus.SUCCEEDED,
                        completed_steps=completed_steps,
                        last_step=last_step,
                        processed_count=processed_count,
                        attempt_count=attempt_count,
                        retry_count=retry_count,
                        task_id=current_task_id,
                    )
                continue
            if result.outcome is WorkerRunOutcome.RETRYABLE:
                retry_count += 1
                if stop_event is None:
                    sleep(_retry_backoff(result.attempt_count))
                else:
                    stop_event.wait(_retry_backoff(result.attempt_count))
                continue
            return WorkerCommandResult(
                status=WorkerCommandStatus.FAILED,
                completed_steps=completed_steps,
                last_step=last_step,
                processed_count=processed_count,
                attempt_count=attempt_count,
                retry_count=retry_count,
                error_code=result.error_code,
                task_id=current_task_id,
                failure_state_commit=result.failure_state_commit,
            )
    finally:
        if not getattr(lock_connection, "closed", False):
            release_global_worker_lock(lock_connection)


def worker_main(argv: list[str] | None = None) -> int:
    """启动一个全局串行 Worker，处理指定联系人最早的一个任务。"""

    load_project_env()
    parser = argparse.ArgumentParser(
        prog="notalone-task-worker",
        description="串行执行指定联系人最早的一个后台任务。",
    )
    parser.add_argument("--contact-id", required=True, type=UUID)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument(
        "--retry-task-id", type=UUID,
        help="显式恢复同联系人已失败的原任务并继续执行。",
    )
    selection.add_argument("--task-id", type=UUID, help="指定尚未领取提取步骤的原任务。")
    parser.add_argument("--extraction-runtime-mode", choices=[mode.value for mode in ExtractionRuntimeMode],
                        help="与--task-id成对使用，在领取前固定该任务的提取合同。")
    args = parser.parse_args(argv)
    if (args.task_id is None) != (args.extraction_runtime_mode is None):
        parser.error("--task-id与--extraction-runtime-mode必须成对提供，失败恢复不能改模式。")

    database_url = os.environ.get("NOTALONE_DATABASE_URL", "").strip()
    owner_value = os.environ.get("NOTALONE_OWNER_ID", "").strip()
    if not database_url:
        return _fail("缺少 NOTALONE_DATABASE_URL 环境变量。")
    if not owner_value:
        return _fail("缺少 NOTALONE_OWNER_ID 环境变量。")
    try:
        owner_id = UUID(owner_value)
    except ValueError:
        return _fail("NOTALONE_OWNER_ID 不是合法 UUID。")

    from notalone.scopes import ContactScope

    scope = ContactScope(owner_id, args.contact_id)
    try:
        if not owner_exists(owner_id, database_url):
            return _fail("Worker 准备失败：owner 不存在。")
        if not contact_exists(scope, database_url):
            return _fail("Worker 准备失败：联系人不存在。")
        extraction_runner = PostgresMemoryExtractionRunner(database_url)
        repository = PostgresBackgroundTaskRepository(database_url)
        index_repository = PostgresContactMemoryIndexRepository(database_url)
        worker = BackgroundTaskWorker(
            repository=repository,
            extraction_runner=extraction_runner,
            lease_duration=DEFAULT_WORKER_LEASE_DURATION,
            index_repository=index_repository,
            deletion_repository=PostgresSourceDeletionRepository(database_url),
        )
    except Exception:
        return _fail("Worker 准备失败：数据库或模型配置不可用。")

    try:
        with psycopg.connect(database_url, autocommit=True) as lock_connection:
            result = run_worker(
                worker=worker,
                lock_connection=lock_connection,
                owner_id=owner_id,
                contact_id=args.contact_id,
                worker_id=uuid4(),
                task_id=args.retry_task_id or args.task_id,
                retry_repository=(
                    repository if args.retry_task_id is not None else None
                ),
                extraction_runtime_mode=(ExtractionRuntimeMode(args.extraction_runtime_mode)
                                         if args.extraction_runtime_mode is not None else None),
                configuration_repository=(repository if args.task_id is not None else None),
            )
    except BackgroundTaskNotFoundError:
        return _fail("Worker 恢复被拒绝：task_not_found。" if args.retry_task_id is not None
                     else "Worker 运行被拒绝：task_not_found。")
    except BackgroundTaskStateError:
        return _fail("Worker 恢复被拒绝：task_retry_conflict。" if args.retry_task_id is not None
                     else "Worker 运行被拒绝：task_runtime_conflict。")
    except Exception:
        return _fail("Worker 执行失败。")

    output = [
        f"status={result.status.value}",
        f"steps={result.completed_steps}",
        f"step={result.last_step.value if result.last_step else 'none'}",
        f"processed={result.processed_count}",
        f"attempts={result.attempt_count}",
        f"retries={result.retry_count}",
    ]
    if result.error_code is not None:
        output.append(f"error={result.error_code}")
    if result.failure_state_commit is not None:
        output.append(f"failure_state_commit={result.failure_state_commit}")
    print(" ".join(output))
    return 1 if result.status is WorkerCommandStatus.FAILED else 0


def _retry_backoff(attempt_count: int) -> float:
    index = max(0, min(attempt_count - 1, len(WORKER_RETRY_BACKOFF_SECONDS) - 1))
    return WORKER_RETRY_BACKOFF_SECONDS[index]


def _fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 2


def _positive_days(value: str) -> int:
    try:
        days = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("留存天数必须是正整数。") from None
    if days <= 0:
        raise argparse.ArgumentTypeError("留存天数必须是正整数。")
    return days


def cleanup_main(argv: list[str] | None = None) -> int:
    """清理超过留存期的终态后台任务，只输出删除数量。"""

    load_project_env()
    parser = argparse.ArgumentParser(
        prog="notalone-task-cleanup",
        description="清理超过留存期的终态后台任务元数据。",
    )
    parser.add_argument(
        "--retention-days",
        type=_positive_days,
        default=TERMINAL_TASK_RETENTION.days,
    )
    args = parser.parse_args(argv)
    database_url = os.environ.get("NOTALONE_DATABASE_URL", "").strip()
    if not database_url:
        print("缺少 NOTALONE_DATABASE_URL 环境变量。", file=sys.stderr)
        return 2
    try:
        deleted = PostgresBackgroundTaskRepository(
            database_url
        ).cleanup_terminal_tasks(
            retention=timedelta(days=args.retention_days)
        )
    except BackgroundTaskPersistenceError:
        print("后台任务清理失败。", file=sys.stderr)
        return 1
    print(f"deleted={deleted}")
    return 0


if __name__ == "__main__":
    raise SystemExit(cleanup_main())
