"""只保护一个有限页面夹具的数据库生命周期，不是任意 Python 沙箱。"""

import json
import os
from pathlib import Path
import re
import stat
import threading


class ScopedDatabaseGuard:
    def __init__(self, ownership_path: Path, database_name: str):
        self.path = Path(ownership_path)
        if not self.path.is_absolute() or not re.fullmatch(r'notalone_core_flow_[0-9a-f]{32}_test', database_name):
            raise RuntimeError('resource_guard_identity')
        directory = self.path.parent.lstat()
        if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid() or stat.S_IMODE(directory.st_mode) != 0o700:
            raise RuntimeError('resource_guard_directory')
        self.name = database_name
        self.created = False
        self.ever_created = False
        self.poisoned = False
        self.sequence = 0
        self.lock = threading.RLock()
        self.instance = None

    def record(self, phase):
        self.sequence += 1
        directory = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            descriptor = os.open(f'resource-guard-{self.sequence:04d}.json',
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            with os.fdopen(descriptor, 'w') as output:
                json.dump({'phase': phase, 'database_name': self.name, 'child_pid': os.getpid()}, output)
                output.flush()
                os.fsync(output.fileno())
            os.fsync(directory)
        finally:
            os.close(directory)

    def deny(self, reason):
        self.poisoned = True
        self.record('denied_' + reason)
        raise RuntimeError('resource_guard_' + reason)

    def verify_marker(self):
        try:
            directory = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                descriptor = os.open(self.path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
            finally:
                os.close(directory)
        except OSError:
            self.deny('ownership')
        with os.fdopen(descriptor, 'r') as source:
            metadata = os.fstat(source.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o600:
                self.deny('ownership')
            raw = source.read(4097)
        try:
            value = json.loads(raw)
        except ValueError:
            self.deny('ownership')
        if len(raw) > 4096 or value != {'database_name': self.name, 'child_pid': os.getpid(), 'phase': 'planned'}:
            self.deny('ownership')

    def identity(self, database, host, port, user):
        with self.lock:
            if database not in ('postgres', self.name) or host != '/tmp':
                self.deny('connection_scope')
            identity = (host, int(port), user)
            if self.instance is None:
                if database != 'postgres':
                    self.deny('admin_first')
                self.instance = identity
            elif self.instance != identity:
                self.deny('instance_changed')
            if database == self.name and (not self.created or self.poisoned):
                self.deny('unowned_connection')

    def execute(self, database, query, params, operation):
        with self.lock:
            create = f'CREATE DATABASE "{self.name}" TEMPLATE template0'
            drop = f'DROP DATABASE "{self.name}" WITH (FORCE)'
            if database == 'postgres':
                if query == create and params is None:
                    if self.poisoned or self.ever_created:
                        self.deny('create_limit')
                    self.verify_marker()
                    self.record('create_planned')
                    try:
                        result = operation()
                    except BaseException:
                        self.poisoned = True
                        self.record('create_failed')
                        raise
                    self.created = self.ever_created = True
                    self.record('create_confirmed')
                    return result
                if query == drop and params is None and self.created:
                    result = operation()
                    self.created = False
                    self.record('drop_confirmed')
                    return result
                if query == 'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = %s)' and tuple(params or ()) == (self.name,):
                    return operation()
                self.deny('admin_statement')
            if database != self.name or not self.created or self.poisoned:
                self.deny('query_scope')
            normalized = re.sub(r'/\*.*?\*/|--[^\n]*', ' ', query, flags=re.S)
            if re.search(r'\b(?:CREATE|DROP|ALTER)\s+(?:DATABASE|ROLE|USER|TABLESPACE)\b|\b(?:dblink\w*|COPY\b.*\bPROGRAM)\b', normalized, re.I | re.S):
                self.deny('global_statement')
        # 业务 SQL 可并发；锁仅保护资源状态，不改变产品事务调度。
        return operation()

    def finish(self, exists):
        with self.lock:
            if exists is not False or self.created:
                self.deny('cleanup_unconfirmed')
            self.record('absence_confirmed')
