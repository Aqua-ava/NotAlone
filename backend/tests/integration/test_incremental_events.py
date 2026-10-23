"""真实PG与原事件总线验证已提交事件投影，夹具仅使用独立随机测试库。"""
from pathlib import Path
import sys
import unittest
from time import monotonic
from threading import Timer
from datetime import datetime, timezone
from uuid import uuid4
import psycopg
from psycopg import sql
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'backend/src'))

from notalone.front_sync import incremental_events as receiver
from notalone.database_migrations import migrate
from notalone.server.event_bus import EventBus
from notalone.server.event_publisher import EventBusMessagePublisher

class TaskObserver:
    def __init__(self):self.calls=[]
    def wake_observation(self,**kwargs):self.calls.append(kwargs)

class EventsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.database='notalone_incremental_events_'+uuid4().hex+'_test'
        with psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as c:
            c.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(cls.database)))
        cls.dsn='host=/tmp dbname='+cls.database
        try:migrate(cls.dsn,ROOT/'backend/database/migrations')
        except BaseException:cls.tearDownClass();raise
    @classmethod
    def tearDownClass(cls):
        with psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as c:
            c.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(cls.database)))
    def setUp(self):
        self.owner,self.contact,self.binding,self.observation,self.message=[uuid4() for _ in range(5)]
        with psycopg.connect(self.dsn) as c:
            c.execute("TRUNCATE owner CASCADE")
            c.execute("INSERT INTO owner(id,display_name) VALUES(%s,'合成本人')",(self.owner,))
            c.execute("INSERT INTO contact(owner_id,id,display_name) VALUES(%s,%s,'合成联系人')",(self.owner,self.contact))
            c.execute("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES(%s,'wechat','synthetic-account','合成本人')",(self.owner,))
            c.execute("INSERT INTO front_sync_state(owner_id,enabled) VALUES(%s,true)",(self.owner,))
            c.execute("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator) VALUES(%s,%s,%s,'wechat','synthetic-account','synthetic-contact')",(self.binding,self.owner,self.contact))
            c.execute("INSERT INTO local_wechat_observation(id,owner_id,contact_id,binding_id,mode,cli_version,conversation_locator,last_local_id,last_cursor,record_count,event_count,is_reliable) VALUES(%s,%s,%s,%s,'cli_background','synthetic','synthetic-contact',1,'cursor',1,1,true)",(self.observation,self.owner,self.contact,self.binding))
            c.execute("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES(%s,%s,%s,'contact','text','PRIVATE_SYNTHETIC_BODY','2026-10-24T01:00:00Z')",(self.message,self.owner,self.contact))
            c.execute("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,observation_id,source_locator,raw_payload) VALUES(%s,%s,%s,'local_wechat_observation',%s,'cli:1','{}')",(self.message,self.owner,self.contact,self.observation))
        self.events=EventBus();self.subscription=self.events.subscribe(owner_id=self.owner)
        self.addCleanup(self.subscription.close)
        self.task=TaskObserver();self.learning=[]
        self.publisher=EventBusMessagePublisher(self.events,owner_id=self.owner,task_host=self.task,learning_notify=self.learning.append)
        self.receiver=receiver.IncrementalEventReceiver(database_url=self.dsn,owner_id=self.owner,publisher=self.publisher)
        self.payload={'events':[{'owner_id':str(self.owner),'contact_id':str(self.contact),'message_id':str(self.message),'occurred_at':'2026-10-24T02:00:00Z'}]}
    def test_locked_database_fails_within_total_budget_without_publishing(self):
        blocker = psycopg.connect(self.dsn)
        blocker.execute("LOCK TABLE public.message IN ACCESS EXCLUSIVE MODE")
        release = Timer(5, blocker.rollback)
        release.start()
        started = monotonic()
        try:
            with self.assertRaisesRegex(RuntimeError, "incremental_event_unavailable"):
                self.receiver.receive(self.payload)
            self.assertLess(monotonic() - started, 4)
            self.assertIsNone(self.subscription.read(timeout=0))
            self.assertEqual(self.task.calls, [])
        finally:
            release.cancel()
            blocker.rollback()
            blocker.close()

    def test_original_bus_task_and_learning_receive_metadata_only(self):
        self.assertEqual(self.receiver.receive(self.payload),1)
        event=self.subscription.read(timeout=0)
        self.assertEqual(event.event_type.value,'message.created')
        self.assertEqual(event.payload.message_id,self.message)
        self.assertEqual(event.occurred_at,datetime(2026,10,24,1,tzinfo=timezone.utc))
        self.assertNotIn('PRIVATE_SYNTHETIC_BODY',repr(event))
        self.assertEqual(self.task.calls,[dict(owner_id=self.owner,contact_id=self.contact,message_id=self.message)])
        self.assertEqual(len(self.learning),1)
    def assert_ignored_after(self, statement):
        with psycopg.connect(self.dsn) as c:c.execute(statement,(self.owner,))
        self.assertEqual(self.receiver.receive(self.payload),0)
        self.assertIsNone(self.subscription.read(timeout=0));self.assertEqual(self.task.calls,[])
    def test_deleted_source_late_event_ignored(self):
        self.assert_ignored_after("DELETE FROM message_source_ref WHERE owner_id=%s")
    def test_revoked_binding_late_event_ignored(self):
        self.assert_ignored_after("UPDATE conversation_binding SET status='revoked',revoked_at=now() WHERE owner_id=%s")
    def test_disabled_late_event_ignored(self):
        self.assert_ignored_after("UPDATE front_sync_state SET enabled=false WHERE owner_id=%s")
    def test_changed_account_late_event_ignored(self):
        self.assert_ignored_after("UPDATE owner_channel_identity SET external_id='other' WHERE owner_id=%s")
    def test_invalid_extra_body_and_foreign_owner_rejected_before_publish(self):
        for key,value in [('text','PRIVATE_SYNTHETIC_BODY'),('owner_id',str(uuid4()))]:
            event={**self.payload['events'][0],key:value}
            with self.assertRaises(ValueError):self.receiver.receive({'events':[event]})
        self.assertIsNone(self.subscription.read(timeout=0))

if __name__=='__main__':unittest.main(verbosity=2)
