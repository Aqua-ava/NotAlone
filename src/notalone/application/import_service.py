"""导入与记忆提取任务的统一应用层入口。

导入预览/提交复用既有 ingest 命令的同一逻辑（单联系人归属校验、
混联系人拒绝、同一事务写入与幂等）；任务触发在进程内启动全局
串行 Worker 线程（与 CLI task-worker 共用 run_worker 同一执行路径
与全局锁），步进进度经事件总线实时推送（TASK_PROGRESS）。
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from uuid import UUID, uuid4

import psycopg

from notalone.ingest.import_command import (
    IngestRepository,
    import_file,
)
from notalone.ingest.models import ContactSelection, ImportConfirmationRequest
from notalone.ingest.preview import build_preview
from notalone.tasks.command import run_worker
from notalone.tasks.worker import BackgroundTaskWorker
from notalone.application.model_priority import ModelPriorityControl, ModelWorkStopped


class ImportService:
    """导入预览与正式提交。"""

    __slots__ = ("_repository",)

    def __init__(self, *, repository: IngestRepository) -> None:
        self._repository = repository

    def preview(self, *, path: str) -> dict[str, object]:
        """完整校验文件并返回结构化预览结果。"""

        preview = build_preview(Path(path))
        return {
            "valid": True,
            "file_name": preview.file_name,
            "record_count": preview.record_count,
            "kind_counts": dict(preview.kind_counts),
            "owner_channel_identity": {
                "external_id": preview.owner_channel_identity.external_id,
                "observed_name": preview.owner_channel_identity.observed_name,
            },
            "contact_channel_identity": {
                "external_id": preview.channel_identity.external_id,
                "observed_name": preview.channel_identity.observed_name,
            },
        }

    def commit(
        self,
        *,
        path: str,
        owner_id: UUID,
        selection: ContactSelection,
    ) -> dict[str, object]:
        """确认联系人后导入；首启 owner 仅可建立从未绑定过的渠道身份。"""

        result = import_file(
            path=Path(path),
            owner_id=owner_id,
            initialize_first_owner_identity=True,
            confirmation=ImportConfirmationRequest(selection=selection),
            repository=self._repository,
        )
        return {
            "imported_count": (
                result.message_count if result.outcome == "imported" else 0
            ),
            "skipped_duplicates": (
                result.message_count if result.outcome == "already_imported" else 0
            ),
            "contact_id": str(result.contact_id),
            "task_id": str(result.task_id),
        }


# 任务进度更新：一次步骤结果的状态投影。
@dataclass(frozen=True, slots=True)
class TaskProgressUpdate:
    owner_id: UUID
    contact_id: UUID
    task_id: UUID | None
    step: str
    status: str
    processed_count: int
    attempt_count: int
    retry_count: int
    error_code: str | None = None

    def as_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "task_id": str(self.task_id) if self.task_id is not None else None,
            "step": self.step,
            "status": self.status,
            "processed_count": self.processed_count,
            "attempt_count": self.attempt_count,
            "retry_count": self.retry_count,
        }
        if self.error_code is not None:
            payload["error_code"] = self.error_code
        return payload


ProgressEvent = Callable[[TaskProgressUpdate], None]


class TaskHost:
    """进程内全局串行任务执行宿主（ADR-018 全局串行）。

    每个联系人最多一个执行中线程；与命令行 Worker 共用同一全局锁，
    保证同一任务不会被两个执行者并发处理。任务触发始终由用户动作
    发起，不引入定时器或无人值守调度。
    """

    __slots__ = (
        "_event_publisher",
        "_lock_connection_builder",
        "_lock",
        "_progress",
        "_threads",
        "_worker_builder",
        "_model_priority",
        "_stopped",
        "_stop_complete",
        "_connections",
    )

    def __init__(
        self,
        *,
        worker_builder: Callable[[], BackgroundTaskWorker],
        lock_connection_builder: Callable[[], psycopg.Connection],
        event_publisher: ProgressEvent,
        model_priority: ModelPriorityControl | None = None,
    ) -> None:
        self._worker_builder = worker_builder
        self._lock_connection_builder = lock_connection_builder
        self._event_publisher = event_publisher
        self._model_priority = model_priority
        self._stopped = threading.Event()
        self._stop_complete = threading.Event()
        self._connections: dict[int, psycopg.Connection] = {}
        # 多个 HTTP 线程与任务线程并发读写这两个 dict；必须持锁完成
        # check-then-act，否则并发 start 会重复建线程、先结束的线程会
        # 误删仍在运行线程的条目（current() 在运行中报 finished）。
        self._lock = threading.RLock()
        self._threads: dict[tuple[UUID, UUID], threading.Thread] = {}
        self._progress: dict[tuple[UUID, UUID], dict[str, object]] = {}

    def start(
        self, *, owner_id: UUID, contact_id: UUID, task_id: UUID | None = None,
    ) -> dict[str, object]:
        """触发一个联系人任务；已有执行中线程时返回 busy。"""

        with self._lock:
            if self._stopped.is_set():
                raise ModelWorkStopped("任务宿主正在停止。")
            scope = (owner_id, contact_id)
            existing = self._threads.get(scope)
            if existing is not None and existing.is_alive():
                return {"status": "busy"}
            thread = threading.Thread(
                target=self._run,
                name=f"notalone-task-{contact_id}",
                args=(owner_id, contact_id, task_id),
                daemon=True,
            )
            self._threads[scope] = thread
            self._set_progress(
                scope,
                {
                    "task_id": str(task_id) if task_id is not None else None,
                    "step": "claiming",
                    "status": "running",
                    "processed_count": 0,
                    "attempt_count": 0,
                    "retry_count": 0,
                },
            )
            thread.start()
            return {"status": "started"}

    def stop(self, *, timeout: float = 4.0) -> None:
        """拒绝新工作并有界等待；无法中断的旧调用依靠原租约恢复。"""

        self._stopped.set()
        if self._model_priority is not None:
            self._model_priority.stop()
        if self._stop_complete.is_set():
            return
        deadline = time.monotonic() + min(4.0, max(0.0, timeout))
        with self._lock:
            threads = tuple(self._threads.values())
        for thread in threads:
            if thread is not threading.current_thread():
                thread.join(timeout=max(0.0, deadline - time.monotonic()))
        # 模型可能仍在调用中；会话锁不能跟随不可中断调用无限占用。
        with self._lock:
            connections = tuple(self._connections.values())
        for connection in connections:
            connection.close()
            with self._lock:
                self._connections.pop(id(connection), None)
        self._stop_complete.set()

    def current(self, *, owner_id: UUID, contact_id: UUID) -> dict[str, object]:
        """返回当前进度快照；无任务时返回 idle。"""

        with self._lock:
            scope = (owner_id, contact_id)
            thread = self._threads.get(scope)
            if thread is not None and thread.is_alive():
                return {
                    "status": "running",
                    "progress": self._progress.get(scope),
                }
            progress = self._progress.get(scope)
            if progress is not None:
                return {"status": "finished", "progress": progress}
            return {"status": "idle", "progress": None}

    def _run(
        self,
        owner_id: UUID,
        contact_id: UUID,
        task_id: UUID | None,
    ) -> None:
        """在全局锁内串行执行任务，每步经事件回调实时推送进度。"""

        current_task_id = task_id

        def on_progress(result, retry_count: int) -> None:
            nonlocal current_task_id
            current_task_id = result.task_id or current_task_id
            self._record(
                TaskProgressUpdate(
                    owner_id=owner_id,
                    contact_id=contact_id,
                    task_id=current_task_id,
                    step=(
                        result.step_name.value
                        if result.step_name is not None
                        else "none"
                    ),
                    status=(
                        result.outcome.value
                        if getattr(result, "outcome", None) is not None
                        else "unknown"
                    ),
                    processed_count=getattr(result, "processed_count", 0),
                    attempt_count=getattr(result, "attempt_count", 0),
                    retry_count=retry_count,
                )
            )

        lock_connection = None
        try:
            if self._stopped.is_set():
                return
            worker = self._worker_builder()
            lock_connection = self._lock_connection_builder()
            with self._lock:
                if self._stopped.is_set():
                    return
                self._connections[id(lock_connection)] = lock_connection
            result = run_worker(
                worker=worker,
                lock_connection=lock_connection,
                owner_id=owner_id,
                contact_id=contact_id,
                worker_id=uuid4(),
                task_id=task_id,
                progress_callback=on_progress,
                stop_event=self._stopped,
            )
        except Exception:
            self._record(
                TaskProgressUpdate(
                    owner_id=owner_id,
                    contact_id=contact_id,
                    task_id=current_task_id,
                    step="unknown",
                    status="failed",
                    processed_count=0,
                    attempt_count=0,
                    retry_count=0,
                    error_code="internal_error",
                )
            )
        else:
            self._record(
                TaskProgressUpdate(
                    owner_id=owner_id,
                    contact_id=contact_id,
                    task_id=result.task_id or current_task_id,
                    step=(
                        result.last_step.value
                        if result.last_step is not None
                        else "none"
                    ),
                    status=result.status.value,
                    processed_count=result.processed_count,
                    attempt_count=result.attempt_count,
                    retry_count=result.retry_count,
                    error_code=result.error_code,
                )
            )
        finally:
            try:
                if lock_connection is not None:
                    lock_connection.close()
            finally:
                # 关闭错误也不能留下线程登记；旧线程仅能清除自己的条目。
                current = threading.current_thread()
                with self._lock:
                    if lock_connection is not None:
                        self._connections.pop(id(lock_connection), None)
                    scope = (owner_id, contact_id)
                    if self._threads.get(scope) is current:
                        self._threads.pop(scope, None)

    def _record(self, update: TaskProgressUpdate) -> None:
        self._set_progress((update.owner_id, update.contact_id), update.as_payload())
        if update.task_id is None:
            return
        try:
            self._event_publisher(update)
        except Exception:
            # 事件通道失败不影响任务执行本身。
            pass

    def _set_progress(
        self, scope: tuple[UUID, UUID], progress: dict[str, object],
    ) -> None:
        with self._lock:
            self._progress[scope] = progress
