"""真实验收观察入口的离线边界验证；只替换外部提取/核验模型。"""
import tempfile
import unittest
from pathlib import Path
from uuid import UUID

from notalone.scopes import ContactScope
from tests.integration.server import real_model_automatic_memory as acceptance
from tests.integration.server.test_observation_auto_flow import ObservationAutoFlowFixture


class RealMemoryObservationEntryTest(ObservationAutoFlowFixture, unittest.TestCase):
    observation_dialog = acceptance.RealMemoryAcceptance.observation_dialog
    read = acceptance.RealMemoryAcceptance.read

    def test_confirmed_observation_uses_existing_task_and_new_message_identity(self):
        self.owner_id = self.scope.owner_id
        self.case = {'scope': 'contact'}
        with tempfile.TemporaryDirectory() as output:
            self.output = Path(output)
            first = self.observation_dialog(1, ['我一直喜欢乌龙茶。'])
            self.scope = ContactScope(self.owner_id, UUID(first['contact_id']))
            self.wait_task()
            second = self.observation_dialog(2, ['更正一下，现在我喜欢红茶。'], first['contact_id'])
            self.wait_task()
            third = self.observation_dialog(3, ['更正一下，现在我喜欢红茶。'], first['contact_id'])
            self.wait_task()
            self.assertEqual(first['task_id'], third['task_id'])
            self.assertEqual(first['task_id'], second['task_id'])
            self.assertEqual(len(self.model.calls), 3)
            self.assertEqual([len(ids) for ids in self.model.calls], [5, 5, 5])
            self.assertTrue(self.model.calls[0].isdisjoint(self.model.calls[1]))
            self.assertTrue((self.output / 'observation-input-2.json').exists())
