"""首次连接一次提交身份、范围与开关；重试不覆盖用户后续决定。"""
from datetime import datetime, timezone
from pathlib import Path
import os
import unittest
from uuid import uuid4
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from notalone.database_migrations import migrate
from notalone.persistence.wechat_setup import PostgresWechatSetupStore
from notalone.application.wechat_setup import WechatSetupConflict
from notalone.persistence.sync_scope import PostgresSyncScopeStore
from notalone.persistence.front_sync_state import PostgresFrontSyncStateStore


class WechatSetupStoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        instance = os.environ.get('NOTALONE_TEST_DATABASE_URL', 'host=/tmp dbname=postgres')
        cls.name = 'notalone_wechat_setup_' + uuid4().hex + '_test'
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

    def setUp(self):
        self.owner = uuid4()
        self.account = 'wxid_synthetic_' + uuid4().hex
        self.at = datetime(2026, 10, 21, tzinfo=timezone.utc)
        self.store = PostgresWechatSetupStore(self.url)
        with psycopg.connect(self.url) as c:
            c.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成首次用户')", (self.owner,))

    def test_connect_and_retry_preserves_scope_time_and_later_disable(self):
        self.assertIsNone(self.store.read(self.owner))
        self.store.connect(self.owner, self.account, self.at)
        self.assertEqual(self.store.read(self.owner), self.account)
        scope = dict(owner_id=self.owner, channel='wechat', account_scope=self.account)
        scopes = PostgresSyncScopeStore(self.url)
        state = PostgresFrontSyncStateStore(self.url)
        self.assertEqual(scopes.read(**scope).mode, 'all_private')
        self.assertEqual(scopes.read(**scope).granted_at, self.at)
        self.assertTrue(state.read(owner_id=self.owner).enabled)
        scopes.set_mode(**scope, mode='selected', at=self.at)
        state.disable(owner_id=self.owner)
        self.store.connect(self.owner, self.account, datetime.now(timezone.utc))
        self.assertEqual(scopes.read(**scope).mode, 'selected')
        self.assertFalse(state.read(owner_id=self.owner).enabled)

    def test_other_owner_and_revoked_identity_fail_without_partial_grant(self):
        other = uuid4()
        with psycopg.connect(self.url) as c:
            c.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'其他合成用户')", (other,))
        self.store.connect(other, self.account, self.at)
        with self.assertRaises(WechatSetupConflict):
            self.store.connect(self.owner, self.account, self.at)
        self.assertIsNone(self.store.read(self.owner))
        self.assertFalse(PostgresFrontSyncStateStore(self.url).read(owner_id=self.owner).enabled)
        with psycopg.connect(self.url) as c:
            c.execute("UPDATE public.owner_channel_identity SET status='revoked' WHERE owner_id=%s", (other,))
        with self.assertRaises(WechatSetupConflict):
            self.store.connect(self.owner, self.account, self.at)
        with self.assertRaises(WechatSetupConflict):
            self.store.connect(other, self.account, self.at)

    def test_concurrent_same_account_has_one_owner_and_no_partial_second_grant(self):
        from concurrent.futures import ThreadPoolExecutor
        other = uuid4()
        with psycopg.connect(self.url) as c:
            c.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'并发合成用户')", (other,))
        def connect(owner):
            try:
                self.store.connect(owner, self.account, self.at)
                return owner
            except WechatSetupConflict:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            winners = [owner for owner in pool.map(connect, (self.owner, other)) if owner]
        self.assertEqual(len(winners), 1)
        for owner in (self.owner, other):
            self.assertEqual(self.store.read(owner), self.account if owner == winners[0] else None)
            self.assertEqual(PostgresFrontSyncStateStore(self.url).read(owner_id=owner).enabled,
                             owner == winners[0])

    def test_conflicting_scope_rolls_back_identity_insert(self):
        scope = dict(owner_id=self.owner, channel='wechat', account_scope=self.account)
        PostgresSyncScopeStore(self.url).set_mode(**scope, mode='selected', at=self.at)
        with self.assertRaises(WechatSetupConflict):
            self.store.connect(self.owner, self.account, self.at)
        self.assertIsNone(self.store.read(self.owner))
        self.assertFalse(PostgresFrontSyncStateStore(self.url).read(owner_id=self.owner).enabled)
