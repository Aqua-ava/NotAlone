"""已提交同步消息到任务读取的持久数量/空闲调度回归。"""
import unittest
from tests.integration.server.test_observation_auto_flow import ObservationAutoFlowFixture


class PersistentExtractionScheduleHttpTest(ObservationAutoFlowFixture, unittest.TestCase):
    def test_after_first_warmup_message_second_waits_for_threshold(self):
        first = self.record(1)
        self.publish(first)
        self.wait_task()
        self.model.entered.clear()
        self.publish(self.record(2))
        self.assertFalse(self.model.entered.wait(.15), '第二轮只有一条消息，不应提前消费阈值2。')
        self.publish(self.record(3))
        self.wait_task()
        self.assertEqual(len(self.model.calls), 2)

    def test_startup_recovers_committed_observation_without_notification(self):
        self.record(1)
        self.host.start_scheduling(owner_id=self.scope.owner_id, interval_seconds=.05)
        self.addCleanup(self.host.stop)
        task = self.wait_task()
        self.assertEqual(task['status'], 'succeeded')
        self.assertEqual(len(self.model.calls), 1)

    def test_idle_tail_survives_host_restart_without_new_notification(self):
        from datetime import datetime, timedelta, timezone
        from unittest.mock import patch
        from notalone.application.model_priority import ModelPriorityControl
        clock = [datetime.now(timezone.utc)]
        with patch('notalone.persistence.extraction_schedule.utcnow', side_effect=lambda: clock[0]):
            self.publish(self.record(1))
            self.wait_task()
            self.model.entered.clear()
            self.record(2)
            self.host.stop()
            self.priority = ModelPriorityControl()
            self.host = self.create_task_host()
            self.addCleanup(self.host.stop)
            clock[0] += timedelta(seconds=601)
            self.host.start_scheduling(owner_id=self.scope.owner_id, interval_seconds=.05)
            self.assertTrue(self.model.entered.wait(2))
            self.wait_task()
            self.assertEqual(len(self.model.calls), 2)

    def test_replayed_observation_does_not_count_twice(self):
        self.publish(self.record(1))
        self.wait_task()
        self.model.entered.clear()
        second = self.record(2)
        self.publish(second)
        self.publish(self.record(2))
        self.assertFalse(self.model.entered.wait(.15))
        self.publish(self.record(3))
        self.wait_task()
        self.assertEqual(len(self.model.calls), 2)

    def test_deleted_pending_source_does_not_count_toward_next_threshold(self):
        self.publish(self.record(1))
        self.wait_task()
        second = self.record(2)
        self.store.delete_observation(owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
                                      observation_id=second.observation.observation_id)
        self.model.entered.clear()
        self.publish(self.record(3))
        self.assertFalse(self.model.entered.wait(.15), '删除的待处理消息不应继续贡献数量阈值。')

    def test_revoked_contact_is_not_claimed_by_startup_scan(self):
        self.record(1)
        self.bindings.revoke_binding(owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
                                     binding_id=self.binding.binding_id)
        self.host.start_scheduling(owner_id=self.scope.owner_id, interval_seconds=.05)
        self.addCleanup(self.host.stop)
        self.assertFalse(self.model.entered.wait(.2))
        code, status = self.backend.request(f'/api/tasks/status?contact_id={self.scope.contact_id}')
        self.assertEqual(code, 200)
        self.assertEqual(status['status'], 'idle')

    def test_scanner_preserves_failure_until_new_source_becomes_due(self):
        from datetime import datetime, timedelta, timezone
        from unittest.mock import patch
        self.model.unavailable = True
        self.publish(self.record(1))
        failed = self.wait_task('failed')
        self.model.entered.clear()
        self.model.unavailable = False
        self.host.start_scheduling(owner_id=self.scope.owner_id, interval_seconds=.05)
        self.addCleanup(self.host.stop)
        self.assertFalse(self.model.entered.wait(.2))
        now = datetime.now(timezone.utc)
        with patch('notalone.persistence.extraction_schedule.utcnow', return_value=now):
            self.record(2)
        with patch('notalone.persistence.extraction_schedule.utcnow', return_value=now+timedelta(seconds=601)):
            self.assertTrue(self.model.entered.wait(2))
            recovered = self.wait_task()
        self.assertEqual(recovered['task_id'], failed['task_id'])

    def test_stopped_host_does_not_dispatch_new_persisted_messages(self):
        self.host.start_scheduling(owner_id=self.scope.owner_id, interval_seconds=.05)
        self.host.stop()
        self.record(1)
        self.assertFalse(self.model.entered.wait(.2))
