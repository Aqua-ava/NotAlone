"""两类整理纠错走公开HTTP，使用正式迁移及自有合成资料。"""

import unittest
from uuid import UUID, uuid4

from notalone.scopes import ContactScope
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server.test_layered_memory_management import (
    LayeredMemoryManagementHttpTest, EchoProposal,
)


class LayeredMemoryCorrectionHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    controlled = LayeredMemoryManagementHttpTest.controlled
    enable = LayeredMemoryManagementHttpTest.enable

    def test_summary_feedback_retracts_result_without_changing_correct_l1(self):
        contact, _, message = self.import_contact("合成课程依据。")
        memory = self.confirm(contact, "双方共同参加合成课程。", message)
        backend = self.controlled(proposer=EchoProposal())
        ready = self.enable(backend, contact)
        snapshot = self.service.capture(ContactScope(self.owner_id, UUID(contact)))
        target = ready['scenarios'][0]
        path = f'/api/contacts/{contact}/layered-memory'
        command = {'settings_generation': ready['settings_generation'],
            'organization_generation': ready['organization_generation'],
            'target_kind': 'scenario', 'version_id': target['version_id'], 'item_index': 0,
            'reason': '这段总结把共同课程写成了长期偏好。', 'operation_id': str(uuid4())}
        status, result = backend.request(path + '/summary-error', command)
        self.assertEqual(status, 200, result)
        corrected = result['layered_memory']
        self.assertEqual(corrected['scenarios'], [])
        self.assertEqual(len(corrected['feedback']), 1)
        self.assertEqual(corrected['feedback'][0]['reason'], command['reason'])
        self.assertFalse(self.service.validate(snapshot))
        self.assertEqual(self._get(self.backend, f'/api/contacts/{contact}/memories')['memories'][0]['text'],
                         memory['text'])
        status, refreshed = backend.request(path + '/refresh', {
            'settings_generation': corrected['settings_generation']})
        self.assertEqual(status, 200, refreshed)
        self.assertEqual(refreshed['layered_memory']['scenarios'], [])
        self.assertEqual(len(self.proposal.inputs), 1, '旧依据不能重新送模型换说法')
