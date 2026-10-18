"""旧资料升级任务即使仍保存在数据库，也不能被当前 Worker 继续执行。"""

import unittest
from unittest.mock import Mock
from uuid import uuid4

from notalone.tasks.models import BackgroundTaskStepName
from notalone.tasks.worker import BackgroundTaskWorker, WorkerRunOutcome


class RetiredMemoryUpgradeTest(unittest.TestCase):
    def test_worker_only_claims_current_task_steps(self):
        repository = Mock()
        repository.claim_next_step.return_value = None
        worker = BackgroundTaskWorker(
            repository=repository, extraction_runner=Mock(), deletion_repository=Mock(),
            index_repository=Mock(), learning_runner=Mock(), organization_runner=Mock(),
        )
        result = worker.run_once(owner_id=uuid4(), contact_id=uuid4(), worker_id='synthetic-retired-task')
        self.assertEqual(result.outcome, WorkerRunOutcome.IDLE)
        supported = repository.claim_next_step.call_args.kwargs['supported_steps']
        self.assertIn(BackgroundTaskStepName.EXTRACT_MEMORY, supported)
        self.assertIn(BackgroundTaskStepName.ORGANIZE_MEMORY, supported)
        for retired in (
            BackgroundTaskStepName.PREVIEW_UPGRADE, BackgroundTaskStepName.VERIFY_UPGRADE_PREVIEW,
            BackgroundTaskStepName.APPLY_UPGRADE, BackgroundTaskStepName.VERIFY_UPGRADE_APPLY,
        ):
            self.assertNotIn(retired, supported)
