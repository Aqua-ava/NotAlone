"""来源删除的用户入口：持久化请求、显式恢复和无模型 Worker。"""

from datetime import timedelta
from threading import Lock, Thread
from uuid import UUID, uuid4

import psycopg

from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
from notalone.persistence.source_tasks import PostgresSourceTasks
from notalone.tasks.command import run_worker, WorkerCommandStatus
from notalone.tasks.models import BackgroundTaskStatus
from notalone.tasks.worker import BackgroundTaskWorker


class SourceService:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url
        self._sources = PostgresSourceTasks(database_url)
        self._tasks = PostgresBackgroundTaskRepository(database_url)
        self._lock = Lock()
        self._running: set[tuple[UUID, UUID]] = set()

    def list_sources(self, owner_id: UUID, contact_id: UUID) -> list[dict[str, object]]:
        return self._sources.list_sources(owner_id, contact_id)

    def delete(self, owner_id: UUID, contact_id: UUID, source_id: UUID) -> dict[str, object]:
        task_id = self._sources.request_delete(owner_id, contact_id, source_id)
        task = self._tasks.get_task(owner_id=owner_id, contact_id=contact_id, task_id=task_id)
        if task.status is BackgroundTaskStatus.FAILED:
            task = self._tasks.retry_failed_task(owner_id=owner_id, contact_id=contact_id, task_id=task_id)
        if task.status is not BackgroundTaskStatus.SUCCEEDED:
            self._start(owner_id, contact_id)
        return {"task_id": str(task_id), "status": task.status.value}

    def _start(self, owner_id: UUID, contact_id: UUID) -> None:
        scope = (owner_id, contact_id)
        with self._lock:
            if scope in self._running:
                return
            self._running.add(scope)
        Thread(target=self._drain, args=scope, daemon=True).start()

    def _drain(self, owner_id: UUID, contact_id: UUID) -> None:
        """处理已请求的删除；重启或其他 Worker 忙时由用户显式继续。

        HTTP 和界面始终重读数据库任务，不把线程存在或消失当作删除结果。
        """
        try:
            worker = BackgroundTaskWorker(
                repository=self._tasks,
                deletion_repository=PostgresSourceDeletionRepository(self._database_url),
                lease_duration=timedelta(minutes=10),
            )
            with psycopg.connect(self._database_url, autocommit=True) as connection:
                while True:
                    result = run_worker(
                        worker=worker, lock_connection=connection,
                        owner_id=owner_id, contact_id=contact_id, worker_id=uuid4(),
                    )
                    if result.status is not WorkerCommandStatus.SUCCEEDED:
                        break
        except Exception:
            # 不把底层异常或连接信息写入日志；持久化租约与状态支持恢复。
            pass
        finally:
            with self._lock:
                self._running.discard((owner_id, contact_id))
