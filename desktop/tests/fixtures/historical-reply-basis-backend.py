"""历史依据验收启动入口：导入夹具前绑定本轮自有随机库，精确收尾。"""

from __future__ import annotations

import json
import os
from pathlib import Path
import runpy
import sys
from uuid import uuid4

import psycopg
from psycopg import sql


def main() -> None:
    root = Path(__file__).resolve().parents[3]
    if (os.environ.get("CONDA_DEFAULT_ENV") != "NotAlone"
            or not os.environ.get("CONDA_PREFIX") or Path.cwd() != root / "backend"):
        raise RuntimeError("历史依据夹具须从 backend 在 Conda NotAlone 中运行。")
    os.environ.update({"NOTALONE_DISABLE_DOTENV": "1", "PYTHON_DOTENV_DISABLED": "1",
                       "LANGCHAIN_TRACING_V2": "false", "LANGCHAIN_TRACING": "false",
                       "LANGSMITH_TRACING": "false"})
    database_name = f"notalone_core_flow_{uuid4().hex}_test"
    database_url = f"host=/tmp dbname={database_name}"
    os.environ.update({"NOTALONE_TEST_DATABASE_URL": database_url,
                       "NOTALONE_DATABASE_URL": database_url})
    record_path = Path(os.environ["NOTALONE_ENV_FILE"]).parent / "database-ownership.json"
    descriptor = os.open(record_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as record:
        json.dump({"database_name": database_name, "child_pid": os.getpid(), "phase": "planned"}, record)
    created = False

    def drop_owned() -> None:
        nonlocal created
        if not created:
            return
        with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(database_name)))
            remaining = admin.execute("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname=%s)",
                                      (database_name,)).fetchone()[0]
            if remaining:
                raise RuntimeError("本轮历史依据自有测试库清理未确认。")
            created = False

    try:
        with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
            admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(database_name)))
            created = True
        with psycopg.connect(database_url) as connection:
            if connection.execute("SELECT current_database()").fetchone()[0] != database_name:
                raise RuntimeError("历史依据夹具数据库身份与本轮随机名称不一致。")
        # 测试模块可能捕获连接环境；必须在精确绑定之后才载入既有生产装配。
        sys.path.insert(0, str(root / "backend"))
        definitions = runpy.run_path(str(Path(__file__).with_name("rewrite-backend.py")))
        fixture_type = definitions["DesktopRewriteFixture"]
        from notalone.database_migrations import migrate

        def prepare_owned(cls):
            cls.database_name = database_name
            cls.database_url = database_url
            cls.addClassCleanup(drop_owned)
            applied = migrate(database_url, root / "backend/database/migrations")
            expected = sorted(path.name for path in (root / "backend/database/migrations").glob("*.sql"))
            if (len(expected) != 89 or [int(name[:3]) for name in expected] != list(range(1, 90))
                    or list(applied) != expected or migrate(database_url, root / "backend/database/migrations") != ()):
                raise RuntimeError("历史依据夹具须使用正式001–089迁移，重复执行为0。")
            cls.migration_receipt = definitions["verify_full_migrations"](database_name, database_url)

        fixture_type.setUpClass = classmethod(prepare_owned)
        # 原夹具负责 HTTP／owner／临时目录；本入口唯一拥有建库和删库。
        definitions["main"]()
    finally:
        drop_owned()


if __name__ == "__main__":
    main()
