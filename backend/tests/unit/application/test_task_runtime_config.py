"""任务状态仅在已有显式配置时公开冻结合同。"""

from __future__ import annotations

import unittest
from dataclasses import replace
from datetime import datetime, timezone
from unittest.mock import Mock
from uuid import uuid4

from notalone.application.task_service import TaskService
from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.tasks.models import (
    BackgroundTask, BackgroundTaskStatus, BackgroundTaskStepName,
    BackgroundTaskType, ExtractionRuntimeConfig,
)


class TaskRuntimeConfigStatusTest(unittest.TestCase):
    def setUp(self) -> None:
        self.task = BackgroundTask(
            task_id=uuid4(), owner_id=uuid4(), contact_id=uuid4(),
            source_document_id=None, task_type=BackgroundTaskType.OBSERVATION,
            status=BackgroundTaskStatus.QUEUED,
            current_step=BackgroundTaskStepName.EXTRACT_MEMORY, message_count=0,
            created_at=datetime(2033, 2, 9, tzinfo=timezone.utc),
            updated_at=datetime(2033, 2, 9, tzinfo=timezone.utc), steps=(),
        )

    def status(self, task: BackgroundTask) -> dict[str, object]:
        repository = Mock(spec=PostgresBackgroundTaskRepository)
        repository.get_task.return_value = task
        payload = TaskService(repository=repository).status(
            owner_id=task.owner_id, contact_id=task.contact_id, task_id=task.task_id,
        )
        repository.get_task.assert_called_once_with(
            owner_id=task.owner_id, contact_id=task.contact_id, task_id=task.task_id,
        )
        return payload

    def test_explicit_config_is_projected_without_internal_diagnostics(self) -> None:
        config = ExtractionRuntimeConfig.from_payload({
            "version": 1, "mode": "bounded-runtime-v1", "rule_set_sha256": "a" * 64,
        })
        task = replace(
            self.task, extraction_runtime_config=config,
            model_version="diagnostic-model", rule_version="diagnostic-rule",
        )

        payload = self.status(task)

        self.assertEqual(payload["extraction_runtime_config"], {
            "version": 1, "mode": "bounded-runtime-v1", "rule_set_sha256": "a" * 64,
        })
        self.assertNotIn("model_version", payload)
        self.assertNotIn("rule_version", payload)

    def test_historical_unconfigured_task_keeps_original_payload(self) -> None:
        self.assertEqual(self.status(self.task), {
            "task_id": str(self.task.task_id), "task_type": "observation",
            "status": "queued", "step": "extract_memory", "message_count": 0,
            "retry_count": 0, "error_code": None, "steps": [],
        })


if __name__ == "__main__":
    unittest.main()
