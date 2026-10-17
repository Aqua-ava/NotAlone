"""073 已有正文前向升级为完整版本集合，重复执行不改写旧依据。"""

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
from notalone.database_migrations import migrate


class LayeredCoverageMigrationTest(unittest.TestCase):
    def test_073_existing_batches_upgrade_with_their_complete_dependencies(self):
        name=f'notalone_layered_migration_{uuid4().hex}_test'
        database=make_conninfo(os.environ['NOTALONE_TEST_DATABASE_URL'],dbname=name)
        with tempfile.TemporaryDirectory() as directory:
            # 创建之前先落盘精确归属，整个测试不读取业务配置。
            ownership={'database_name':name,'pid':os.getpid(),'phase':'planned'}
            Path(directory,'ownership.json').write_text(json.dumps(ownership))
            print('layered_migration_database_ownership: '+json.dumps(ownership),flush=True)
            admin=psycopg.connect(database,dbname='postgres',autocommit=True)
            created=False
            try:
                admin.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(name)))
                created=True
                root=Path(__file__).resolve().parents[3]/'database/migrations'
                prefix=Path(directory,'migrations');prefix.mkdir()
                for path in root.glob('*.sql'):
                    if int(path.name[:3])<=73:
                        shutil.copyfile(path,prefix/path.name)
                self.assertEqual(len(migrate(database,prefix)),73)
                owner,contact,batch,version,scenario,a,b=(uuid4() for _ in range(7))
                with psycopg.connect(database) as connection:
                    connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成升级用户')",(owner,))
                    connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES(%s,%s,'合成升级联系人')",(owner,contact))
                    connection.execute("INSERT INTO public.layered_memory_state(owner_id,contact_id,organization_generation) VALUES(%s,%s,1)",(owner,contact))
                    connection.execute("INSERT INTO public.layered_memory_batch(id,owner_id,contact_id,settings_generation,work_key,status,input_manifest,input_payload,dependency_ids,created_at) "
                        "VALUES(%s,%s,%s,0,'synthetic-upgrade','succeeded','[]','[]',%s,now())",(batch,owner,contact,[a,b]))
                    connection.execute("INSERT INTO public.scenario_document_version(id,owner_id,contact_id,scenario_id,batch_id,organization_generation,schema_version,title,hint,paragraphs,created_at) "
                        "VALUES(%s,%s,%s,%s,%s,1,1,'合成主题','合成目录','[]',now())",(version,owner,contact,scenario,batch))
                path=root/'074_layered_memory_coverage.sql';shutil.copyfile(path,prefix/path.name)
                self.assertEqual(migrate(database,prefix),(path.name,))
                self.assertEqual(migrate(database,prefix),())
                maintenance=root/'075_layered_memory_maintenance.sql'
                shutil.copyfile(maintenance,prefix/maintenance.name)
                self.assertEqual(migrate(database,prefix),(maintenance.name,))
                self.assertEqual(migrate(database,prefix),())
                with psycopg.connect(database) as connection:
                    row=connection.execute("SELECT schema_version,scenario_version_ids,profile_version_id,dependency_ids FROM public.layered_memory_generation "
                        "WHERE owner_id=%s AND contact_id=%s AND organization_generation=1",(owner,contact)).fetchone()
                    self.assertEqual(row[:3],(2,[version],None))
                    self.assertEqual(set(row[3]),{a,b})
                    connection.execute("SELECT public.erase_layered_memory_dependencies(%s,%s)",(owner,[b]))
                    self.assertEqual(connection.execute('SELECT count(*) FROM public.scenario_document_version').fetchone()[0],0)
                    self.assertFalse(connection.execute('SELECT 1 FROM public.layered_memory_generation WHERE dependency_ids && %s::uuid[]',([b],)).fetchone())
            finally:
                if created:
                    admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
                    self.assertFalse(admin.execute('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)',(name,)).fetchone()[0])
                    print('layered_migration_database_cleanup_confirmed: '+name,flush=True)
                admin.close()
