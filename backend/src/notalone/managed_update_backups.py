"""明确删除时清除本App可恢复正文的完整更新快照。"""

from contextlib import ExitStack
import json
import os
from pathlib import Path
import re
import stat
from typing import Any

import psycopg
from psycopg.rows import tuple_row


class ManagedUpdateBackupError(RuntimeError):
    """归属或清理未确认；不能宣告业务资料已删除。"""

    code = "update_backup_cleanup_required"


_DIRECTORY = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z")
_HASH = re.compile(r"[a-f0-9]{64}\Z")
_FILES = {"checkpoint.json", "database.dump", "legacy-launch.json", "retired-launch.json", "verification.json"}


def _private(metadata: os.stat_result, *, directory: bool = False) -> None:
    valid = stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)
    if not valid or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
        raise ManagedUpdateBackupError("请查看本机更新备份恢复说明，核验后重试删除。")


def _read_json(directory: int, name: str, limit: int) -> dict[str, Any]:
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    with os.fdopen(descriptor, "rb") as stream:
        metadata = os.fstat(stream.fileno())
        _private(metadata)
        if metadata.st_size > limit:
            raise ManagedUpdateBackupError("更新备份凭证需要恢复核验。")
        value = json.loads(stream.read(limit + 1))
        if not isinstance(value, dict):
            raise ManagedUpdateBackupError("更新备份凭证需要恢复核验。")
        return value


def erase_managed_update_backups(connection: psycopg.Connection[Any]) -> int:
    """先完整核验归属，再删除归档名；不跟随链接，不清理外部原库或未知文件。

    Main为本次后台固定传入userData。无该装配时不猜测用户目录。
    数据库事务锁与更新的会话锁互斥；清理失败时业务删除必须回滚。
    """
    configured = os.environ.get("NOTALONE_MANAGED_USER_DATA")
    if not configured:
        return 0
    try:
        root = Path(configured)
        if not root.is_absolute() or root.is_symlink():
            raise ManagedUpdateBackupError("更新备份位置需要恢复核验。")
        metadata = root.stat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
            raise ManagedUpdateBackupError("更新备份位置需要恢复核验。")
        updates = root / "updates"
        if not updates.exists() and not updates.is_symlink():
            return 0
        with ExitStack() as handles:
            def directory(selected: str | Path, parent: int | None = None) -> int:
                descriptor = os.open(selected, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                handles.callback(os.close, descriptor)
                _private(os.fstat(descriptor), directory=True)
                return descriptor

            updates_fd = directory(updates)
            names = os.listdir(updates_fd)
            if len(names) > 1024:
                raise ManagedUpdateBackupError("更新备份目录需要恢复核验。")
            folders = []
            for name in names:
                if name == "恢复说明.txt":
                    _private(os.stat(name, dir_fd=updates_fd, follow_symlinks=False))
                elif _DIRECTORY.fullmatch(name):
                    folders.append(name)
                else:
                    raise ManagedUpdateBackupError("存在未知或未完成的备份，请查看恢复说明。")
            if not folders:
                return 0
            managed_fd = directory(root / "managed")
            state = _read_json(managed_fd, "state.json", 4096)
            if state.get("formatVersion") != 1 or state.get("bootstrapComplete") is not True:
                raise ManagedUpdateBackupError("请先恢复未完成的资料接续，再重试删除。")
            with connection.cursor(row_factory=tuple_row) as cursor:
                cursor.execute("SELECT pg_catalog.pg_try_advisory_xact_lock(1852798049, 1)")
                if not cursor.fetchone()[0]:
                    raise ManagedUpdateBackupError("资料更新尚未结束，请稍后重试删除。")
                cursor.execute("""SELECT system_identifier, d.oid, d.datname, d.datdba
                    FROM pg_catalog.pg_control_system(), pg_catalog.pg_database AS d
                    WHERE d.datname=pg_catalog.current_database()""")
                system, oid, name, owner = cursor.fetchone()
            from notalone.database_audit import digest
            fingerprint = digest([str(system), oid, name, owner])
            archives = []
            for name in folders:
                backup_fd = directory(name, updates_fd)
                files = os.listdir(backup_fd)
                if any(file not in _FILES for file in files):
                    raise ManagedUpdateBackupError("备份中有未知文件，请查看恢复说明。")
                for file in files:
                    _private(os.stat(file, dir_fd=backup_fd, follow_symlinks=False))
                checkpoint = _read_json(backup_fd, "checkpoint.json", 131072)
                target = checkpoint.get("destination_fingerprint", checkpoint.get("target_fingerprint"))
                if (checkpoint.get("format_version") != 1 or not isinstance(target, str) or not _HASH.fullmatch(target)
                        or target != fingerprint or checkpoint.get("phase") != "complete"
                        or checkpoint.get("restore_verified") is not True or checkpoint.get("connection_gate") is not False
                        or checkpoint.get("source_gate", False) is not False
                        or "destination_fingerprint" in checkpoint and checkpoint.get("activation_complete") is not True):
                    raise ManagedUpdateBackupError("备份不属于当前已完成的资料更新，请查看恢复说明。")
                if "database.dump" in files:
                    archives.append(backup_fd)
            # 归属预检全部通过后才动任何文件；中途失败不提交数据库删除结果。
            for backup_fd in archives:
                os.unlink("database.dump", dir_fd=backup_fd)
                os.fsync(backup_fd)
            if any("database.dump" in os.listdir(backup_fd) for backup_fd in archives):
                raise ManagedUpdateBackupError("更新备份清理尚未确认，请重试原删除。")
            return len(archives)
    except ManagedUpdateBackupError:
        raise
    except (OSError, ValueError, TypeError, psycopg.Error):
        raise ManagedUpdateBackupError("本机更新备份清理未确认；请查看恢复说明后重试删除。") from None
