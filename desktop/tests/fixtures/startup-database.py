"""本轮 App 诊断验收拥有的随机测试库；只由测试准备显式迁移。"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from uuid import uuid4

import psycopg
from psycopg import sql

from notalone.database_migrations import migrate


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("create", "migrate", "drop", "untracked", "drift", "restore-drift", "incomplete",
                                          "owner-incomplete", "restore-owner-timestamp"))
    parser.add_argument("--database", default="")
    parser.add_argument("--project", type=Path, required=True)
    args = parser.parse_args()
    name = args.database
    if args.action == "create":
        name = f"notalone_startup_{uuid4().hex}_test"
    if not re.fullmatch(r"notalone_startup_[0-9a-f]{32}_test", name):
        raise ValueError("只允许本轮随机测试库。")
    if args.action == "migrate":
        migrate(f"host=/tmp dbname={name}", args.project / "backend/database/migrations")
    elif args.action in {"untracked", "drift", "restore-drift", "incomplete", "owner-incomplete", "restore-owner-timestamp"}:
        with psycopg.connect(f"host=/tmp dbname={name}") as connection:
            if args.action == "untracked":
                connection.execute("DROP TABLE public.notalone_schema_migration")
            elif args.action == "drift":
                connection.execute("UPDATE public.notalone_schema_migration SET checksum = 'synthetic-drift' WHERE name = '001_initial_ingest.sql'")
            elif args.action == "restore-drift":
                # 只恢复本轮已经完整迁移的测试库中故意改坏的一项，不是业务库恢复入口。
                checksum = hashlib.sha256((args.project / "backend/database/migrations/001_initial_ingest.sql").read_bytes()).hexdigest()
                connection.execute("UPDATE public.notalone_schema_migration SET checksum = %s WHERE name = '001_initial_ingest.sql'", (checksum,))
            elif args.action == "incomplete":
                connection.execute("ALTER TABLE public.contact DROP COLUMN display_name")
            elif args.action == "owner-incomplete":
                connection.execute("ALTER TABLE public.owner DROP COLUMN created_at")
            else:
                # 仅恢复本轮空测试库的原迁移列定义；产品只读门禁不会执行 DDL。
                connection.execute("ALTER TABLE public.owner ADD COLUMN created_at timestamptz NOT NULL DEFAULT now()")
    else:
        with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as connection:
            command = "CREATE DATABASE {} TEMPLATE template0" if args.action == "create" else "DROP DATABASE {} WITH (FORCE)"
            connection.execute(sql.SQL(command).format(sql.Identifier(name)))
    print(json.dumps({"database": name, "database_url": f"host=/tmp dbname={name}"}))


if __name__ == "__main__":
    main()
