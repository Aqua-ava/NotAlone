"""升级共享事务端口的合成边界；真实原子应用另由公开PG用例覆盖。"""

import unittest
from unittest.mock import patch
from uuid import uuid4
import psycopg

from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.memory_upgrade_apply import _ports
from notalone.scopes import ContactScope


class TransactionRows:
    def fetchall(self):
        return []


class ExistingTransaction:
    def __init__(self, scope, *, started):
        self.scope, self.started = scope, started
        self.isolation_statements = []
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True

    def execute(self, query, params=None):
        if query.startswith('SET TRANSACTION'):
            if self.started:
                raise psycopg.errors.ActiveSqlTransaction('synthetic transaction already started')
            self.isolation_statements.append(query)
            return TransactionRows()
        if 'FROM public.confirmed_memory AS memory' in query or 'FROM public.memory_candidate' in query:
            if params[:2] != (self.scope.owner_id, self.scope.contact_id):
                raise AssertionError('共享事务读取必须保持原联系人范围。')
            self.started = True
            return TransactionRows()
        if 'FROM public.owner_memory AS memory' in query:
            if params != (self.scope.owner_id,):
                raise AssertionError('共享事务读取必须保持原账号范围。')
            self.started = True
            return TransactionRows()
        raise AssertionError('合成事务端口出现未声明查询。')


class UpgradeTransactionPortsTest(unittest.TestCase):
    def setUp(self):
        self.scope = ContactScope(uuid4(), uuid4())
        self.corrections = patch('notalone.persistence.memory_store.available_correction_memories',
                                 side_effect=lambda _, **request: request['rows'])
        self.corrections.start()
        self.addCleanup(self.corrections.stop)
        self.owner_corrections = patch('notalone.persistence.owner_memory_store.available_correction_memories',
                                       side_effect=lambda _, **request: request['rows'])
        self.owner_corrections.start()
        self.addCleanup(self.owner_corrections.stop)

    def test_approved_apply_reads_existing_write_transaction_without_changing_or_closing_it(self):
        for operation in ('list_confirmed', 'list_pending_candidates'):
            with self.subTest(operation=operation):
                connection = ExistingTransaction(self.scope, started=True)
                memory, _ = _ports(connection, 'synthetic-only')
                self.assertEqual(getattr(memory, operation)(self.scope), ())
                self.assertEqual(connection.isolation_statements, [])
                self.assertFalse(connection.closed)

    def test_independent_memory_read_keeps_its_original_readonly_snapshot(self):
        for operation in ('list_confirmed', 'list_pending_candidates'):
            with self.subTest(operation=operation):
                connection = ExistingTransaction(self.scope, started=False)
                with patch('notalone.persistence.memory_store.psycopg.connect', return_value=connection):
                    self.assertEqual(getattr(PostgresMemoryStore('synthetic-only'), operation)(self.scope), ())
                self.assertEqual(connection.isolation_statements,
                                 ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'])
                self.assertTrue(connection.closed)

    def test_approved_owner_apply_preserves_existing_write_transaction(self):
        connection = ExistingTransaction(self.scope, started=True)
        _, owner_memory = _ports(connection, 'synthetic-only')
        self.assertEqual(owner_memory.list_active(self.scope.owner_id), ())
        self.assertEqual(connection.isolation_statements, [])
        self.assertFalse(connection.closed)

    def test_independent_owner_read_keeps_its_original_readonly_snapshot(self):
        connection = ExistingTransaction(self.scope, started=False)
        with patch('notalone.persistence.owner_memory_store.psycopg.connect', return_value=connection):
            self.assertEqual(PostgresOwnerMemoryStore('synthetic-only').list_active(self.scope.owner_id), ())
        self.assertEqual(connection.isolation_statements,
                         ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'])
        self.assertTrue(connection.closed)
