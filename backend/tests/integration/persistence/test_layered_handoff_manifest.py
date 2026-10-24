"""移交后的分层事务只使用当前依赖指纹，不要求概览缓存存在。"""

import os
import unittest
from dataclasses import replace
from types import SimpleNamespace
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from notalone.memory.layered import LayeredMemoryConflict, OrganizationBudget
from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
from notalone.scopes import ContactScope, OwnerScope
from notalone.server.memory_overview import overview_payload
from notalone.server.contact_context_handoff import ContactContextHandoff


class LayeredHandoffManifestTest(unittest.TestCase):
    def setUp(self):
        self.url = os.environ['NOTALONE_TEST_DATABASE_URL']
        self.owner, self.contact, self.source, self.memory = (uuid4() for _ in range(4))
        self.scope = ContactScope(self.owner, self.contact)
        with psycopg.connect(self.url) as c:
            self.assertTrue(c.info.dbname.endswith('_test'))
            c.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成本人')", (self.owner,))
            c.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成联系人')", (self.contact,self.owner))
            c.execute("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES(%s,%s,%s,'manual','合成资料',repeat('a',64),1)", (self.source,self.owner,self.contact))
            c.execute("INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method) VALUES(%s,%s,%s,'合成旧资料','common_fact',%s,'manual')", (self.memory,self.owner,self.contact,[self.source]))
        self.addCleanup(self.cleanup)
        self.policy = ContactContextHandoff()
        self.policy.stop()
        self.store = PostgresLayeredMemoryStore(self.url, contact_context=self.policy)

    def cleanup(self):
        with psycopg.connect(self.url) as c:
            c.execute('DELETE FROM public.owner WHERE id=%s', (self.owner,))

    def manifest(self, store=None):
        store = store or self.store
        with store.transaction(self.scope) as (c, state, overview):
            return store._manifest(c,self.scope,store.eligible(overview))

    def cache(self):
        with psycopg.connect(self.url) as c:
            return c.execute('SELECT manifest FROM public.relationship_overview_projection WHERE owner_id=%s AND contact_id=%s', (self.owner,self.contact)).fetchone()

    def test_no_projection_and_missing_internal_manifest_fail_closed(self):
        self.assertIsNone(self.cache())
        manifest = self.manifest()
        self.assertEqual(manifest[0]['memory_id'],str(self.memory))
        self.assertIsNone(self.cache())
        self.store.read(self.scope)
        with self.store.transaction(self.scope) as (c,state,overview):
            entry = replace(self.store.eligible(overview)[0],dependency_manifest=None)
            with self.assertRaises(LayeredMemoryConflict):
                self.store._manifest(c,self.scope,(entry,))

    def test_stale_projection_uses_complete_current_fingerprint(self):
        old = self.manifest(PostgresLayeredMemoryStore(self.url))
        cached = self.cache()
        with psycopg.connect(self.url) as c:
            saved = c.execute('SELECT to_jsonb(p) FROM public.relationship_overview_projection p WHERE owner_id=%s', (self.owner,)).fetchone()[0]
            c.execute("UPDATE public.confirmed_memory SET text_content='合成新资料',revision=revision+1 WHERE id=%s", (self.memory,))
            # 真实失效触发器会删除缓存；还原旧缓存验证读取不会信任陈旧指纹。
            c.execute('INSERT INTO public.relationship_overview_projection SELECT * FROM jsonb_populate_record(NULL::public.relationship_overview_projection,%s)', (Jsonb(saved),))
        current = self.manifest()
        self.assertNotEqual(current,old)
        self.assertNotEqual(current[0]['record_sha256'],old[0]['record_sha256'])
        self.assertEqual(self.cache(),cached)
        expected = self.manifest(PostgresLayeredMemoryStore(self.url))
        self.assertEqual(current,expected)

    def test_changed_manifest_invalidates_job_and_rejects_late_publish(self):
        manifest = self.manifest()
        budget = OrganizationBudget()
        task,_ = self.store.enqueue(self.scope,budget,'synthetic-handoff')
        batch = uuid4()
        with self.store.transaction(self.scope) as (c,state,overview):
            c.execute("INSERT INTO public.layered_memory_batch(id,owner_id,contact_id,settings_generation,work_key,status,input_manifest,input_payload,dependency_ids,created_at) VALUES(%s,%s,%s,%s,%s,'running',%s,'[]',%s,now())", (batch,self.owner,self.contact,state['settings_generation'],str(batch),Jsonb(manifest),[self.memory]))
            work = SimpleNamespace(id=batch,scope=self.scope,settings_generation=state['settings_generation'],correction_revision=state['correction_revision'],scenarios=(),claim=None,memories=(SimpleNamespace(memory_id=self.memory),),manifest=manifest)
        with psycopg.connect(self.url) as c:
            c.execute("UPDATE public.confirmed_memory SET text_content='合成迟到变更',revision=revision+1 WHERE id=%s", (self.memory,))
        self.store.read(self.scope)
        with psycopg.connect(self.url) as c:
            self.assertEqual(c.execute('SELECT state FROM public.layered_memory_job WHERE task_id=%s',(task,)).fetchone()[0],'invalidated')
            self.assertEqual(c.execute('SELECT status FROM public.background_task WHERE id=%s',(task,)).fetchone()[0],'cancelled')
        with self.assertRaisesRegex(LayeredMemoryConflict,'整理实际输入已变化'):
            self.store.publish(work,{'scenarios':[]},budget)
        self.assertIsNone(self.cache())

    def test_owner_contact_isolation_and_public_dto_remain_unchanged(self):
        owner_memory, other_contact = uuid4(), uuid4()
        with psycopg.connect(self.url) as c:
            c.execute("INSERT INTO public.owner_memory(id,owner_id,text_content,category,source_ids,adoption_method) VALUES(%s,%s,'本人独立合成资料','common_fact',%s,'manual')", (owner_memory,self.owner,[self.owner]))
            c.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'另一合成联系人')", (other_contact,self.owner))
        for scope, expected in ((self.scope,[str(self.memory)]), (ContactScope(self.owner,other_contact),[]), (OwnerScope(self.owner),[str(owner_memory)])):
            with self.store.transaction(scope) as (c,state,overview):
                manifest = self.store._manifest(c,scope,self.store.eligible(overview))
                self.assertEqual([item['memory_id'] for item in manifest],expected)
                payload = overview_payload(overview,lambda memory: {'memory_id':str(memory.memory_id)})
                for entry in payload['entries']:
                    self.assertEqual(set(entry),{'memory','is_latest','current_leaf','provenance'})
        self.assertIsNone(self.cache())
