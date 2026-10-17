"""本机启动时沿用当前数据库，只补齐可信版本账本之后的结构。"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import psycopg
from psycopg.conninfo import conninfo_to_dict

from notalone.database_migrations import MigrationError, migrate_connection
from notalone.startup_diagnostics import database_readiness


def ensure_database_schema(database_url: str, migrations: Path) -> dict[str, Any]:
    """已就绪时只读返回；缺少结构时在同一库执行并复验，不创建资料副本。"""
    code = database_readiness(database_url, migrations)
    if code != "migration_pending":
        return {"code": code, "applied": []}
    options = conninfo_to_dict(database_url)
    host = options.get("host") or os.environ.get("PGHOST", "")
    address = options.get("hostaddr") or os.environ.get("PGHOSTADDR", "")
    name = options.get("dbname") or os.environ.get("PGDATABASE", "")
    if (host not in {"", "localhost", "127.0.0.1", "::1"} and not host.startswith("/")
            or address not in {"", "127.0.0.1", "::1"}
            or any(key in options for key in ("service", "options"))
            or os.environ.get("PGSERVICE") or os.environ.get("PGOPTIONS")
            or name in {"", "postgres", "template0", "template1"}):
        return {"code": "database_update_requires_local", "applied": []}
    try:
        with psycopg.connect(database_url, autocommit=True, connect_timeout=3,
                             application_name="notalone_schema_startup") as connection:
            if not connection.execute("SELECT pg_catalog.pg_try_advisory_lock(1852798049, 1)").fetchone()[0]:
                return {"code": "migration_busy", "applied": []}
            if connection.execute("""SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity
                WHERE datname=pg_catalog.current_database() AND pid<>pg_catalog.pg_backend_pid()
                  AND backend_type='client backend')""").fetchone()[0]:
                return {"code": "database_writers_present", "applied": []}
            applied = migrate_connection(connection, migrations)
        return {"code": database_readiness(database_url, migrations), "applied": list(applied)}
    except MigrationError as error:
        code = str(error).split("：", 1)[0]
        if code not in {"migration_busy", "migration_failed", "migration_history_mismatch",
                        "baseline_invalid", "baseline_missing", "baseline_files_mismatch"}:
            code = "diagnostic_failed"
        return {"code": code, "applied": []}
    except psycopg.OperationalError:
        return {"code": "database_unavailable", "applied": []}
    except psycopg.Error:
        return {"code": "diagnostic_failed", "applied": []}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="在现有本机数据库补齐缺少的表结构。")
    parser.add_argument("--migrations", type=Path, required=True)
    args = parser.parse_args(argv)
    from notalone.runtime_config import load_project_env
    try:
        load_project_env()
        result = ensure_database_schema(os.environ.get("NOTALONE_DATABASE_URL", ""), args.migrations)
    except (OSError, ValueError, psycopg.Error):
        result = {"code": "diagnostic_failed", "applied": []}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["code"] == "ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())
