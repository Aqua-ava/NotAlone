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
if operation in {"hold-owner-writes", "waiting-owner-writes"}:
    with psycopg.connect(f"host=/tmp dbname={name}") as connection:
        if operation == "hold-owner-writes":
            # 仅安排并发窗口；不读写业务行，两个真实 HTTP 写操作仍进正式仓储。
            connection.execute("LOCK TABLE public.owner IN SHARE MODE")
            print("ready", flush=True)
            sys.stdin.readline()
        else:
            row = connection.execute(
                """SELECT count(*) FROM pg_locks
                WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
                  AND relation = 'public.owner'::regclass AND NOT granted"""
            ).fetchone()
            print(row[0])
    raise SystemExit(0)
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
