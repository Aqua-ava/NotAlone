"""全部私聊范围只在总开关打开时发现，失败可恢复，重启保持授权。"""
from datetime import datetime, timedelta, timezone
import unittest
from notalone.front_sync.full_sync_engine import CliFullSyncEngine
from notalone.persistence.sync_scope import SyncScopeState
from tests.unit.front_sync.test_cli_full_sync_engine import (
    OWNER_ID, FakeState, FakeBackground, FakeForeground, FakeBindingCoordinator, FakeFallback, FakeCli,
)


class ScopeStore:
    state = SyncScopeState()
    def __init__(self): self.enrolled=[]
    def read(self, **kwargs): return self.state
    def set_mode(self, *, mode, at, **kwargs): self.state=SyncScopeState(mode,at)
    def enroll(self, *, sessions, **kwargs): self.enrolled.append(tuple(sessions)); return 1


class Cli(FakeCli):
    def __init__(self): super().__init__(); self.calls=0; self.fail=False
    def sessions(self, **kwargs):
        self.calls+=1
        if self.fail: raise RuntimeError('sensitive error')
        return ('synthetic',)


class AllPrivateEngineTest(unittest.TestCase):
    def setUp(self):
        self.now=datetime(2026,1,1,tzinfo=timezone.utc)
        self.scope=ScopeStore(); self.cli=Cli(); self.state=FakeState(False)
        self.background=FakeBackground()
        self.engine=self.make_engine()
    def make_engine(self):
        return CliFullSyncEngine(owner_id=OWNER_ID,channel='wechat',account_scope='self',cli=self.cli,
            sync_state=self.state,background=self.background,foreground=FakeForeground(),
            binding_coordinator=FakeBindingCoordinator(),fallback=FakeFallback(),clock=lambda:self.now,
            scope_store=self.scope)
    def test_off_grant_enable_periodic_new_sessions_restart_and_selected(self):
        self.engine.set_sync_scope('all_private')
        self.assertFalse(self.state.enabled)
        self.assertEqual(self.engine.cycle().sync_scope,'all_private')
        self.assertEqual(self.cli.calls,0)
        self.engine.enable_sync(); self.engine.cycle()
        self.assertEqual(len(self.scope.enrolled),1)
        self.engine.cycle(); self.assertEqual(self.cli.calls,1)
        self.now+=timedelta(seconds=61); self.engine.cycle()
        self.assertEqual(len(self.scope.enrolled),2)
        self.engine=self.make_engine(); self.engine.cycle()
        self.assertEqual(len(self.scope.enrolled),3)
        self.engine.set_sync_scope('selected'); self.now+=timedelta(seconds=61); self.engine.cycle()
        self.assertEqual(len(self.scope.enrolled),3)
    def test_failure_visible_existing_sync_continues_and_retries(self):
        self.engine.set_sync_scope('all_private'); self.engine.enable_sync(); self.cli.fail=True
        report=self.engine.cycle()
        self.assertEqual(report.sync_scope_failure_code,'sync_scope_discovery_failed')
        self.assertTrue(self.background.calls[-1])
        self.cli.fail=False; self.now+=timedelta(seconds=61)
        report=self.engine.cycle()
        self.assertIsNone(report.sync_scope_failure_code)
        self.assertEqual(len(self.scope.enrolled),1)
