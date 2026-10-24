"""仅HEAD与四份已审变更构造独立Python树，验证修复无需其他未提交业务。"""
from pathlib import Path
import os, shutil, subprocess, sys, tarfile, tempfile
from uuid import uuid4
import psycopg
from psycopg import sql

root = Path.cwd()
files = ["backend/src/notalone/memory/overview.py", "backend/src/notalone/persistence/memory_overview.py", "backend/src/notalone/persistence/layered_memory.py", "backend/tests/integration/persistence/test_layered_handoff_manifest.py"]
name = "notalone_manifest_" + uuid4().hex + "_test"
with tempfile.TemporaryDirectory(prefix="notalone-manifest-independent-") as directory:
    temp = Path(directory)
    archive = temp / "base.tar"
    subprocess.run(["git", "archive", "--output", str(archive), "HEAD", "backend"], check=True)
    with tarfile.open(archive) as source:
        source.extractall(temp, filter="data")
    archive.unlink()
    for name_in_repo in files:
        shutil.copyfile(root / name_in_repo, temp / name_in_repo)
    managed = temp / "managed"
    managed.mkdir(mode=0o700)
    env = {**os.environ, "NOTALONE_DISABLE_DOTENV": "1", "NOTALONE_TEST_DATABASE_URL": "host=/tmp dbname="+name, "NOTALONE_MANAGED_USER_DATA": str(managed), "PYTHONPATH": str(temp/"backend/src")+os.pathsep+str(temp/"backend")}
    with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as c:
        c.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(name)))
    try:
        subprocess.run([sys.executable, "-c", 'import os;from pathlib import Path;from notalone.database_migrations import migrate;migrate(os.environ["NOTALONE_TEST_DATABASE_URL"],Path("backend/database/migrations"))'], cwd=temp, env=env, check=True, timeout=60)
        result = subprocess.run([sys.executable, "-m", "unittest", "tests.integration.persistence.test_layered_handoff_manifest", "tests.integration.persistence.test_layered_capture_availability"], cwd=temp/"backend", env=env, timeout=120)
    finally:
        with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as c:
            c.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
    raise SystemExit(result.returncode)
