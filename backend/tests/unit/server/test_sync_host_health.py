"""SyncHost 心跳失败状态投影；使用内存 fake engine，不连接数据库。"""

from __future__ import annotations

import threading
import time
import unittest

from notalone.front_sync import FrontSyncPhase
from notalone.front_sync.sync_engine import FrontSyncCycleReport
from notalone.front_sync.tail_lifecycle import FollowRuntimeStatus
from notalone.server.sync_host import SyncHost


class FlakyEngine:
    """可注入开关读取/循环失败的最小引擎。"""

    def __init__(self) -> None:
        self.enabled = True
        self.fail_switch = False
        self.fail_cycle = False
        self.cycle_calls = 0
        self._lock = threading.Lock()

    def sync_enabled(self) -> bool:
        if self.fail_switch:
            raise RuntimeError("synthetic switch failure")
        return self.enabled

    def cycle(self) -> FrontSyncCycleReport:
        with self._lock:
            self.cycle_calls += 1
        if self.fail_cycle:
            raise RuntimeError("synthetic cycle failure")
        return FrontSyncCycleReport(
            sync_enabled=self.enabled,
            phase=FrontSyncPhase.WAITING_FOREGROUND,
            probe_available=True,
            wechat_in_front=False,
            cli_available=True,
            failure_code=None,
            active_contact_id=None,
            active_binding_display_name=None,
            decision_reason=None,
        )

    def follow_runtime_status(self) -> FollowRuntimeStatus:
        return FollowRuntimeStatus(enabled=self.enabled, stream_active=False)


class SyncHostHealthTest(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = FlakyEngine()
        self.host = SyncHost(engine=self.engine, interval=0.01)

    def tearDown(self) -> None:
        self.host.stop()

    def _wait_for(self, predicate, timeout: float = 2.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.01)
        return False

    def test_switch_read_failure_is_projected_and_recovered(self) -> None:
        self.engine.fail_switch = True
        with self.assertLogs("notalone.server.sync_host", level="WARNING") as captured:
            self.host.start()
            self.assertTrue(
                self._wait_for(
                    lambda: self.host.health()["failure_code"]
                    == "sync_switch_unavailable"
                )
            )
            self.assertFalse(self.host.health()["healthy"])
            self.engine.fail_switch = False
            self.assertTrue(self._wait_for(lambda: self.host.health()["healthy"]))

        joined = "\n".join(captured.output)
        self.assertIn("sync_heartbeat_switch_unavailable", joined)
        self.assertNotIn("synthetic switch failure", joined)

    def test_cycle_failure_is_projected_and_recovered(self) -> None:
        self.engine.fail_cycle = True
        with self.assertLogs("notalone.server.sync_host", level="WARNING") as captured:
            self.host.start()
            self.assertTrue(
                self._wait_for(
                    lambda: self.host.health()["failure_code"] == "sync_cycle_failed"
                )
            )
            self.assertIsNone(self.host.status())
            self.engine.fail_cycle = False
            self.assertTrue(self._wait_for(lambda: self.host.health()["healthy"]))
            self.assertIsNotNone(self.host.status())

        self.assertIn("sync_heartbeat_cycle_failed", "\n".join(captured.output))

    def test_user_disabled_sync_is_healthy_and_not_a_failure(self) -> None:
        self.engine.enabled = False
        self.host.start()
        self.assertTrue(
            self._wait_for(
                lambda: self.host.status() is not None and self.host.health()["healthy"]
            )
        )

        health = self.host.health()
        self.assertIsNone(health["failure_code"])
        self.assertTrue(self.engine.cycle_calls >= 1)
