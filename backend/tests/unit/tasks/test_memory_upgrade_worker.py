"""升级只能由原Worker执行预览或已批准应用，核验不再次调用模型。"""

import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from notalone.tasks.models import BackgroundTaskStepName, ClaimedBackgroundTaskStep
from notalone.tasks.worker import BackgroundTaskWorker, WorkerRunOutcome
from tests.unit.tasks.test_skill_learning_worker import TaskLeaseBoundary


class MemoryUpgradeWorkerTest(unittest.TestCase):
    def test_trace_failure_keeps_explicit_error_and_never_completes_business_step(self):
        from notalone.memory_trace import TraceWriteError
        from notalone.tasks.models import BackgroundTaskStepStatus
        observed = []
        class Tasks(TaskLeaseBoundary):
            def fail_step(self, claim, *, error_code, retryable):
                observed.append((error_code, retryable))
                return BackgroundTaskStepStatus.FAILED
        class Upgrade:
            def preview(self, claim):
                raise TraceWriteError('model_response')
            def failed(self, claim, code):
                observed.append(code)
        claim = ClaimedBackgroundTaskStep(uuid4(), uuid4(), uuid4(), None, uuid4(),
            BackgroundTaskStepName.PREVIEW_UPGRADE, uuid4(), 3, 1, datetime.now(timezone.utc)+timedelta(seconds=30))
        tasks = Tasks(claim)
        result = BackgroundTaskWorker(repository=tasks, upgrade_runner=Upgrade()).run_once(
            owner_id=claim.owner_id, contact_id=claim.contact_id, worker_id=claim.worker_id)
        self.assertEqual(result.error_code, 'trace_write_failed')
        self.assertEqual(observed, [('trace_write_failed', True), 'trace_write_failed'])
        self.assertEqual(tasks.completed, [])

    def test_existing_worker_runs_only_the_claimed_fixed_upgrade_step(self):
        observed = []
        class UpgradeBoundary:
            def preview(self, claim):
                observed.append('preview')
                return 2
            def apply(self, claim):
                observed.append('apply')
                return 2
            def verify(self, claim):
                observed.append('verify')
            def failed(self, claim, code):
                observed.append('failed')
        claim = ClaimedBackgroundTaskStep(uuid4(), uuid4(), uuid4(), None, uuid4(),
            BackgroundTaskStepName.PREVIEW_UPGRADE, uuid4(), 1, 2, datetime.now(timezone.utc)+timedelta(seconds=30))
        tasks = TaskLeaseBoundary(claim)
        worker = BackgroundTaskWorker(repository=tasks, upgrade_runner=UpgradeBoundary())
        for name in (BackgroundTaskStepName.PREVIEW_UPGRADE, BackgroundTaskStepName.VERIFY_UPGRADE_PREVIEW,
                     BackgroundTaskStepName.APPLY_UPGRADE, BackgroundTaskStepName.VERIFY_UPGRADE_APPLY):
            tasks.claim = replace(claim, name=name)
            result = worker.run_once(owner_id=claim.owner_id, contact_id=claim.contact_id, worker_id=claim.worker_id)
            self.assertEqual(result.outcome, WorkerRunOutcome.SUCCEEDED)
        self.assertEqual(observed, ['preview','verify','apply','verify'])
