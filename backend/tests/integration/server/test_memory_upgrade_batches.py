"""一次批准多批的真实 HTTP 回归；自身写入和用户后来决定分别复验。"""

import threading
import time
import unittest
from unittest.mock import patch

from tests.integration.server import test_memory_upgrade as upgrade
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture


class MemoryUpgradeBatchesHttpTest(upgrade.UpgradeHttpSupport, CoreBusinessFlowFixture, unittest.TestCase):
    def _two_ready(self):
        self._raw(('我平时喜欢合成红茶。', '我平时喜欢合成绿茶。'))
        prepared, _ = self._prepare(limit=2, size=1, calls=4)
        ready = self._wait(prepared)
        self.assertEqual(len(ready['batches']), 2)
        self.assertEqual(ready['model_calls_used'], 4)
        return ready

    def test_one_approval_applies_independent_batches_without_new_preview_or_budget(self):
        ready = self._two_ready()
        (status, result), command = self._action(ready, 'apply')
        self.assertEqual(status, 200, result)
        applied = self._wait(ready, states=('applied',))
        self.assertEqual(applied['model_calls_used'], 4)
        self.assertEqual(len(self.extraction_model.seen_calls), 4)
        self.assertEqual([batch['comparison'] for batch in applied['batches']],
                         [batch['comparison'] for batch in ready['batches']])
        path = f'/api/contacts/{self.contact_id}/memory-candidates'
        self.assertEqual(len(self._get(self.backend, path)['candidates']), 2)
        restored = self._production_backend(self.owner_id)
        status, repeated = restored.request(
            f"/api/memory-upgrades/{ready['job_id']}?{self._query()}", command)
        self.assertEqual(status, 200, repeated)
        self.assertEqual(repeated, applied)
        self.assertEqual(len(self._get(restored, path)['candidates']), 2)

    def test_user_change_between_approved_batches_still_rejects_the_second_batch(self):
        from notalone.persistence.memory_upgrade import PostgresMemoryUpgradeStore

        ready = self._two_ready()
        first_committed, release = threading.Event(), threading.Event()
        original = PostgresMemoryUpgradeStore.apply

        def pause_after_first(store, claim, **kwargs):
            result = original(store, claim, **kwargs)
            if not first_committed.is_set():
                first_committed.set()
                if not release.wait(10):
                    raise TimeoutError('合成批次间等待超时。')
            return result

        with patch.object(PostgresMemoryUpgradeStore, 'apply', pause_after_first):
            try:
                self.assertEqual(self._action(ready, 'apply')[0][0], 200)
                self.assertTrue(first_committed.wait(8))
                status, manual = self.backend.request('/api/memories/manual-contact', {
                    'contact_id': str(self.contact_id), 'text': '用户在两个批准批次间新增的合成决定。',
                    'category': 'relationship_note', 'topic': 'other',
                })
                self.assertEqual(status, 200, manual)
            finally:
                release.set()
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                current = self._get(self.backend, f"/api/memory-upgrades/{ready['job_id']}?{self._query()}")
                if any(batch['task_status'] == 'failed' for batch in current['batches']):
                    break
                time.sleep(.02)
            self.assertEqual([batch['state'] for batch in current['batches']], ['applied', 'apply_queued'])
            self.assertEqual(current['batches'][1]['task_status'], 'failed')
        restored = self._production_backend(self.owner_id)
        memories = self._get(restored, f'/api/contacts/{self.contact_id}/memories')['memories']
        self.assertEqual([row['memory_id'] for row in memories], [manual['memory']['memory_id']])
        self.assertEqual(len(self._get(restored, f'/api/contacts/{self.contact_id}/memory-candidates')['candidates']), 1)
        self.assertEqual(len(self.extraction_model.seen_calls), 4)
