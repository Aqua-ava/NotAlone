"""真实连续loader在已有078资料上追加079；不伪造迁移账本。"""
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
from tests.integration.persistence import test_layered_correction_migration as migration_support


class OrganizationQualityMigrationTest(unittest.TestCase):
    def test_populated_078_upgrade_preserves_old_rows_and_loader_checksums(self):
        name = f'notalone_quality_upgrade_{uuid4().hex}_test'
        database = make_conninfo(os.environ['NOTALONE_TEST_DATABASE_URL'], dbname=name)
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            marker = directory / 'ownership.json'
            marker.write_text(json.dumps({'database_name': name, 'pid': os.getpid(), 'phase': 'planned'}))
            marker.chmod(0o600)
            print('quality_upgrade_planned: ' + name, flush=True)
            with psycopg.connect(database, dbname='postgres', autocommit=True) as admin:
                admin.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(name)))
                try:
                    root = Path(__file__).resolve().parents[3] / 'database/migrations'
                    prefix = directory / 'migrations'
                    prefix.mkdir()
                    for path in root.glob('*.sql'):
                        if int(path.name[:3]) <= 78:
                            shutil.copyfile(path, prefix / path.name)
                    self.assertEqual(len(migrate(database, prefix)), 78)
                    owner, contact, source = uuid4(), uuid4(), uuid4()
                    tables = ['owner', 'contact', 'source_document', 'background_task', 'layered_memory_state',
                        'layered_memory_job', 'layered_memory_batch', 'scenario_document_version',
                        'layered_profile_batch', 'layered_profile_version', 'layered_memory_generation', 'layered_memory_feedback']
                    with psycopg.connect(database) as connection:
                        connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成质量升级用户')", (owner,))
                        connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成质量升级联系人')", (contact, owner))
                        connection.execute("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) "
                            "VALUES(%s,%s,%s,'wechat_jsonl','synthetic-quality.jsonl',%s,1)", (source, owner, contact, 'b' * 64))
                        for scoped_contact in (contact, None):
                            migration_support.LayeredCorrectionMigrationTest._seed_old_scope(connection, owner, scoped_contact, source)
                            migration_support.LayeredCorrectionMigrationTest._feedback(connection, owner, scoped_contact, uuid4(), source)
                        before = migration_support.LayeredCorrectionMigrationTest._rows(connection, tables)
                        ledger = connection.execute('SELECT name,checksum FROM public.notalone_schema_migration ORDER BY name').fetchall()
                    migration = root / '079_organization_quality.sql'
                    shutil.copyfile(migration, prefix / migration.name)
                    self.assertEqual(migrate(database, prefix), (migration.name,))
                    self.assertEqual(migrate(database, prefix), ())
                    with psycopg.connect(database) as connection:
                        self.assertEqual(migration_support.LayeredCorrectionMigrationTest._rows(connection, tables), before)
                        self.assertEqual(connection.execute('SELECT name,checksum FROM public.notalone_schema_migration '
                            "WHERE left(name,3)::int<=78 ORDER BY name").fetchall(), ledger)
                        self.assertEqual(connection.execute('SELECT count(*) FROM public.organization_quality_case').fetchone()[0], 0)
                        self.assertEqual(connection.execute('SELECT count(*) FROM public.organization_quality_run').fetchone()[0], 0)
                finally:
                    admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
                    self.assertFalse(admin.execute('SELECT 1 FROM pg_database WHERE datname=%s', (name,)).fetchone())
                    print('quality_upgrade_catalog_absent: ' + name, flush=True)
