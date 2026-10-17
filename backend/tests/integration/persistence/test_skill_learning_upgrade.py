"""真实065前向升级066，旧资料不自动授权、不补证明或生成草稿。"""

import hashlib
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from uuid import uuid4
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.types.json import Jsonb
from notalone.database_migrations import migrate
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient


class SkillLearningUpgradeTest(unittest.TestCase):
    def test_controlled_contact_delete_erases_inherited_work_and_rolls_back_erasure_failure(self):
        from notalone.persistence.contact_deletion import delete_contact
        from notalone.scopes import ContactScope

        database = os.environ['NOTALONE_TEST_DATABASE_URL']
        owner, other_owner, contact, source_contact, alien = (uuid4() for _ in range(5))
        source, message, draft, alien_draft, task, batch, material = (uuid4() for _ in range(7))
        with psycopg.connect(database) as connection:
            for identifier in (owner, other_owner):
                connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成清理用户')", (identifier,))
            for identifier, parent in ((contact, owner), (source_contact, owner), (alien, other_owner)):
                connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成清理联系人')", (identifier, parent))
            connection.execute("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES(%s,%s,%s,'wechat_jsonl','synthetic-inherited.jsonl',%s,1)", (source, owner, source_contact, uuid4().hex * 2))
            connection.execute("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES(%s,%s,%s,'contact','text','合成来源正文。',now())", (message, owner, source_contact))
            # 存量继承依赖边界夹具；不声称09能发布或直接接受跨联系人原始材料。
            for identifier, parent, actual_contact in ((draft, owner, contact), (alien_draft, other_owner, alien)):
                connection.execute('''INSERT INTO public.skill_draft(id,owner_id,contact_id,logical_skill_id,
                    proposal_kind,batch_key,strategy,private_evidence,dependency_ids)
                    VALUES(%s,%s,%s,%s,'create',%s,%s,%s,%s)''',
                    (identifier, parent, actual_contact, uuid4(), uuid4().hex,
                     Jsonb({'document': '合成待清理旧策略。'}),
                     Jsonb({'existing_skills': [{'description': '合成继承审核依据。'}]}), [source, message]))
            connection.execute("INSERT INTO public.background_task(id,owner_id,contact_id,task_type,current_step,message_count) VALUES(%s,%s,%s,'skill_learning','propose_skill',0)", (task, owner, contact))
            connection.execute("INSERT INTO public.skill_learning_batch(id,owner_id,contact_id,task_id,batch_key,outcome,draft_id,dependency_ids) VALUES(%s,%s,%s,%s,%s,'draft',%s,%s)", (batch, owner, contact, task, uuid4().hex, draft, [source, message]))
            connection.execute('INSERT INTO public.skill_learning_receipt(owner_id,contact_id,material_id,digest,batch_id) VALUES(%s,%s,%s,%s,%s)', (owner, contact, material, 'synthetic-inherited-digest', batch))
            before = connection.execute('SELECT to_jsonb(d) FROM public.skill_draft d WHERE id=%s', (draft,)).fetchone()
            alien_before = connection.execute('SELECT to_jsonb(d) FROM public.skill_draft d WHERE id=%s', (alien_draft,)).fetchone()
            connection.execute('''CREATE FUNCTION public.synthetic_learning_contact_erase_fault() RETURNS trigger
                LANGUAGE plpgsql AS $$ BEGIN
                    IF NEW.outcome='invalidated' THEN
                        IF NOT EXISTS (SELECT 1 FROM public.skill_draft WHERE id=NEW.draft_id
                            AND status='invalidated' AND private_evidence IS NULL) THEN
                            RAISE EXCEPTION 'synthetic_partial_erasure_missing';
                        END IF;
                        RAISE EXCEPTION 'synthetic_after_draft_erasure';
                    END IF;
                    RETURN NEW;
                END; $$''')
            connection.execute('''CREATE TRIGGER synthetic_learning_contact_erase_fault BEFORE UPDATE
                ON public.skill_learning_batch FOR EACH ROW EXECUTE FUNCTION public.synthetic_learning_contact_erase_fault()''')
        scope = ContactScope(owner, source_contact)
        try:
            with self.assertRaises(psycopg.Error) as failure:
                delete_contact(database, scope)
            self.assertIn('synthetic_after_draft_erasure', str(failure.exception))
            with psycopg.connect(database) as connection:
                self.assertEqual(connection.execute('SELECT to_jsonb(d) FROM public.skill_draft d WHERE id=%s', (draft,)).fetchone(), before)
                self.assertIsNotNone(connection.execute('SELECT id FROM public.contact WHERE owner_id=%s AND id=%s', (owner, source_contact)).fetchone())
                self.assertIsNotNone(connection.execute('SELECT id FROM public.source_document WHERE owner_id=%s AND id=%s', (owner, source)).fetchone())
                self.assertEqual(connection.execute('SELECT status FROM public.background_task WHERE id=%s', (task,)).fetchone()[0], 'queued')
        finally:
            with psycopg.connect(database) as connection:
                connection.execute('DROP TRIGGER IF EXISTS synthetic_learning_contact_erase_fault ON public.skill_learning_batch')
                connection.execute('DROP FUNCTION IF EXISTS public.synthetic_learning_contact_erase_fault()')
        self.assertTrue(delete_contact(database, scope))
        self.assertFalse(delete_contact(database, scope))
        # 不先GET；直接核对同一删除事务已擦除，不让延迟失效掩盖残留。
        with psycopg.connect(database) as connection:
            self.assertEqual(connection.execute('''SELECT status,strategy,private_evidence,target_versions,
                dependency_ids,source_generation FROM public.skill_draft WHERE id=%s''', (draft,)).fetchone(),
                ('invalidated', None, None, [], [], {}))
            self.assertEqual(connection.execute('SELECT outcome,dependency_ids FROM public.skill_learning_batch WHERE id=%s', (batch,)).fetchone(), ('invalidated', []))
            self.assertIsNone(connection.execute('SELECT digest FROM public.skill_learning_receipt WHERE batch_id=%s', (batch,)).fetchone()[0])
            self.assertEqual(connection.execute('SELECT status FROM public.background_task WHERE id=%s', (task,)).fetchone()[0], 'cancelled')
            self.assertIsNone(connection.execute('SELECT id FROM public.message WHERE owner_id=%s AND id=%s', (owner, message)).fetchone())
            self.assertEqual(connection.execute('SELECT to_jsonb(d) FROM public.skill_draft d WHERE id=%s', (alien_draft,)).fetchone(), alien_before)
        client = InProcessClient(create_app(database_url=database, owner_id=owner, token='synthetic-cleanup'))
        self.assertEqual(client.get(f'/api/contacts/{contact}/skill-learning', headers={'Authorization':'Bearer synthetic-cleanup'}).json()['drafts'], [])

    def test_batch_draft_and_receipt_references_cannot_cross_owner_or_contact(self):
        database=os.environ['NOTALONE_TEST_DATABASE_URL']
        owner,other,contact,second,alien=(uuid4() for _ in range(5))
        with psycopg.connect(database) as connection:
            for identifier in (owner,other):
                connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成范围用户')",(identifier,))
            tasks={};drafts={}
            for actual_contact,parent in ((contact,owner),(second,owner),(alien,other)):
                connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成范围联系人')",(actual_contact,parent))
                task,draft=uuid4(),uuid4();tasks[actual_contact]=task;drafts[actual_contact]=draft
                connection.execute("INSERT INTO public.background_task(id,owner_id,contact_id,task_type,current_step,message_count) VALUES(%s,%s,%s,'skill_learning','propose_skill',0)",(task,parent,actual_contact))
                connection.execute("INSERT INTO public.skill_draft(id,owner_id,contact_id,logical_skill_id,proposal_kind,batch_key) VALUES(%s,%s,%s,%s,'create','synthetic-scope')",(draft,parent,actual_contact,uuid4()))
            insert="INSERT INTO public.skill_learning_batch(id,owner_id,contact_id,task_id,batch_key,outcome,draft_id) VALUES(%s,%s,%s,%s,%s,'draft',%s)"
            for actual_task,actual_draft in ((tasks[second],drafts[contact]),(tasks[contact],drafts[second]),(tasks[alien],drafts[contact]),(tasks[contact],drafts[alien])):
                with self.assertRaises(psycopg.IntegrityError):
                    with connection.transaction():
                        connection.execute(insert,(uuid4(),owner,contact,actual_task,uuid4().hex,actual_draft))
            batch=uuid4()
            connection.execute(insert,(batch,owner,contact,tasks[contact],'synthetic-valid',drafts[contact]))
            for parent,actual_contact in ((owner,second),(other,alien)):
                with self.assertRaises(psycopg.IntegrityError):
                    with connection.transaction():
                        connection.execute('INSERT INTO public.skill_learning_receipt(owner_id,contact_id,material_id,batch_id) VALUES(%s,%s,%s,%s)',(parent,actual_contact,uuid4(),batch))
            connection.execute('INSERT INTO public.skill_learning_receipt(owner_id,contact_id,material_id,batch_id) VALUES(%s,%s,%s,%s)',(owner,contact,uuid4(),batch))

    def test_real_065_rows_history_and_unknown_proofs_unchanged_new_learning_disabled(self):
        instance=os.environ['NOTALONE_TEST_DATABASE_URL']
        name=f'notalone_09_upgrade_{uuid4().hex}_test';database=make_conninfo(instance,dbname=name)
        admin=psycopg.connect(instance,dbname='postgres',autocommit=True)
        try:
            admin.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(name)))
            with tempfile.TemporaryDirectory() as directory:
                migrations=Path(__file__).resolve().parents[3]/'database/migrations';prefix=Path(directory)
                for path in migrations.glob('*.sql'):
                    if int(path.name[:3])<=65:shutil.copyfile(path,prefix/path.name)
                self.assertEqual(len(migrate(database,prefix)),65)
                owner,contact,candidate,memory=(uuid4() for _ in range(4))
                with psycopg.connect(database) as connection:
                    connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成旧用户')",(owner,))
                    connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成旧联系人')",(contact,owner))
                    connection.execute("INSERT INTO public.memory_candidate(id,owner_id,contact_id,text_content,category,source_ids,status) VALUES(%s,%s,%s,'合成旧未知证明','common_fact',%s,'confirmed')",(candidate,owner,contact,[contact]))
                    connection.execute("INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,source_candidate_id,adoption_method) VALUES(%s,%s,%s,'合成旧未知证明','common_fact',%s,%s,'manual')",(memory,owner,contact,[contact],candidate))
                    tables=('memory_candidate','confirmed_memory','owner_memory','expression_preference','background_task')
                    before={table:connection.execute(sql.SQL('SELECT to_jsonb(row) FROM public.{} row').format(sql.Identifier(table))).fetchall() for table in tables}
                    history=connection.execute('SELECT name,checksum FROM public.notalone_schema_migration ORDER BY name').fetchall()
                path=migrations/'066_skill_learning_drafts.sql';shutil.copyfile(path,prefix/path.name)
                self.assertEqual(migrate(database,prefix),(path.name,));self.assertEqual(migrate(database,prefix),())
                with psycopg.connect(database) as connection:
                    for table,rows in before.items():self.assertEqual(connection.execute(sql.SQL('SELECT to_jsonb(row) FROM public.{} row').format(sql.Identifier(table))).fetchall(),rows)
                    self.assertEqual(connection.execute('SELECT name,checksum FROM public.notalone_schema_migration WHERE left(name,3)::int<=65 ORDER BY name').fetchall(),history)
                    self.assertEqual(connection.execute('SELECT checksum FROM public.notalone_schema_migration WHERE name=%s',(path.name,)).fetchone()[0],hashlib.sha256(path.read_bytes()).hexdigest())
                    for table in ('skill_learning_scope','skill_learning_operation','skill_draft','skill_learning_batch','skill_learning_receipt','skill_method_identity'):
                        self.assertEqual(connection.execute(sql.SQL('SELECT count(*) FROM public.{}').format(sql.Identifier(table))).fetchone()[0],0)
                        self.assertEqual(connection.execute('SELECT attname FROM pg_attribute WHERE attrelid=%s::regclass AND attnum>0 AND NOT attisdropped AND col_description(attrelid,attnum) IS NULL',('public.'+table,)).fetchall(),[])
                client=InProcessClient(create_app(database_url=database,owner_id=owner,token='synthetic-upgrade'))
                response=client.get(f'/api/contacts/{contact}/skill-learning',headers={'Authorization':'Bearer synthetic-upgrade'})
                self.assertEqual(response.status_code,200,response.json());self.assertEqual(response.headers.get('Cache-Control'),'no-store')
                self.assertEqual(response.json(),{'enabled':False,'scope_revision':0,'drafts':[],'task':None,'recent_outcomes':[]})
                self.assertEqual(migrate(database,prefix),())
        finally:
            try:
                admin.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(name)))
                self.assertFalse(admin.execute('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)',(name,)).fetchone()[0])
            finally:admin.close()
