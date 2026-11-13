"""以临时 UTF-8 PostgreSQL 集群验证既有去重契约，不监听 TCP。"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


root = Path(__file__).resolve().parents[3]
evidence = Path(__file__).resolve().parent
assert shutil.disk_usage("/tmp").free >= 15 * 1024 ** 3
cluster = Path(tempfile.mkdtemp(prefix="notalone-stream-http-pg-", dir="/tmp"))
started = False
try:
    subprocess.run(["initdb", "-D", str(cluster / "data"), "-A", "trust",
                    "-U", "synthetic", "--no-locale", "--encoding=UTF8"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
    subprocess.run(["pg_ctl", "-D", str(cluster / "data"), "-l", str(cluster / "server.log"),
                    "-o", f"-h '' -k {cluster} -p 6543", "-w", "start"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
    started = True
    env = {**os.environ, "PYTHONPATH": "src", "PYTHONDONTWRITEBYTECODE": "1",
           "NOTALONE_TEST_DATABASE_URL": f"host={cluster} port=6543 user=synthetic dbname=postgres"}
    result = subprocess.run([
        sys.executable, "-m", "unittest",
        "tests.integration.front_sync.test_confirmed_contact_continuity", "-v"],
        cwd=root / "backend", env=env, capture_output=True, text=True)
    log = (result.stdout + result.stderr).replace(str(root), "<worktree>")
    (evidence / "persistence-tests.log").write_text(log)
    print(log)
    if result.returncode:
        raise RuntimeError("隔离持久化回归失败；未修改测试安全门。")
finally:
    if started:
        subprocess.run(["pg_ctl", "-D", str(cluster / "data"), "-m", "fast", "-w", "stop"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
    size = sum(path.stat().st_size for path in cluster.rglob("*") if path.is_file())
    shutil.rmtree(cluster)
    cleanup = {"isolated_pg_stopped": started, "cluster_removed": not cluster.exists(),
               "temporary_bytes_removed": size, "tcp_listening": False}
    (evidence / "persistence-cleanup.json").write_text(json.dumps(cleanup, indent=2) + "\n")
    print(json.dumps(cleanup))
