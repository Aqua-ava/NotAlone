"""增量移交适配器的匿名 loopback 协议与停止合同。"""
from pathlib import Path
import http.client
import importlib.util
import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID

from notalone.front_sync.cli_sync import CliSyncStatus, CliSyncPhase, CliSyncCycleResult
from notalone.front_sync import incremental_remote as module
OWNER=UUID('11111111-1111-1111-1111-111111111111')
BINDING=UUID('22222222-2222-2222-2222-222222222222')
CONTACT=UUID('33333333-3333-3333-3333-333333333333')
HISTORY_COVERAGE={
    'binding_id':str(BINDING),'contact_id':str(CONTACT),'phase':'syncing','failure_code':'cli_timeout',
    'message_count':3,'non_text_count':1,'page_count':2,'last_local_id':'9','last_cursor':'history-cursor',
    'watermark_at':'2026-10-25T00:00:00Z','started_at':'2026-10-25T00:01:00Z',
    'completed_at':None,'updated_at':'2026-10-25T00:02:00Z',
}

class History:
    _history_only=True
    def __init__(self):
        self.pending=True;self.calls=[];self.closed=0;self.complete_next=False
    def close(self):self.closed+=1
    def history_only_pending(self):self.calls.append('pending');return self.pending
    def current_history_coverages(self):self.calls.append('coverage');return ()
    def cycle(self,**kwargs):
        self.calls.append(('history',kwargs))
        if self.complete_next:self.pending=False
        return CliSyncCycleResult(CliSyncStatus(CliSyncPhase.ACTIVE,False,None,None,2),1,True,None)
    def request_history_start(self):self.calls.append('start')
    def request_safety_sweep(self):self.calls.append('check')
    def pause_backfill(self):self.calls.append('pause')
    def retry_backfill(self):self.calls.append('retry')
    def start_history_for_bindings(self,bindings):return len(bindings)

class RemoteTest(unittest.TestCase):
    def setUp(self):
        self.requests=[];self.response_code=200
        self.history_coverages=[dict(HISTORY_COVERAGE)]
        outer=self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                outer.requests.append((self.path,body,self.headers.get('Authorization')))
                value={'phase':'active','stream_active':True,'stream_mode':'global_follow','failure_code':None,'bound_count':2,'batch_message_count':2,'enabled':True,'cli_available':True,'cli_failure_code':None}
                if outer.history_coverages is not None:
                    value['history_coverages']=outer.history_coverages
                if self.path.rsplit('/',1)[-1].startswith('follow-'):
                    value={'enabled':True,'stream_active':True,'process_id':123,'mode':'global_follow','watermark':None}
                if outer.response_code!=200:value={'error':'runtime_stopping'}
                payload=json.dumps(value).encode();self.send_response(outer.response_code);self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.history=History()
        self.remote=module.RemoteIncrementalBackground(url='http://127.0.0.1:'+str(self.server.server_port),token='synthetic-token',owner_id=OWNER,account_scope='synthetic_account',history=self.history)
    def tearDown(self):
        self.remote.shutdown();self.server.shutdown();self.server.server_close();self.thread.join(2)
    def test_constructor_local_drain_and_alternating_one_page_then_direct_incremental(self):
        self.assertEqual(self.requests,[]);self.assertEqual(self.history.closed,1)
        one=self.remote.cycle(enabled=True,max_bindings=32)
        self.assertEqual(one.batch_message_count,1);self.assertEqual(self.requests,[])
        two=self.remote.cycle(enabled=True,max_bindings=32)
        self.assertEqual(two.batch_message_count,2);self.assertEqual(self.requests[-1][1]['max_bindings'],1)
        self.history.complete_next=True
        self.remote.cycle(enabled=True)
        self.assertFalse(self.history.pending)
        self.remote.cycle(enabled=True);self.remote.cycle(enabled=True)
        self.assertEqual(len([r for r in self.requests if r[0].endswith('/cycle')]),3)
        self.assertEqual(len([c for c in self.history.calls if isinstance(c,tuple)]),2)
        self.assertEqual(self.requests[0][2],'Bearer synthetic-token')
    def test_close_503_always_cleans_history_then_explicit_resume_only(self):
        self.response_code=503
        self.remote.close();self.assertEqual(self.history.closed,2)
        before=len(self.requests)
        with self.assertRaises(module.IncrementalRemoteError):self.remote.cycle(enabled=True)
        self.assertEqual(len(self.requests),before)
        self.response_code=200;self.remote.resume();self.history.pending=False
        self.remote.cycle(enabled=True)
        self.assertEqual([r[0].rsplit('/',1)[-1] for r in self.requests],['stop','resume','cycle'])
    def test_controls_and_follow_only_use_explicit_remote_routes(self):
        self.remote.enable();self.remote.request_safety_sweep();self.remote.pause_backfill();self.remote.retry_backfill()
        before=len(self.requests)
        self.remote.follow_runtime_status()
        self.assertEqual(len(self.requests),before)
        self.remote.enable_follow_smoke()
        self.assertTrue(self.remote.follow_runtime_status().stream_active)
        self.remote.disable()
        names=[r[0].rsplit('/',1)[-1] for r in self.requests]
        self.assertEqual(names,['enable','check','pause','retry','follow-enable','disable'])
        self.assertIn('pause',self.history.calls);self.assertIn('retry',self.history.calls)
    def test_typescript_owns_history_when_local_adapter_is_absent(self):
        remote=module.RemoteIncrementalBackground(
            url='http://127.0.0.1:'+str(self.server.server_port),token='synthetic-token',
            owner_id=OWNER,account_scope='synthetic_account',history=None,
        )
        try:
            remote.enable()
            result=remote.cycle(enabled=True,max_bindings=1)
            self.assertEqual(result.status.history_coverages[0].binding_id,BINDING)
            self.assertEqual(result.status.history_coverages[0].last_local_id,9)
            self.assertEqual(result.batch_message_count,2)
            remote.request_safety_sweep();remote.request_backfill_check()
            remote.pause_backfill();remote.retry_backfill()
            disabled=remote.cycle(enabled=False)
            self.assertEqual(disabled.status.phase,CliSyncPhase.DISABLED)
            self.assertEqual(disabled.status.history_coverages[0].page_count,2)
            self.assertEqual(remote.start_history_for_bindings(()),0)
            remote.request_history_start()
            remote.disable()
            remote.close()
            before=len(self.requests)
            with self.assertRaises(module.IncrementalRemoteError):
                remote.cycle(enabled=True)
            self.assertEqual(len(self.requests),before)
        finally:
            remote.shutdown()
        names=[r[0].rsplit('/',1)[-1] for r in self.requests]
        self.assertEqual(names,['enable','cycle','check','check','pause','retry','status','disable','stop'])
    def test_remote_history_metadata_and_failures_are_strict(self):
        self.history.pending=False
        self.history_coverages=None
        with self.assertRaisesRegex(module.IncrementalRemoteError,'invalid_response'):
            self.remote.cycle(enabled=True)
        self.history_coverages=[{**HISTORY_COVERAGE,'message_count':-1}]
        with self.assertRaisesRegex(module.IncrementalRemoteError,'invalid_response'):
            self.remote.cycle(enabled=True)
    def test_factory_fails_closed_and_never_builds_python_history_in_typescript_mode(self):
        with patch.dict('os.environ',{'NOTALONE_HISTORY_RUNTIME':'typo'},clear=True):
            with self.assertRaisesRegex(ValueError,'history_runtime_invalid'):
                module.configured_history_runtime(__import__('os').environ)
        with patch.dict('os.environ',{'NOTALONE_HISTORY_RUNTIME':'typescript'},clear=True):
            from notalone.front_sync.factory import build_cli_full_sync_engine
            with self.assertRaisesRegex(ValueError,'history_runtime_incremental_required'):
                build_cli_full_sync_engine(database_url='synthetic',owner_id=OWNER,account_scope='synthetic')
        environment={
            'NOTALONE_HISTORY_RUNTIME':'typescript',
            'NOTALONE_SYNC_INCREMENTAL_URL':'http://127.0.0.1:1234',
            'NOTALONE_SYNC_INCREMENTAL_TOKEN':'synthetic',
            'NOTALONE_SYNC_INCREMENTAL_TRANSFERRED':'1',
            'NOTALONE_WECHAT_SCOPE_URL':'http://127.0.0.1:1234',
            'NOTALONE_WECHAT_SCOPE_TOKEN':'synthetic',
        }
        with patch.dict('os.environ',environment,clear=True), patch(
            'notalone.front_sync.factory.CliBackgroundSync',side_effect=AssertionError('python history built')
        ):
            from notalone.front_sync.factory import build_cli_full_sync_engine
            engine=build_cli_full_sync_engine(database_url='synthetic',owner_id=OWNER,account_scope='synthetic')
        self.assertIsNone(engine._background._history)
    def test_transfer_configuration_requires_complete_valid_trio(self):
        check=module.incremental_transfer_enabled
        self.assertFalse(check({}))
        good={'NOTALONE_SYNC_INCREMENTAL_URL':'http://127.0.0.1:1234','NOTALONE_SYNC_INCREMENTAL_TOKEN':'synthetic','NOTALONE_SYNC_INCREMENTAL_TRANSFERRED':'1'}
        self.assertTrue(check(good))
        for key in good:
            bad=dict(good);del bad[key]
            with self.assertRaises(ValueError):check(bad)
        for url in ('http://localhost:1234','http://127.0.0.1:0','http://127.0.0.1:3/path','http://user@127.0.0.1:3'):
            with self.assertRaises(ValueError):check({**good,'NOTALONE_SYNC_INCREMENTAL_URL':url})
        with self.assertRaises(ValueError):check({'NOTALONE_SYNC_INCREMENTAL_TRANSFERRED':'0'})
    def test_cancel_generation_cannot_be_reopened_by_late_enable(self):
        original=self.remote._request
        def request(operation,*args,**kwargs):
            result=original(operation,*args,**kwargs)
            if operation=='enable':self.remote.cancel_pending_io()
            return result
        self.remote._request=request
        with self.assertRaises(module.IncrementalRemoteError):self.remote.enable()
        self.assertTrue(self.remote._suspended)
        before=len(self.requests)
        with self.assertRaises(module.IncrementalRemoteError):self.remote.cycle(enabled=True)
        self.assertEqual(len(self.requests),before)
    def test_scope_failure_is_cached_without_extra_rpc(self):
        self.history.pending=False
        original=self.remote._request
        def request(operation,*args,**kwargs):
            return {**original(operation,*args,**kwargs),'sync_scope_failure_code':'sync_scope_identity_conflict'}
        self.remote._request=request
        result=self.remote.cycle(enabled=True)
        self.assertTrue(result.cli_available)
        before=len(self.requests)
        self.assertEqual(self.remote.scope_failure_code,'sync_scope_identity_conflict')
        self.assertEqual(len(self.requests),before)
    def test_full_sync_reads_scope_and_projects_remote_failure_without_discovery(self):
        from tests.unit.front_sync.test_cli_full_sync_engine import CliFullSyncEngineTest
        from notalone.persistence.sync_scope import SyncScopeState
        fixture=CliFullSyncEngineTest();fixture.setUp()
        fixture.engine._background=self.remote
        fixture.engine._sync_state=module.IncrementalReadOnlyState(fixture.state)
        reads=[]
        fixture.engine._scope_store=SimpleNamespace(read=lambda **kw: (reads.append(kw),SyncScopeState(mode='all_private'))[1])
        self.history.pending=False
        original=self.remote._request
        def request(operation,*args,**kwargs):
            return {**original(operation,*args,**kwargs),'sync_scope_failure_code':'sync_scope_identity_conflict'}
        self.remote._request=request
        report=fixture.engine.cycle_step(priority_contact_id=None,priority_requested_at=None)
        self.assertEqual(report.sync_scope_failure_code,'sync_scope_identity_conflict')
        self.assertEqual(report.sync_scope,'all_private')
        self.assertEqual(len(reads),1)
        fixture.engine.disable_sync()
        fixture.engine.enable_sync()
        self.assertTrue(fixture.state.enabled)
        self.assertFalse(self.remote._suspended)
    def test_full_sync_disabled_cycle_reports_without_remote_read_or_resume(self):
        from tests.unit.front_sync.test_cli_full_sync_engine import CliFullSyncEngineTest
        fixture=CliFullSyncEngineTest();fixture.setUp()
        fixture.engine._background=self.remote
        fixture.engine._sync_state=module.IncrementalReadOnlyState(fixture.state)
        original=self.remote._request
        def request(operation,*args,**kwargs):
            result=original(operation,*args,**kwargs)
            if operation=='disable':object.__setattr__(fixture.state,'enabled',False)
            return result
        self.remote._request=request
        fixture.engine.disable_sync()
        before=len(self.requests)
        report=fixture.engine.cycle_step(priority_contact_id=None,priority_requested_at=None)
        self.assertEqual(report.cli_sync_phase,'disabled')
        self.assertEqual(report.cli_batch_message_count,0)
        self.assertEqual(len(self.requests),before)
        self.assertTrue(self.remote._suspended)
    def test_readonly_switch_refuses_legacy_writers(self):
        state=module.IncrementalReadOnlyState(SimpleNamespace(read=lambda **kw:42,read_bounded=lambda **kw:43))
        self.assertEqual(state.read(),42);self.assertEqual(state.read_bounded(),43)
        with self.assertRaises(module.IncrementalRemoteError):state.enable()
        with self.assertRaises(module.IncrementalRemoteError):state.disable()
    def test_cancel_after_connect_never_auto_reconnects_or_sends_late_request(self):
        entered=threading.Event();release=threading.Event();connections=[];failures=[]
        class Connection:
            def __init__(self,*a,**kw):self.sock=None;self.auto_open=1;self.connects=0;connections.append(self)
            def connect(self):self.connects+=1;entered.set();release.wait(2)
            def close(self):pass
            def request(self,*a,**kw):raise AssertionError('cancelled request was sent')
        with patch.object(module.http.client,'HTTPConnection',Connection):
            def read():
                try:self.remote._request('status')
                except Exception as error:failures.append(error)
            thread=threading.Thread(target=read);thread.start();self.assertTrue(entered.wait(1))
            # 只执行本地取消半部，避免假连接阻塞 stop 控制请求。
            with self.remote._lock:self.remote._epoch+=1
            for c in tuple(self.remote._connections):self.remote._interrupt(c)
            release.set();thread.join(2)
        self.assertEqual(connections[0].connects,1);self.assertEqual(connections[0].auto_open,0)
        self.assertEqual(len(failures),1);self.assertIsInstance(failures[0],module.IncrementalRemoteError)

if __name__=='__main__':unittest.main(verbosity=2)
