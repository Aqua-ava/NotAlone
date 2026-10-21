"""全部私聊授权到消息检索的真实持久化链路，仅外部 CLI 使用合成数据。"""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
import os
import unittest
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from notalone.database_migrations import migrate
from notalone.front_sync.cli_binding import CliBindingCoordinator
from notalone.front_sync.cli_sync import CliBackgroundSync
from notalone.front_sync.full_sync_engine import CliFullSyncEngine
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.front_sync_state import PostgresFrontSyncStateStore
from notalone.persistence.observation_store import PostgresObservationStore
from notalone.persistence.retrieval import PostgresRetrieval
from notalone.persistence.sync_scope import PostgresSyncScopeStore
from notalone.scopes import ContactScope
from notalone.wechat_cli.models import ChatCandidate, CliMessageEvent, MessageIdentifier, TailResult
from tests.integration.front_sync.test_confirmed_contact_continuity import SyntheticCli


class ScopeSyntheticCli(SyntheticCli):
    """外部 CLI 的合成替身，按实际 since_time 请求过滤历史。"""
    def __init__(self):
        super().__init__()
        self.available = []
        self.session_calls = 0
        self.since_calls = []

    def sessions(self, **kwargs):
        self.session_calls += 1
        return tuple(self.available)

    def tail(self, talker, **kwargs):
        result = super().tail(talker, **kwargs)
        since = kwargs.get('since_time')
        if since:
            self.since_calls.append((talker, since))
            cutoff = datetime.fromisoformat(since).astimezone().timestamp()
            result = replace(result, events=tuple(event for event in result.events if event.create_time >= cutoff))
        elif kwargs.get('cursor'):
            # 可重叠返回水位所在项以验证去重，但不能伪造 cursor 之前的旧历史。
            cursor_id = int(kwargs['cursor'].split(':', 1)[1])
            result = replace(result, events=tuple(event for event in result.events if event.message_id.local_id >= cursor_id))
        return result


class AllPrivateContinuityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        instance = os.environ.get('NOTALONE_TEST_DATABASE_URL', 'host=/tmp dbname=postgres')
        cls.name = 'notalone_scope_continuity_' + uuid4().hex + '_test'
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

    def test_future_first_message_before_discovery_is_ingested_once_and_off_stops_reads(self):
        owner = uuid4()
        with psycopg.connect(self.url) as connection:
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成范围验收用户')", (owner,))
        grant = datetime(2026, 10, 21, 1, tzinfo=timezone.utc)
        now = grant
        cli = ScopeSyntheticCli()
        bindings = PostgresConversationBindingRepository(self.url)
        observations = PostgresObservationStore(self.url)
        state = PostgresFrontSyncStateStore(self.url)
        retrieval = PostgresRetrieval(self.url)
        scope = dict(owner_id=owner, channel='wechat', account_scope='synthetic-account')
        background = CliBackgroundSync(**scope, cli=cli, bindings=bindings,
            observation_store=observations, sync_state=state, clock=lambda: now)
        engine = CliFullSyncEngine(**scope, cli=cli, sync_state=state, background=background,
            binding_coordinator=CliBindingCoordinator(**scope, cli=cli, bindings=bindings,
                batch_repository=bindings, clock=lambda: now),
            foreground=object(), fallback=object(), clock=lambda: now,
            scope_store=PostgresSyncScopeStore(self.url))
        self.addCleanup(engine.close)
        def session(talker):
            return ChatCandidate(username=talker, display_name='同名合成人', chat_type='private',
                last_timestamp=None, match=None, sort_timestamp=None, source='sessions')
        def message(talker, local_id, text, seconds):
            return CliMessageEvent(message_id=MessageIdentifier(local_id,talker), text=text, kind='text',
                sender='合成人', sender_wxid=talker, is_from_me=False,
                create_time=int(grant.timestamp())+seconds, time=None, time_iso=None)
        def messages(contact):
            return retrieval.search_messages(scope=ContactScope(owner,contact))
        cli.available = [session('synthetic_a')]
        cli.replay('synthetic_a', message('synthetic_a', 1, '授权前历史', -60),
                   message('synthetic_a', 2, '授权后甲的消息', 1))
        engine.set_sync_scope('all_private')
        engine.cycle()
        self.assertEqual(cli.session_calls, 0)
        self.assertEqual(cli.tail_calls, [])
        self.assertEqual(bindings.list_active_bindings(**scope), ())
        now = grant + timedelta(seconds=10)
        engine.enable_sync()
        engine.cycle()
        saved = {binding.conversation_locator: binding.scope.contact_id for binding in bindings.list_active_bindings(**scope)}
        self.assertEqual(set(saved), {'synthetic_a'})
        self.assertEqual([item.text for item in messages(saved['synthetic_a'])], ['授权后甲的消息'])

        # 新会话在两次发现之间收到首条消息；发现时间不能成为它的新 baseline。
        cli.available.append(session('synthetic_b'))
        cli.replay('synthetic_b', message('synthetic_b', 1, '发现前乙的首条消息', 30))
        now = grant + timedelta(seconds=71)
        engine.cycle()
        saved = {binding.conversation_locator: binding.scope.contact_id for binding in bindings.list_active_bindings(**scope)}
        self.assertEqual(set(saved), {'synthetic_a', 'synthetic_b'})
        self.assertNotEqual(saved['synthetic_a'], saved['synthetic_b'])
        self.assertEqual([item.text for item in messages(saved['synthetic_b'])], ['发现前乙的首条消息'])
        expected_since = grant.astimezone().replace(tzinfo=None).isoformat(timespec='seconds')
        self.assertIn(('synthetic_b', expected_since), cli.since_calls)
        cli.notify('synthetic_b', 5)
        now += timedelta(seconds=3)
        engine.cycle()
        self.assertEqual(len(messages(saved['synthetic_b'])), 1)
        self.assertEqual([item.text for item in messages(saved['synthetic_a'])], ['授权后甲的消息'])

        engine.disable_sync()
        calls = (cli.session_calls, len(cli.tail_calls))
        cli.available.append(session('synthetic_c'))
        cli.replay('synthetic_b', message('synthetic_b', 2, '关闭时不读取', 80))
        now += timedelta(seconds=61)
        engine.cycle()
        self.assertEqual((cli.session_calls, len(cli.tail_calls)), calls)
        self.assertEqual(len(bindings.list_active_bindings(**scope)), 2)
        self.assertEqual([item.text for item in messages(saved['synthetic_b'])], ['发现前乙的首条消息'])
