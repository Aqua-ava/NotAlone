"""存储与检索边界：错误和未知旧版不生成，明确变化允许历史且保留审计。"""

import os
import unittest
from uuid import uuid4

import psycopg

from notalone.memory.models import (
    AdoptionMethod, ConfirmedMemoryStatus, MemoryCandidate, MemoryCategory,
    MemoryChangeKind, MemoryRetirementReason, MemoryTopic, OwnerMemory,
)
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.retrieval import PostgresRetrieval
from notalone.scopes import ContactScope


class MemoryRetirementPersistenceTest(unittest.TestCase):
    def setUp(self):
        self.database_url = os.environ['NOTALONE_TEST_DATABASE_URL']
        self.owner_id, self.contact_id = uuid4(), uuid4()
        self.scope = ContactScope(self.owner_id, self.contact_id)
        with psycopg.connect(self.database_url) as connection:
            name = connection.execute('SELECT current_database()').fetchone()[0]
            self.assertEqual(name, os.environ['NOTALONE_EXPECTED_TEST_DATABASE'])
            self.assertTrue(name.endswith('_test'))
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成退役用户')", (self.owner_id,))
            connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成退役联系人')", (self.contact_id, self.owner_id))
        self.contacts = PostgresMemoryStore(self.database_url)
        self.owners = PostgresOwnerMemoryStore(self.database_url)
        self.retrieval = PostgresRetrieval(self.database_url, memory_store=self.contacts,
                                         owner_memory_store=self.owners)

    def tearDown(self):
        with psycopg.connect(self.database_url) as connection:
            connection.execute('DELETE FROM public.owner WHERE id=%s', (self.owner_id,))

    def create(self, kind):
        if kind == 'owner':
            return self.owners.create(OwnerMemory(
                memory_id=uuid4(), owner_id=self.owner_id, text='我喜欢咖啡',
                category=MemoryCategory.PREFERENCE, topic=MemoryTopic.OTHER,
                source_ids=(self.owner_id,), adoption_method=AdoptionMethod.MANUAL,
                status=ConfirmedMemoryStatus.ACTIVE,
            ))
        candidate = self.contacts.create_manual_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=self.scope, text='对方喜欢咖啡',
            category=MemoryCategory.PREFERENCE, source_ids=(uuid4(),),
        ))
        return self.contacts.confirm(scope=self.scope, candidate_id=candidate.candidate_id,
                                     adoption_method=AdoptionMethod.MANUAL)

    def correct(self, kind, memory, change_kind=MemoryChangeKind.ERROR_CORRECTION):
        store, scope = ((self.owners, {'owner_id': self.owner_id}) if kind == 'owner'
                        else (self.contacts, {'scope': self.scope}))
        return store.correct(**scope, memory_id=memory.memory_id, text='现在不喝咖啡', change_kind=change_kind)

    def versions(self, kind, memory):
        if kind == 'owner':
            return self.owners.list_versions(owner_id=self.owner_id, memory_id=memory.memory_id)
        return self.contacts.list_versions(scope=self.scope, memory_id=memory.memory_id)

    def search(self, kind, memory, *, historical=True):
        kwargs = dict(memory_ids=(memory.memory_id,), include_historical=historical)
        if kind == 'owner':
            return self.retrieval.search_owner_memories(owner_id=self.owner_id, **kwargs)
        return self.retrieval.search_confirmed_memories(scope=self.scope, **kwargs)

    def test_correction_keeps_audit_and_blocks_error_from_current_and_history(self):
        for kind in ('contact', 'owner'):
            with self.subTest(kind=kind):
                old = self.create(kind)
                current = self.correct(kind, old)
                retired = next(item for item in self.versions(kind, current) if item.memory_id == old.memory_id)
                self.assertEqual(retired.text, old.text)
                self.assertEqual(retired.retirement_reason, MemoryRetirementReason.ERROR_CORRECTION)
                self.assertIsNotNone(retired.retired_at)
                self.assertEqual(retired.invalid_at, old.invalid_at)
                self.assertEqual(self.search(kind, old), ())
                self.assertEqual(self.search(kind, old, historical=False), ())
                self.assertEqual(self.search(kind, current)[0].text, '现在不喝咖啡')

    def test_explicit_change_is_historical_with_original_source_times(self):
        for kind in ('contact', 'owner'):
            with self.subTest(kind=kind):
                old = self.create(kind)
                current = self.correct(kind, old, MemoryChangeKind.STATE_CHANGED)
                history = self.search(kind, old)
                self.assertEqual(len(history), 1)
                self.assertEqual(history[0].text, old.text)
                self.assertEqual(history[0].retirement_reason, 'state_changed')
                self.assertEqual(history[0].timing.current_status, 'historical')
                self.assertEqual(history[0].source_ids, old.source_ids)
                self.assertEqual(self.search(kind, old, historical=False), ())
                self.assertEqual(self.search(kind, current)[0].text, '现在不喝咖啡')

    def test_deleting_current_leaf_removes_historical_change_from_retrieval(self):
        for kind in ('contact', 'owner'):
            with self.subTest(kind=kind):
                old = self.create(kind)
                current = self.correct(kind, old, MemoryChangeKind.STATE_CHANGED)
                self.assertEqual(len(self.search(kind, old)), 1)
                if kind == 'owner':
                    self.owners.delete(self.owner_id, current.memory_id)
                else:
                    self.contacts.delete(scope=self.scope, memory_id=current.memory_id)
                self.assertEqual(self.search(kind, old), ())

    def test_unspecified_invalidation_is_not_historical(self):
        for kind in ('contact', 'owner'):
            with self.subTest(kind=kind):
                old = self.create(kind)
                if kind == 'owner':
                    self.owners.invalidate(self.owner_id, old.memory_id)
                else:
                    self.contacts.invalidate(scope=self.scope, memory_id=old.memory_id)
                retired = self.versions(kind, old)[0]
                self.assertEqual(retired.retirement_reason, MemoryRetirementReason.UNKNOWN)
                self.assertEqual(self.search(kind, old), ())

    def test_foreign_scope_cannot_retrieve_historical_change(self):
        old = self.create('contact')
        self.correct('contact', old, MemoryChangeKind.STATE_CHANGED)
        foreign = ContactScope(self.owner_id, uuid4())
        self.assertEqual(self.retrieval.search_confirmed_memories(
            scope=foreign, memory_ids=(old.memory_id,), include_historical=True), ())
        own = self.create('owner')
        self.correct('owner', own, MemoryChangeKind.STATE_CHANGED)
        self.assertEqual(self.retrieval.search_owner_memories(
            owner_id=uuid4(), memory_ids=(own.memory_id,), include_historical=True), ())


class MemoryRetirementMigrationTest(unittest.TestCase):
    def test_upgrade_preserves_old_records_and_defaults_invalidated_to_unknown(self):
        import shutil
        import tempfile
        from pathlib import Path
        from psycopg import sql
        from psycopg.conninfo import make_conninfo
        from notalone.database_migrations import migrate

        instance = os.environ['NOTALONE_TEST_DATABASE_URL']
        name = f'notalone_retirement_upgrade_{uuid4().hex}_test'
        database = make_conninfo(instance, dbname=name)
        admin = psycopg.connect(instance, dbname='postgres', autocommit=True)
        created = False
        try:
            admin.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(name)))
            created = True
            migrations = Path(__file__).resolve().parents[3] / 'database/migrations'
            with tempfile.TemporaryDirectory() as directory:
                prefix = Path(directory)
                for path in migrations.glob('*.sql'):
                    if int(path.name[:3]) < 81:
                        shutil.copyfile(path, prefix / path.name)
                self.assertEqual(len(migrate(database, prefix)), 80)
                owner, contact, first, second = (uuid4() for _ in range(4))
                with psycopg.connect(database) as connection:
                    connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成旧版本用户')", (owner,))
                    connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成旧版本联系人')", (contact, owner))
                    connection.execute("INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method,status) VALUES(%s,%s,%s,'旧联系人记录','common_fact',%s,'manual','invalidated')", (first, owner, contact, [contact]))
                    connection.execute("INSERT INTO public.owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method,status) VALUES(%s,%s,'旧本人记录','common_fact','other',%s,'manual','invalidated')", (second, owner, [owner]))
                    before = {table: connection.execute(sql.SQL('SELECT to_jsonb(row) FROM public.{} row').format(sql.Identifier(table))).fetchall() for table in ('confirmed_memory', 'owner_memory')}
                path = migrations / '081_memory_retirement_reason.sql'
                shutil.copyfile(path, prefix / path.name)
                self.assertEqual(migrate(database, prefix), (path.name,))
                self.assertEqual(migrate(database, prefix), ())
                with psycopg.connect(database) as connection:
                    for table, rows in before.items():
                        self.assertEqual(connection.execute(sql.SQL("SELECT to_jsonb(row)-'retirement_reason'-'retired_at' FROM public.{} row").format(sql.Identifier(table))).fetchall(), rows)
                        self.assertEqual(connection.execute(sql.SQL('SELECT retirement_reason,retired_at FROM public.{}').format(sql.Identifier(table))).fetchall(), [('unknown', None)])
                retrieval = PostgresRetrieval(database, owner_memory_store=PostgresOwnerMemoryStore(database))
                self.assertEqual(retrieval.search_confirmed_memories(scope=ContactScope(owner, contact), memory_ids=(first,), include_historical=True), ())
                self.assertEqual(retrieval.search_owner_memories(owner_id=owner, memory_ids=(second,), include_historical=True), ())
        finally:
            if created:
                admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
                self.assertFalse(admin.execute('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)', (name,)).fetchone()[0])
            admin.close()
