# 隔离 PostgreSQL 合成集群，仅复现 pg_stat_activity 统计口径。
from pathlib import Path
import json, os, subprocess, tempfile, time
import psycopg
pg_bin = Path.home() / "miniconda3/envs/NotAlone/bin"
directory = Path(tempfile.mkdtemp(prefix="na-reconnect-pg-"))
cluster, socket = directory / "cluster", directory / "socket"
socket.mkdir()
env = {"PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8", "LC_ALL": "C"}
connections = []
server = None
try:
 subprocess.run([str(pg_bin / "initdb"), "-D", str(cluster), "--auth=trust", "--encoding=UTF8", "--locale=C", "--no-instructions"], env=env, check=True, capture_output=True, timeout=30)
 server = subprocess.Popen([str(pg_bin / "postgres"), "-D", str(cluster), "-c", "listen_addresses=", "-c", "unix_socket_directories=" + str(socket), "-c", "autovacuum_naptime=1s", "-c", "autovacuum_vacuum_cost_delay=20ms", "-c", "autovacuum_vacuum_cost_limit=1"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
 def connect(database):
  c = psycopg.connect(host=str(socket), dbname=database, connect_timeout=1, autocommit=True)
  connections.append(c)
  return c
 deadline = time.monotonic() + 10
 while True:
  try:
   admin = connect("postgres")
   break
  except psycopg.OperationalError:
   if time.monotonic() >= deadline:
    raise
   time.sleep(.05)
 database = "notalone_reconnect_background_test"
 admin.execute("CREATE DATABASE " + database)
 c = connect(database)
 c.execute("CREATE TABLE synthetic_vacuum(id integer, padding text) WITH (autovacuum_vacuum_threshold=0, autovacuum_vacuum_scale_factor=0)")
 c.execute("INSERT INTO synthetic_vacuum SELECT i, repeat(md5(i::text),30) FROM generate_series(1,50000) i")
 c.execute("DELETE FROM synthetic_vacuum")
 c.execute("SELECT pg_stat_force_next_flush()")
 deadline = time.monotonic() + 12
 while True:
  rows = c.execute("SELECT pid,backend_type FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()").fetchall()
  if any(kind == "autovacuum worker" for _, kind in rows):
   break
  if time.monotonic() >= deadline:
   raise AssertionError("synthetic_autovacuum_not_started")
  time.sleep(.05)
 extra = connect(database)
 rows = c.execute("SELECT pid,backend_type FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()").fetchall()
 original = len(rows)
 business = sum(kind == "client backend" for _, kind in rows)
 print(json.dumps({"original_count": original, "business_count": business, "backends": [kind for _, kind in rows]}), flush=True)
 assert original == 1, "原夹具把 autovacuum worker 计为第二条业务连接"
finally:
 for c in reversed(connections):
  c.close()
 if server is not None:
  subprocess.run([str(pg_bin / "pg_ctl"), "-D", str(cluster), "-m", "immediate", "-w", "stop"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False)
  server.wait(timeout=10)
 import shutil
 shutil.rmtree(directory)
 print(json.dumps({"owned_cluster_stopped": True, "owned_connections_closed": True, "owned_directory_removed": not directory.exists()}), flush=True)
