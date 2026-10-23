"""微信授权移交后旧HTTP入口不能继续读取列表或写入授权。"""
import unittest
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient


class WechatScopeHandoffTest(unittest.TestCase):
    def test_transferred_routes_reject_before_services_and_require_authentication(self):
        client = InProcessClient(create_app(database_url='postgresql:///not_used',
            owner_id=None, token='synthetic-token', wechat_scope_transferred=True))
        headers = {'Authorization': 'Bearer synthetic-token'}
        paths = ('/api/setup/wechat', '/api/setup/wechat/detect', '/api/setup/wechat/confirm',
                 '/api/sync/cli-sessions', '/api/sync/cli-bindings',
                 '/api/sync/cli-bindings/confirm', '/api/sync/cli-bindings/revoke',
                 '/api/sync/scope', '/api/sync/history-authorization',
                 '/api/sync/confirm', '/api/sync/confirm-pending')
        for path in paths:
            with self.subTest(path=path):
                self.assertEqual(client.request('POST', path, body=b'{}').status_code, 401)
                result = client.request('POST', path, headers=headers, body=b'{}')
                self.assertEqual(result.status_code, 503)
                self.assertEqual(result.json(), {'error': 'wechat_scope_owned_by_typescript'})
