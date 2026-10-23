"""责任门独立验证；不访问数据库或桌面。"""
import unittest
from threading import Event, Thread
from uuid import uuid4
from notalone.persistence.skill_management_handoff import SkillManagementHandoff, SkillManagementUnavailable


OWNER = uuid4()


class HandoffTests(unittest.TestCase):
    def test_drain_preserves_nested_lease(self):
        gate = SkillManagementHandoff()
        entered, stopped = Event(), Event()
        result = []
        def work():
            with gate.local_operation():
                entered.set()
                if not stopped.wait(2):
                    return
                with gate.local_operation():
                    result.append('completed')
        worker = Thread(target=work)
        worker.start()
        self.assertTrue(entered.wait(2))
        self.assertEqual(gate.stop(), {'state': 'draining', 'active_requests': 1})
        with self.assertRaises(SkillManagementUnavailable):
            gate.activate(owner_id=OWNER, synchronize=lambda: 1)
        with self.assertRaises(SkillManagementUnavailable):
            with gate.local_operation():
                self.fail('停收后不可进入')
        stopped.set()
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(result, ['completed'])
        self.assertEqual(gate.status()['active_requests'], 0)
        gate.activate(owner_id=OWNER, synchronize=lambda: 2)
        self.assertEqual(gate.synchronize(OWNER, lambda: self.fail('不得本地同步')), 2)

    def test_failed_remote_never_falls_back(self):
        gate = SkillManagementHandoff()
        gate.stop()
        def remote():
            raise SkillManagementUnavailable('不可用')
        gate.activate(owner_id=OWNER, synchronize=remote)
        with self.assertRaises(SkillManagementUnavailable):
            gate.synchronize(OWNER, lambda: self.fail('不得回退'))
        self.assertEqual(gate.status()['state'], 'remote')

    def test_remote_revision_contract(self):
        for bad in [True, -1, 2147483648, '1', None]:
            gate = SkillManagementHandoff()
            gate.stop()
            gate.activate(owner_id=OWNER, synchronize=lambda value=bad: value)
            with self.assertRaises(SkillManagementUnavailable):
                gate.synchronize(OWNER, lambda: 0)

    def test_exception_releases_lease(self):
        gate = SkillManagementHandoff()
        with self.assertRaises(ValueError):
            with gate.local_operation():
                raise ValueError()
        self.assertEqual(gate.stop()['state'], 'stopped')
        with self.assertRaises(SkillManagementUnavailable):
            gate.synchronize(OWNER, lambda: self.fail('停收不可同步'))

    def test_requires_drain_and_single_activation(self):
        gate = SkillManagementHandoff()
        with self.assertRaises(SkillManagementUnavailable):
            gate.activate(owner_id=OWNER, synchronize=lambda: 0)
        gate.stop()
        gate.activate(owner_id=OWNER, synchronize=lambda: 0)
        with self.assertRaises(SkillManagementUnavailable):
            gate.activate(owner_id=OWNER, synchronize=lambda: 1)

    def test_remote_owner_is_fixed_before_call(self):
        gate = SkillManagementHandoff()
        gate.stop()
        gate.activate(owner_id=OWNER, synchronize=lambda: self.fail('不应调用远端'))
        with self.assertRaises(SkillManagementUnavailable):
            gate.synchronize(uuid4(), lambda: self.fail('不得回退'))
        with self.assertRaises(SkillManagementUnavailable):
            gate.synchronize(str(OWNER), lambda: self.fail('不得回退'))


if __name__ == '__main__':
    unittest.main()
