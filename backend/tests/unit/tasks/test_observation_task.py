"""观察记忆任务的领域模型接缝测试。"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone
from uuid import uuid4

from notalone.tasks.models import (
    OBSERVATION_TASK_STEPS,
    BackgroundTask,
    BackgroundTaskStatus,
    BackgroundTaskStepName,
    BackgroundTaskType,
)


class ObservationTaskModelTest(unittest.TestCase):
    def test_observation_task_type_has_contact_scope_without_source(self) -> None:
        task_id = uuid4()
        owner_id = uuid4()
        contact_id = uuid4()
        task = BackgroundTask(
            task_id=task_id,
            owner_id=owner_id,
            contact_id=contact_id,
            source_document_id=None,
            task_type=BackgroundTaskType.OBSERVATION,
            status=BackgroundTaskStatus.QUEUED,
            current_step=BackgroundTaskStepName.EXTRACT_MEMORY,
            message_count=0,
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
            steps=(),
        )

        self.assertEqual(task.task_type, BackgroundTaskType.OBSERVATION)
        self.assertIsNone(task.source_document_id)
        self.assertEqual(
            tuple(name for name, _ in OBSERVATION_TASK_STEPS),
            (
                BackgroundTaskStepName.EXTRACT_MEMORY,
                BackgroundTaskStepName.INDEX,
                BackgroundTaskStepName.VERIFY,
            ),
        )


if __name__ == "__main__":
    unittest.main()
