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
from typing import Callable, Protocol
from uuid import UUID, uuid4

import psycopg

from notalone.ingest.import_command import (
    IngestRepository,
    import_file,
)
from notalone.ingest.models import ContactSelection, ImportConfirmationRequest
from notalone.ingest.preview import build_preview
from notalone.tasks.command import run_worker, WorkerCommandStatus
from notalone.tasks.worker import BackgroundTaskWorker
from notalone.application.model_priority import ModelPriorityControl, ModelWorkStopped
from notalone.persistence.background_tasks import (
    BackgroundTaskNotFoundError, PostgresBackgroundTaskRepository,
)
from notalone.tasks.models import BackgroundTaskStatus


class ImportRepository(IngestRepository, Protocol):
    """导入写入与当前本人身份只读预检的应用边界。"""

    def validate_preview_identity(
        self,
        *,
        owner_id: UUID,
        owner_external_id: str,
        contact_external_id: str,
        contact_id: UUID | None = None,
    ) -> None: ...


class ImportService:
    """导入预览与正式提交。"""

    __slots__ = ("_repository",)

    def __init__(self, *, repository: ImportRepository) -> None:
        self._repository = repository

    def preview(
        self,
        *,
        path: str,
        owner_id: UUID,
        contact_id: UUID | None = None,
    ) -> dict[str, object]:
        """完整校验文件并返回结构化预览结果。"""

        preview = build_preview(Path(path))
        self._repository.validate_preview_identity(
            owner_id=owner_id,
            owner_external_id=preview.owner_channel_identity.external_id,
            contact_external_id=preview.channel_identity.external_id,
            contact_id=contact_id,
        )
        return {
            "valid": True,
            "file_name": preview.file_name,
            "content_sha256": preview.content_sha256,
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
        expected_content_sha256: str | None = None,
    ) -> dict[str, object]:
        """确认联系人后导入；首启 owner 仅可建立从未绑定过的渠道身份。"""

        result = import_file(
            path=Path(path),
            owner_id=owner_id,
            initialize_first_owner_identity=True,
            expected_content_sha256=expected_content_sha256,
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
    failure_state_commit: str | None = None

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
        if self.failure_state_commit is not None:
            payload["failure_state_commit"] = self.failure_state_commit
        return payload


ProgressEvent = Callable[[TaskProgressUpdate], None]


class TaskHost:
    """保留当前后端收到的任务唤醒，执行仍受全局锁与联系人租约保护。"""

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
        "_pending",
        "_active",
        "_task_repository",
    )

    def __init__(
        self,
        *,
        worker_builder: Callable[[], BackgroundTaskWorker],
        lock_connection_builder: Callable[[], psycopg.Connection],
        event_publisher: ProgressEvent,
        model_priority: ModelPriorityControl | None = None,
        task_repository: PostgresBackgroundTaskRepository | None = None,
    ) -> None:
        self._worker_builder = worker_builder
        self._lock_connection_builder = lock_connection_builder
        self._event_publisher = event_publisher
        self._model_priority = model_priority
        self._task_repository = task_repository
        self._stopped = threading.Event()
        self._stop_complete = threading.Event()
        self._connections: dict[int, psycopg.Connection] = {}
        # 多个 HTTP 线程与任务线程并发读写这两个 dict；必须持锁完成
        # check-then-act，否则并发 start 会重复建线程、先结束的线程会
        # 误删仍在运行线程的条目（current() 在运行中报 finished）。
        self._lock = threading.RLock()
        self._threads: dict[tuple[UUID, UUID], threading.Thread] = {}
        self._progress: dict[tuple[UUID, UUID], dict[str, object]] = {}
        self._pending: dict[tuple[UUID, UUID], dict[UUID | None, bool]] = {}
        self._active: dict[tuple[UUID, UUID], UUID | None] = {}

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
            self._pending[scope] = {task_id: False}
            self._launch(scope, task_id)
            return {"status": "started"}

    def wake(
        self, *, owner_id: UUID, contact_id: UUID, task_id: UUID,
    ) -> dict[str, object]:
        """导入提交后的可靠唤醒；合并同任务，不扫描其他持久队列。"""

        with self._lock:
            if self._stopped.is_set():
                raise ModelWorkStopped("任务宿主正在停止。")
            if self._task_repository is None:
                raise RuntimeError("自动处理缺少持久任务状态仓储。")
            scope = (owner_id, contact_id)
            # 显式执行可能在锁忙后结束；同任务唤醒仍须保留可靠等待。
            self._pending.setdefault(scope, {})[task_id] = True
            if scope in self._active and self._active[scope] == task_id:
                return {"status": "busy"}
            existing = self._threads.get(scope)
            if existing is not None and existing.is_alive():
                return {"status": "queued"}
            self._launch(scope, task_id)
            return {"status": "started"}

    def _launch(self, scope: tuple[UUID, UUID], task_id: UUID | None) -> None:
        owner_id, contact_id = scope
        thread = threading.Thread(
            target=self._run,
            name=f"notalone-task-{contact_id}",
            args=(owner_id, contact_id),
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

    def _run(self, owner_id: UUID, contact_id: UUID) -> None:
        scope = (owner_id, contact_id)
        current = threading.current_thread()
        try:
            while not self._stopped.is_set():
                with self._lock:
                    pending = self._pending.get(scope, {})
                    if not pending:
                        # 与 wake 的登记共享锁，退出窗口不会吞掉新任务。
                        self._pending.pop(scope, None)
                        if self._threads.get(scope) is current:
                            self._threads.pop(scope, None)
                        return
                    task_id = next(iter(pending))
                    reliable = pending.pop(task_id)
                    self._active[scope] = task_id
                delay = 0.25
                while not self._stopped.is_set():
                    if reliable and task_id is not None:
                        try:
                            if not self._can_execute(scope, task_id):
                                break
                        except Exception:
                            self._defer(scope, task_id, "execution_resources_unavailable")
                            break
                    status = self._execute(owner_id, contact_id, task_id)
                    if not reliable or status not in {
                        WorkerCommandStatus.BUSY, WorkerCommandStatus.IDLE,
                    }:
                        break
                    if self._stopped.wait(delay):
                        break
                    delay = min(30.0, delay * 2)
                with self._lock:
                    self._active.pop(scope, None)
        finally:
            with self._lock:
                if self._threads.get(scope) is current:
                    self._active.pop(scope, None)
                    self._threads.pop(scope, None)
                if self._stopped.is_set():
                    self._pending.pop(scope, None)

    def _can_execute(self, scope: tuple[UUID, UUID], task_id: UUID) -> bool:
        if self._task_repository is None:
            return True
        try:
            task = self._task_repository.get_task(
                owner_id=scope[0], contact_id=scope[1], task_id=task_id,
            )
        except BackgroundTaskNotFoundError:
            return False
        return task.status not in {
            BackgroundTaskStatus.SUCCEEDED, BackgroundTaskStatus.FAILED,
            BackgroundTaskStatus.CANCELLED,
        }

    def _execute(
        self,
        owner_id: UUID,
        contact_id: UUID,
        task_id: UUID | None,
    ) -> WorkerCommandStatus:
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
                    error_code=getattr(result, "error_code", None),
                    failure_state_commit=getattr(
                        result, "failure_state_commit", None
                    ),
                )
            )

        lock_connection = None
        try:
            if self._stopped.is_set():
                return WorkerCommandStatus.STOPPED
            try:
                worker = self._worker_builder()
            except ValueError:
                self._defer((owner_id, contact_id), task_id, "model_configuration_unavailable")
                return WorkerCommandStatus.FAILED
            except Exception:
                self._defer((owner_id, contact_id), task_id, "execution_resources_unavailable")
                return WorkerCommandStatus.FAILED
            try:
                lock_connection = self._lock_connection_builder()
            except Exception:
                self._defer((owner_id, contact_id), task_id, "execution_resources_unavailable")
                return WorkerCommandStatus.FAILED
            with self._lock:
                if self._stopped.is_set():
                    return WorkerCommandStatus.STOPPED
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
            return WorkerCommandStatus.FAILED
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
                    failure_state_commit=result.failure_state_commit,
                )
            )
            return result.status
        finally:
            try:
                if lock_connection is not None:
                    lock_connection.close()
            except Exception:
                # 锁连接收尾异常不能丢失当前线程中的后续唤醒。
                pass
            finally:
                with self._lock:
                    if lock_connection is not None:
                        self._connections.pop(id(lock_connection), None)

    def _defer(
        self, scope: tuple[UUID, UUID], task_id: UUID | None, error_code: str,
    ) -> None:
        if self._task_repository is not None and task_id is not None:
            try:
                self._task_repository.record_queued_reason(
                    owner_id=scope[0], contact_id=scope[1], task_id=task_id,
                    error_code=error_code,
                )
            except Exception:
                # 数据库本身不可用时无法持久记录，仍不得误报模型执行失败。
                pass
        self._record(TaskProgressUpdate(
            owner_id=scope[0], contact_id=scope[1], task_id=task_id,
            step="claiming", status="queued", processed_count=0,
            attempt_count=0, retry_count=0, error_code=error_code,
        ))

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
