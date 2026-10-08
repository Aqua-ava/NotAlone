"""后台任务的持久状态与显式恢复入口，只投影非正文元数据。"""

from uuid import UUID

from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.tasks.models import BackgroundTask


class TaskService:
    def __init__(self, *, repository: PostgresBackgroundTaskRepository) -> None:
        self._repository = repository

    def status(
        self, *, owner_id: UUID, contact_id: UUID, task_id: UUID,
    ) -> dict[str, object]:
        task = self._repository.get_task(
            owner_id=owner_id, contact_id=contact_id, task_id=task_id,
        )
        return _task_payload(task)

    def retry(
        self, *, owner_id: UUID, contact_id: UUID, task_id: UUID,
    ) -> dict[str, object]:
        task = self._repository.retry_failed_task(
            owner_id=owner_id, contact_id=contact_id, task_id=task_id,
        )
        return {"task_id": str(task.task_id), "status": task.status.value}

    def defer(
        self, *, owner_id: UUID, contact_id: UUID, task_id: UUID,
        error_code: str = "execution_resources_unavailable",
    ) -> None:
        self._repository.record_queued_reason(
            owner_id=owner_id, contact_id=contact_id, task_id=task_id,
            error_code=error_code,
        )


def _task_payload(task: BackgroundTask) -> dict[str, object]:
    return {
        "task_id": str(task.task_id),
        "task_type": task.task_type.value,
        "status": task.status.value,
        "step": task.current_step.value,
        "message_count": task.message_count,
        "retry_count": task.retry_count,
        "error_code": task.last_error_code,
        "steps": [{
            "name": step.name.value,
            "status": step.status.value,
            "attempt_count": step.attempt_count,
            "processed_count": step.processed_count,
            "total_count": step.total_count,
            "error_code": step.last_error_code,
        } for step in task.steps],
    }
