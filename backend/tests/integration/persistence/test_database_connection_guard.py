"""真实私有 PostgreSQL 的连接门禁；不改共享服务配置或查看他库。"""

from pathlib import Path
import os
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from uuid import uuid4

import psycopg
from psycopg import sql

from notalone.database_adoption import _ensure_no_other_connections
from notalone.database_migrations import MigrationError


class DatabaseConnectionGuardTest(unittest.TestCase):
    def test_real_autovacuum_is_not_an_unknown_writer_but_named_client_still_is(self) -> None:
        with tempfile.TemporaryDirectory(prefix="notalone-guard-") as directory:
            root = Path(directory)
            sockets = root / "sockets"
            sockets.mkdir(mode=0o700)
            cluster = root / "database"
            tools = {name: shutil.which(name) for name in ("initdb", "postgres", "pg_isready")}
            self.assertTrue(all(tools.values()), "需要已安装的PostgreSQL测试工具")
            environment = {"PATH": os.environ["PATH"], "HOME": str(root), "LANG": "C", "LC_ALL": "C"}
            subprocess.run([tools["initdb"], "-D", str(cluster), "-U", "notalone", "--encoding=UTF8",
                            "--locale=C", "--auth-local=trust", "--auth-host=reject", "--no-instructions"],
                           env=environment, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
            server = subprocess.Popen([tools["postgres"], "-D", str(cluster), "-k", str(sockets), "-h", "",
                                       "-c", "autovacuum_naptime=1s", "-c", "autovacuum_max_workers=1",
                                       "-c", "shared_buffers=16MB", "-c", "max_connections=10"],
                                      env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 10
                while subprocess.run([tools["pg_isready"], "-h", str(sockets)], env=environment,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
                    self.assertLess(time.monotonic(), deadline, "本例私有数据库尚未启动")
                    time.sleep(0.02)
                name = f"notalone_guard_{uuid4().hex}_test"
                with psycopg.connect(host=str(sockets), dbname="postgres", user="notalone", autocommit=True) as admin:
                    admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(name)))
                with psycopg.connect(host=str(sockets), dbname=name, user="notalone", autocommit=True) as connection:
                    connection.execute("""CREATE TABLE public.guard_probe (id int, payload text) WITH (
                        autovacuum_vacuum_threshold=0, autovacuum_vacuum_scale_factor=0,
                        autovacuum_analyze_threshold=0, autovacuum_analyze_scale_factor=0,
                        autovacuum_vacuum_cost_delay=20, autovacuum_vacuum_cost_limit=1)""")
                    connection.execute("ALTER TABLE public.guard_probe ALTER COLUMN payload SET STORAGE EXTERNAL")
                    connection.execute("INSERT INTO public.guard_probe SELECT i, repeat(md5(i::text),32) FROM generate_series(1,12000) i")
                    connection.execute("DELETE FROM public.guard_probe")
                    connection.execute("SELECT pg_catalog.pg_stat_force_next_flush()")
                    deadline = time.monotonic() + 12
                    worker = None
                    while worker is None:
                        connection.execute("SELECT pg_catalog.pg_stat_clear_snapshot()")
                        worker = connection.execute("""SELECT pid, backend_type FROM pg_catalog.pg_stat_activity
                            WHERE datname=pg_catalog.current_database() AND backend_type='autovacuum worker'""").fetchone()
                        self.assertLess(time.monotonic(), deadline, "未观察到本例真实autovacuum worker")
                        if worker is None:
                            time.sleep(0.02)
                    self.assertEqual(worker[1], "autovacuum worker")
                    _ensure_no_other_connections(connection)
                    with psycopg.connect(host=str(sockets), dbname=name, user="notalone",
                                         application_name="autovacuum worker") as named_client:
                        self.assertEqual(named_client.execute("SELECT backend_type FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()").fetchone()[0], "client backend")
                        with self.assertRaisesRegex(MigrationError, "adoption_writers_present"):
                            _ensure_no_other_connections(connection)
            finally:
                if server.poll() is None:
                    server.send_signal(signal.SIGINT)
                    try:
                        server.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        server.kill()
                        server.wait(timeout=5)
