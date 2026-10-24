"""前台定位单独移交；后台正文保持原执行责任。"""
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor

from notalone.front_sync.foreground_observation import FreshForegroundObservation
from notalone.server.sync_host import SyncHost, SyncHostBusy, SyncHostStopped
from tests.unit.server.test_sync_host import FakeEngine


class ForegroundLocationHandoffTests(unittest.TestCase):
    def test_transfer_drains_and_rejects_new_observation_without_stopping_background(self):
        entered, release, cancelled = threading.Event(), threading.Event(), threading.Event()
        reads = []

        class Engine(FakeEngine):
            def cancel_foreground_observation(self):
                cancelled.set()
                release.set()

            def observe_foreground(self, *, deadline, check_current):
                entered.set()
                if not release.wait(4):
                    raise AssertionError("合成观察未释放")
                check_current()
                reads.append("native")
                return FreshForegroundObservation.create(
                    phase="paused", reason="wechat_not_in_front",
                    probe_available=True, wechat_in_front=False,
                )

        host = SyncHost(engine=Engine(enabled=True))
        self.addCleanup(host.stop)
        with ThreadPoolExecutor(max_workers=2) as pool:
            request = pool.submit(host.observe_foreground)
            self.assertTrue(entered.wait(1))
            result = host.transfer_foreground_location()
            self.assertTrue(cancelled.is_set())
            self.assertEqual(result, {"state": "stopped", "active_requests": 0})
            with self.assertRaises(SyncHostStopped):
                request.result(timeout=1)
            with self.assertRaises(SyncHostStopped):
                host.observe_foreground()
            self.assertEqual(reads, [])
            self.assertTrue(host.check().sync_enabled)

    def test_busy_transfer_remains_closed_until_existing_observation_exits(self):
        entered, release = threading.Event(), threading.Event()

        class Engine(FakeEngine):
            def cancel_foreground_observation(self):
                pass

            def observe_foreground(self, *, deadline, check_current):
                entered.set()
                if not release.wait(6):
                    raise AssertionError("合成观察未释放")
                check_current()

        host = SyncHost(engine=Engine(enabled=True))
        with ThreadPoolExecutor(max_workers=2) as pool:
            request = pool.submit(host.observe_foreground)
            try:
                self.assertTrue(entered.wait(1))
                with self.assertRaises(SyncHostBusy):
                    host.transfer_foreground_location()
                with self.assertRaises(SyncHostStopped):
                    host.observe_foreground()
                self.assertTrue(host.check().sync_enabled)
                release.set()
                with self.assertRaises(SyncHostStopped):
                    request.result(timeout=1)
                self.assertEqual(host.transfer_foreground_location()["active_requests"], 0)
            finally:
                release.set()
                host.stop()
