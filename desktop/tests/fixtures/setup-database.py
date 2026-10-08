"""只创建、迁移和清理本轮首启验收的随机 PostgreSQL 测试库。"""

import os
from pathlib import Path
import re
import subprocess
import sys

import psycopg
from psycopg import sql


operation, name = sys.argv[1:3]
if not re.fullmatch(r"notalone_setup_[0-9a-f]{32}_test", name):
    raise SystemExit("拒绝非本轮测试库名称。")
with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
    if operation == "create":
        admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(name)))
        environment = dict(os.environ)
        environment.update({"NOTALONE_DISABLE_DOTENV": "1", "NOTALONE_DATABASE_URL": f"host=/tmp dbname={name}"})
        result = subprocess.run(
            [sys.executable, "-m", "notalone.database_migrations", "--migrations",
             str(Path(__file__).resolve().parents[3] / "backend/database/migrations")],
            env=environment, capture_output=True, timeout=60,
        )
        if result.returncode:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
            raise SystemExit("隔离首启测试库迁移失败。")
    elif operation == "drop":
        admin.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))
    else:
        raise SystemExit("未知测试资源操作。")
