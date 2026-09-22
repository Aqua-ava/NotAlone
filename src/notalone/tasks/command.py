"""后台任务维护命令。"""

from __future__ import annotations

import argparse
import os
import sys
import time
from dataclasses import dataclass
from datetime import timedelta
from enum import StrEnum
from typing import Callable
from uuid import UUID, uuid4

import psycopg

from notalone.memory_extraction.cli_support import contact_exists, owner_exists
from notalone.persistence.background_tasks import (
    TERMINAL_TASK_RETENTION,
    BackgroundTaskPersistenceError,
    PostgresBackgroundTaskRepository,
)
from notalone.persistence.contact_memory_index import (
    PostgresContactMemoryIndexRepository,
)
from notalone.persistence.locks import (
    release_global_worker_lock,
    try_acquire_global_worker_lock,
)
from notalone.runtime_config import load_project_env
from notalone.tasks.models import BackgroundTaskStepName, VERIFY_STEPS
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


def run_worker(
    *,
    worker: BackgroundTaskWorker,
    lock_connection: psycopg.Connection,
    owner_id: UUID,
    contact_id: UUID,
    worker_id: UUID,
    sleep: Callable[[float], None] = time.sleep,
    progress_callback: Callable[[WorkerRunResult, int], None] | None = None,
) -> WorkerCommandResult:
    """在一个全局锁内串行执行一个联系人任务。

    ``progress_callback(result, retry_count)`` 在每步结果产生后调用
    一次（结果含步骤名与计数，附带截至当前的累计重试数），供进程内
    宿主实时推送进度；CLI 调用方不传则保持原行为。
    """

    if not try_acquire_global_worker_lock(lock_connection):
        return WorkerCommandResult(status=WorkerCommandStatus.BUSY)

    completed_steps = 0
    last_step: BackgroundTaskStepName | None = None
    processed_count = 0
    attempt_count = 0
    retry_count = 0
    try:
        while True:
            result = worker.run_once(
                owner_id=owner_id,
                contact_id=contact_id,
                worker_id=worker_id,
            )
            last_step = result.step_name
            processed_count = result.processed_count
            attempt_count = result.attempt_count
            if progress_callback is not None:
                progress_callback(result, retry_count)
            if result.outcome is WorkerRunOutcome.IDLE:
                return WorkerCommandResult(
                    status=WorkerCommandStatus.IDLE,
                    completed_steps=completed_steps,
                    last_step=last_step,
                    processed_count=processed_count,
                    attempt_count=attempt_count,
                    retry_count=retry_count,
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
                    )
                continue
            if result.outcome is WorkerRunOutcome.RETRYABLE:
                retry_count += 1
                sleep(_retry_backoff(result.attempt_count))
                continue
            return WorkerCommandResult(
                status=WorkerCommandStatus.FAILED,
                completed_steps=completed_steps,
                last_step=last_step,
                processed_count=processed_count,
                attempt_count=attempt_count,
                retry_count=retry_count,
                error_code=result.error_code,
            )
    finally:
        release_global_worker_lock(lock_connection)


def worker_main(argv: list[str] | None = None) -> int:
    """启动一个全局串行 Worker，处理指定联系人最早的一个任务。"""

    load_project_env()
    parser = argparse.ArgumentParser(
        prog="notalone-task-worker",
        description="串行执行指定联系人最早的一个后台任务。",
    )
    parser.add_argument("--contact-id", required=True, type=UUID)
    args = parser.parse_args(argv)

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
            )
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
