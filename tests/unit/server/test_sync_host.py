"""后端进程内同步宿主的单元测试；使用内存 fake engine，不连接数据库。"""

from __future__ import annotations

import threading
import time
import unittest
from uuid import uuid4

from notalone.front_sync import FrontSyncPhase
from notalone.front_sync.sync_engine import FrontSyncCycleReport
from notalone.front_sync.tail_lifecycle import FollowRuntimeStatus
from notalone.server.sync_host import LatestValidForegroundObservation, SyncHost


class FakeEngine:
    """记录调用的内存前端同步引擎端口。"""

    def __init__(self, *, enabled: bool = False) -> None:
        self.enabled = enabled
        self.wechat_in_front = False
        self.active_contact_id = None
        self.active_binding_display_name = None
        self.cycle_calls = 0
        self.enable_calls = 0
        self.disable_calls = 0
        self.confirm_calls: list[tuple[str, str]] = []
        self.waits_for_selection = False
        self.wait_cycles = threading.Event()

    def sync_enabled(self) -> bool:
        return self.enabled

    def cycle(self) -> FrontSyncCycleReport:
        self.cycle_calls += 1
        if self.cycle_calls >= 3:
            self.wait_cycles.set()
        return FrontSyncCycleReport(
            sync_enabled=self.enabled,
            phase=(
                FrontSyncPhase.ACTIVE
                if self.enabled
                else FrontSyncPhase.SYNC_DISABLED
            ),
            probe_available=True,
            wechat_in_front=self.wechat_in_front,
            cli_available=True,
            failure_code=None,
            active_contact_id=self.active_contact_id,
            active_binding_display_name=self.active_binding_display_name,
            decision_reason=None,
        )

    def enable_sync(self) -> None:
        self.enable_calls += 1
        self.enabled = True

    def disable_sync(self) -> None:
        self.disable_calls += 1
        self.enabled = False

    def confirm_binding(self, *, contact_id, locator) -> FrontSyncCycleReport:
        self.confirm_calls.append((str(contact_id), locator))
        return FrontSyncCycleReport(
            sync_enabled=self.enabled,
            phase=FrontSyncPhase.ACTIVE,
            probe_available=True,
            wechat_in_front=True,
            cli_available=True,
            failure_code=None,
            active_contact_id=contact_id,
            active_binding_display_name="合成已绑定",
            decision_reason=None,
        )

    def follow_runtime_status(self) -> FollowRuntimeStatus:
        return FollowRuntimeStatus(
            enabled=self.enabled,
            stream_active=self.wechat_in_front,
            process_id=4321 if self.wechat_in_front else None,
            mode="live" if self.wechat_in_front else None,
            watermark=41 if self.wechat_in_front else None,
        )


class SyncHostTest(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = FakeEngine()
        self.host = SyncHost(engine=self.engine, interval=0.01)

    def tearDown(self) -> None:
        self.host.stop()

    # ------------------------------------------------------------------
    # 同步操作委托
    # ------------------------------------------------------------------

    def test_check_runs_one_cycle_and_caches_report(self) -> None:
        self.engine.enabled = True

        first = self.host.check()
        second = self.host.check()

        self.assertEqual(self.engine.cycle_calls, 2)
        self.assertTrue(first.sync_enabled)
        self.assertEqual(self.host.status(), second)
        self.assertEqual(self.host.status(), self.host.status())

    def test_status_is_none_before_any_cycle(self) -> None:
        self.assertIsNone(self.host.status())

    def test_enable_delegates_and_returns_fresh_report(self) -> None:
        report = self.host.enable()

        self.assertEqual(self.engine.enable_calls, 1)
        self.assertEqual(self.engine.cycle_calls, 1)
        self.assertTrue(report.sync_enabled)
        self.assertEqual(self.host.status(), report)

    def test_disable_delegates_and_returns_fresh_report(self) -> None:
        self.engine.enabled = True

        report = self.host.disable()

        self.assertEqual(self.engine.disable_calls, 1)
        self.assertEqual(self.engine.cycle_calls, 1)
        self.assertFalse(report.sync_enabled)
        self.assertEqual(report.phase, FrontSyncPhase.SYNC_DISABLED)

    # ------------------------------------------------------------------
    # 常驻循环
    # ------------------------------------------------------------------

    def test_loop_seeds_initial_report_then_cycles_while_enabled(self) -> None:
        self.engine.enabled = True
        self.host.start()
        self.assertTrue(self.engine.wait_cycles.wait(timeout=2.0))
        # 播种 1 次 + 循环若干次
        self.assertGreaterEqual(self.engine.cycle_calls, 3)
        self.engine.enabled = False
        time.sleep(0.05)
        cycles_when_disabled = self.engine.cycle_calls
        time.sleep(0.05)
        self.assertEqual(self.engine.cycle_calls, cycles_when_disabled)

    def test_loop_only_seeds_when_disabled_from_start(self) -> None:
        self.host.start()
        time.sleep(0.05)
        self.host.stop()

        # 仅播种一轮初始化报告，之后不循环（stop 后计数不再增长）。
        self.assertEqual(self.engine.cycle_calls, 1)
        cycles_after_stop = self.engine.cycle_calls
        time.sleep(0.05)
        self.assertEqual(self.engine.cycle_calls, cycles_after_stop)
        # 种子报告保留为最新状态。
        self.assertIsNotNone(self.host.status())
        self.assertFalse(self.host.status().sync_enabled)

    def test_stop_terminates_loop(self) -> None:
        self.engine.enabled = True
        self.host.start()
        self.assertTrue(self.engine.wait_cycles.wait(timeout=2.0))
        self.host.stop()

        before = self.engine.cycle_calls
        time.sleep(0.05)
        self.assertEqual(self.engine.cycle_calls, before)

    def test_start_twice_is_rejected(self) -> None:
        self.host.start()
        with self.assertRaises(RuntimeError):
            self.host.start()
        self.host.stop()

    def test_stop_without_start_is_safe(self) -> None:
        self.host.stop()
        self.host.stop()

    def test_rejects_non_positive_interval(self) -> None:
        with self.assertRaises(ValueError):
            SyncHost(engine=self.engine, interval=0)
        with self.assertRaises(ValueError):
            SyncHost(engine=self.engine, interval=-1.0)

    def test_confirm_delegates_and_caches_report(self) -> None:
        contact_id = uuid4()
        self.engine.enabled = True

        report = self.host.confirm(contact_id=contact_id, locator="wxid_front")

        self.assertEqual(
            self.engine.confirm_calls,
            [(str(contact_id), "wxid_front")],
        )
        self.assertTrue(report.sync_enabled)
        self.assertEqual(report.active_contact_id, contact_id)
        self.assertEqual(self.host.status(), report)

    def test_confirm_rejects_invalid_arguments(self) -> None:
        with self.assertRaises(TypeError):
            self.host.confirm(contact_id="not-uuid", locator="wxid_front")
        with self.assertRaises(ValueError):
            self.host.confirm(contact_id=uuid4(), locator="  ")

    def test_keeps_latest_valid_foreground_observation_when_app_returns_front(self) -> None:
        contact_id = uuid4()
        self.engine.enabled = True
        self.engine.wechat_in_front = True
        self.engine.active_contact_id = contact_id
        self.engine.active_binding_display_name = "合成已绑定"

        self.host.check()
        observation = self.host.last_valid_observation()

        self.assertIsInstance(observation, LatestValidForegroundObservation)
        self.assertEqual(observation.contact_id, contact_id)
        self.assertEqual(observation.display_name, "合成已绑定")
        self.assertEqual(observation.watermark, 41)

        # 用户切回 NotAlone 查看状态后，当前报告会变成非微信前台，
        # 但最近一次有效观测仍应保留，供人工验证页面展示。
        self.engine.wechat_in_front = False
        self.engine.active_contact_id = None
        self.engine.active_binding_display_name = None
        self.host.check()

        self.assertEqual(self.host.last_valid_observation(), observation)


class SyncHostTypingTest(unittest.TestCase):
    def test_owner_scope_is_not_required_by_host(self) -> None:
        # 同步宿主不直接依赖 owner；owner 范围由 engine 构造时固定。
        engine = FakeEngine()
        host = SyncHost(engine=engine, interval=0.01)
        report = host.check()
        self.assertFalse(report.sync_enabled)
        host.stop()


if __name__ == "__main__":
    unittest.main()
