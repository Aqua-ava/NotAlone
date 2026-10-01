"""导入与记忆提取任务的统一应用层入口。

导入预览/提交复用既有 ingest 命令的同一逻辑（单联系人归属校验、
混联系人拒绝、同一事务写入与幂等）；任务触发在进程内启动全局
串行 Worker 线程（与 CLI task-worker 共用 run_worker 同一执行路径
与全局锁），步进进度经事件总线实时推送（TASK_PROGRESS）。
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from uuid import UUID, uuid4

from notalone.ingest.import_command import (
    IngestRepository,
    import_file,
)
from notalone.ingest.models import ContactSelection, ImportConfirmationRequest
from notalone.ingest.preview import build_preview
from notalone.tasks.command import run_worker
from notalone.tasks.worker import BackgroundTaskWorker


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
        }


# 任务进度更新：一次步骤结果的状态投影。
@dataclass(frozen=True, slots=True)
class TaskProgressUpdate:
    owner_id: UUID
    contact_id: UUID
    task_id: UUID
    step: str
    status: str
    processed_count: int
    attempt_count: int
    retry_count: int
    error_code: str | None = None

    def as_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "task_id": str(self.task_id),
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
    )

    def __init__(
        self,
        *,
        worker_builder: Callable[[], BackgroundTaskWorker],
        lock_connection_builder: Callable[[], object],
        event_publisher: ProgressEvent,
    ) -> None:
        self._worker_builder = worker_builder
        self._lock_connection_builder = lock_connection_builder
        self._event_publisher = event_publisher
        # 多个 HTTP 线程与任务线程并发读写这两个 dict；必须持锁完成
        # check-then-act，否则并发 start 会重复建线程、先结束的线程会
        # 误删仍在运行线程的条目（current() 在运行中报 finished）。
        self._lock = threading.RLock()
        self._threads: dict[UUID, threading.Thread] = {}
        self._progress: dict[UUID, dict[str, object]] = {}

    def start(self, *, owner_id: UUID, contact_id: UUID) -> dict[str, object]:
        """触发一个联系人任务；已有执行中线程时返回 busy。"""

        with self._lock:
            existing = self._threads.get(contact_id)
            if existing is not None and existing.is_alive():
                return {"status": "busy"}
            task_id = uuid4()
            thread = threading.Thread(
                target=self._run,
                name=f"notalone-task-{contact_id}",
                args=(owner_id, contact_id, task_id),
                daemon=True,
            )
            self._threads[contact_id] = thread
            self._set_progress(
                contact_id,
                {
                    "task_id": str(task_id),
                    "step": "claiming",
                    "status": "running",
                    "processed_count": 0,
                    "attempt_count": 0,
                    "retry_count": 0,
                },
            )
            thread.start()
            return {"status": "started"}

    def current(self, *, owner_id: UUID, contact_id: UUID) -> dict[str, object]:
        """返回当前进度快照；无任务时返回 idle。"""

        with self._lock:
            thread = self._threads.get(contact_id)
            if thread is not None and thread.is_alive():
                return {
                    "status": "running",
                    "progress": self._progress.get(contact_id),
                }
            progress = self._progress.get(contact_id)
            if progress is not None:
                return {"status": "finished", "progress": progress}
            return {"status": "idle", "progress": None}

    def _run(
        self,
        owner_id: UUID,
        contact_id: UUID,
        task_id: UUID,
    ) -> None:
        """在全局锁内串行执行任务，每步经事件回调实时推送进度。"""

        def on_progress(result, retry_count: int) -> None:
            self._record(
                TaskProgressUpdate(
                    owner_id=owner_id,
                    contact_id=contact_id,
                    task_id=task_id,
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

        try:
            worker = self._worker_builder()
            lock_connection = self._lock_connection_builder()
            result = run_worker(
                worker=worker,
                lock_connection=lock_connection,
                owner_id=owner_id,
                contact_id=contact_id,
                worker_id=task_id,
                progress_callback=on_progress,
            )
        except Exception:
            self._record(
                TaskProgressUpdate(
                    owner_id=owner_id,
                    contact_id=contact_id,
                    task_id=task_id,
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
                    task_id=task_id,
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
            # 只清除自己的条目：并发触发的重复线程不能被先结束的一方误删。
            current = threading.current_thread()
            with self._lock:
                if self._threads.get(contact_id) is current:
                    self._threads.pop(contact_id, None)

    def _record(self, update: TaskProgressUpdate) -> None:
        self._set_progress(update.contact_id, update.as_payload())
        try:
            self._event_publisher(update)
        except Exception:
            # 事件通道失败不影响任务执行本身。
            pass

    def _set_progress(self, contact_id: UUID, progress: dict[str, object]) -> None:
        self._progress[contact_id] = progress
