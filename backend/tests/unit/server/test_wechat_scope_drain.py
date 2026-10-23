"""迁移撤销先排空旧读取；超时不触发 TS 写请求。"""
import threading
import unittest
from unittest.mock import Mock
from uuid import UUID

from notalone.server.sync_host import SyncHost, SyncHostBusy

IDENTIFIER = UUID("33333333-3333-3333-3333-333333333333")


class WechatScopeDrainTest(unittest.TestCase):
    def test_revoke_waits_for_active_reader_then_holds_both_locks(self):
        engine = Mock()
        host = SyncHost(engine=engine)
        started = threading.Event()
        finished = threading.Event()
        results = []
        host._engine_lock.acquire()
        def revoke():
            started.set()
            results.append(host.revoke_transferred_binding(contact_id=IDENTIFIER, binding_id=IDENTIFIER))
            finished.set()
        def verify_locks(**kwargs):
            # 从另一个线程探测两把锁，不能在撤销事务中插入新读取。
            acquired = []
            def probe():
                for lock in (host._engine_lock, host._foreground_lock):
                    result = lock.acquire(blocking=False)
                    acquired.append(result)
                    if result:
                        lock.release()
            thread = threading.Thread(target=probe)
            thread.start()
            thread.join(1)
            self.assertEqual(acquired, [False, False])
            return {"status": 200, "body": {"status": "revoked"}}
        engine.revoke_transferred_binding.side_effect = verify_locks
        worker = threading.Thread(target=revoke)
        worker.start()
        self.assertTrue(started.wait(1))
        self.assertFalse(finished.wait(0.03))
        engine.revoke_transferred_binding.assert_not_called()
        host._engine_lock.release()
        worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results[0]["status"], 200)

    def test_foreground_drain_is_also_bounded_without_writing(self):
        engine = Mock()
        host = SyncHost(engine=engine)
        foreground_lock = Mock()
        foreground_lock.acquire.return_value = False
        host._foreground_lock = foreground_lock
        with self.assertRaises(SyncHostBusy):
            host.revoke_transferred_binding(contact_id=IDENTIFIER, binding_id=IDENTIFIER)
        timeout = foreground_lock.acquire.call_args.kwargs["timeout"]
        self.assertGreater(timeout, 0)
        self.assertLessEqual(timeout, 4)
        engine.revoke_transferred_binding.assert_not_called()
        foreground_lock.release.assert_not_called()

    def test_busy_after_four_seconds_does_not_write(self):
        engine = Mock()
        host = SyncHost(engine=engine)
        host._engine_lock.acquire()
        errors = []
        def revoke():
            try:
                host.revoke_transferred_binding(contact_id=IDENTIFIER, binding_id=IDENTIFIER)
            except SyncHostBusy as error:
                errors.append(error)
        worker = threading.Thread(target=revoke)
        worker.start()
        worker.join(4.5)
        host._engine_lock.release()
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(errors), 1)
        engine.revoke_transferred_binding.assert_not_called()
        self.assertEqual(host._observation_mutations, 0)
