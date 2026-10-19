"""后端进程内同步宿主的单元测试；使用内存 fake engine，不连接数据库。"""

from __future__ import annotations

import threading
import time
import unittest
from dataclasses import replace
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
        self.request_sync_check_calls = 0
        self.priority_contact_calls: list[object] = []
        self.cancel_pending_io_calls = 0
        self.confirm_calls: list[tuple[str, str]] = []
        self.confirm_pending_calls: list[tuple[str, str]] = []
        self.close_calls = 0
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

    def request_sync_check(self) -> None:
        self.request_sync_check_calls += 1

    def set_priority_contact(self, contact_id) -> None:
        self.priority_contact_calls.append(contact_id)

    def cancel_pending_io(self) -> None:
        self.cancel_pending_io_calls += 1

    def close(self) -> None:
        self.close_calls += 1

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

    def confirm_pending_binding(self, *, contact_id, locator) -> FrontSyncCycleReport:
        self.confirm_pending_calls.append((str(contact_id), locator))
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
        return FollowRuntimeStatus(
            enabled=self.enabled,
            stream_active=self.wechat_in_front,
            process_id=4321 if self.wechat_in_front else None,
            mode="live" if self.wechat_in_front else None,
            watermark=41 if self.wechat_in_front else None,
        )


class BlockingCycleEngine(FakeEngine):
    """在 cycle 内等待，用来验证状态读取不被慢同步周期拖住。"""

    def __init__(self) -> None:
        super().__init__(enabled=True)
        self.cycle_started = threading.Event()
        self.release_cycle = threading.Event()

    def cycle(self) -> FrontSyncCycleReport:
        self.cycle_started.set()
        self.release_cycle.wait(timeout=2.0)
        return super().cycle()


class CooperativeEngine(FakeEngine):
    """通过切片接口暂停首个任务，观察后续任务的公开调用顺序。"""

    def __init__(self) -> None:
        super().__init__(enabled=True)
        self.first_started = threading.Event()
        self.release_first = threading.Event()
        self.second_started = threading.Event()
        self.step_priorities = []
        self.running = 0
        self.maximum_running = 0
        self.cancel_started = threading.Event()

    def cycle_step(self, *, priority_contact_id, priority_requested_at):
        if not self.enabled:
            return super().cycle()
        self.step_priorities.append((priority_contact_id, priority_requested_at))
        self.running += 1
        self.maximum_running = max(self.maximum_running, self.running)
        try:
            if len(self.step_priorities) == 1:
                self.first_started.set()
                self.release_first.wait(timeout=2.0)
                return replace(super().cycle(), cli_pending_count=1)
            self.second_started.set()
            return super().cycle()
        finally:
            self.running -= 1

    def cancel_pending_io(self):
        super().cancel_pending_io()
        self.cancel_started.set()


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
        self.assertEqual(self.engine.request_sync_check_calls, 2)
        self.assertTrue(first.sync_enabled)
        self.assertEqual(self.host.status(), second)
        self.assertEqual(self.host.status(), self.host.status())

    def test_stop_rejects_later_reads_without_changing_sync_preference(self) -> None:
        self.engine.enabled = True
        self.host.check()
        self.host.stop()

        with self.assertRaises(RuntimeError):
            self.host.check()
        with self.assertRaises(RuntimeError):
            self.host.enable()
        with self.assertRaises(RuntimeError):
            self.host.cli_sessions()
        self.assertEqual(self.engine.cycle_calls, 1)
        self.assertEqual(self.engine.enable_calls, 0)
        self.assertEqual(self.engine.close_calls, 1)
        self.assertTrue(self.engine.enabled)

    def test_shutdown_rejects_queued_check_before_engine_is_released(self) -> None:
        engine = BlockingCycleEngine()
        stop_started = threading.Event()
        original_cancel = engine.cancel_pending_io

        def cancel_io() -> None:
            original_cancel()
            stop_started.set()

        engine.cancel_pending_io = cancel_io
        host = SyncHost(engine=engine, interval=0.01)
        host.start()
        self.assertTrue(engine.cycle_started.wait(timeout=1))
        check_started = threading.Event()
        rejected = []

        def queued_check() -> None:
            check_started.set()
            try:
                host.check()
            except RuntimeError:
                rejected.append(True)

        reader = threading.Thread(target=queued_check)
        stopper = threading.Thread(target=host.stop)
        reader.start()
        self.assertTrue(check_started.wait(timeout=1))
        stopper.start()
        try:
            self.assertTrue(stop_started.wait(timeout=1))
            engine.release_cycle.set()
            reader.join(timeout=1)
            stopper.join(timeout=1)
            self.assertFalse(reader.is_alive())
            self.assertFalse(stopper.is_alive())
            self.assertEqual(rejected, [True])
            self.assertEqual(engine.cycle_calls, 1)
            self.assertEqual(engine.close_calls, 1)
            self.assertTrue(engine.enabled)
            with self.assertRaises(RuntimeError):
                host.start()
            host.stop()
            self.assertEqual(engine.close_calls, 1)
        finally:
            engine.release_cycle.set()
            reader.join(timeout=1)
            stopper.join(timeout=1)
            host.stop()

    def test_registered_priority_is_forwarded_to_legacy_engine_on_next_check(self) -> None:
        contact_id = uuid4()

        result = self.host.set_priority_contact(contact_id)

        self.assertEqual(result, self.host.status())
        self.host.check()
        self.assertEqual(self.engine.priority_contact_calls, [contact_id])

    def test_status_is_none_before_any_cycle(self) -> None:
        self.assertIsNone(self.host.status())

    def test_status_and_follow_runtime_do_not_wait_for_blocked_cycle(self) -> None:
        engine = BlockingCycleEngine()
        host = SyncHost(engine=engine, interval=0.01)
        host.start()
        self.assertTrue(engine.cycle_started.wait(timeout=1.0))

        status_result: list[FrontSyncCycleReport | None] = []
        status_done = threading.Event()

        def read_status() -> None:
            status_result.append(host.status())
            status_done.set()

        status_thread = threading.Thread(target=read_status)
        status_thread.start()
        try:
            self.assertTrue(
                status_done.wait(timeout=0.2),
                "状态 API 不应等待正在执行的同步周期",
            )
            self.assertEqual(status_result, [None])
            self.assertFalse(host.follow_runtime_status().stream_active)
        finally:
            engine.release_cycle.set()
            status_thread.join(timeout=1.0)
            host.stop()

    def test_priority_registration_does_not_wait_for_running_cycle(self) -> None:
        engine = BlockingCycleEngine()
        host = SyncHost(engine=engine, interval=3.0)
        registered = threading.Event()
        contact_id = uuid4()
        host.start()
        self.assertTrue(engine.cycle_started.wait(timeout=1.0))

        def register() -> None:
            host.set_priority_contact(contact_id)
            registered.set()

        request = threading.Thread(target=register)
        request.start()
        try:
            self.assertTrue(registered.wait(timeout=0.2), "优先联系人登记不能等待慢同步轮次。")
        finally:
            engine.release_cycle.set()
            request.join(timeout=1.0)
            host.stop()

    def test_next_pending_step_uses_latest_priority_without_heartbeat_delay(self) -> None:
        engine = CooperativeEngine()
        host = SyncHost(engine=engine, interval=3.0)
        first, latest = uuid4(), uuid4()
        host.start()
        try:
            self.assertTrue(engine.first_started.wait(timeout=0.2), "宿主应使用有界切片接口。")
            host.set_priority_contact(first)
            host.set_priority_contact(latest)
            engine.release_first.set()
            self.assertTrue(engine.second_started.wait(timeout=0.2), "有待处理任务时不能再等待三秒心跳。")
            self.assertEqual(engine.step_priorities[1][0], latest)
            self.assertIsNotNone(engine.step_priorities[1][1])
            self.assertEqual(engine.maximum_running, 1, "切片不得并发执行。")
        finally:
            engine.release_first.set()
            host.stop()

    def test_stop_discards_priority_waiting_behind_a_running_step(self) -> None:
        engine = CooperativeEngine()
        host = SyncHost(engine=engine, interval=3.0)
        host.start()
        self.assertTrue(engine.first_started.wait(timeout=0.2))
        host.set_priority_contact(uuid4())
        stopper = threading.Thread(target=host.stop)
        stopper.start()
        try:
            self.assertTrue(engine.cancel_started.wait(timeout=0.2))
            engine.release_first.set()
            stopper.join(timeout=1.0)
            self.assertFalse(stopper.is_alive())
            self.assertEqual(len(engine.step_priorities), 1)
            self.assertEqual(engine.close_calls, 1)
            with self.assertRaises(RuntimeError):
                host.set_priority_contact(uuid4())
        finally:
            engine.release_first.set()
            stopper.join(timeout=1.0)
            host.stop()

    def test_disabled_host_does_not_read_when_priority_request_wakes_it(self) -> None:
        engine = CooperativeEngine()
        engine.release_first.set()
        host = SyncHost(engine=engine, interval=3.0)
        host.start()
        try:
            self.assertTrue(engine.second_started.wait(timeout=0.2))
            self.assertFalse(host.disable().sync_enabled)
            reads = len(engine.step_priorities)
            engine.second_started.clear()
            host.set_priority_contact(uuid4())
            self.assertFalse(engine.second_started.wait(timeout=0.05))
            self.assertEqual(len(engine.step_priorities), reads)
        finally:
            host.stop()

    def test_production_engine_rechecks_latest_contact_between_cli_bindings(self) -> None:
        from tests.unit.front_sync import test_cli_background_sync as background_fixture
        from tests.unit.front_sync import test_cli_full_sync_engine as full_fixture
        from notalone.front_sync.cli_sync import CliBackgroundSync
        from notalone.front_sync.full_sync_engine import CliFullSyncEngine

        started, release, selected = threading.Event(), threading.Event(), threading.Event()
        bindings = [background_fixture.FakeBinding(uuid4(), uuid4(), f"synthetic_{index}", "合成联系人")
                    for index in range(3)]

        class SlowCli(background_fixture.FakeCli):
            def __init__(self):
                super().__init__(stream_events=[])
                self.running = 0
                self.maximum_running = 0

            def tail(self, talker, **kwargs):
                self.running += 1
                self.maximum_running = max(self.maximum_running, self.running)
                try:
                    result = super().tail(talker, **kwargs)
                    if len(self.tail_calls) == 1:
                        started.set()
                        release.wait(timeout=1.0)
                    if talker == bindings[2].conversation_locator:
                        selected.set()
                    return result
                finally:
                    self.running -= 1

        cli, state = SlowCli(), full_fixture.FakeState()
        background = CliBackgroundSync(owner_id=background_fixture.OWNER_ID, channel="wechat",
            account_scope="synthetic", cli=cli, bindings=bindings,
            observation_store=background_fixture.FakeObservationStore(), sync_state=state)
        engine = CliFullSyncEngine(owner_id=background_fixture.OWNER_ID, channel="wechat",
            account_scope="synthetic", cli=cli, sync_state=state, background=background,
            foreground=full_fixture.FakeForeground(), binding_coordinator=full_fixture.FakeBindingCoordinator(),
            fallback=full_fixture.FakeFallback())
        host = SyncHost(engine=engine, interval=3.0)
        host.start()
        try:
            self.assertTrue(started.wait(timeout=0.2))
            host.set_priority_contact(bindings[1].contact_id)
            host.set_priority_contact(bindings[2].contact_id)
            release.set()
            self.assertTrue(selected.wait(timeout=0.2))
            self.assertEqual([call["talker"] for call in cli.tail_calls[:2]],
                             [bindings[0].conversation_locator, bindings[2].conversation_locator])
            self.assertEqual(cli.maximum_running, 1)
        finally:
            release.set()
            host.stop()

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

    def test_loop_survives_sync_enabled_read_failures(self) -> None:
        # 开关读取（查库）瞬时失败只丢弃本轮，不能让心跳线程死亡：
        # 线程死亡后 /api/sync/status 会永远返回崩溃前的旧报告。
        self.engine.enabled = True
        failures = {"count": 2}

        original = self.engine.sync_enabled

        def flaky_sync_enabled() -> bool:
            if failures["count"] > 0:
                failures["count"] -= 1
                raise RuntimeError("synthetic persistence outage")
            return original()

        self.engine.sync_enabled = flaky_sync_enabled  # type: ignore[method-assign]
        self.host.start()
        try:
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline:
                if self.engine.cycle_calls >= 3 and failures["count"] == 0:
                    break
                time.sleep(0.02)
            self.assertEqual(failures["count"], 0)
            self.assertGreaterEqual(self.engine.cycle_calls, 3)
        finally:
            self.host.stop()

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
        self.assertEqual(self.engine.cancel_pending_io_calls, 1)
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

    def test_stop_closes_engine_resources_without_disabling_sync(self) -> None:
        self.engine.enabled = True

        self.host.check()
        self.host.stop()

        self.assertGreaterEqual(self.engine.close_calls, 1)
        self.assertTrue(self.engine.enabled)

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

    def test_confirm_pending_delegates_and_caches_report(self) -> None:
        contact_id = uuid4()
        self.engine.enabled = True

        report = self.host.confirm_pending(
            contact_id=contact_id, locator="wxid_front"
        )

        self.assertEqual(
            self.engine.confirm_pending_calls,
            [(str(contact_id), "wxid_front")],
        )
        self.assertTrue(report.sync_enabled)
        self.assertEqual(report.phase, FrontSyncPhase.WAITING_FOREGROUND)
        self.assertEqual(self.host.status(), report)

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
