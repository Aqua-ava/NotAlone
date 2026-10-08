"""机器级启动诊断：只读结构与迁移元数据，不装配业务运行时。"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
from typing import Any


REQUIRED_TABLES = frozenset({
    "owner", "contact", "channel_identity", "owner_channel_identity",
    "source_document", "import_confirmation", "message", "message_source_ref",
    "wechat_message_metadata", "conversation_binding", "front_sync_state",
    "local_wechat_observation", "wechat_observation_cursor",
    "wechat_observation_baseline", "cli_backfill_state", "background_task",
    "background_task_step", "memory_candidate", "confirmed_memory", "owner_memory",
    "memory_extraction_watermark", "contact_memory_state", "contact_memory_index",
    "outbound_ledger_entry", "reply_request", "reply_attempt",
    "reply_context_evidence", "reply_candidate", "reply_candidate_citation",
    "skill_library", "reply_skill", "reply_skill_version", "reply_skill_resource",
})
REQUIRED_COLUMNS = {
    "owner": {"id": "uuid", "display_name": "text"},
    "contact": {"id": "uuid", "owner_id": "uuid", "display_name": "text"},
    "message": {"id": "uuid", "owner_id": "uuid", "contact_id": "uuid", "text_content": "text"},
    "source_document": {"id": "uuid", "owner_id": "uuid", "contact_id": "uuid", "status": "text"},
    "conversation_binding": {"id": "uuid", "owner_id": "uuid", "contact_id": "uuid", "status": "text"},
    "background_task": {"id": "uuid", "owner_id": "uuid", "task_type": "text", "status": "text"},
    "background_task_step": {"task_id": "uuid", "status": "text", "worker_id": "uuid"},
    "confirmed_memory": {"id": "uuid", "owner_id": "uuid", "contact_id": "uuid"},
    "owner_memory": {"id": "uuid", "owner_id": "uuid"},
}
DEPENDENCIES = ("psycopg", "httpx", "yaml", "langchain", "langchain_core",
                "langchain_deepseek", "langgraph", "deepagents")


def _column_metadata(connection: Any) -> dict[str, dict[str, str]]:
    rows = connection.execute("""
        SELECT c.relname, a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod)
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND a.attnum > 0 AND NOT a.attisdropped AND c.relname = ANY(%s)
    """, (list(REQUIRED_TABLES | {"notalone_schema_migration", "notalone_schema_baseline"}),)
    ).fetchall()
    tables: dict[str, dict[str, str]] = {}
    for table, column, kind in rows:
        tables.setdefault(table, {})[column] = kind
    return tables


def database_readiness(database_url: str, migrations_directory: Path) -> str:
    """返回受限状态，不运行迁移、接管、参考库或业务表查询。"""

    import psycopg
    from notalone.database_baseline import BaselineError, baseline_offset
    from notalone.database_migrations import MigrationError, _load_migrations

    if not database_url.strip():
        return "database_unconfigured"
    try:
        migrations = _load_migrations(migrations_directory)
    except (MigrationError, ValueError, OSError, UnicodeError):
        return "migration_files_invalid"
    try:
        with psycopg.connect(database_url, autocommit=True, connect_timeout=3,
                             options="-c default_transaction_read_only=on "
                                     "-c statement_timeout=3000 -c lock_timeout=1000") as connection:
            with connection.transaction():
                connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                connection.execute("SET LOCAL search_path = pg_catalog, public")
                tables = _column_metadata(connection)
                baseline = connection.execute("""
                    SELECT c.relkind FROM pg_catalog.pg_class c
                    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = 'notalone_schema_baseline'
                """
                ).fetchone()
                if baseline is not None:
                    expected_baseline = {"format_version": "integer", "through_version": "integer",
                                         "manifest": "jsonb", "backup_sha256": "text",
                                         "restore_verified_at": "timestamp with time zone"}
                    if baseline[0] != "r" or any(tables.get("notalone_schema_baseline", {}).get(column) != kind
                                                 for column, kind in expected_baseline.items()):
                        return "baseline_invalid"
                ledger = tables.get("notalone_schema_migration")
                if ledger is None:
                    existing = connection.execute("""
                        SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f'))
                    """
                    ).fetchone()[0]
                    return "baseline_missing" if existing else "migration_pending"
                if ledger.get("name") != "text" or ledger.get("checksum") != "text":
                    return "schema_incomplete"
                try:
                    offset = baseline_offset(connection, migrations)
                except BaselineError as error:
                    return "migration_history_mismatch" if str(error).startswith("baseline_files_mismatch") else "baseline_invalid"
                completed = connection.execute(
                    "SELECT name, checksum FROM public.notalone_schema_migration ORDER BY name"
                ).fetchall()
                expected = [(item.name, item.checksum) for item in migrations[offset:offset + len(completed)]]
                if completed != expected:
                    return "migration_history_mismatch"
                if offset + len(completed) < len(migrations):
                    return "migration_pending"
                if not REQUIRED_TABLES.issubset(tables):
                    return "schema_incomplete"
                for table, columns in REQUIRED_COLUMNS.items():
                    if any(tables[table].get(column) != kind for column, kind in columns.items()):
                        return "schema_incomplete"
                return "ready"
    except psycopg.OperationalError:
        return "database_unavailable"
    except psycopg.Error:
        return "diagnostic_failed"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="只读检查 NotAlone 的机器级启动条件。")
    parser.add_argument("--migrations", type=Path, required=True)
    args = parser.parse_args(argv)
    code = "ready"
    if sys.version_info[:2] != (3, 12):
        code = "python_version_unsupported"
    elif any(importlib.util.find_spec(module) is None for module in DEPENDENCIES):
        code = "backend_package_missing"
    else:
        from notalone.runtime_config import load_project_env
        try:
            load_project_env()
            code = database_readiness(os.environ.get("NOTALONE_DATABASE_URL", ""), args.migrations)
        except (OSError, UnicodeError, ValueError, ImportError):
            code = "diagnostic_failed"
    print(json.dumps({"code": code}, ensure_ascii=False))
    return 0 if code == "ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())
