"""宿主控制面只在原停收/排空之后激活；无owner不取得管理权。"""
import unittest
from unittest.mock import patch
from uuid import uuid4
from notalone.server.skill_management_control import SkillManagementControl
from notalone.persistence.skill_management_handoff import SkillManagementHandoff, SkillManagementUnavailable

class SkillManagementControlTests(unittest.TestCase):
    def setUp(self):
        self.gate = SkillManagementHandoff()
        self.override = patch('notalone.server.skill_management_control.skill_management_handoff', self.gate)
        self.override.start()
        self.addCleanup(self.override.stop)
        self.owner = uuid4()
        self.control = SkillManagementControl(self.owner)
        self.addCleanup(self.control.close)
        self.payload = {'owner_id': str(self.owner), 'port': 12345, 'token': 'synthetic-only-token-' * 3}

    def test_stop_drain_then_activate_and_close(self):
        with self.assertRaises(SkillManagementUnavailable):
            self.control.handle('activate', 'POST', self.payload)
        with self.gate.local_operation():
            self.assertEqual(self.control.handle('stop', 'POST', {})['state'], 'draining')
            with self.assertRaises(SkillManagementUnavailable):
                self.control.handle('activate', 'POST', self.payload)
        self.assertEqual(self.control.handle('status', 'GET', {})['active_requests'], 0)
        self.assertEqual(self.control.handle('activate', 'POST', self.payload)['state'], 'remote')
        with self.assertRaises(SkillManagementUnavailable):
            self.control.handle('activate', 'POST', self.payload)
        self.control.close()
        with self.assertRaises(SkillManagementUnavailable):
            self.control.handle('status', 'GET', {})
        with self.assertRaises(SkillManagementUnavailable):
            with self.gate.local_operation():
                self.fail('旧写者不得恢复')

    def test_no_owner_and_cross_owner_reject(self):
        for owner in (None, uuid4()):
            control = SkillManagementControl(owner)
            with self.assertRaises(ValueError):
                control.handle('activate', 'POST', self.payload)
            control.close()
        self.assertEqual(self.gate.status()['state'], 'python')

    def test_untransferred_ordinary_shutdown_does_not_poison_global_gate(self):
        self.control.close()
        self.assertEqual(self.gate.status()['state'], 'python')
