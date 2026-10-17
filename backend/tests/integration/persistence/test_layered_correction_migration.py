"""正式077已有两类范围、来源、任务与正文后前向升级078。"""

import json
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


class LayeredCorrectionMigrationTest(unittest.TestCase):
    def test_077_populated_scopes_upgrade_preserves_data_and_erasure_constraints(self):
        name = f'notalone_correction_upgrade_{uuid4().hex}_test'
        database = make_conninfo(os.environ['NOTALONE_TEST_DATABASE_URL'], dbname=name)
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            marker = directory / 'ownership.json'
            marker.write_text(json.dumps({'database_name': name, 'pid': os.getpid(), 'phase': 'planned'}))
            marker.chmod(0o600)
            print('correction_upgrade_planned: ' + name, flush=True)
            with psycopg.connect(database, dbname='postgres', autocommit=True) as admin:
                admin.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(name)))
                try:
                    root = Path(__file__).resolve().parents[3] / 'database/migrations'
                    prefix = directory / 'migrations'
                    prefix.mkdir()
                    for path in root.glob('*.sql'):
                        if int(path.name[:3]) <= 77:
                            shutil.copyfile(path, prefix / path.name)
                    self.assertEqual(len(migrate(database, prefix)), 77)
                    owner, contact, source = uuid4(), uuid4(), uuid4()
                    tables = ['owner', 'contact', 'source_document', 'background_task', 'layered_memory_state',
                        'layered_memory_job', 'layered_memory_batch', 'scenario_document_version',
                        'layered_profile_batch', 'layered_profile_version', 'layered_memory_generation']
                    with psycopg.connect(database) as connection:
                        connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成升级用户')", (owner,))
                        connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成升级联系人')", (contact, owner))
                        connection.execute("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) "
                            "VALUES(%s,%s,%s,'wechat_jsonl','synthetic.jsonl',%s,1)", (source, owner, contact, 'a' * 64))
                        for scoped_contact in (contact, None):
                            self._seed_old_scope(connection, owner, scoped_contact, source)
                        before = self._rows(connection, tables)
                        ledger = connection.execute('SELECT name,checksum FROM public.notalone_schema_migration ORDER BY name').fetchall()
                    path = root / '078_layered_memory_corrections.sql'
                    shutil.copyfile(path, prefix / path.name)
                    self.assertEqual(migrate(database, prefix), (path.name,))
                    self.assertEqual(migrate(database, prefix), ())
                    with psycopg.connect(database) as connection:
                        after = self._rows(connection, tables)
                        for table in tables:
                            added = {'correction_revision': 0} if table == 'layered_memory_state' else (
                                {'correction_input': []} if table in {'layered_memory_batch', 'layered_profile_batch'} else {})
                            self.assertEqual(after[table], sorted([{**row, **added} for row in before[table]], key=lambda row: json.dumps(row, sort_keys=True)), table)
                        self.assertEqual(connection.execute('SELECT name,checksum FROM public.notalone_schema_migration '
                            "WHERE left(name,3)::int<=77 ORDER BY name").fetchall(), ledger)
                        operation = uuid4()
                        for scoped_contact in (contact, None):
                            self._feedback(connection, owner, scoped_contact, operation, source)
                            self._fact_receipt(connection, owner, scoped_contact, source)
                        with self.assertRaises(psycopg.errors.UniqueViolation), connection.transaction():
                            self._fact_receipt(connection, owner, None, source)
                        with self.assertRaises(psycopg.errors.ForeignKeyViolation), connection.transaction():
                            self._fact_receipt(connection, owner, uuid4(), source)
                        with self.assertRaises(psycopg.errors.UniqueViolation), connection.transaction():
                            self._feedback(connection, owner, None, operation, source)
                        with self.assertRaises(psycopg.errors.ForeignKeyViolation), connection.transaction():
                            self._feedback(connection, owner, uuid4(), uuid4(), source)
                        with self.assertRaises(psycopg.errors.CheckViolation), connection.transaction():
                            connection.execute("UPDATE public.layered_memory_feedback SET state='erased_guard'")
                        connection.execute("UPDATE public.source_document SET status='delete_requested' WHERE id=%s", (source,))
                        for table in ('layered_memory_feedback', 'layered_memory_fact_correction', 'layered_memory_batch', 'scenario_document_version',
                                'layered_profile_batch', 'layered_profile_version', 'layered_memory_generation'):
                            self.assertEqual(connection.execute(f'SELECT count(*) FROM public.{table}').fetchone()[0], 0, table)
                        self.assertEqual(connection.execute("SELECT count(*) FROM public.layered_memory_job WHERE state='invalidated'").fetchone()[0], 2)
                        # 新反馈的范围FK与删除级联同时生效，不借NULL绕过本人约束。
                        self._feedback(connection, owner, None, uuid4(), source)
                        self._fact_receipt(connection, owner, None, source)
                        connection.execute('DELETE FROM public.layered_memory_state WHERE contact_id IS NULL')
                        self.assertEqual(connection.execute('SELECT count(*) FROM public.layered_memory_feedback').fetchone()[0], 0)
                        self.assertEqual(connection.execute('SELECT count(*) FROM public.layered_memory_fact_correction').fetchone()[0], 0)
                finally:
                    admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
                    self.assertFalse(admin.execute('SELECT 1 FROM pg_database WHERE datname=%s', (name,)).fetchone())
                    print('correction_upgrade_catalog_absent: ' + name, flush=True)

    @staticmethod
    def _rows(connection, tables):
        return {table: sorted([row[0] for row in connection.execute(f'SELECT to_jsonb(v) FROM public.{table} v')],
            key=lambda row: json.dumps(row, sort_keys=True)) for table in tables}

    @staticmethod
    def _seed_old_scope(connection, owner, contact, source):
        task, batch, scenario, version, profile_batch, profile, memory = (uuid4() for _ in range(7))
        manifest = Jsonb([{'memory_id': str(memory), 'revision': 1}])
        connection.execute("INSERT INTO public.background_task(id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count) "
            "VALUES(%s,%s,%s,NULL,'layered_memory','succeeded','organize_memory',1)", (task, owner, contact))
        connection.execute("INSERT INTO public.layered_memory_state(owner_id,contact_id,settings_generation,organization_generation,enabled,status,covered_count) "
            "VALUES(%s,%s,1,1,true,'ready',1)", (owner, contact))
        connection.execute("INSERT INTO public.layered_memory_job(task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,state,run_remaining,model_call_limit) "
            "VALUES(%s,%s,%s,1,'legacy-target','synthetic-legacy',%s,%s,'complete',0,4)", (task, owner, contact, manifest, [source]))
        connection.execute("INSERT INTO public.layered_memory_batch(id,owner_id,contact_id,settings_generation,work_key,status,input_manifest,input_payload,dependency_ids,created_at,task_id) "
            "VALUES(%s,%s,%s,1,'legacy-batch','succeeded',%s,%s,%s,now(),%s)", (batch, owner, contact, manifest, Jsonb([{'text': '旧合法输入。'}]), [source], task))
        connection.execute("INSERT INTO public.scenario_document_version(id,owner_id,contact_id,scenario_id,batch_id,organization_generation,schema_version,title,hint,paragraphs,created_at) "
            "VALUES(%s,%s,%s,%s,%s,1,1,'旧合成主题','旧合成目录',%s,now())", (version, owner, contact, scenario, batch, Jsonb([{'text': '旧合成主题正文。', 'references': [{'memory_id': str(memory), 'revision': 1}]}])))
        connection.execute("INSERT INTO public.layered_profile_batch(id,owner_id,contact_id,settings_generation,organization_generation,work_key,work_token,budget_batch_id,task_id,status,lease_expires_at,scenario_version_ids,input_manifest,input_payload,dependency_ids,created_at) "
            "VALUES(%s,%s,%s,1,1,'legacy-profile',%s,%s,%s,'succeeded',now(),%s,%s,%s,%s,now())", (profile_batch, owner, contact, uuid4(), batch, task, [version], manifest, Jsonb([{'text': '旧画像输入。'}]), [source]))
        connection.execute("INSERT INTO public.layered_profile_version(id,owner_id,contact_id,batch_id,schema_version,entries,created_at) "
            "VALUES(%s,%s,%s,%s,2,%s,now())", (profile, owner, contact, profile_batch, Jsonb([{'text': '旧画像正文。'}])))
        connection.execute("INSERT INTO public.layered_memory_generation(owner_id,contact_id,organization_generation,schema_version,scenario_version_ids,profile_version_id,dependency_ids) "
            "VALUES(%s,%s,1,2,%s,%s,%s)", (owner, contact, [version], profile, [source]))

    @staticmethod
    def _feedback(connection, owner, contact, operation, source):
        connection.execute("INSERT INTO public.layered_memory_feedback(id,owner_id,contact_id,operation_id,settings_generation,target_kind,item_index,reason,rejected_text,dependency_ids,protected_memory_ids,protected_message_ids) "
            "VALUES(%s,%s,%s,%s,1,'scenario',0,'合成说明','合成旧总结',%s,'{}','{}')", (uuid4(), owner, contact, operation, [source]))

    @staticmethod
    def _fact_receipt(connection, owner, contact, source):
        connection.execute('INSERT INTO public.layered_memory_fact_correction('
            'id,owner_id,contact_id,settings_generation,request_digest,memory_id,memory_revision,'
            "source_dependency_mode,dependency_ids,protected_message_ids) VALUES(%s,%s,%s,1,'synthetic-digest',%s,1,'any',%s,'{}')",
            (uuid4(), owner, contact, uuid4(), [source]))
