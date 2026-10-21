"""首次微信连接 API 只接受服务器候选，不接受调用者指定身份。"""
import json
import unittest
from uuid import uuid4
from notalone.application.wechat_setup import WechatSetupService
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient
from tests.unit.application.test_wechat_setup import Store


class WechatSetupApiTest(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.service = WechatSetupService(owner_id=uuid4(), runtime_account=None,
            store=self.store, probe=lambda: 'wxid_synthetic')
        self.client = InProcessClient(create_app(database_url='postgresql:///not_used',
            owner_id=None, token='synthetic-token', wechat_setup_service=self.service))
        self.headers = {'Authorization': 'Bearer synthetic-token'}

    def test_authentication_and_strict_confirmation(self):
        self.assertEqual(self.client.get('/api/setup/wechat').status_code, 401)
        self.assertEqual(self.client.get('/api/setup/wechat', headers=self.headers).json()['state'], 'needs_detection')
        ready = self.client.request('POST', '/api/setup/wechat/detect', headers=self.headers, body=b'{}').json()
        payload = dict(candidate_token=ready['candidate_token'], confirmed=True)
        for invalid in ({**payload, 'owner_id':str(uuid4())}, {**payload, 'account_id':'injected'},
                        {**payload, 'confirmed':1}, {'confirmed':True}):
            result = self.client.request('POST', '/api/setup/wechat/confirm', headers=self.headers,
                body=json.dumps(invalid).encode())
            self.assertEqual(result.status_code, 400)
        duplicate = b'{"candidate_token":"x","confirmed":false,"confirmed":true}'
        self.assertEqual(self.client.request('POST', '/api/setup/wechat/confirm',
            headers=self.headers, body=duplicate).status_code, 400)
        self.assertEqual(self.store.writes, [])
        result = self.client.request('POST', '/api/setup/wechat/confirm', headers=self.headers,
            body=json.dumps(payload).encode())
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()['state'], 'restart_required')
        self.assertEqual(len(self.store.writes), 1)

    def test_detection_requires_explicit_empty_body_and_generic_errors(self):
        for body in (b'', b'[]', b'{"account_id":"injected"}'):
            self.assertEqual(self.client.request('POST', '/api/setup/wechat/detect',
                headers=self.headers, body=body).status_code, 400)
        self.assertEqual(self.store.writes, [])
        failing = WechatSetupService(owner_id=uuid4(), runtime_account=None, store=self.store,
            probe=lambda: (_ for _ in ()).throw(RuntimeError('/private/raw-key')))
        client = InProcessClient(create_app(database_url='postgresql:///not_used',
            owner_id=None, token='synthetic-token', wechat_setup_service=failing))
        result = client.request('POST', '/api/setup/wechat/detect', headers=self.headers, body=b'{}')
        self.assertEqual(result.status_code, 500)
        self.assertEqual(result.json(), {'error':'setup_operation_failed'})
