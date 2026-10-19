"""公开宿主最终代际复验失败时只回收前台资源。"""

import unittest
from uuid import UUID

from notalone.front_sync.foreground_observation import FreshForegroundObservation
from notalone.front_sync.full_sync_engine import CliFullSyncEngine
from notalone.server.sync_host import SyncHost, SyncHostBusy
from tests.unit.front_sync.test_cli_full_sync_engine import (
    FakeState, FakeBackground, FakeCli, FakeBindingCoordinator, FakeFallback,
)


class ForegroundWorkerCleanupTest(unittest.TestCase):
    def test_final_host_generation_check_cleans_foreground_without_closing_cli(self):
        class Foreground:
            close_calls = 0

            def close(self):
                self.close_calls += 1

            def observe_fresh(self, *, enabled, deadline, check_current):
                check_current()
                result = FreshForegroundObservation.create(
                    phase="confirmed", reason="confirmed_active_binding",
                    probe_available=True, wechat_in_front=True,
                    contact_id=UUID(int=2), binding_id=UUID(int=3),
                )
                # 模拟引擎完成自身复验后、宿主最终复验前的授权代际变化。
                with host._state_lock:
                    host._observation_generation += 1
                return result

        foreground = Foreground()
        cli = FakeCli()
        engine = CliFullSyncEngine(
            owner_id=UUID(int=1), channel="wechat", account_scope="synthetic-account",
            cli=cli, sync_state=FakeState(), background=FakeBackground(), foreground=foreground,
            binding_coordinator=FakeBindingCoordinator(), fallback=FakeFallback(),
        )
        host = SyncHost(engine=engine)
        self.addCleanup(host.stop)
        with self.assertRaises(SyncHostBusy):
            host.observe_foreground()
        self.assertEqual(foreground.close_calls, 1)
        self.assertEqual(cli.close_calls, 0)
        self.assertTrue(engine.sync_enabled())
