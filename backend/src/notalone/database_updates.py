"""App 明确确认后的本机更新：备份、真实恢复核验、逐版本迁移与保留校验。"""

from __future__ import annotations

import argparse
from collections.abc import Callable
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import select
import stat
import subprocess
import sys
import time
from typing import Any, Iterator
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from notalone.database_adoption import (
    _BASELINE_DDL, _ensure_no_other_connections, _local_url, _owned_database,
    _run_pg, _verified_backup,
)
from notalone.database_audit import digest, schema_catalog
from notalone.database_baseline import BaselineError, baseline_offset
from notalone.database_migrations import Migration, MigrationError, _load_migrations, migrate_connection


def _safe_url(value: str) -> str:
    options = conninfo_to_dict(value)
    # 不让旧配置把服务文件、客户端配置或注入式 options 带入受管操作。
    if set(options) - {"host", "hostaddr", "port", "user", "password", "dbname", "sslmode", "connect_timeout"}:
        raise MigrationError("update_target_unsupported")
    normalized = _local_url(value)
    actual = conninfo_to_dict(normalized)
    name, host, port = actual["dbname"], actual["host"], actual["port"]
    # pg 工具会把含等号或 URI 前缀的“数据库名”再次当作连接串解析。
    if (not name or len(name.encode()) > 63 or any(character in name for character in "=\0\r\n")
            or "://" in name or "," in host or any(character in host for character in "\0\r\n")
            or not port.isdecimal() or not 1 <= int(port) <= 65535):
        raise MigrationError("update_target_unsupported")
    return normalized


def _admin_url(value: str) -> str:
    return make_conninfo(value, dbname="postgres", application_name="notalone_update")


def _identity(admin: psycopg.Connection[Any], database_url: str) -> tuple[str, bool]:
    name = conninfo_to_dict(database_url)["dbname"]
    row = admin.execute("""SELECT oid, datname, datdba, datallowconn FROM pg_catalog.pg_database
                           WHERE datname = %s""", (name,)).fetchone()
    if admin.info.server_version // 10000 != 16 or name in {"postgres", "template0", "template1"} or row is None:
        raise MigrationError("update_target_unsupported")
    system = admin.execute("SELECT system_identifier FROM pg_catalog.pg_control_system()").fetchone()[0]
    return digest([str(system), *row[:3]]), row[3]


def _history(connection: psycopg.Connection[Any], migrations: tuple[Migration, ...]) -> tuple[int, bool]:
    connection.execute("SET search_path = pg_catalog, public")
    try:
        offset = baseline_offset(connection, migrations)
    except BaselineError as error:
        raise MigrationError(str(error).split("：", 1)[0]) from None
    if connection.execute("SELECT pg_catalog.to_regclass('public.notalone_schema_migration')").fetchone()[0] is None:
        raise MigrationError("baseline_missing")
    completed = connection.execute("SELECT name, checksum FROM public.notalone_schema_migration ORDER BY name").fetchall()
    expected = [(item.name, item.checksum) for item in migrations[offset:offset + len(completed)]]
    if not completed and not offset or completed != expected:
        raise MigrationError("migration_history_mismatch")
    return offset + len(completed), bool(offset)


def inspect_database(database_url: str, directory: Path) -> dict[str, Any]:
    """目标只读；不建参考库、不恢复门禁、不创建备份。"""
    database_url = _safe_url(database_url)
    migrations = _load_migrations(directory)
    with psycopg.connect(_admin_url(database_url), autocommit=True) as admin:
        admin.execute("SET search_path = pg_catalog, public")
        fingerprint, allowed = _identity(admin, database_url)
    if not allowed:
        return {"code": "update_interrupted", "target_fingerprint": fingerprint}
    with psycopg.connect(database_url, autocommit=True) as connection:
        with connection.transaction():
            connection.execute("SET TRANSACTION READ ONLY")
            through, _ = _history(connection, migrations)
    return {"code": "ready" if through == len(migrations) else "migration_pending",
            "target_fingerprint": fingerprint, "through_version": through}


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.parent / f".checkpoint-{uuid4().hex}"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def _checkpoint(directory: Path, fingerprint: str) -> dict[str, Any] | None:
    if not directory.exists():
        return None
    if directory.is_symlink() or directory.stat().st_mode & 0o077:
        raise MigrationError("update_backup_invalid")
    if not directory.is_dir() or directory.stat().st_uid != os.getuid():
        raise MigrationError("update_backup_invalid")
    file = directory / "checkpoint.json"
    if not file.exists():
        if any(directory.iterdir()):
            raise MigrationError("update_backup_incomplete")
        return None
    try:
        descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        raise MigrationError("update_backup_invalid") from None
    with os.fdopen(descriptor, encoding="utf-8") as stream:
        metadata = os.fstat(stream.fileno())
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                or metadata.st_mode & 0o077 or metadata.st_size > 131072):
            raise MigrationError("update_backup_invalid")
        try:
            value = json.loads(stream.read(131073))
        except (ValueError, UnicodeError):
            raise MigrationError("update_backup_invalid") from None
    if not isinstance(value, dict):
        raise MigrationError("update_backup_invalid")
    if value.get("format_version") != 1 or value.get("target_fingerprint") != fingerprint:
        raise MigrationError("update_target_changed")
    if (value.get("phase") not in {"backup_verified", "migrating", "restoring", "awaiting_activation", "complete"}
            or type(value.get("connection_gate")) is not bool or value.get("restore_verified") is not True
            or any(key in value and type(value[key]) is not bool for key in ("source_gate", "activation_complete"))
            or "destination_fingerprint" in value and (not isinstance(value["destination_fingerprint"], str)
                or len(value["destination_fingerprint"]) != 64
                or any(character not in "0123456789abcdef" for character in value["destination_fingerprint"]))
            or not isinstance(value.get("columns"), dict) or not value["columns"]
            or not isinstance(value.get("applied"), list)
            or any(not isinstance(value.get(key), str) or len(value[key]) != 64
                   or any(character not in "0123456789abcdef" for character in value[key])
                   for key in ("backup_sha256", "retention_sha256"))):
        raise MigrationError("update_backup_invalid")
    for table, columns in value["columns"].items():
        if (not isinstance(table, str) or not table.replace("_", "").isalnum()
                or not isinstance(columns, list) or not columns
                or any(not isinstance(column, str) or not column.replace("_", "").isalnum() for column in columns)):
            raise MigrationError("update_backup_invalid")
    return value


def _columns(connection: psycopg.Connection[Any]) -> dict[str, list[str]]:
    rows = connection.execute("""SELECT c.relname, a.attname FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
        WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
          AND c.relname NOT IN ('notalone_schema_migration','notalone_schema_baseline')
        ORDER BY c.relname, a.attnum""").fetchall()
    result: dict[str, list[str]] = {}
    for table, column in rows:
        result.setdefault(table, []).append(column)
    if not result:
        raise MigrationError("schema_incomplete")
    return result


def _retention_digest(connection: psycopg.Connection[Any], columns: dict[str, list[str]]) -> str:
    """只投影更新前原有列；新增可空列不改变保留证据，旧字段逐字节参与摘要。"""
    connection.execute("SET LOCAL TIME ZONE 'UTC'")
    result = hashlib.sha256()
    for table, names in sorted(columns.items()):
        result.update(table.encode() + b"\0")
        query = sql.SQL('SELECT to_jsonb(t)::text FROM (SELECT {} FROM public.{}) t '
                        'ORDER BY to_jsonb(t)::text COLLATE "C"').format(
                            sql.SQL(",").join(map(sql.Identifier, names)), sql.Identifier(table))
        with connection.cursor(name=f"retain_{table}") as cursor:
            cursor.execute(query)
            for (row,) in cursor:
                body = row.encode()
                result.update(len(body).to_bytes(8, "big"))
                result.update(body)
    return result.hexdigest()


def _validate_catalog(connection: psycopg.Connection[Any], database_url: str,
                      migrations: tuple[Migration, ...], through: int, baseline: bool) -> None:
    # 先以正式历史重建空参考结构，再读业务内容；未知函数／额外结构不可进入恢复执行。
    with _owned_database(database_url, "update_reference", synthetic=True) as reference_url:
        with psycopg.connect(reference_url, autocommit=True) as reference:
            reference.execute("SET search_path = pg_catalog, public")
            if not baseline:
                reference.execute("""CREATE TABLE public.notalone_schema_migration (
                    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())""")
            for index, migration in enumerate(migrations[:through], 1):
                with reference.transaction():
                    reference.execute(migration.body)
                    if baseline and index == 35:
                        reference.execute(_BASELINE_DDL)
            if schema_catalog(connection) != schema_catalog(reference):
                raise MigrationError("update_schema_mismatch")


def _lock(connection: psycopg.Connection[Any]) -> None:
    connection.execute("SET search_path = pg_catalog, public")
    connection.execute("SET lock_timeout = '10s'")
    connection.execute("SET statement_timeout = '120s'")
    deadline = time.monotonic() + 5
    while not connection.execute("SELECT pg_catalog.pg_try_advisory_lock(1852798049, 1)").fetchone()[0]:
        if time.monotonic() >= deadline:
            raise MigrationError("migration_busy")
        time.sleep(0.1)
    _ensure_no_other_connections(connection)


def _allow(admin: psycopg.Connection[Any], database_url: str, allowed: bool) -> None:
    admin.execute(sql.SQL("ALTER DATABASE {} ALLOW_CONNECTIONS {}").format(
        sql.Identifier(conninfo_to_dict(database_url)["dbname"]), sql.Literal(allowed)))


@contextmanager
def _update_connection(database_url: str, fingerprint: str, checkpoint: dict[str, Any] | None
                       ) -> Iterator[tuple[psycopg.Connection[Any], psycopg.Connection[Any]]]:
    with psycopg.connect(_admin_url(database_url), autocommit=True) as admin:
        admin.execute("SET search_path = pg_catalog, public")
        actual, allowed = _identity(admin, database_url)
        if actual != fingerprint:
            raise MigrationError("update_target_changed")
        if not allowed and (not checkpoint or not checkpoint.get("connection_gate")):
            raise MigrationError("update_recovery_required")
        if not allowed:
            # 仅本操作已记录、同指纹目标允许续接；不终止任何陌生会话。
            _allow(admin, database_url, True)
        try:
            connection = psycopg.connect(database_url, autocommit=True)
        finally:
            if not allowed:
                _allow(admin, database_url, False)
        with connection:
            _lock(connection)
            yield connection, admin


def _backup(connection: psycopg.Connection[Any], database_url: str, directory: Path,
            migrations: tuple[Migration, ...], fingerprint: str) -> dict[str, Any]:
    through, baseline = _history(connection, migrations)
    _validate_catalog(connection, database_url, migrations, through, baseline)
    columns = _columns(connection)
    estimate = connection.execute("SELECT pg_catalog.pg_database_size(pg_catalog.current_database())").fetchone()[0]
    directory.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # 同服务器临时恢复也需要空间；宁可保留原目标并明确拒绝，不在半途耗尽磁盘。
    if shutil.disk_usage(directory.parent).free < max(estimate * 3, 64 * 1024 * 1024):
        raise MigrationError("update_disk_space_insufficient")
    with connection.transaction():
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        connection.execute(sql.SQL("LOCK TABLE {} IN SHARE MODE").format(
            sql.SQL(",").join(sql.Identifier("public", table) for table in columns)))
        _ensure_no_other_connections(connection)
        before = _retention_digest(connection, columns)
        catalog = schema_catalog(connection)
        tables = tuple(row[0] for row in catalog["relations"] if row[1] == "r")
        backup_sha, _, verified_at = _verified_backup(connection, database_url, directory, tables, catalog)
        _ensure_no_other_connections(connection)
        if schema_catalog(connection) != catalog or _retention_digest(connection, columns) != before:
            raise MigrationError("update_source_changed")
    value = {"format_version": 1, "target_fingerprint": fingerprint, "phase": "backup_verified",
             "backup_sha256": backup_sha, "restore_verified": True,
             "verified_at": verified_at.isoformat(), "columns": columns, "retention_sha256": before,
             "connection_gate": False, "through_version": through, "applied": []}
    _atomic_json(directory / "checkpoint.json", value)
    return value


def _verify_archive(directory: Path, checkpoint: dict[str, Any]) -> None:
    archive = directory / "database.dump"
    try:
        descriptor = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            metadata = os.fstat(stream.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
                raise MigrationError("update_backup_invalid")
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
    except OSError:
        raise MigrationError("update_backup_invalid") from None
    if actual != checkpoint.get("backup_sha256") or not checkpoint.get("restore_verified"):
        raise MigrationError("update_backup_invalid")


def update_database(database_url: str, migrations_directory: Path, backup_directory: Path,
                    expected_target: str) -> dict[str, Any]:
    database_url = _safe_url(database_url)
    migrations = _load_migrations(migrations_directory)
    checkpoint = _checkpoint(backup_directory, expected_target)
    with _update_connection(database_url, expected_target, checkpoint) as (connection, admin):
        if checkpoint is None:
            checkpoint = _backup(connection, database_url, backup_directory, migrations, expected_target)
        _finish_update(connection, admin, database_url, migrations_directory, backup_directory, checkpoint)
    return {"code": "ready", "backup_verified": True}


def _finish_update(connection: psycopg.Connection[Any], admin: psycopg.Connection[Any],
                   database_url: str, migrations_directory: Path, backup_directory: Path,
                   checkpoint: dict[str, Any]) -> None:
    _verify_archive(backup_directory, checkpoint)
    through, _ = _history(connection, _load_migrations(migrations_directory))
    with connection.transaction():
        if _retention_digest(connection, checkpoint["columns"]) != checkpoint["retention_sha256"]:
            raise MigrationError("update_source_changed")
    _ensure_no_other_connections(connection)
    checkpoint.update(phase="migrating", connection_gate=True, through_version=through)
    _atomic_json(backup_directory / "checkpoint.json", checkpoint)
    _allow(admin, database_url, False)
    _ensure_no_other_connections(connection)

    def committed(name: str) -> None:
        checkpoint["applied"].append(name)
        checkpoint["through_version"] = int(name[:3])
        _atomic_json(backup_directory / "checkpoint.json", checkpoint)

    migrate_connection(connection, migrations_directory, committed)
    with connection.transaction():
        if _retention_digest(connection, checkpoint["columns"]) != checkpoint["retention_sha256"]:
            raise MigrationError("update_retention_mismatch")
    checkpoint.update(phase="complete", connection_gate=True,
                      completed_at=datetime.now(timezone.utc).isoformat())
    _atomic_json(backup_directory / "checkpoint.json", checkpoint)
    _allow(admin, database_url, True)
    checkpoint["connection_gate"] = False
    _atomic_json(backup_directory / "checkpoint.json", checkpoint)

def copy_and_update_database(source_url: str, destination_url: str, migrations_directory: Path,
                             backup_directory: Path, expected_target: str,
                             activate: Callable[[], None] | None = None) -> dict[str, Any]:
    """外置库只读复制到尚未对业务开放的新目标；成功也不改写来源库。"""
    source_url, destination_url = _safe_url(source_url), _safe_url(destination_url)
    migrations = _load_migrations(migrations_directory)
    checkpoint = _checkpoint(backup_directory, expected_target)
    source_resume = {"connection_gate": bool(checkpoint and checkpoint.get("source_gate"))}
    with _update_connection(source_url, expected_target, source_resume) as (source, source_admin):
        if source_resume["connection_gate"]:
            _allow(source_admin, source_url, True)
        if checkpoint is None:
            checkpoint = _backup(source, source_url, backup_directory, migrations, expected_target)
        _verify_archive(backup_directory, checkpoint)
        with psycopg.connect(_admin_url(destination_url), autocommit=True) as admin:
            destination_fingerprint, _ = _identity(admin, destination_url)
        if destination_fingerprint == expected_target:
            raise MigrationError("update_target_changed")
        if checkpoint.get("destination_fingerprint", destination_fingerprint) != destination_fingerprint:
            raise MigrationError("update_target_changed")
        checkpoint["destination_fingerprint"] = destination_fingerprint
        _atomic_json(backup_directory / "checkpoint.json", checkpoint)
        # 恢复期间冻结来源业务行，且新目标尚未开放后台。任何陌生连接均拒绝切换。
        with source.transaction():
            source.execute(sql.SQL("LOCK TABLE {} IN SHARE MODE").format(
                sql.SQL(",").join(sql.Identifier("public", table) for table in checkpoint["columns"])))
            _ensure_no_other_connections(source)
            if _retention_digest(source, checkpoint["columns"]) != checkpoint["retention_sha256"]:
                raise MigrationError("update_source_changed")
            with _update_connection(destination_url, destination_fingerprint, checkpoint) as (destination, _):
                destination.execute("SET search_path = pg_catalog, public")
                empty = not destination.execute("""SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')""").fetchone()[0]
            if empty:
                checkpoint["phase"] = "restoring"
                _atomic_json(backup_directory / "checkpoint.json", checkpoint)
                _run_pg("pg_restore", destination_url, ["--no-owner", "--no-acl", "--single-transaction",
                                                       "--exit-on-error", str(backup_directory / "database.dump")])
            with _update_connection(destination_url, destination_fingerprint, checkpoint) as (destination, admin):
                through, baseline = _history(destination, migrations)
                _validate_catalog(destination, destination_url, migrations, through, baseline)
                _finish_update(destination, admin, destination_url, migrations_directory, backup_directory, checkpoint)
            _ensure_no_other_connections(source)
            if _retention_digest(source, checkpoint["columns"]) != checkpoint["retention_sha256"]:
                raise MigrationError("update_source_changed")
            checkpoint.update(phase="awaiting_activation", source_gate=True, activation_complete=False)
            _atomic_json(backup_directory / "checkpoint.json", checkpoint)
            _allow(source_admin, source_url, False)
            try:
                _ensure_no_other_connections(source)
                if activate:
                    activate()
                _ensure_no_other_connections(source)
                checkpoint.update(phase="complete", activation_complete=True)
                _atomic_json(backup_directory / "checkpoint.json", checkpoint)
            finally:
                # 来源结构从未升级，解除本次短时冻结不会让旧程序写入新结构。
                _allow(source_admin, source_url, True)
                checkpoint["source_gate"] = False
                _atomic_json(backup_directory / "checkpoint.json", checkpoint)
    return {"code": "ready", "backup_verified": True}


def release_completed_source_gate(database_url: str, backup_directory: Path, expected_target: str) -> dict[str, Any]:
    """只解除已完成复制操作留下的来源连接门；不恢复数据、不迁移来源。"""
    database_url = _safe_url(database_url)
    checkpoint = _checkpoint(backup_directory, expected_target)
    if (not checkpoint or checkpoint.get("activation_complete") is not True
            or not isinstance(checkpoint.get("destination_fingerprint"), str)):
        raise MigrationError("update_recovery_required")
    _verify_archive(backup_directory, checkpoint)
    with psycopg.connect(_admin_url(database_url), autocommit=True) as admin:
        actual, allowed = _identity(admin, database_url)
        if actual != expected_target:
            raise MigrationError("update_target_changed")
        if not allowed:
            if checkpoint.get("source_gate") is not True:
                raise MigrationError("update_recovery_required")
            _allow(admin, database_url, True)
    checkpoint["source_gate"] = False
    _atomic_json(backup_directory / "checkpoint.json", checkpoint)
    return {"code": "ready"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="受控本机资料更新；不接收命令或数据库凭据参数。")
    parser.add_argument("--migrations", type=Path, required=True)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--inspect", action="store_true")
    action.add_argument("--update", action="store_true")
    action.add_argument("--copy-update", action="store_true")
    action.add_argument("--release-source-gate", action="store_true")
    parser.add_argument("--backup-dir", type=Path)
    parser.add_argument("--expected-target")
    parser.add_argument("--parent-pid", type=int)
    parser.add_argument("--lifetime-lock")
    parser.add_argument("--destination-env-file", type=Path)
    parser.add_argument("--activation-fd", type=int, choices=(3,))
    args = parser.parse_args(argv)
    from notalone.parent_lifetime import ParentLifetime
    try:
        with ParentLifetime(args.parent_pid, args.lifetime_lock, exit_timeout=8) as lifetime:
            if args.parent_pid:
                def cancel(*_: object) -> None:
                    raise InterruptedError("update_cancelled")
                signal.signal(signal.SIGTERM, cancel)
                signal.signal(signal.SIGINT, cancel)
                lifetime.on_exit(lambda: os.kill(os.getpid(), signal.SIGTERM))
            return _run_command(args)
    except InterruptedError:
        print(json.dumps({"code": "update_interrupted"}))
        return 1
    except (OSError, ValueError):
        print(json.dumps({"code": "update_failed"}))
        return 1


def _run_command(args: argparse.Namespace) -> int:
    try:
        _load_update_environment()
        database_url = os.environ.get("NOTALONE_DATABASE_URL", "")
        if args.inspect:
            result = inspect_database(database_url, args.migrations)
        elif args.release_source_gate:
            if args.backup_dir is None or not args.expected_target:
                raise MigrationError("update_recovery_required")
            result = release_completed_source_gate(database_url, args.backup_dir, args.expected_target)
        else:
            if args.backup_dir is None or not args.expected_target:
                raise ValueError("更新需要已核验目标与本机备份位置。")
            def activate() -> None:
                if args.destination_env_file:
                    _copy_settings(args.destination_env_file)
                if args.activation_fd is not None:
                    print(json.dumps({"code": "activation_ready"}), flush=True)
                    if not select.select([args.activation_fd], [], [], 30)[0]:
                        raise InterruptedError("update_interrupted")
                    if os.read(args.activation_fd, 32) != b"activate\n":
                        raise InterruptedError("update_interrupted")

            result = (copy_and_update_database(database_url, os.environ.get("NOTALONE_UPDATE_DESTINATION_URL", ""),
                                               args.migrations, args.backup_dir, args.expected_target, activate)
                      if args.copy_update else update_database(database_url, args.migrations, args.backup_dir, args.expected_target))
    except InterruptedError:
        raise
    except MigrationError as error:
        print(json.dumps({"code": str(error).split("：", 1)[0]}, ensure_ascii=False))
        return 1
    except (OSError, ValueError, psycopg.Error, subprocess.SubprocessError):
        print(json.dumps({"code": "update_failed"}))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


def _load_update_environment() -> None:
    from notalone.runtime_config import _parse_line
    if os.environ.get("NOTALONE_DISABLE_DOTENV") == "1":
        return
    configured = os.environ.get("NOTALONE_ENV_FILE", "")
    if not configured or not Path(configured).is_absolute():
        raise MigrationError("update_configuration_invalid")
    descriptor = os.open(configured, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, encoding="utf-8") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_size > 1048576:
            raise MigrationError("update_configuration_invalid")
        allowed = {"NOTALONE_DATABASE_URL", "NOTALONE_OWNER_ID", "NOTALONE_DEEPSEEK_API_KEY",
                   "NOTALONE_DEEPSEEK_MODEL", "NOTALONE_DEEPSEEK_BASE_URL",
                   "PGHOST", "PGHOSTADDR", "PGPORT", "PGUSER", "PGPASSWORD"}
        for line in stream.read(1048577).splitlines():
            key, value = _parse_line(line)
            if key in allowed and key not in os.environ:
                os.environ[key] = value


def _copy_settings(destination: Path) -> None:
    from notalone.runtime_config import _parse_line
    # 新环境只延续明确的本人／模型设置，不搬运开发命令、追踪、隐含出站或授权变量。
    keys = {"NOTALONE_OWNER_ID", "NOTALONE_DEEPSEEK_API_KEY", "NOTALONE_DEEPSEEK_MODEL",
            "NOTALONE_DEEPSEEK_BASE_URL"}
    descriptor = os.open(destination, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, encoding="utf-8") as stream:
        metadata = os.fstat(stream.fileno())
        if metadata.st_mode & 0o077 or metadata.st_size > 65536:
            raise MigrationError("update_configuration_invalid")
        existing = stream.read()
    retained = [line for line in existing.splitlines() if _parse_line(line)[0] not in keys]
    for key in sorted(keys):
        if key in os.environ:
            value = os.environ[key]
            if "\n" in value or "\r" in value or "\0" in value:
                raise MigrationError("update_configuration_invalid")
            retained.append(f"{key}={value}")
    temporary = destination.parent / f".settings-{uuid4().hex}"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write("\n".join(retained) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
