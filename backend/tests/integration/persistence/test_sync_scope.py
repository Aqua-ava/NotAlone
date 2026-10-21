"""全部私聊授权的持久化、稳定身份复用与删除排除。"""
from datetime import datetime, timezone
from pathlib import Path
import unittest
from uuid import uuid4

import psycopg
from psycopg import sql
from notalone.database_migrations import migrate
from notalone.persistence.sync_scope import PostgresSyncScopeStore
from notalone.wechat_cli.models import ChatCandidate


class SyncScopeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.name = 'notalone_sync_scope_' + uuid4().hex + '_test'
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
        self.at = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.store = PostgresSyncScopeStore(self.url)
        with psycopg.connect(self.url) as c:
            c.execute("INSERT INTO public.owner(id,display_name) VALUES (%s,'合成用户')", (self.owner,))

    def candidate(self, key, name='同名'):
        return ChatCandidate(username=key, display_name=name, chat_type='private', last_timestamp=None, match=None, sort_timestamp=None, source='sessions')

    def test_default_grant_restart_identity_reuse_and_future_baseline(self):
        self.assertEqual(self.store.read(**self.scope).mode, 'selected')
        self.assertEqual(self.store.enroll(**self.scope, sessions=[self.candidate('a')]), 0)
        with psycopg.connect(self.url) as c:
            contact = c.execute("INSERT INTO public.contact(owner_id,display_name) VALUES(%s,'旧称') RETURNING id", (self.owner,)).fetchone()[0]
            c.execute("INSERT INTO public.channel_identity(owner_id,contact_id,channel,external_id,observed_name) VALUES(%s,%s,'wechat','a','旧称')", (self.owner,contact))
        self.store.set_mode(**self.scope, mode='all_private', at=self.at)
        self.store.set_mode(**self.scope, mode='all_private', at=datetime(2026,2,1,tzinfo=timezone.utc))
        restarted = PostgresSyncScopeStore(self.url)
        self.assertEqual(restarted.read(**self.scope).granted_at, self.at)
        self.assertEqual(restarted.enroll(**self.scope, sessions=[self.candidate('a'),self.candidate('b')]), 2)
        self.assertEqual(restarted.enroll(**self.scope, sessions=[self.candidate('a')]), 0)
        self.assertEqual(restarted.enroll(**self.scope, sessions=[self.candidate('c')]), 1)
        with psycopg.connect(self.url) as c:
            self.assertEqual(c.execute("SELECT contact_id FROM public.conversation_binding WHERE owner_id=%s AND conversation_locator='a'", (self.owner,)).fetchone()[0], contact)
            self.assertEqual(c.execute('SELECT count(DISTINCT contact_id) FROM public.conversation_binding WHERE owner_id=%s', (self.owner,)).fetchone()[0], 3)
            self.assertEqual(c.execute('SELECT DISTINCT baseline_at FROM public.wechat_observation_baseline WHERE owner_id=%s', (self.owner,)).fetchall(), [(self.at,)])
        self.assertEqual(restarted.read(**{**self.scope,'account_scope':'other'}).mode,'selected')
        self.store.set_mode(**self.scope, mode='selected', at=self.at)
        self.assertEqual(self.store.enroll(**self.scope,sessions=[self.candidate('d')]),0)

    def test_revoked_and_physically_deleted_are_not_recreated(self):
        self.store.set_mode(**self.scope,mode='all_private',at=self.at)
        self.store.enroll(**self.scope,sessions=[self.candidate('a'),self.candidate('b')])
        with psycopg.connect(self.url) as c:
            c.execute("UPDATE public.conversation_binding SET status='revoked',revoked_at=now() WHERE owner_id=%s AND conversation_locator='a'",(self.owner,))
            c.execute("DELETE FROM public.contact WHERE owner_id=%s AND id IN (SELECT contact_id FROM public.conversation_binding WHERE owner_id=%s AND conversation_locator='b')",(self.owner,self.owner))
        self.assertEqual(self.store.enroll(**self.scope,sessions=[self.candidate('a'),self.candidate('b')]),0)
        self.store.set_mode(**self.scope,mode='selected',at=self.at)
        self.store.set_mode(**self.scope,mode='all_private',at=self.at)
        self.assertEqual(self.store.enroll(**self.scope,sessions=[self.candidate('a'),self.candidate('b')]),0)

    def test_groups_and_other_owners_remain_outside_scope(self):
        from dataclasses import replace
        other = uuid4()
        with psycopg.connect(self.url) as c:
            c.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'另一个合成用户')",(other,))
        self.store.set_mode(**self.scope,mode='all_private',at=self.at)
        self.assertEqual(self.store.enroll(**self.scope,sessions=[replace(self.candidate('group'),chat_type='group')]),0)
        self.assertEqual(self.store.read(**{**self.scope,'owner_id':other}).mode,'selected')
        self.assertEqual(self.store.enroll(**{**self.scope,'owner_id':other},sessions=[self.candidate('a')]),0)
        self.store.enroll(**self.scope,sessions=[self.candidate('a')])
        with psycopg.connect(self.url) as c:
            c.execute('DELETE FROM public.owner WHERE id=%s',(self.owner,))
            self.assertEqual(c.execute('SELECT count(*) FROM public.wechat_sync_exclusion WHERE owner_id=%s',(self.owner,)).fetchone()[0],0)
