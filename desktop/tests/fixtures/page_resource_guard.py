"""有限合成页面的资源适配器；仅在专用夹具进程导入产品前安装。"""

from contextlib import ExitStack
import hashlib
import ipaddress
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import threading
from unittest.mock import patch


def _load_database_guard():
    prefix = 'NOTALONE_EVOLUTION_GUARD_' if os.environ.get('NOTALONE_EVOLUTION_GUARD_DATABASE_GUARD_PATH') else 'NOTALONE_LEARNING_GUARD_'
    path = Path(os.environ[prefix + 'DATABASE_GUARD_PATH'])
    expected = os.environ[prefix + 'DATABASE_GUARD_SHA256']
    if not path.is_absolute():
        raise RuntimeError('resource_guard_path')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as source:
        metadata = os.fstat(source.fileno())
        raw = source.read(256 * 1024 + 1)
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600 or len(raw) > 256 * 1024
            or hashlib.sha256(raw).hexdigest() != expected):
        raise RuntimeError('resource_guard_bytes')
    namespace = {'__file__': str(path), '__name__': 'finite_page_database_guard'}
    exec(compile(raw, str(path), 'exec'), namespace)
    return namespace['ScopedDatabaseGuard']


class PageResourceGuard:
    def __init__(self, root, ownership_path, database_name):
        self.root = Path(root).resolve()
        self.url = f'host=/tmp dbname={database_name}'
        if (os.environ.get('NOTALONE_DATABASE_URL') != self.url
                or os.environ.get('NOTALONE_TEST_DATABASE_URL') != self.url
                or os.environ.get('NOTALONE_DISABLE_DOTENV') != '1'
                or any(name == 'notalone' or name.startswith('notalone.') for name in sys.modules)):
            raise RuntimeError('resource_guard_import_scope')
        if any(os.environ.get(key) for key in ('PGSERVICE', 'PGSERVICEFILE', 'PGHOSTADDR', 'PGOPTIONS')):
            raise RuntimeError('resource_guard_environment')
        self.database = _load_database_guard()(Path(ownership_path), database_name)
        self.hooks = ExitStack()
        self.registered = False
        self.closed = False
        self.process_state = threading.local()
        self.migrations_started = 0
        files = [self.root / 'backend/src/notalone/database_migrations.py',
                 self.root / 'backend/src/notalone/database_baseline.py']
        files.extend(sorted((self.root / 'backend/database/migrations').glob('*.sql')))
        self.migration_bytes = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in files if p.exists()}
        try:
            self._database_hooks()
            self._network_hooks()
            self._process_hooks()
        except BaseException:
            self.hooks.close()
            raise

    def _patch(self, owner, name, replacement):
        self.hooks.enter_context(patch.object(owner, name, replacement))

    def _database_hooks(self):
        import psycopg
        from psycopg.conninfo import conninfo_to_dict
        original_connect = psycopg.connect
        original_execute = psycopg.Cursor.execute
        original_many = psycopg.Cursor.executemany
        original_cursor = psycopg.Connection.cursor
        guard = self.database

        def connect(conninfo='', **kwargs):
            if any(os.environ.get(key) for key in ('PGSERVICE', 'PGSERVICEFILE', 'PGHOSTADDR', 'PGOPTIONS')):
                guard.deny('connection_environment')
            special = {'autocommit', 'prepare_threshold', 'context', 'row_factory', 'cursor_factory'}
            params = conninfo_to_dict(conninfo, **{k: v for k, v in kwargs.items() if k not in special})
            if (set(params) - {'host', 'dbname', 'port', 'user', 'connect_timeout', 'application_name', 'options'}
                    or params.get('host') != '/tmp' or params.get('dbname') not in ('postgres', guard.name)
                    or kwargs.get('cursor_factory') is not None or kwargs.get('context') is not None):
                guard.deny('connection_parameters')
            if params.get('options') and not re.fullmatch(
                    r'(?:\s*-c (?:statement_timeout=\d+|lock_timeout=\d+|default_transaction_read_only=on))+\s*', params['options']):
                guard.deny('connection_options')
            expected_port = int(os.environ.get('PGPORT', '5432'))
            expected_user = os.environ.get('PGUSER') or __import__('getpass').getuser()
            if int(params.get('port', expected_port)) != expected_port or params.get('user', expected_user) != expected_user:
                guard.deny('requested_instance')
            if params['dbname'] == guard.name and (not guard.created or guard.poisoned):
                guard.deny('unowned_connection')
            connection = original_connect(conninfo, **{**kwargs, 'connect_timeout': 3})
            try:
                info = connection.info
                guard.identity(info.dbname, info.host, info.port, info.user)
                if info.port != expected_port or info.user != expected_user:
                    guard.deny('actual_instance')
            except BaseException:
                connection.close()
                raise
            return connection

        def text(query, connection):
            if isinstance(query, psycopg.sql.Composable):
                return query.as_string(connection)
            if isinstance(query, bytes):
                return query.decode('utf-8', errors='strict')
            if not isinstance(query, str):
                guard.deny('query_type')
            return query

        def execute(cursor, query, params=None, **kwargs):
            statement = text(query, cursor.connection)
            if cursor.connection.info.dbname == 'postgres' and statement.startswith('CREATE') and not self.registered:
                guard.deny('fixture_not_registered')
            return guard.execute(cursor.connection.info.dbname, statement, params,
                                 lambda: original_execute(cursor, query, params, **kwargs))

        def many(cursor, query, params_seq, **kwargs):
            if cursor.connection.info.dbname == 'postgres':
                guard.deny('admin_batch')
            return guard.execute(cursor.connection.info.dbname, text(query, cursor.connection), None,
                                 lambda: original_many(cursor, query, params_seq, **kwargs))

        def cursor(connection, name='', **kwargs):
            if name:
                guard.deny('server_cursor')
            return original_cursor(connection, **kwargs)

        def denied(*args, **kwargs):
            guard.deny('uncovered_client')

        self._patch(psycopg, 'connect', connect)
        self._patch(psycopg.Connection, 'connect', classmethod(lambda cls, *a, **kw: connect(*a, **kw)))
        self._patch(psycopg.AsyncConnection, 'connect', classmethod(denied))
        self._patch(psycopg.Connection, 'cursor', cursor)
        self._patch(psycopg.Cursor, 'execute', execute)
        self._patch(psycopg.Cursor, 'executemany', many)
        self._patch(psycopg.Cursor, 'copy', denied)
        self._patch(psycopg.ServerCursor, 'execute', denied)
        self._patch(psycopg.ClientCursor, 'execute', denied)
        self.connect = connect

    def _network_hooks(self):
        guard = self.database
        def check(address):
            if isinstance(address, tuple) and len(address) >= 2:
                try:
                    if ipaddress.ip_address(address[0]).is_loopback:
                        return
                except ValueError:
                    pass
            guard.deny('network')
        for name in ('connect', 'connect_ex', 'bind'):
            original = getattr(socket.socket, name)
            def guarded(sock, address, _original=original):
                check(address)
                return _original(sock, address)
            self._patch(socket.socket, name, guarded)
        original_resolve = socket.getaddrinfo
        def resolve(host, port, *args, **kwargs):
            check((host, port))
            return original_resolve(host, port, *args, **kwargs)
        self._patch(socket, 'getaddrinfo', resolve)
        original_sendto = socket.socket.sendto
        def sendto(sock, data, *args):
            check(args[-1])
            return original_sendto(sock, data, *args)
        self._patch(socket.socket, 'sendto', sendto)

    def _process_hooks(self):
        original_run, original_popen = subprocess.run, subprocess.Popen
        def run(args, **kwargs):
            expected = [sys.executable, '-m', 'notalone.database_migrations', '--migrations', str(self.root / 'backend/database/migrations')]
            env = kwargs.get('env', {})
            if (list(args) != expected or kwargs.get('shell') or kwargs.get('cwd') != self.root / 'backend'
                    or not 0 < kwargs.get('timeout', 0) <= 60 or env.get('NOTALONE_DATABASE_URL') != self.url
                    or env.get('NOTALONE_TEST_DATABASE_URL') != self.url or env.get('NOTALONE_DISABLE_DOTENV') != '1'
                    or any(env.get(key) for key in ('PGSERVICE', 'PGSERVICEFILE', 'PGHOSTADDR', 'PGOPTIONS'))
                    or not self.database.created or self.database.instance is None or self.database.poisoned or self.migrations_started >= 2
                    or not self.migration_bytes
                    or set((self.root / 'backend/database/migrations').glob('*.sql')) != {p for p in self.migration_bytes if p.suffix == '.sql'}
                    or any(hashlib.sha256(p.read_bytes()).hexdigest() != digest for p, digest in self.migration_bytes.items())):
                self.database.deny('subprocess')
            # 子进程不继承Python钩子，显式绑定已确认实例与仓库模块。
            host, port, user = self.database.instance
            kwargs['env'] = dict(env, PGHOST=host, PGPORT=str(port), PGUSER=user,
                PYTHONPATH=os.pathsep.join((str(self.root / 'backend/src'), str(self.root / 'backend'))))
            self.migrations_started += 1
            self.process_state.allowed = True
            try:
                return original_run(args, **kwargs)
            finally:
                self.process_state.allowed = False
        def popen(*args, **kwargs):
            if not getattr(self.process_state, 'allowed', False):
                self.database.deny('subprocess')
            return original_popen(*args, **kwargs)
        self._patch(subprocess, 'run', run)
        self._patch(subprocess, 'Popen', popen)

    def register(self, fixture_class):
        if (self.registered or fixture_class._prepared_database_name != self.database.name
                or Path(fixture_class._database_ownership_path) != self.database.path):
            self.database.deny('fixture_registration')
        if fixture_class.production_model_wiring:
            # 此标志表示使用正式装配；网络边界仍必须是受控合成模型。
            from tests.integration.server.core_business_flow_support import ScriptedCoreModel
            for name in ('extraction_model_factory', 'reply_model_factory'):
                factory = getattr(fixture_class, name, None)
                if not isinstance(factory, type) or not issubclass(factory, ScriptedCoreModel):
                    self.database.deny('model_factory')
        self.registered = True
        self.database.record('fixture_registered')

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            if self.database.ever_created:
                with self.connect('host=/tmp dbname=postgres', autocommit=True) as admin:
                    if self.database.created:
                        admin.execute(f'DROP DATABASE "{self.database.name}" WITH (FORCE)')
                    exists = admin.execute('SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = %s)', (self.database.name,)).fetchone()[0]
                self.database.finish(exists)
            else:
                self.database.record('no_database_created')
            if self.database.poisoned:
                raise RuntimeError('resource_guard_poisoned')
        finally:
            self.hooks.close()


def install(root, ownership_path, database_name):
    return PageResourceGuard(root, ownership_path, database_name)
