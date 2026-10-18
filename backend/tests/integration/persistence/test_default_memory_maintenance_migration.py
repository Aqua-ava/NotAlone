"""083只启用未作人工决定的旧整理范围，重复迁移保持设置和原记忆。"""

from pathlib import Path
import shutil
import tempfile
import unittest
from uuid import uuid4

import psycopg
from psycopg import sql

from notalone.database_migrations import migrate


class DefaultMemoryMaintenanceMigrationTest(unittest.TestCase):
    def test_existing_unconfigured_scopes_become_due_but_explicit_choices_remain_closed(self):
        name = 'notalone_default_maintenance_' + uuid4().hex + '_test'
        database = 'host=/tmp dbname=' + name
        with tempfile.TemporaryDirectory() as directory:
            root = Path(__file__).resolve().parents[3] / 'database/migrations'
            prefix = Path(directory, 'migrations')
            prefix.mkdir()
            for path in root.glob('*.sql'):
                if int(path.name[:3]) <= 82:
                    shutil.copyfile(path, prefix / path.name)
            Path(directory, 'ownership.txt').write_text(name)
            with psycopg.connect('host=/tmp dbname=postgres', autocommit=True) as admin:
                admin.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(name)))
                try:
                    migrate(database, prefix)
                    owner = uuid4()
                    with psycopg.connect(database) as connection:
                        connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成迁移用户')", (owner,))
                        scopes = []
                        for action in (None, 'disable', 'delete'):
                            contact = uuid4()
                            scopes.append((contact, action))
                            connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成迁移联系人')", (contact, owner))
                            connection.execute("INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method) "
                                "VALUES(%s,%s,%s,'原有合成记忆','common_fact',%s,'manual')", (uuid4(), owner, contact, [contact]))
                            connection.execute("INSERT INTO public.layered_memory_state(owner_id,contact_id,last_action) VALUES(%s,%s,%s)", (owner, contact, action))
                        connection.execute("INSERT INTO public.owner_memory(id,owner_id,text_content,category,source_ids,adoption_method) "
                            "VALUES(%s,%s,'本人原有合成记忆','common_fact',%s,'manual')", (uuid4(), owner, [owner]))
                        connection.execute("INSERT INTO public.layered_memory_state(owner_id,contact_id) VALUES(%s,NULL)", (owner,))
                        self.assertEqual(connection.execute("SELECT count(*) FROM public.layered_memory_state WHERE enabled").fetchone()[0], 0)
                    path = root / '083_default_memory_maintenance.sql'
                    shutil.copyfile(path, prefix / path.name)
                    self.assertEqual(migrate(database, prefix), (path.name,))
                    self.assertEqual(migrate(database, prefix), ())
                    with psycopg.connect(database) as connection:
                        for contact, action in (*scopes, (None, None)):
                            row = connection.execute("SELECT enabled,maintenance_allowed,dirty_revision>consumed_revision,next_due_at IS NOT NULL "
                                "FROM public.layered_memory_state WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s", (owner, contact)).fetchone()
                            self.assertEqual(row, (True, True, True, True) if action is None else (False, False, False, False))
                        self.assertEqual(connection.execute("SELECT count(*) FROM public.confirmed_memory WHERE owner_id=%s", (owner,)).fetchone()[0], 3)
                        self.assertEqual(connection.execute("SELECT count(*) FROM public.owner_memory WHERE owner_id=%s", (owner,)).fetchone()[0], 1)
                finally:
                    admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
                    self.assertFalse(admin.execute('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)', (name,)).fetchone()[0])
