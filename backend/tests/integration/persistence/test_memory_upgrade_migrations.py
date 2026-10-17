"""真实066前向升级067及持久范围约束；只用本轮归属合成库。"""

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

from notalone.database_migrations import migrate


class MemoryUpgradeMigrationTest(unittest.TestCase):
    def test_real_066_forward_preserves_unknown_proofs_watermarks_and_scoped_tasks(self):
        instance = os.environ['NOTALONE_TEST_DATABASE_URL']
        name = f'notalone_10_upgrade_{uuid4().hex}_test'
        database = make_conninfo(instance, dbname=name)
        admin = psycopg.connect(instance, dbname='postgres', autocommit=True)
        created = False
        try:
            admin.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(name)))
            created = True
            with psycopg.connect(database) as identity:
                self.assertEqual(identity.execute('SELECT current_database()').fetchone()[0], name)
            with tempfile.TemporaryDirectory() as directory:
                migrations = Path(__file__).resolve().parents[3] / 'database/migrations'
                prefix = Path(directory)
                for path in migrations.glob('*.sql'):
                    if int(path.name[:3]) <= 66:
                        shutil.copyfile(path, prefix / path.name)
                self.assertEqual(len(migrate(database, prefix)), 66)
                owner, other, contact, second, alien, candidate, memory = (uuid4() for _ in range(7))
                with psycopg.connect(database) as connection:
                    for identifier in (owner, other):
                        connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成升级旧用户')", (identifier,))
                    for identifier, parent in ((contact, owner), (second, owner), (alien, other)):
                        connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成升级旧联系人')", (identifier, parent))
                    connection.execute("INSERT INTO public.memory_candidate(id,owner_id,contact_id,text_content,category,source_ids,status) VALUES(%s,%s,%s,'合成未知旧证明','common_fact',%s,'confirmed')", (candidate, owner, contact, [contact]))
                    connection.execute("INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,source_candidate_id,adoption_method) VALUES(%s,%s,%s,'合成未知旧证明','common_fact',%s,%s,'manual')", (memory, owner, contact, [contact], candidate))
                    tables = ('memory_candidate', 'confirmed_memory', 'owner_memory', 'memory_extraction_watermark', 'background_task', 'skill_draft')
                    before = {table: connection.execute(sql.SQL('SELECT to_jsonb(row) FROM public.{} row').format(sql.Identifier(table))).fetchall() for table in tables}
                    history = connection.execute('SELECT name,checksum FROM public.notalone_schema_migration ORDER BY name').fetchall()
                path = migrations / '067_memory_upgrade_batches.sql'
                shutil.copyfile(path, prefix / path.name)
                self.assertEqual(migrate(database, prefix), (path.name,))
                self.assertEqual(migrate(database, prefix), ())
                with psycopg.connect(database) as connection:
                    for table, rows in before.items():
                        self.assertEqual(connection.execute(sql.SQL('SELECT to_jsonb(row) FROM public.{} row').format(sql.Identifier(table))).fetchall(), rows)
                    self.assertEqual(connection.execute('SELECT name,checksum FROM public.notalone_schema_migration WHERE left(name,3)::int<=66 ORDER BY name').fetchall(), history)
                    self.assertEqual(connection.execute('SELECT checksum FROM public.notalone_schema_migration WHERE name=%s', (path.name,)).fetchone()[0], hashlib.sha256(path.read_bytes()).hexdigest())
                    for table in ('memory_upgrade_job', 'memory_upgrade_batch', 'memory_upgrade_operation'):
                        self.assertEqual(connection.execute(sql.SQL('SELECT count(*) FROM public.{}').format(sql.Identifier(table))).fetchone()[0], 0)
                        self.assertEqual(connection.execute('SELECT attname FROM pg_attribute WHERE attrelid=%s::regclass AND attnum>0 AND NOT attisdropped AND col_description(attrelid,attnum) IS NULL', ('public.'+table,)).fetchall(), [])
                    job, owner_job, task, second_task, wrong_type, alien_task = (uuid4() for _ in range(6))
                    for identifier, kind, actual_contact in ((job, 'contact', contact), (owner_job, 'owner', None)):
                        connection.execute('INSERT INTO public.memory_upgrade_job(id,owner_id,contact_id,scope_kind,operation_key,message_limit,batch_size,model_call_limit) VALUES(%s,%s,%s,%s,%s,10,2,4)', (identifier, owner, actual_contact, kind, uuid4()))
                    for identifier, parent, actual_contact, kind, step in ((task, owner, contact, 'memory_upgrade', 'preview_upgrade'), (second_task, owner, second, 'memory_upgrade', 'preview_upgrade'), (wrong_type, owner, contact, 'observation', 'extract_memory'), (alien_task, other, alien, 'memory_upgrade', 'preview_upgrade')):
                        connection.execute('INSERT INTO public.background_task(id,owner_id,contact_id,task_type,current_step,message_count) VALUES(%s,%s,%s,%s,%s,0)', (identifier, parent, actual_contact, kind, step))
                    insert = "INSERT INTO public.memory_upgrade_batch(id,job_id,owner_id,contact_id,task_id,batch_number,message_ids,source_generation,dependency_ids) VALUES(%s,%s,%s,%s,%s,%s,'{}','{}','{}')"
                    batch=uuid4()
                    connection.execute(insert, (batch, job, owner, contact, task, 1))
                    for actual_job, parent, actual_contact, actual_task in ((job, owner, second, second_task), (job, owner, contact, wrong_type), (job, other, alien, alien_task)):
                        with self.assertRaises(psycopg.IntegrityError):
                            with connection.transaction():
                                connection.execute(insert, (uuid4(), actual_job, parent, actual_contact, actual_task, 2))
                    # 独立本人工作允许同owner不同实际来源批次，仍不跨owner。
                    connection.execute(insert, (uuid4(), owner_job, owner, second, second_task, 1))
                    matching_trace,wrong_trace=uuid4(),uuid4()
                    for identifier,actual_contact in ((matching_trace,contact),(wrong_trace,second)):
                        connection.execute('''INSERT INTO public.memory_extraction_trace
                            (trace_id,owner_id,contact_id,run_id,batch_key) VALUES(%s,%s,%s,%s,%s)''',
                            (identifier,owner,actual_contact,batch,'synthetic-upgrade-constraint'))
                    with self.assertRaises(psycopg.IntegrityError):
                        with connection.transaction():
                            connection.execute('UPDATE public.memory_upgrade_batch SET trace_id=%s WHERE id=%s',
                                               (wrong_trace,batch))
                    connection.execute('UPDATE public.memory_upgrade_batch SET trace_id=%s WHERE id=%s',
                                       (matching_trace,batch))
                self.assertEqual(migrate(database, prefix), ())
        finally:
            try:
                if created:
                    admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
                    self.assertFalse(admin.execute('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)', (name,)).fetchone()[0])
            finally:
                admin.close()
