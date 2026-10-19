"""通过公开安装接口验证页面守卫恢复原函数并拒绝外网。"""

import hashlib
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from page_resource_guard import install


@contextmanager
def installed(directory, *, project=None):
    root = Path(directory)
    root.chmod(0o700)
    source = Path(__file__).with_name('page_database_guard.py')
    guard_path = root / source.name
    shutil.copyfile(source, guard_path)
    guard_path.chmod(0o600)
    name = f'notalone_core_flow_{uuid4().hex}_test'
    url = f'host=/tmp dbname={name}'
    environment = {'NOTALONE_EVOLUTION_GUARD_DATABASE_GUARD_PATH': str(guard_path),
        'NOTALONE_EVOLUTION_GUARD_DATABASE_GUARD_SHA256': hashlib.sha256(guard_path.read_bytes()).hexdigest(),
        'NOTALONE_DATABASE_URL': url, 'NOTALONE_TEST_DATABASE_URL': url, 'NOTALONE_DISABLE_DOTENV': '1'}
    with patch.dict(os.environ, environment):
        guard = install(project or root, root / 'database-ownership.json', name)
        try:
            yield guard, name, url
        finally:
            if not guard.closed:
                guard.close()


class AdapterTests(unittest.TestCase):
    def test_external_network_is_denied_and_hooks_are_restored(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o700)
            source = Path(__file__).with_name('page_database_guard.py')
            guard_path = root / source.name
            shutil.copyfile(source, guard_path)
            guard_path.chmod(0o600)
            name = 'notalone_core_flow_' + 'b' * 32 + '_test'
            url = f'host=/tmp dbname={name}'
            environment = {'NOTALONE_EVOLUTION_GUARD_DATABASE_GUARD_PATH': str(guard_path),
                'NOTALONE_EVOLUTION_GUARD_DATABASE_GUARD_SHA256': hashlib.sha256(guard_path.read_bytes()).hexdigest(),
                'NOTALONE_DATABASE_URL': url, 'NOTALONE_TEST_DATABASE_URL': url,
                'NOTALONE_DISABLE_DOTENV': '1'}
            original = socket.socket.connect
            with patch.dict(os.environ, environment):
                guard = install(root, root / 'database-ownership.json', name)
                with socket.socket() as connection, self.assertRaisesRegex(RuntimeError, 'network'):
                    connection.connect(('203.0.113.1', 443))
                with self.assertRaisesRegex(RuntimeError, 'poisoned'):
                    guard.close()
            self.assertIs(socket.socket.connect, original)

    def test_loopback_listening_is_permitted_without_external_network(self):
        with tempfile.TemporaryDirectory() as directory, installed(directory), socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            self.assertGreater(listener.getsockname()[1], 0)

    def test_inherited_libpq_scope_overrides_are_rejected_before_install(self):
        for key in ('PGSERVICE', 'PGSERVICEFILE', 'PGHOSTADDR', 'PGOPTIONS'):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory:
                with patch.dict(os.environ, {key: 'synthetic-denied'}):
                    with self.assertRaisesRegex(RuntimeError, 'environment'), installed(directory):
                        self.fail('hooks installed')

    def test_unknown_database_async_direct_cursor_and_process_are_rejected(self):
        import psycopg
        operations = [
            lambda: psycopg.connect('host=/tmp dbname=private'),
            lambda: psycopg.Connection.connect('host=203.0.113.1 dbname=postgres'),
            lambda: psycopg.connect('host=/tmp dbname=postgres', options='-c session_preload_libraries=private'),
            lambda: psycopg.AsyncConnection.connect('host=/tmp dbname=postgres'),
            lambda: psycopg.Cursor.execute(SimpleNamespace(connection=SimpleNamespace(info=SimpleNamespace(dbname='postgres'))), 'DROP DATABASE private'),
            lambda: subprocess.run(['/bin/echo', 'unexpected']),
            lambda: subprocess.Popen(['/bin/echo', 'unexpected']),
        ]
        for operation in operations:
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as directory:
                with self.assertRaisesRegex(RuntimeError, 'poisoned'), installed(directory):
                    with self.assertRaisesRegex(RuntimeError, 'resource_guard_'):
                        operation()

    def test_existing_bounded_connection_options_reach_only_the_scoped_driver(self):
        import psycopg
        fake = SimpleNamespace(info=SimpleNamespace(dbname='postgres', host='/tmp',
            port=int(os.environ.get('PGPORT', '5432')), user=os.environ.get('PGUSER') or __import__('getpass').getuser()))
        with patch.object(psycopg, 'connect', return_value=fake) as driver:
            with tempfile.TemporaryDirectory() as directory, installed(directory):
                self.assertIs(psycopg.connect('host=/tmp dbname=postgres',
                    options=' -c statement_timeout=200 -c lock_timeout=200'), fake)
                self.assertEqual(driver.call_count, 1)

    def test_migration_subprocess_is_pinned_to_owned_instance_and_project(self):
        project = Path(__file__).resolve().parents[3]
        with patch('subprocess.run', return_value=SimpleNamespace(returncode=0)) as run:
            with tempfile.TemporaryDirectory() as directory, installed(directory, project=project) as (guard, _, url):
                guard.database.created = True
                guard.database.instance = ('/tmp', 5432, 'synthetic_guard_owner')
                env = dict(os.environ, PGPORT='55441', PGUSER='different_owner', PYTHONPATH='/unrelated/module')
                subprocess.run([sys.executable, '-m', 'notalone.database_migrations', '--migrations',
                    str(project / 'backend/database/migrations')], cwd=project / 'backend', env=env, timeout=60)
                child = run.call_args.kwargs['env']
                self.assertEqual(child['PGPORT'], '5432')
                self.assertEqual(child['PGUSER'], 'synthetic_guard_owner')
                self.assertEqual(child['PYTHONPATH'], os.pathsep.join((str(project / 'backend/src'), str(project / 'backend'))))
                self.assertEqual(child['NOTALONE_DATABASE_URL'], url)

    def test_database_guard_digest_and_permissions_are_checked_before_install(self):
        with tempfile.TemporaryDirectory() as directory:
            with installed(directory) as (guard, name, url):
                guard.close()
                source = Path(directory) / 'page_database_guard.py'
                source.chmod(0o644)
                with self.assertRaisesRegex(RuntimeError, 'bytes'):
                    install(Path(directory), Path(directory) / 'database-ownership.json', name)
                source.chmod(0o600)
                source.write_text(source.read_text() + '\n# changed\n')
                with self.assertRaisesRegex(RuntimeError, 'bytes'):
                    install(Path(directory), Path(directory) / 'database-ownership.json', name)

    @unittest.skipUnless(os.environ.get('NOTALONE_GUARD_INTEGRATION') == '1', '显式单库合成验证')
    def test_one_real_owned_database_is_removed_even_after_poison(self):
        import psycopg
        directory = Path(tempfile.mkdtemp(prefix='notalone-page-guard-owned-'))
        with installed(directory, project=Path(__file__).resolve().parents[3]) as (guard, name, url):
            fixture = type('SyntheticFixture', (), {'_prepared_database_name': name,
                '_database_ownership_path': directory / 'database-ownership.json', 'production_model_wiring': False})
            guard.register(fixture)
            descriptor = os.open(fixture._database_ownership_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, 'w') as output:
                json.dump({'database_name': name, 'child_pid': os.getpid(), 'phase': 'planned'}, output)
                output.flush(); os.fsync(output.fileno())
            with psycopg.connect('host=/tmp dbname=postgres', autocommit=True) as admin:
                admin.execute(psycopg.sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(psycopg.sql.Identifier(name)))
            with psycopg.Connection.connect(url) as connection:
                connection.execute('CREATE TABLE synthetic_guard(value text)')
                with psycopg.Cursor(connection) as cursor:
                    cursor.execute('INSERT INTO synthetic_guard VALUES (%s)', ('合成守卫验证',))
                self.assertEqual(connection.execute('SELECT value FROM synthetic_guard').fetchone(), ('合成守卫验证',))
            with self.assertRaisesRegex(RuntimeError, 'parameters'):
                psycopg.connect('host=/tmp dbname=private')
            with self.assertRaisesRegex(RuntimeError, 'poisoned'):
                guard.close()
        # 守卫恢复后独立核验同一个确证创建的名字，不扫描前缀或未知库。
        with psycopg.connect('host=/tmp dbname=postgres') as admin:
            self.assertFalse(admin.execute('SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = %s)', (name,)).fetchone()[0])
        print(json.dumps({'guard_integration': 'passed', 'created': 1, 'absence_confirmed': True, 'evidence': str(directory)}))


if __name__ == '__main__':
    unittest.main()
