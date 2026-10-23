"""历史同步授权版本的持久化、幂等与并发语义。

老授权没有版本行时必须保持“待确认”，不能按同步范围推断历史读取资格。
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg import sql

from notalone.database_migrations import migrate
from notalone.persistence.history_authorization import (
    HISTORY_SYNC_AUTHORIZATION_VERSION,
    HistoryAuthorizationState,
    PostgresHistorySyncAuthorizationStore,
)


class HistoryAuthorizationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.name = 'notalone_history_auth_' + uuid4().hex + '_test'
        cls.url = 'host=/tmp dbname=' + cls.name
        with psycopg.connect('host=/tmp dbname=postgres', autocommit=True) as c:
            c.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(cls.name)))
        migrate(cls.url, Path(__file__).resolve().parents[3] / 'database/migrations')

    @classmethod
    def tearDownClass(cls):
        with psycopg.connect('host=/tmp dbname=postgres', autocommit=True) as c:
            c.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(cls.name)))

    def setUp(self):
        self.owner = uuid4()
        self.scope = dict(owner_id=self.owner, channel='wechat', account_scope='self-a')
        self.at = datetime(2026, 10, 23, tzinfo=timezone.utc)
        self.store = PostgresHistorySyncAuthorizationStore(self.url)
        with psycopg.connect(self.url) as c:
            c.execute("INSERT INTO public.owner(id,display_name) VALUES (%s,'合成用户')", (self.owner,))

    def test_old_authorization_without_version_requires_confirmation(self):
        state = self.store.read(**self.scope)
        self.assertIs(state.state, HistoryAuthorizationState.REQUIRED)
        self.assertIsNone(state.version)
        self.assertEqual(state.current_version, HISTORY_SYNC_AUTHORIZATION_VERSION)
        self.assertFalse(self.store.history_sync_authorized(**self.scope))

    def test_decline_is_persisted_idempotent_and_grants_nothing(self):
        declined = self.store.decide(**self.scope, decision='declined', at=self.at)
        self.assertIs(declined.state, HistoryAuthorizationState.DECLINED)
        self.assertEqual(declined.version, HISTORY_SYNC_AUTHORIZATION_VERSION)
        self.assertFalse(self.store.history_sync_authorized(**self.scope))
        repeated = self.store.decide(**self.scope, decision='declined', at=self.at)
        self.assertIs(repeated.state, HistoryAuthorizationState.DECLINED)
        # 恢复应用后仍保持拒绝，不反复要求确认。
        restarted = PostgresHistorySyncAuthorizationStore(self.url)
        self.assertIs(restarted.read(**self.scope).state, HistoryAuthorizationState.DECLINED)

    def test_accept_after_decline_and_repeat_are_idempotent(self):
        self.store.decide(**self.scope, decision='declined', at=self.at)
        accepted = self.store.decide(**self.scope, decision='accepted', at=self.at)
        self.assertIs(accepted.state, HistoryAuthorizationState.ACCEPTED)
        self.assertTrue(self.store.history_sync_authorized(**self.scope))
        repeated = PostgresHistorySyncAuthorizationStore(self.url).decide(
            **self.scope, decision='accepted', at=datetime(2026, 10, 24, tzinfo=timezone.utc),
        )
        self.assertIs(repeated.state, HistoryAuthorizationState.ACCEPTED)
        with psycopg.connect(self.url) as c:
            self.assertEqual(c.execute(
                'SELECT count(*), min(decided_at) FROM public.wechat_history_sync_authorization WHERE owner_id=%s',
                (self.owner,),
            ).fetchone(), (1, self.at))
        # 已经明确同意后，迟到的拒绝不能静默收回历史读取资格。
        stayed = self.store.decide(**self.scope, decision='declined', at=self.at)
        self.assertIs(stayed.state, HistoryAuthorizationState.ACCEPTED)

    def test_newer_authorization_version_is_not_downgraded(self):
        with psycopg.connect(self.url) as c:
            c.execute('''INSERT INTO public.wechat_history_sync_authorization
                (owner_id,channel,account_scope,version,decision,decided_at)
                VALUES(%s,'wechat','self-a',2,'accepted',%s)''', (self.owner, self.at))
        # 降级后的应用不能把更新版本的同意改写成当前版本。
        state = self.store.decide(**self.scope, decision='accepted', at=self.at)
        self.assertIs(state.state, HistoryAuthorizationState.ACCEPTED)
        with psycopg.connect(self.url) as c:
            self.assertEqual(c.execute(
                'SELECT version, decision FROM public.wechat_history_sync_authorization WHERE owner_id=%s',
                (self.owner,),
            ).fetchone(), (2, 'accepted'))

    def test_concurrent_accept_and_decline_leave_one_accepted_row(self):
        def decide(decision):
            store = PostgresHistorySyncAuthorizationStore(self.url)
            return store.decide(**self.scope, decision=decision, at=self.at).state
        with ThreadPoolExecutor(max_workers=2) as pool:
            states = list(pool.map(decide, ('accepted', 'declined')))
        self.assertIn(HistoryAuthorizationState.ACCEPTED, states)
        self.assertIs(self.store.read(**self.scope).state, HistoryAuthorizationState.ACCEPTED)
        with psycopg.connect(self.url) as c:
            self.assertEqual(c.execute(
                'SELECT count(*) FROM public.wechat_history_sync_authorization WHERE owner_id=%s',
                (self.owner,),
            ).fetchone()[0], 1)

    def test_older_version_requires_new_confirmation(self):
        self.store.decide(**self.scope, decision='accepted', at=self.at)
        with patch(
            'notalone.persistence.history_authorization.HISTORY_SYNC_AUTHORIZATION_VERSION', 2
        ):
            state = self.store.read(**self.scope)
            self.assertIs(state.state, HistoryAuthorizationState.REQUIRED)
            self.assertEqual(state.version, 1)
            self.assertEqual(state.current_version, 2)
            self.assertFalse(self.store.history_sync_authorized(**self.scope))
            accepted = self.store.decide(**self.scope, decision='accepted', at=self.at)
            self.assertIs(accepted.state, HistoryAuthorizationState.ACCEPTED)
            self.assertEqual(accepted.version, 2)

    def test_accounts_and_owners_are_isolated(self):
        other_owner = uuid4()
        with psycopg.connect(self.url) as c:
            c.execute("INSERT INTO public.owner(id,display_name) VALUES (%s,'另一个合成用户')", (other_owner,))
        self.store.decide(**self.scope, decision='accepted', at=self.at)
        self.assertTrue(self.store.history_sync_authorized(**self.scope))
        self.assertFalse(self.store.history_sync_authorized(
            **{**self.scope, 'account_scope': 'self-b'}))
        self.assertFalse(self.store.history_sync_authorized(
            **{**self.scope, 'owner_id': other_owner}))


if __name__ == '__main__':
    unittest.main()
