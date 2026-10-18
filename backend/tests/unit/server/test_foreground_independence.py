"""前台身份观察与后台同步的公开宿主并发边界。"""
import threading
import unittest
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor

from notalone.front_sync.foreground_observation import FreshForegroundObservation
from notalone.server.sync_host import SyncHost, SyncHostBusy, SyncHostStopped
from tests.unit.server.test_sync_host import FakeEngine


class IndependentObservationTests(unittest.TestCase):
    def test_background_io_does_not_block_foreground_observation(self):
        entered, release = threading.Event(), threading.Event()

        class Engine(FakeEngine):
            def cycle(self):
                entered.set()
                if not release.wait(3):
                    raise AssertionError('后台测试闸门未释放')
                return super().cycle()

            def observe_foreground(self, *, deadline, check_current=lambda: None):
                check_current()
                return FreshForegroundObservation.create(
                    phase='paused', reason='wechat_not_in_front',
                    probe_available=True, wechat_in_front=False,
                )

        host = SyncHost(engine=Engine(enabled=True))
        with ThreadPoolExecutor(max_workers=2) as pool:
            background = pool.submit(host.check)
            try:
                self.assertTrue(entered.wait(1))
                result = pool.submit(host.observe_foreground).result(timeout=1)
                self.assertEqual(result.reason, 'wechat_not_in_front')
                self.assertFalse(background.done())
            finally:
                release.set()
                background.result(timeout=2)
                host.stop()

    def test_authority_changes_invalidate_inflight_before_next_read(self):
        for operation in ('disable', 'enable', 'revoke', 'confirm', 'confirm_pending', 'batch'):
            with self.subTest(operation=operation):
                self._assert_mutation_cancels_observation(operation)

    def _assert_mutation_cancels_observation(self, operation):
        entered, release, disabled = threading.Event(), threading.Event(), threading.Event()
        reads = []

        class Engine(FakeEngine):
            def observe_foreground(self, *, deadline, check_current=lambda: None):
                entered.set()
                if not release.wait(3):
                    raise AssertionError('观察闸门未释放')
                check_current()
                reads.append('metadata')
                return FreshForegroundObservation.create(
                    phase='paused', reason='wechat_not_in_front',
                    probe_available=True, wechat_in_front=False,
                )

            def revoke_cli_binding(self, **kwargs):
                disabled.set()

            def confirm_cli_bindings(self, selections):
                disabled.set()
                return self.cycle()

            def disable_sync(self):
                disabled.set()
                super().disable_sync()

        engine = Engine(enabled=True)
        host = SyncHost(engine=engine)
        with ThreadPoolExecutor(max_workers=2) as pool:
            observation = pool.submit(host.observe_foreground)
            try:
                self.assertTrue(entered.wait(1))
                actions = {
                    'disable': host.disable, 'enable': host.enable,
                    'revoke': lambda: host.revoke_cli_binding(contact_id=uuid4(), binding_id=uuid4()),
                    'confirm': lambda: host.confirm(contact_id=uuid4(), locator='synthetic'),
                    'confirm_pending': lambda: host.confirm_pending(contact_id=uuid4(), locator='synthetic'),
                    'batch': lambda: host.confirm_cli_bindings(()),
                }
                mutation = pool.submit(actions[operation])
                # 新观察必须被关闭请求挡住；不依赖线程调度的短睡眠。
                with self.assertRaises(SyncHostBusy):
                    host.observe_foreground()
                self.assertFalse(mutation.done(), '授权变更完成前必须等待在途观察收尾')
                self.assertEqual(engine.confirm_calls, [])
                self.assertEqual(engine.confirm_pending_calls, [])
                release.set()
                with self.assertRaises(SyncHostBusy):
                    observation.result(timeout=2)
                mutation.result(timeout=2)
                self.assertEqual(reads, [])

            finally:
                release.set()
                host.stop()

    def test_stop_drains_observation_and_prevents_next_read(self):
        entered, release, cancelled = threading.Event(), threading.Event(), threading.Event()
        reads = []

        class Engine(FakeEngine):
            def cancel_pending_io(self):
                cancelled.set()

            def observe_foreground(self, *, deadline, check_current):
                entered.set()
                if not release.wait(3):
                    raise AssertionError('观察闸门未释放')
                check_current()
                reads.append('metadata')

        engine = Engine(enabled=True)
        host = SyncHost(engine=engine)
        with ThreadPoolExecutor(max_workers=2) as pool:
            observation = pool.submit(host.observe_foreground)
            try:
                self.assertTrue(entered.wait(1))
                stopping = pool.submit(host.stop)
                self.assertTrue(cancelled.wait(1))
                self.assertFalse(stopping.done())
                release.set()
                with self.assertRaises(SyncHostStopped):
                    observation.result(timeout=2)
                stopping.result(timeout=2)
                self.assertEqual(reads, [])
                with self.assertRaises(SyncHostStopped):
                    host.observe_foreground()
            finally:
                release.set()
                host.stop()

    def test_real_locator_stops_between_probe_and_metadata_on_disable(self):
        from datetime import datetime, timezone
        from notalone.conversation.matcher import FrontSessionEvidence
        from notalone.front_sync.probe_adapter import FrontSessionProbeObservation, FrontSessionQuality
        from notalone.front_sync.foreground_locator import ForegroundLocator
        from notalone.front_sync.full_sync_engine import CliFullSyncEngine
        from tests.unit.front_sync.test_cli_full_sync_engine import (
            FakeState, FakeBackground, FakeCli, FakeBindingCoordinator, FakeFallback,
        )

        entered, release = threading.Event(), threading.Event()
        reads = []

        class Probe:
            def observe_fresh(self, **kwargs):
                entered.set()
                if not release.wait(3):
                    raise AssertionError('探针闸门未释放')
                return FrontSessionProbeObservation(
                    wechat_in_front=True,
                    evidence=FrontSessionEvidence(display_name='合成私聊'),
                    quality=FrontSessionQuality('automatic-header-v3', 1.0, name_complete=True),
                    captured_at=datetime.now(timezone.utc),
                )

        class Cli(FakeCli):
            def sessions(self, **kwargs):
                reads.append('metadata')
                return ()

        cli, owner = Cli(), uuid4()
        engine = CliFullSyncEngine(
            owner_id=owner, channel='wechat', account_scope='synthetic', cli=cli,
            sync_state=FakeState(), background=FakeBackground(),
            foreground=ForegroundLocator(owner_id=owner, channel='wechat', account_scope='synthetic',
                                         probe=Probe(), cli=cli, bindings=object()),
            binding_coordinator=FakeBindingCoordinator(), fallback=FakeFallback(),
        )
        host = SyncHost(engine=engine)
        with ThreadPoolExecutor(max_workers=2) as pool:
            observation = pool.submit(host.observe_foreground)
            try:
                self.assertTrue(entered.wait(1))
                mutation = pool.submit(host.disable)
                with self.assertRaises(SyncHostBusy):
                    host.observe_foreground()
                self.assertFalse(mutation.done(), '授权变更完成前必须等待在途观察收尾')
                release.set()
                with self.assertRaises(SyncHostBusy):
                    observation.result(timeout=2)
                mutation.result(timeout=2)
                self.assertEqual(reads, [])
                self.assertEqual(host.observe_foreground().reason, 'sync_disabled')
            finally:
                release.set()
                host.stop()

    def test_stop_rejects_enable_queued_behind_inflight_observation(self):
        entered, release, cancelled = threading.Event(), threading.Event(), threading.Event()

        class Engine(FakeEngine):
            def observe_foreground(self, *, deadline, check_current):
                entered.set()
                if not release.wait(3):
                    raise AssertionError('观察闸门未释放')
                check_current()

            def cancel_pending_io(self):
                cancelled.set()

        engine = Engine(enabled=False)
        host = SyncHost(engine=engine)
        with ThreadPoolExecutor(max_workers=3) as pool:
            observation = pool.submit(host.observe_foreground)
            try:
                self.assertTrue(entered.wait(1))
                enabling = pool.submit(host.enable)
                # 观察仍持锁时，新公开观察的拒绝给排队的 enable 一个调度窗口。
                with self.assertRaises(SyncHostBusy):
                    host.observe_foreground()
                stopping = pool.submit(host.stop)
                self.assertTrue(cancelled.wait(1))
                release.set()
                with self.assertRaises(SyncHostStopped):
                    observation.result(timeout=2)
                with self.assertRaises(SyncHostStopped):
                    enabling.result(timeout=2)
                stopping.result(timeout=2)
                self.assertEqual(engine.enable_calls, 0)
                self.assertEqual(engine.cycle_calls, 0)
            finally:
                release.set()
                host.stop()
