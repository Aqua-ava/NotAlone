"""嵌入宿主的既有Worker适配器；应用服务不装配数据库或任务仓储。"""

from uuid import UUID, uuid4

import psycopg

from notalone.application.model_priority import ModelPriorityControl
from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.scopes import ContactScope
from notalone.tasks.command import run_worker
from notalone.tasks.worker import BackgroundTaskWorker


class EmbeddedOrganizationDispatcher:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def __call__(self, scope: ContactScope, task_id: UUID, *, runner,
                 model_priority: ModelPriorityControl) -> None:
        worker = BackgroundTaskWorker(
            repository=PostgresBackgroundTaskRepository(self._database_url),
            organization_runner=runner,
            model_priority=model_priority,
        )
        with psycopg.connect(self._database_url, autocommit=True) as connection:
            run_worker(
                worker=worker,
                lock_connection=connection,
                owner_id=scope.owner_id,
                contact_id=scope.contact_id,
                worker_id=uuid4(),
                task_id=task_id,
                stop_event=model_priority.stop_event,
            )
