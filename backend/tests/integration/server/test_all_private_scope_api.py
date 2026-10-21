"""全部私聊范围的鉴权、严格确认与状态缓存契约。"""
from dataclasses import replace
import unittest
import json
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient
from tests.integration.server.test_sync_api import OWNER_ID, ScriptedSyncControl, _report
from tests.unit.server.test_sync_host import FakeEngine
from notalone.server.sync_host import SyncHost


class ScopeControl(ScriptedSyncControl):
    def __init__(self): super().__init__(_report(enabled=False)); self.scopes=[]
    def set_sync_scope(self, mode):
        self.scopes.append(mode)
        self.next_report=replace(self.next_report,sync_scope=mode)
        return self.next_report


class ScopeApiTest(unittest.TestCase):
    def setUp(self):
        self.control=ScopeControl()
        self.client=InProcessClient(create_app(database_url='postgresql:///notalone_test',owner_id=OWNER_ID,
            token='test-token',sync_control=self.control))
        self.headers={'Authorization':'Bearer test-token'}
    def test_explicit_scope_preserves_off_and_status(self):
        response=self.client.request('POST','/api/sync/scope',headers=self.headers,body=json.dumps({'mode':'all_private','confirmed':True}).encode())
        self.assertEqual(response.status_code,200)
        self.assertFalse(response.json()['sync_enabled'])
        self.assertEqual(response.json()['sync_scope'],'all_private')
        self.assertEqual(self.client.get('/api/sync/status',headers=self.headers).json()['sync_scope'],'all_private')
    def test_rejects_missing_auth_confirmation_and_extra_authority(self):
        response=self.client.request('POST','/api/sync/scope',body=b'{}')
        self.assertEqual(response.status_code,401)
        for payload in ({'mode':'all_private'}, {'mode':'all_private','confirmed':1},
            {'mode':'all_private','confirmed':False},{'mode':'all','confirmed':True},
            {'mode':'all_private','confirmed':True,'owner_id':str(OWNER_ID)},[],None):
            with self.subTest(payload=payload):
                self.assertEqual(self.client.request('POST','/api/sync/scope',headers=self.headers,body=json.dumps(payload).encode()).status_code,400)
        for raw in (b'{"mode":"selected","mode":"all_private","confirmed":true}',
                    b'{"mode":"all_private","confirmed":false,"confirmed":true}',
                    b'{"mode":NaN,"confirmed":true}', b'not-json', b'\xff'):
            self.assertEqual(self.client.request('POST','/api/sync/scope',headers=self.headers,body=raw).status_code,400)
        self.assertEqual(self.control.scopes,[])
    def test_host_scope_change_refreshes_cache_without_enabling(self):
        class Engine(FakeEngine):
            mode='selected'
            def set_sync_scope(self,mode): self.mode=mode
            def cycle(self): return replace(super().cycle(),sync_scope=self.mode)
        engine=Engine(); host=SyncHost(engine=engine)
        report=host.set_sync_scope('all_private')
        self.assertEqual(report.sync_scope,'all_private')
        self.assertEqual(host.status().sync_scope,'all_private')
        self.assertFalse(engine.enabled)
