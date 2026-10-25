"""本轮专用 PG 集群：让真实 autovacuum 与故意保留的客户端连接并存。"""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

import psycopg

pg_bin = Path(os.environ.get("NOTALONE_TEST_PG_BIN", Path.home() / "miniconda3/envs/NotAlone/bin"))
directory = Path(tempfile.mkdtemp(prefix="na-reconnect-vacuum-"))
cluster, socket = directory / "cluster", directory / "socket"
socket.mkdir()
environment = {"PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8", "LC_ALL": "C"}
server = None
admin = None
client = None
database = "notalone_reconnect_vacuum_test"
dropped = False
try:
    subprocess.run(
        [str(pg_bin / "initdb"), "-D", str(cluster), "--auth=trust", "--encoding=UTF8", "--locale=C", "--no-instructions"],
        env=environment, check=True, capture_output=True, timeout=30,
    )
    server = subprocess.Popen(
        [str(pg_bin / "postgres"), "-D", str(cluster), "-c", "listen_addresses=",
         "-c", "unix_socket_directories=" + str(socket), "-c", "autovacuum_naptime=1s",
         "-c", "autovacuum_vacuum_cost_delay=20ms", "-c", "autovacuum_vacuum_cost_limit=1"],
        env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + 10
    while True:
        try:
            admin = psycopg.connect(host=str(socket), dbname="postgres", connect_timeout=1, autocommit=True)
            break
        except psycopg.OperationalError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.05)
    admin.execute("CREATE DATABASE " + database)
    client = psycopg.connect(host=str(socket), dbname=database, autocommit=True)
    client.execute("CREATE TABLE synthetic_vacuum(id integer, padding text) WITH (autovacuum_vacuum_threshold=0, autovacuum_vacuum_scale_factor=0)")
    client.execute("INSERT INTO synthetic_vacuum SELECT i, repeat(md5(i::text),30) FROM generate_series(1,50000) i")
    client.execute("DELETE FROM synthetic_vacuum")
    client.execute("SELECT pg_stat_force_next_flush()")
    deadline = time.monotonic() + 12
    while True:
        if client.execute("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND backend_type='autovacuum worker')").fetchone()[0]:
            break
        if time.monotonic() >= deadline:
            raise AssertionError("synthetic_autovacuum_not_started")
        time.sleep(0.05)
    client.close()
    client = None
    print(json.dumps({"socket": str(socket), "database": database, "directory": str(directory)}), flush=True)
    # 测试进程的 stdin EOF 是本轮唯一收尾信号；不修改系统 PG 配置。
    sys.stdin.read()
    active = admin.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=%s AND backend_type='client backend'", (database,)).fetchone()[0]
    assert active == 0, "隔离集群正常 DROP 前仍有测试客户端连接"
    admin.execute("DROP DATABASE " + database)
    dropped = True
finally:
    if client is not None:
        client.close()
    if admin is not None:
        admin.close()
    if server is not None:
        subprocess.run(
            [str(pg_bin / "pg_ctl"), "-D", str(cluster), "-m", "fast", "-w", "stop"],
            env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=10,
        )
        server.wait(timeout=10)
    shutil.rmtree(directory)
    print(json.dumps({"normal_drop_client_connections": 0 if dropped else None, "database_dropped": dropped,
                      "owned_cluster_stopped": server is None or server.poll() is not None,
                      "owned_directory_removed": not directory.exists()}), flush=True)
