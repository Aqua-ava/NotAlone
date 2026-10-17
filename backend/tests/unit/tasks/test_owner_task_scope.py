"""本人范围仅是整理任务的显式例外，旧任务仍须真实联系人。"""
from datetime import datetime, timezone
import unittest
from uuid import uuid4
from notalone.tasks.models import (BackgroundTask, BackgroundTaskType, BackgroundTaskStatus,
    BackgroundTaskStepName, ClaimedBackgroundTaskStep)


class OwnerTaskScopeTest(unittest.TestCase):
    def test_only_organization_claim_can_have_owner_scope(self):
        values = dict(task_id=uuid4(), owner_id=uuid4(), contact_id=None,
            source_document_id=None, step_id=uuid4(), worker_id=uuid4(), attempt_count=1,
            message_count=1, lease_expires_at=datetime.now(timezone.utc))
        self.assertEqual(ClaimedBackgroundTaskStep(**values, name=BackgroundTaskStepName.ORGANIZE_MEMORY).scope_kind, 'owner')
        with self.assertRaises(TypeError):
            ClaimedBackgroundTaskStep(**values, name=BackgroundTaskStepName.EXTRACT_MEMORY)

    def test_existing_observation_task_still_requires_contact(self):
        values = dict(task_id=uuid4(), owner_id=uuid4(), contact_id=None,
            source_document_id=None, status=BackgroundTaskStatus.QUEUED,
            current_step=BackgroundTaskStepName.ORGANIZE_MEMORY, message_count=0,
            created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc), steps=())
        self.assertEqual(BackgroundTask(**values, task_type=BackgroundTaskType.LAYERED_MEMORY).scope_kind, 'owner')
        with self.assertRaises(TypeError):
            BackgroundTask(**values, task_type=BackgroundTaskType.OBSERVATION)
