"""经明确批准后接管本机 035 旧库；普通迁移仍拒绝未知旧库。"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import Any, Iterator
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.types.json import Jsonb

from notalone.database_audit import (
    AuditResult, audit_connection, business_digest, digest, schema_catalog,
)
from notalone.database_baseline import (
    BASELINE_MANIFEST, BASELINE_VERSION, BaselineError, baseline_offset, validate_prefix,
)
from notalone.database_migrations import Migration, MigrationError, _load_migrations


_REPAIR_SQL = """
ALTER TABLE public.source_document DROP CONSTRAINT source_document_source_type_check;
ALTER TABLE public.source_document ADD CONSTRAINT source_document_source_type_check
    CHECK (source_type IN ('wechat_jsonl', 'manual'));
""".strip()

_BASELINE_DDL = """
CREATE TABLE public.notalone_schema_baseline (
    singleton boolean PRIMARY KEY CHECK (singleton),
    format_version integer NOT NULL CHECK (format_version = 1),
    through_version integer NOT NULL CHECK (through_version = 35),
    manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'array'
        AND jsonb_array_length(manifest) = 35),
    schema_before_sha256 text NOT NULL CHECK (schema_before_sha256 ~ '^[0-9a-f]{64}$'),
    schema_after_sha256 text NOT NULL CHECK (schema_after_sha256 ~ '^[0-9a-f]{64}$'),
    repair_sha256 text CHECK (repair_sha256 ~ '^[0-9a-f]{64}$'),
    backup_sha256 text NOT NULL CHECK (backup_sha256 ~ '^[0-9a-f]{64}$'),
    restored_data_sha256 text NOT NULL CHECK (restored_data_sha256 ~ '^[0-9a-f]{64}$'),
    restore_verified_at timestamptz NOT NULL,
    adopted_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.notalone_schema_baseline IS
    '经过备份恢复和全范围契约核验的旧库接管基线，不表示历史 SQL 曾执行。';
CREATE TABLE public.notalone_schema_migration (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
);
"""


@dataclass(frozen=True, slots=True)
class AdoptionResult:
    adopted: bool
    backup_sha256: str


@dataclass(frozen=True, slots=True)
class _ReferenceSchema:
    business: dict[str, list[tuple[Any, ...]]]
    managed: dict[str, list[tuple[Any, ...]]]


def _local_url(database_url: str) -> str:
    options = conninfo_to_dict(database_url)
    if options.get("service") or os.environ.get("PGSERVICE"):
        raise MigrationError("adoption_local_only：接管入口只支持明确的本机连接。")
    for key, variable in (("host", "PGHOST"), ("hostaddr", "PGHOSTADDR"),
                          ("port", "PGPORT"), ("user", "PGUSER"), ("password", "PGPASSWORD")):
        if not options.get(key) and os.environ.get(variable):
            options[key] = os.environ[variable]
    if not options.get("host"):
        options["host"] = "/tmp"
    options.setdefault("user", getpass.getuser())
    options.setdefault("port", "5432")
    host = options.get("host", "")
    if (options.get("service") or options.get("hostaddr", "") not in ("", "127.0.0.1", "::1")
            or not (host in ("", "127.0.0.1", "::1") or host.startswith("/"))):
        raise MigrationError("adoption_local_only：接管入口只支持明确的本机连接。")
    if not options.get("dbname"):
        raise MigrationError("adoption_target_invalid：需要明确的业务数据库名。")
    return make_conninfo(**options)


def _local_connection(database_url: str) -> psycopg.Connection[Any]:
    connection = psycopg.connect(database_url, autocommit=True)
    if (connection.info.server_version // 10000 != 16
            or connection.info.dbname in ("postgres", "template0", "template1")):
        connection.close()
        raise MigrationError("adoption_target_invalid：仅支持 PostgreSQL 16 的专用业务库。")
    # 第一个 SQL 即固定安全解析路径；旧库同名函数不得在拒绝前运行。
    connection.execute("SET search_path = pg_catalog, public")
    if not connection.execute("SELECT pg_catalog.pg_try_advisory_lock(1852798049, 1)").fetchone()[0]:
        connection.close()
        raise MigrationError("migration_busy：另一个迁移或接管命令正在执行。")
    connection.execute("SET lock_timeout = '10s'")
    connection.execute("SET statement_timeout = '120s'")
    return connection


@contextmanager
def _owned_database(
    database_url: str, prefix: str, *, synthetic: bool,
) -> Iterator[str]:
    """只创建和清理本次调用生成的随机副本；私人恢复库不使用 _test 名称。"""

    name = f"notalone_{prefix}_{uuid4().hex}" + ("_test" if synthetic else "")
    with psycopg.connect(make_conninfo(database_url, dbname="postgres"), autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(name)))
        try:
            admin.execute(sql.SQL("REVOKE ALL ON DATABASE {} FROM PUBLIC").format(sql.Identifier(name)))
            yield make_conninfo(database_url, dbname=name)
        finally:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


@contextmanager
def _reference_catalog(
    database_url: str, migrations: tuple[Migration, ...],
) -> Iterator[_ReferenceSchema]:
    with _owned_database(database_url, "baseline", synthetic=True) as reference_url:
        with psycopg.connect(reference_url, autocommit=True) as reference:
            reference.execute("SET search_path = pg_catalog, public")
            for migration in migrations[:BASELINE_VERSION]:
                with reference.transaction():
                    reference.execute(migration.body)
            business = schema_catalog(reference)
            with reference.transaction():
                reference.execute(_BASELINE_DDL)
            yield _ReferenceSchema(business, schema_catalog(reference))


def audit_legacy_database(database_url: str, directory: Path) -> AuditResult:
    """目标库只读；参考结构来自固定前缀在空合成库中的实际执行。"""

    try:
        migrations = _load_migrations(directory)
        validate_prefix(migrations)
        database_url = _local_url(database_url)
        with _local_connection(database_url) as connection:
            with connection.transaction():
                connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                with _reference_catalog(database_url, migrations) as expected:
                    return audit_connection(connection, expected.business)
    except MigrationError:
        raise
    except BaselineError as error:
        raise MigrationError(str(error)) from None
    except (ValueError, OSError, psycopg.Error):
        raise MigrationError("legacy_audit_failed：无法完成只读核验，未接管。") from None


def _run_pg(program: str, database_url: str, arguments: list[str]) -> None:
    executable = shutil.which(program)
    if executable is None:
        raise MigrationError("backup_tool_missing：需要 PostgreSQL 16 的备份恢复工具。")
    version = subprocess.run([executable, "--version"], capture_output=True, text=True,
                             check=True, timeout=10)
    if re.search(r"\(PostgreSQL\) 16\.", version.stdout) is None:
        raise MigrationError("backup_tool_version：备份恢复工具必须与 PostgreSQL 16 匹配。")
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    # libpq 不会展开 PGDATABASE 中的连接串；逐项传递连接参数。
    # pg_restore 必须显式选择数据库，否则会把 SQL（含私人行）输出到 stdout。
    variables = {
        "host": "PGHOST", "hostaddr": "PGHOSTADDR", "port": "PGPORT",
        "user": "PGUSER", "password": "PGPASSWORD", "dbname": "PGDATABASE",
        "connect_timeout": "PGCONNECT_TIMEOUT", "options": "PGOPTIONS",
        "sslmode": "PGSSLMODE", "application_name": "PGAPPNAME",
        "passfile": "PGPASSFILE", "sslcert": "PGSSLCERT", "sslkey": "PGSSLKEY",
        "sslrootcert": "PGSSLROOTCERT", "sslcrl": "PGSSLCRL",
        "target_session_attrs": "PGTARGETSESSIONATTRS",
    }
    options = conninfo_to_dict(database_url)
    if any(key not in variables for key in options):
        raise MigrationError("backup_connection_options：备份工具不支持该连接参数组合。")
    for key, value in options.items():
        env[variables[key]] = value
    # 数据库名本身不是连接串；凭据从不进入进程参数或错误输出。
    target = options.get("dbname")
    if not target:
        raise MigrationError("backup_connection_options：需要明确的数据库名。")
    result = subprocess.run([executable, "--no-password", "--dbname", target, *arguments], env=env,
                            capture_output=True, timeout=120)
    if result.returncode or result.stderr:
        raise MigrationError("backup_restore_failed：备份或恢复未完整成功，未接管。")


def _backup_directory(directory: Path) -> Path:
    # backend/src/notalone 下移后，备份保护范围仍覆盖整个仓库。
    repository = Path(__file__).resolve().parents[3]
    if directory.is_symlink() or directory.resolve().is_relative_to(repository):
        raise MigrationError("backup_path_invalid：备份必须保存在仓库外的本机受限目录。")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.stat().st_mode & 0o777 != 0o700 or any(directory.iterdir()):
        raise MigrationError("backup_path_invalid：备份目录必须为空且权限为 0700。")
    return directory


def _verified_backup(
    connection: psycopg.Connection[Any], database_url: str, directory: Path,
    tables: tuple[str, ...], schema_before: dict[str, list[tuple[Any, ...]]],
) -> tuple[str, str, datetime]:
    source_data = business_digest(connection, tables)
    directory = _backup_directory(directory)
    archive = directory / "database.dump"
    descriptor = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    snapshot = connection.execute("SELECT pg_export_snapshot()").fetchone()[0]
    _run_pg("pg_dump", database_url, ["--format=custom", "--snapshot", snapshot,
                                     "--file", str(archive)])
    with archive.open("rb") as stream:
        backup_sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
        os.fsync(stream.fileno())
    with _owned_database(database_url, "restore", synthetic=False) as restored_url:
        _run_pg("pg_restore", restored_url, ["--single-transaction", "--exit-on-error", str(archive)])
        with psycopg.connect(restored_url) as restored:
            restored.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            restored.execute("SET search_path = pg_catalog, public")
            if (schema_catalog(restored) != schema_before
                    or business_digest(restored, tables) != source_data):
                raise MigrationError("restore_mismatch：恢复副本与升级前完整结构或资料不一致，未接管。")
    return backup_sha256, source_data, datetime.now(timezone.utc)


def _ensure_no_other_connections(connection: psycopg.Connection[Any]) -> None:
    connection.execute("SELECT pg_catalog.pg_stat_clear_snapshot()")
    if connection.execute("""
        SELECT count(*) FROM pg_catalog.pg_stat_activity
        WHERE datname = pg_catalog.current_database() AND pid <> pg_catalog.pg_backend_pid()
    """).fetchone()[0]:
        raise MigrationError("adoption_writers_present：请先停止 App、同步、Worker 和其他目标库连接。")


def adopt_legacy_database(
    database_url: str, directory: Path, backup_directory: Path,
) -> AdoptionResult:
    """显式、受控接管：验证恢复之后才在一个事务中补齐约束与基线。"""

    try:
        migrations = _load_migrations(directory)
        validate_prefix(migrations)
        database_url = _local_url(database_url)
        with _local_connection(database_url) as connection:
            if baseline_offset(connection, migrations):
                backup_sha = connection.execute(
                    "SELECT backup_sha256 FROM public.notalone_schema_baseline"
                ).fetchone()[0]
                return AdoptionResult(False, backup_sha)
            if connection.execute(
                "SELECT to_regclass('public.notalone_schema_migration')"
            ).fetchone()[0] is not None:
                raise MigrationError("adoption_tracked_database：已有实际迁移账本的库不能接管。")
            _ensure_no_other_connections(connection)
            with _reference_catalog(database_url, migrations) as expected:
                tables = tuple(row[0] for row in expected.business["relations"] if row[1] == "r")
                with connection.transaction():
                    # 业务行由 SHARE 锁冻结；目录用新快照复核，不能漏掉并发新对象。
                    connection.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
                    connection.execute(sql.SQL("LOCK TABLE {} IN SHARE MODE").format(
                        sql.SQL(", ").join(sql.Identifier("public", table) for table in tables)
                    ))
                    _ensure_no_other_connections(connection)
                    audit = audit_connection(connection, expected.business)
                    schema_before = schema_catalog(connection)
                    backup_sha, source_data, verified_at = _verified_backup(
                        connection, database_url, backup_directory, tables, schema_before,
                    )
                    _ensure_no_other_connections(connection)
                    if audit.repair_required:
                        connection.execute(_REPAIR_SQL)
                    if schema_catalog(connection) != expected.business:
                        raise MigrationError("adoption_repair_mismatch：补齐未得到完整 035 结构，事务回滚。")
                    if business_digest(connection, tables) != source_data:
                        raise MigrationError("adoption_data_changed：资料摘要变化，事务回滚。")
                    connection.execute(_BASELINE_DDL)
                    manifest = [{"name": name, "checksum": checksum}
                                for name, checksum in BASELINE_MANIFEST]
                    repair_sha = (hashlib.sha256(_REPAIR_SQL.encode("utf-8")).hexdigest()
                                  if audit.repair_required else None)
                    connection.execute("""
                        INSERT INTO public.notalone_schema_baseline (
                            singleton, format_version, through_version, manifest,
                            schema_before_sha256, schema_after_sha256, repair_sha256,
                            backup_sha256, restored_data_sha256, restore_verified_at
                        ) VALUES (true, 1, 35, %s, %s, %s, %s, %s, %s, %s)
                    """, (Jsonb(manifest), audit.schema_digest, digest(expected.business), repair_sha,
                          backup_sha, source_data, verified_at))
                    evidence = {
                        "format_version": 1, "through_version": BASELINE_VERSION,
                        "manifest": manifest, "schema_before_sha256": audit.schema_digest,
                        "schema_after_sha256": digest(expected.business), "repair_sha256": repair_sha,
                        "backup_sha256": backup_sha, "restored_data_sha256": source_data,
                        "restore_verified_at": verified_at.isoformat(),
                    }
                    evidence_path = backup_directory / "verification.json"
                    descriptor = os.open(evidence_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                        json.dump(evidence, stream, ensure_ascii=False, indent=2)
                        stream.flush()
                        os.fsync(stream.fileno())
                    _ensure_no_other_connections(connection)
                    # 参考库也执行同一基线 DDL；最后比较完整目录，不猜测排除自动对象。
                    if schema_catalog(connection) != expected.managed:
                        raise MigrationError("adoption_repair_mismatch：提交前目录变化，基线与补齐回滚。")
        return AdoptionResult(True, backup_sha)
    except MigrationError:
        raise
    except BaselineError as error:
        raise MigrationError(str(error)) from None
    except (ValueError, OSError, psycopg.Error, subprocess.SubprocessError):
        raise MigrationError(
            "adoption_failed：接管未完成；请检查基线状态及保留的备份后重试。"
        ) from None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="核验或显式接管本机完整 035 旧库。")
    parser.add_argument("--migrations", type=Path, required=True)
    parser.add_argument("--adopt", action="store_true", help="已获升级授权后执行接管；默认只读核验")
    parser.add_argument("--backup-dir", type=Path, help="仓库外、空且权限为 0700 的本机备份目录")
    args = parser.parse_args(argv)
    if args.adopt and args.backup_dir is None:
        parser.error("--adopt 需要 --backup-dir。")
    database_url = os.environ.get("NOTALONE_DATABASE_URL", "")
    if not database_url.strip():
        print("未配置 NOTALONE_DATABASE_URL。", file=sys.stderr)
        return 1
    try:
        result = (adopt_legacy_database(database_url, args.migrations, args.backup_dir)
                  if args.adopt else audit_legacy_database(database_url, args.migrations))
    except MigrationError as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps({"status": "succeeded", **asdict(result)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
