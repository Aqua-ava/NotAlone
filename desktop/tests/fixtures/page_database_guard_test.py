"""有限页面资源守卫的无数据库正反例。"""

import json
import os
from pathlib import Path
import tempfile
import unittest

from page_database_guard import ScopedDatabaseGuard


class DatabaseGuardTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)
        self.path.chmod(0o700)
        self.name = 'notalone_core_flow_' + 'a' * 32 + '_test'
        self.marker = self.path / 'database-ownership.json'
        self.marker.write_text(json.dumps({'database_name': self.name, 'child_pid': os.getpid(), 'phase': 'planned'}))
        self.marker.chmod(0o600)
        self.guard = ScopedDatabaseGuard(self.marker, self.name)

    def test_only_successful_owned_create_grants_cleanup_and_creation_is_bounded(self):
        calls = []
        create = f'CREATE DATABASE "{self.name}" TEMPLATE template0'
        drop = f'DROP DATABASE "{self.name}" WITH (FORCE)'
        self.guard.execute('postgres', create, None, lambda: calls.append('create'))
        with self.assertRaisesRegex(RuntimeError, 'create_limit'):
            self.guard.execute('postgres', create, None, lambda: calls.append('duplicate'))
        self.guard.execute('postgres', drop, None, lambda: calls.append('drop'))
        self.guard.finish(False)
        self.assertEqual(calls, ['create', 'drop'])
        phases = [json.loads(p.read_text())['phase'] for p in sorted(self.path.glob('resource-guard-*.json'))]
        self.assertIn('create_planned', phases)
        self.assertIn('create_confirmed', phases)
        self.assertIn('absence_confirmed', phases)

    def test_failed_create_never_grants_drop_and_unknown_sql_poison_blocks_create(self):
        called = []
        def failed():
            raise ValueError('synthetic failure')
        with self.assertRaises(ValueError):
            self.guard.execute('postgres', f'CREATE DATABASE "{self.name}" TEMPLATE template0', None, failed)
        for query in (f'DROP DATABASE "{self.name}" WITH (FORCE)',
                      f'CREATE DATABASE "{self.name}" TEMPLATE template0'):
            with self.assertRaises(RuntimeError):
                self.guard.execute('postgres', query, None, lambda: called.append(query))
        self.assertEqual(called, [])

    def test_admin_never_accepts_other_database_comments_batches_or_missing_marker(self):
        for query in ('CREATE DATABASE private', 'SELECT 1; DROP DATABASE private',
                      '-- comment\nCREATE DATABASE private', 'ALTER DATABASE postgres RENAME TO private'):
            with self.subTest(query=query), self.assertRaises(RuntimeError):
                self.guard.execute('postgres', query, None, lambda: self.fail('driver invoked'))
        with self.assertRaises(RuntimeError):
            self.guard.finish(True)

    def test_instance_change_is_rejected_before_followup_sql(self):
        self.guard.identity('postgres', '/tmp', 5432, 'synthetic')
        with self.assertRaisesRegex(RuntimeError, 'instance_changed'):
            self.guard.identity('postgres', '/tmp', 5433, 'synthetic')

    def test_missing_or_replaced_ownership_marker_prevents_create(self):
        self.marker.unlink()
        with self.assertRaisesRegex(RuntimeError, 'ownership'):
            self.guard.execute('postgres', f'CREATE DATABASE "{self.name}" TEMPLATE template0', None, lambda: self.fail('driver invoked'))
        self.assertTrue(self.guard.poisoned)

    def test_marker_symlink_is_rejected_without_following_it(self):
        target = self.path / 'private.json'
        self.marker.rename(target)
        self.marker.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'ownership'):
            self.guard.execute('postgres', f'CREATE DATABASE "{self.name}" TEMPLATE template0', None, lambda: self.fail('driver invoked'))

    def test_owned_business_sql_and_exact_absence_query_remain_usable(self):
        self.guard.execute('postgres', f'CREATE DATABASE "{self.name}" TEMPLATE template0', None, lambda: None)
        self.assertEqual(self.guard.execute(self.name, 'SELECT %s', ('synthetic',), lambda: 'ok'), 'ok')
        self.assertFalse(self.guard.execute('postgres', 'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = %s)', (self.name,), lambda: False))
        with self.assertRaisesRegex(RuntimeError, 'global_statement'):
            self.guard.execute(self.name, 'CREATE DATABASE other', None, lambda: self.fail('driver invoked'))


if __name__ == '__main__':
    unittest.main()
