"""空用户经公开接入接口与正式装配自动关联、同步；仅外部微信工具合成。"""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from notalone.application.wechat_setup import WechatSetupService
from notalone.database_migrations import migrate
from notalone.front_sync.factory import owner_wechat_account_scope
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.retrieval import PostgresRetrieval
from notalone.persistence.wechat_setup import PostgresWechatSetupStore
from notalone.scopes import ContactScope
from notalone.server.app import create_app
from notalone.server.command import _build_sync_host
from notalone.server.event_bus import EventBus
from notalone.server.testing import InProcessClient
from notalone.wechat_cli.models import ChatCandidate, CliMessageEvent, MessageIdentifier
from tests.integration.front_sync.test_all_private_continuity import ScopeSyntheticCli


class FirstWechatConnectionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        instance = os.environ.get('NOTALONE_TEST_DATABASE_URL', 'host=/tmp dbname=postgres')
        cls.name = 'notalone_first_wechat_' + uuid4().hex + '_test'
        cls.url = make_conninfo(instance, dbname=cls.name)
        cls.admin = psycopg.connect(instance, dbname='postgres', autocommit=True)
        cls.admin.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(cls.name)))
        cls.addClassCleanup(cls.drop_database)
        migrate(cls.url, Path(__file__).resolve().parents[3] / 'database/migrations')

    @classmethod
    def drop_database(cls):
        try:
            cls.admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(cls.name)))
        finally:
            cls.admin.close()

    def test_first_grant_builds_sync_host_and_discovers_current_and_future_private_chats(self):
        owner = uuid4()
        with psycopg.connect(self.url) as connection:
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'首次接入合成用户')", (owner,))
        events = EventBus()
        self.assertIsNone(_build_sync_host(database_url=self.url, owner_id=owner, interval=3, events=events))
        account = 'synthetic-first-connection'
        grant = datetime.now(timezone.utc) - timedelta(seconds=5)
        probe_calls = []
        def probe():
            probe_calls.append(True)
            return account
        service = WechatSetupService(owner_id=owner, runtime_account=None,
            store=PostgresWechatSetupStore(self.url), probe=probe, clock=lambda: grant)
        client = InProcessClient(create_app(database_url=self.url, owner_id=owner,
            token='synthetic-token', wechat_setup_service=service))
        headers = {'Authorization': 'Bearer synthetic-token'}
        def request(method, suffix='', payload=None):
            response = client.request(method, '/api/setup/wechat' + suffix, headers=headers,
                body=b'' if payload is None else json.dumps(payload).encode())
            self.assertEqual(response.status_code, 200, response.json())
            return response.json()
        self.assertEqual(request('GET')['state'], 'needs_detection')
        self.assertEqual(probe_calls, [])
        detected = request('POST', '/detect', {})
        self.assertEqual(detected['state'], 'ready')
        self.assertIsNone(owner_wechat_account_scope(self.url, owner))
        confirmed = request('POST', '/confirm', {'candidate_token': detected['candidate_token'], 'confirmed': True})
        self.assertEqual(confirmed['state'], 'restart_required')
        self.assertEqual(len(probe_calls), 2)
        self.assertEqual(owner_wechat_account_scope(self.url, owner), account)

        cli = ScopeSyntheticCli()
        def add_chat(talker, local_id, text, seconds):
            cli.available.append(ChatCandidate(username=talker, display_name='同名合成联系人',
                chat_type='private', last_timestamp=None, match=None, sort_timestamp=None, source='sessions'))
            cli.replay(talker, CliMessageEvent(message_id=MessageIdentifier(local_id, talker),
                text=text, kind='text', sender='合成人', sender_wxid=talker, is_from_me=False,
                create_time=int(grant.timestamp()) + seconds, time=None, time_iso=None))
        add_chat('synthetic_current', 1, '首次授权后的消息', 1)
        # 重建调用正式服务器装配，替换的只有外部微信适配器；没有人工插入身份或联系人。
        with patch('notalone.front_sync.factory.LocalWechatCli', return_value=cli):
            host = _build_sync_host(database_url=self.url, owner_id=owner, interval=3, events=events)
        self.assertIsNotNone(host)
        self.addCleanup(host.stop)
        report = host.check()
        self.assertTrue(report.sync_enabled)
        self.assertEqual(report.sync_scope, 'all_private')
        bindings = PostgresConversationBindingRepository(self.url)
        scope = dict(owner_id=owner, channel='wechat', account_scope=account)
        saved = {item.conversation_locator: item.scope.contact_id for item in bindings.list_active_bindings(**scope)}
        self.assertEqual(set(saved), {'synthetic_current'})
        retrieval = PostgresRetrieval(self.url)
        self.assertEqual([message.text for message in retrieval.search_messages(
            scope=ContactScope(owner, saved['synthetic_current']))], ['首次授权后的消息'])

        add_chat('synthetic_future', 2, '以后新增私聊的消息', 2)
        host.check()
        saved = {item.conversation_locator: item.scope.contact_id for item in bindings.list_active_bindings(**scope)}
        self.assertEqual(set(saved), {'synthetic_current', 'synthetic_future'})
        self.assertEqual(len(set(saved.values())), 2)
        host.check()
        self.assertEqual(len(retrieval.search_messages(scope=ContactScope(owner, saved['synthetic_future']))), 1)

        resumed = WechatSetupService(owner_id=owner, runtime_account=account,
            store=PostgresWechatSetupStore(self.url), probe=probe)
        self.assertEqual(resumed.status()['state'], 'connected')
        host.disable()
        self.assertEqual(resumed.confirm(candidate_token=detected['candidate_token'])['state'], 'connected')
        self.assertFalse(host.check().sync_enabled)
        self.assertEqual(len(probe_calls), 2)
