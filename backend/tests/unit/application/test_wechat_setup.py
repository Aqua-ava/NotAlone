"""首次连接的公开服务契约：候选身份必须重新核实，重复操作不重新授权。"""
import unittest
from uuid import uuid4
from notalone.application.wechat_setup import WechatSetupService, WechatProbeUnavailable, WechatSetupConflict


class Store:
    def __init__(self):
        self.account = None
        self.writes = []

    def read(self, owner_id):
        return self.account

    def connect(self, owner_id, account_id, at):
        self.writes.append((owner_id, account_id, at))
        self.account = account_id


class WechatSetupTest(unittest.TestCase):
    def setUp(self):
        self.owner = uuid4()
        self.account = 'wxid_synthetic_owner'
        self.store = Store()
        self.service = WechatSetupService(owner_id=self.owner, runtime_account=None,
            store=self.store, probe=lambda: self.account)

    def test_first_connection_reprobes_and_recovers_after_lost_response(self):
        ready = self.service.detect()
        self.assertEqual(ready['state'], 'ready')
        self.assertEqual(ready['account_id'], self.account)
        result = self.service.confirm(candidate_token=ready['candidate_token'])
        self.assertEqual(result['state'], 'restart_required')
        self.assertEqual(self.service.status()['state'], 'restart_required')
        self.assertEqual(self.service.confirm(candidate_token=ready['candidate_token'])['state'], 'restart_required')
        self.assertEqual(len(self.store.writes), 1)
        restarted = WechatSetupService(owner_id=self.owner, runtime_account=self.account,
            store=self.store, probe=lambda: self.account)
        self.assertEqual(restarted.status()['state'], 'connected')

    def test_changed_account_cannot_be_authorized_with_old_candidate(self):
        ready = self.service.detect()
        self.account = 'wxid_other_owner'
        self.assertEqual(self.service.confirm(candidate_token=ready['candidate_token'])['state'], 'conflict')
        self.assertEqual(self.store.writes, [])

    def test_status_does_not_probe_before_user_detection(self):
        def forbidden():
            self.fail('后台状态检查不应访问微信')
        service = WechatSetupService(owner_id=self.owner, runtime_account=None,
            store=self.store, probe=forbidden)
        self.assertEqual(service.status()['state'], 'needs_detection')

    def test_no_owner_never_probes_and_failure_does_not_expose_external_details(self):
        def forbidden():
            self.fail('尚无 owner 不得探测')
        service = WechatSetupService(owner_id=None, runtime_account=None,
            store=self.store, probe=forbidden)
        self.assertEqual(service.detect()['state'], 'needs_owner')
        def failed():
            raise WechatProbeUnavailable('/private/keys/raw-secret')
        service = WechatSetupService(owner_id=self.owner, runtime_account=None,
            store=self.store, probe=failed)
        self.assertEqual(service.detect(), dict(state='tool_not_ready', account_id=None,
            candidate_token=None, failure_code='wechat_probe_failed'))

    def test_existing_account_does_not_reset_selected_or_disabled(self):
        self.store.account = self.account
        service = WechatSetupService(owner_id=self.owner, runtime_account=self.account,
            store=self.store, probe=lambda: self.fail('已接入不需要首次探测'))
        self.assertEqual(service.detect()['state'], 'connected')
        self.assertEqual(service.confirm(candidate_token='expired')['state'], 'connected')
        self.assertEqual(self.store.writes, [])

    def test_invalid_token_never_probes_or_writes(self):
        service = WechatSetupService(owner_id=self.owner, runtime_account=None,
            store=self.store, probe=lambda: self.fail('无候选不得探测'))
        self.assertEqual(service.confirm(candidate_token='forged')['failure_code'], 'wechat_candidate_expired')
        self.assertEqual(self.store.writes, [])

    def test_detection_does_not_read_sessions_before_scope_confirmation(self):
        calls = []
        def verify(expected):
            self.assertEqual(expected, self.account)
            calls.append('authorized_readability')
            return self.account
        service = WechatSetupService(owner_id=self.owner, runtime_account=None,
            store=self.store, probe=lambda: self.account, confirm_probe=verify)
        ready = service.detect()
        self.assertEqual(calls, [])
        self.assertEqual(service.confirm(candidate_token=ready['candidate_token'])['state'], 'restart_required')
        self.assertEqual(calls, ['authorized_readability'])

    def test_changed_candidate_cannot_trigger_authorized_readability_probe(self):
        service = WechatSetupService(owner_id=self.owner, runtime_account=None,
            store=self.store, probe=lambda: self.account,
            confirm_probe=lambda expected: self.fail('不能读取另一账号会话'))
        ready = service.detect()
        self.account = 'wxid_changed'
        self.assertEqual(service.confirm(candidate_token=ready['candidate_token'])['state'], 'conflict')
        self.assertEqual(self.store.writes, [])
