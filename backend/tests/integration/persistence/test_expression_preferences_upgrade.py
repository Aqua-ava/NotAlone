"""真实001–064向065前向升级；旧资料不回填偏好或版本证明。"""

import hashlib
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
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient


class ExpressionPreferencesUpgradeTest(unittest.TestCase):
    def test_real_064_data_preserved_new_directory_empty_and_repeat_no_write(self):
        instance = os.environ['NOTALONE_TEST_DATABASE_URL']
        name = f'notalone_08_upgrade_{uuid4().hex}_test'
        database = make_conninfo(instance, dbname=name)
        directory = Path(tempfile.mkdtemp(prefix="notalone08-upgrade-owned-"))
        directory.chmod(0o700)
        marker = directory / "database-ownership.json"
        descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w") as record:
            json.dump({"database_name": name, "child_pid": os.getpid(), "phase": "planned"}, record)
            record.flush()
            os.fsync(record.fileno())
        print(f"ownership={marker}", flush=True)
        admin = psycopg.connect(instance, dbname='postgres', autocommit=True)
        try:
            admin.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(name)))
            with psycopg.connect(database) as connection:
                self.assertEqual(connection.execute("SELECT current_database()").fetchone()[0], name)
            with tempfile.TemporaryDirectory() as directory:
                migrations = Path(__file__).resolve().parents[3] / 'database/migrations'
                prefix = Path(directory)
                for path in migrations.glob('*.sql'):
                    if int(path.name[:3]) <= 64:
                        shutil.copyfile(path, prefix / path.name)
                self.assertEqual(len(migrate(database, prefix)), 64)
                owner, contact, candidate, memory, request = (uuid4() for _ in range(5))
                with psycopg.connect(database) as connection:
                    connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成升级用户')", (owner,))
                    connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成升级联系人')", (contact, owner))
                    connection.execute("INSERT INTO public.memory_candidate(id,owner_id,contact_id,text_content,category,source_ids,status) VALUES(%s,%s,%s,'旧资料未知证明','preference',%s,'confirmed')", (candidate, owner, contact, [contact]))
                    connection.execute("INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,source_candidate_id,adoption_method) VALUES(%s,%s,%s,'旧资料未知证明','preference',%s,%s,'manual')", (memory, owner, contact, [contact], candidate))
                    connection.execute("INSERT INTO public.reply_request(id,owner_id,contact_id,conversation_binding_id,idempotency_key,normalized_input,state,attempt,lease_expires_at,context_snapshot,skill_library_revision) VALUES(%s,%s,%s,%s,%s,'合成旧输入','completed',1,now(),%s,0)", (request, owner, contact, uuid4(), uuid4(), Jsonb({'legacy': '合成旧快照'})))
                    old = {table: connection.execute(sql.SQL('SELECT to_jsonb(record) FROM public.{} record ORDER BY id').format(sql.Identifier(table))).fetchall() for table in ('memory_candidate', 'confirmed_memory', 'reply_request')}
                    history = connection.execute('SELECT name,checksum FROM public.notalone_schema_migration ORDER BY name').fetchall()
                path = migrations / '065_expression_preferences.sql'
                shutil.copyfile(path, prefix / path.name)
                self.assertEqual(migrate(database, prefix), (path.name,))
                self.assertEqual(migrate(database, prefix), ())
                with psycopg.connect(database) as connection:
                    for table, rows in old.items():
                        after = connection.execute(sql.SQL('SELECT to_jsonb(record) FROM public.{} record ORDER BY id').format(sql.Identifier(table))).fetchall()
                        expected = [({**row[0], 'expression_preference_revision': None},) for row in rows] if table == 'reply_request' else rows
                        self.assertEqual(after, expected)
                    self.assertEqual(connection.execute("SELECT name,checksum FROM public.notalone_schema_migration WHERE left(name,3)::int<=64 ORDER BY name").fetchall(), history)
                    self.assertEqual(connection.execute("SELECT checksum FROM public.notalone_schema_migration WHERE name=%s", (path.name,)).fetchone()[0], hashlib.sha256(path.read_bytes()).hexdigest())
                    for table in ('expression_preference_state', 'expression_preference', 'expression_preference_operation', 'reply_expression_preference_use', 'style_sample_expression_preference_use'):
                        undocumented = connection.execute("SELECT attname FROM pg_attribute WHERE attrelid=%s::regclass AND attnum>0 AND NOT attisdropped AND col_description(attrelid,attnum) IS NULL", ('public.' + table,)).fetchall()
                        self.assertEqual(undocumented, [])
                client = InProcessClient(create_app(database_url=database, owner_id=owner, token='synthetic-token'))
                headers = {'Authorization': 'Bearer synthetic-token'}
                endpoint = f'/api/expression-preferences?contact_id={contact}'
                self.assertEqual(client.get(endpoint, headers=headers).json()['preferences'], [])
                command = {
                    'operation_key': str(uuid4()), 'text': '用户明确保存的合成长期偏好。',
                    'scope': {'contact_id': str(contact), 'reply_mode': None}, 'origin': {'kind': 'manual'}, 'confirm_long_term': True,
                }
                saved = client.request('POST', endpoint, headers=headers, body=json.dumps(command).encode())
                self.assertEqual(saved.status_code, 200, saved.json())
                before_repeat = client.get(endpoint, headers=headers).json()
                self.assertEqual(migrate(database, prefix), ())
                self.assertEqual(client.get(endpoint, headers=headers).json(), before_repeat)
                preference = saved.json()['preference']
                deletion = client.request('DELETE', f"/api/expression-preferences/{preference['preference_id']}?contact_id={contact}",
                    headers=headers, body=json.dumps({'operation_key': str(uuid4()), 'expected_revision': preference['revision']}).encode())
                self.assertEqual(deletion.status_code, 200, deletion.json())
                self.assertEqual(migrate(database, prefix), ())
                restored = InProcessClient(create_app(database_url=database, owner_id=owner, token='synthetic-token'))
                empty = restored.get(endpoint, headers=headers)
                self.assertEqual(empty.json()['preferences'], [])
                self.assertEqual(empty.headers.get('Cache-Control'), 'no-store')
                replay = restored.request('POST', endpoint, headers=headers, body=json.dumps(command).encode())
                self.assertEqual(replay.status_code, 410, replay.json())
        finally:
            try:
                admin.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(name)))
                self.assertFalse(admin.execute('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)', (name,)).fetchone()[0])
            finally:
                admin.close()


if __name__ == '__main__':
    unittest.main()
