"""已发布 Skill 的受控目录、不可变快照及可重试删除。"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from threading import Lock
from typing import Any, Mapping
from uuid import UUID

from psycopg.rows import dict_row

from notalone.skills import LocalSkillPackageReader, SkillPackageValidator


logger = logging.getLogger(__name__)

_MAX_FILE_FAILURES = 512
_FILE_FAILURES: dict[tuple[UUID, str, UUID | None], "SkillFileFailure"] = {}
_FILE_FAILURES_LOCK = Lock()


class SkillFileError(RuntimeError):
    """文件不可用；不向调用方暴露实际路径或正文。"""


@dataclass(frozen=True, slots=True)
class SkillFileFailure:
    """可查询的文件同步/清理失败；不含路径、正文或联系资料。"""

    operation: str
    code: str
    skill_id: UUID | None
    occurred_at: datetime

    def as_payload(self) -> dict[str, Any]:
        return {
            "operation": self.operation,
            "code": self.code,
            "skill_id": str(self.skill_id) if self.skill_id is not None else None,
            "occurred_at": self.occurred_at.isoformat(),
        }


def skill_file_failure_code(error: BaseException) -> str:
    """把文件/权限/校验失败压成稳定脱敏错误码，不回传原始信息。"""
    if isinstance(error, PermissionError):
        return "permission_denied"
    if isinstance(error, OSError):
        return "filesystem_error"
    if isinstance(error, SkillFileError):
        return "file_unavailable"
    return "unknown_error"


def _store_file_failure(
    owner_id: UUID, *, operation: str, code: str, skill_id: UUID | None = None,
) -> None:
    with _FILE_FAILURES_LOCK:
        _FILE_FAILURES[(owner_id, operation, skill_id)] = SkillFileFailure(
            operation=operation, code=code, skill_id=skill_id,
            occurred_at=datetime.now(timezone.utc),
        )
        overflow = len(_FILE_FAILURES) - _MAX_FILE_FAILURES
        for key in list(_FILE_FAILURES)[:max(overflow, 0)]:
            _FILE_FAILURES.pop(key, None)


def record_skill_file_failure(owner_id: UUID, *, operation: str, code: str) -> None:
    """记录目录发现等外部已归类的脱敏失败码，供健康状态查询与重试恢复。"""
    if not isinstance(owner_id, UUID):
        raise TypeError("owner_id 必须是 UUID。")
    _store_file_failure(owner_id, operation=operation, code=code)
    logger.warning("skill_file_sync_failed operation=%s code=%s", operation, code)


def clear_skill_file_failure(owner_id: UUID, *, operation: str) -> None:
    if not isinstance(owner_id, UUID):
        raise TypeError("owner_id 必须是 UUID。")
    with _FILE_FAILURES_LOCK:
        _FILE_FAILURES.pop((owner_id, operation, None), None)


def _record_file_failure(
    owner_id: UUID, *, operation: str, error: BaseException, skill_id: UUID | None = None,
) -> None:
    code = skill_file_failure_code(error)
    _store_file_failure(owner_id, operation=operation, code=code, skill_id=skill_id)
    logger.warning("skill_file_sync_failed operation=%s code=%s", operation, code)


def _clear_file_failure(
    owner_id: UUID, *, operation: str, skill_id: UUID | None = None,
) -> None:
    with _FILE_FAILURES_LOCK:
        _FILE_FAILURES.pop((owner_id, operation, skill_id), None)


def read_skill_file_failures(owner_id: UUID) -> tuple[SkillFileFailure, ...]:
    """返回该 owner 进程内最近的文件同步失败；状态查询用，可重试恢复。"""
    if not isinstance(owner_id, UUID):
        raise TypeError("owner_id 必须是 UUID。")
    with _FILE_FAILURES_LOCK:
        values = [
            item for (owner, _operation, _skill), item in _FILE_FAILURES.items()
            if owner == owner_id
        ]
    return tuple(sorted(values, key=lambda item: item.occurred_at))


def _owner_from_relative(relative_path: Any) -> UUID | None:
    """从受控相对路径解析 owner；仅用于状态归集，不接受任意真实路径。"""
    if not isinstance(relative_path, str):
        return None
    parts = PurePosixPath(relative_path).parts
    if not parts or len(parts) > 6:
        return None
    index = 1 if parts[0] in (".versions", ".staging") else 0
    if len(parts) <= index:
        return None
    try:
        return UUID(parts[index])
    except (TypeError, ValueError):
        return None


def _skill_id_from_relative(relative_path: Any) -> UUID | None:
    if not isinstance(relative_path, str):
        return None
    parts = PurePosixPath(relative_path).parts
    if len(parts) < 3 or parts[0] not in (".versions", ".staging"):
        return None
    try:
        return UUID(parts[2])
    except (TypeError, ValueError):
        return None


def _cleanup_skill_ids(connection: Any, rows: list[Mapping[str, Any]]) -> dict[str, UUID]:
    """一次性解析清理队列项的技能身份，供失败归因与成功清障复用。

    受控路径自带技能身份时直接解析；工作目录 `<owner>/<name>` 只在这里
    用一次库查询补齐，循环内与异常处理路径不再查库。
    """

    resolved: dict[str, UUID] = {}
    workdir_names: dict[UUID, set[str]] = {}
    for row in rows:
        relative_path = row.get("relative_path")
        skill_id = _skill_id_from_relative(relative_path)
        if skill_id is not None:
            resolved[relative_path] = skill_id
            continue
        owner = _owner_from_relative(relative_path)
        if owner is None or not isinstance(relative_path, str):
            continue
        parts = PurePosixPath(relative_path).parts
        if len(parts) != 2:
            continue
        workdir_names.setdefault(owner, set()).add(parts[1])
    if not workdir_names:
        return resolved
    with connection.cursor(row_factory=dict_row) as cursor:
        rows_by_owner = cursor.execute(
            "SELECT id,owner_id,name FROM public.reply_skill WHERE owner_id = ANY(%s)",
            (list(workdir_names),),
        ).fetchall()
    for row in rows_by_owner:
        owner_id = row["owner_id"]
        name = row["name"]
        if name in workdir_names.get(owner_id, ()):
            resolved[f"{owner_id}/{name}"] = row["id"]
    return resolved


def skill_file_health(connection: Any, owner_id: UUID) -> dict[str, Any]:
    """可查询的目录文件健康状态：只含计数、固定错误码与不可识别 ID。"""
    if not isinstance(owner_id, UUID):
        raise TypeError("owner_id 必须是 UUID。")
    relation = connection.execute(
        "SELECT to_regclass('public.reply_skill_file_cleanup') AS relation"
    ).fetchone()
    if relation is None or (relation["relation"] if isinstance(relation, dict) else relation[0]) is None:
        return {
            "state": "ok", "pending_working_copies": 0,
            "pending_cleanup_files": 0, "failures": [],
        }
    with connection.cursor(row_factory=dict_row) as cursor:
        working_copies = cursor.execute(
            "SELECT count(*) AS total FROM public.reply_skill_working_copy AS job "
            "JOIN public.reply_skill AS skill ON skill.id=job.skill_id "
            "WHERE skill.owner_id=%s",
            (owner_id,),
        ).fetchone()["total"]
        cleanups = cursor.execute(
            "SELECT count(*) AS total FROM public.reply_skill_file_cleanup "
            "WHERE relative_path=%s OR starts_with(relative_path,%s) "
            "OR starts_with(relative_path,%s) OR starts_with(relative_path,%s)",
            (str(owner_id), f"{owner_id}/", f".versions/{owner_id}/", f".staging/{owner_id}/"),
        ).fetchone()["total"]
    failures = [item.as_payload() for item in read_skill_file_failures(owner_id)]
    pending_working_copies = int(working_copies or 0)
    pending_cleanup_files = int(cleanups or 0)
    degraded = bool(pending_working_copies or pending_cleanup_files or failures)
    return {
        "state": "degraded" if degraded else "ok",
        "pending_working_copies": pending_working_copies,
        "pending_cleanup_files": pending_cleanup_files,
        "failures": failures,
    }


def skills_root() -> Path:
    try:
        root = Path(os.environ.get("NOTALONE_SKILLS_DIR", "~/.notalone/skills")).expanduser().absolute()
        # macOS 的 /var、/tmp 是系统别名；根本身和根内各级仍拒绝符号链接。
        return root.parent.resolve() / root.name
    except (OSError, RuntimeError, ValueError):
        raise SkillFileError("Skill 根目录不可用。") from None


def owner_directory(owner_id: UUID) -> Path:
    return skills_root() / str(UUID(str(owner_id)))


def working_directory(owner_id: UUID, name: str) -> Path:
    _validate_name(name)
    return owner_directory(owner_id) / name


def serialize_skill_document(name: str, description: str, content: str) -> bytes:
    return ("---\n" + f"name: {name}\n" +
            f"description: {json.dumps(description, ensure_ascii=False)}\n---\n\n" + content).encode("utf-8")


def _validate_name(name: str) -> None:
    import re
    if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        raise SkillFileError("Skill 文件不可用。")


def _validate_relative_path(relative: str) -> None:
    """拒绝空段、`.`/`..`、绝对路径、反斜杠与重复斜杠；末段同样受约束。"""
    if not isinstance(relative, str):
        raise SkillFileError("Skill 文件不可用。")
    parts = PurePosixPath(relative).parts
    if (not parts or relative.startswith("/") or "\\" in relative or
            any(part in (".", "..", "") for part in parts) or "//" in relative):
        raise SkillFileError("Skill 文件不可用。")


def _checked_path(relative: str) -> Path:
    _validate_relative_path(relative)
    parts = PurePosixPath(relative).parts
    root = skills_root()
    for path in (root, *root.parents):
        if path.is_symlink():
            raise SkillFileError("Skill 文件不可用。")
    target = root
    for part in parts:
        target /= part
        if target.is_symlink():
            raise SkillFileError("Skill 文件不可用。")
    return target


def _snapshot_relative(owner_id: UUID, skill_id: UUID, version_id: UUID, name: str) -> str:
    _validate_name(name)
    return f".versions/{owner_id}/{skill_id}/{version_id}/{name}"


def write_version_package(*, owner_id: UUID, skill_id: UUID, version_id: UUID, package: Any) -> tuple[str, str]:
    """先写不可扫描暂存，再原子放入版本快照；数据库成功前无工作副本。"""
    relative = _snapshot_relative(owner_id, skill_id, version_id, package.name)
    target = _checked_path(relative)
    document = serialize_skill_document(package.name, package.description, package.content)
    digest = hashlib.sha256(document).hexdigest()
    staging_root = _checked_path(f".staging/{owner_id}/{skill_id}")
    try:
        staging_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = Path(tempfile.mkdtemp(prefix="publish-", dir=staging_root))
        staged_package = temporary / package.name
        staged_package.mkdir(mode=0o700)
        (staged_package / "SKILL.md").write_bytes(document)
        for resource in package.resources:
            resource_target = staged_package / resource.relative_path
            resource_target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            resource_target.write_bytes(resource.content)
        validated = SkillPackageValidator().validate(LocalSkillPackageReader().read(staged_package))
        if validated.content_sha256 != package.content_sha256:
            raise SkillFileError("Skill 文件校验失败。")
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if target.exists():
            existing = LocalSkillPackageReader().read(target)
            if existing.skill_document != document or {r.relative_path: r.content for r in existing.resources} != {r.relative_path: r.content for r in package.resources}:
                raise SkillFileError("Skill 文件校验失败。")
        else:
            os.replace(staged_package, target)
        from notalone.persistence.skill_manifest import write_package_manifest
        write_package_manifest(relative + "/SKILL.md", package)
        return relative + "/SKILL.md", digest
    except (OSError, ValueError):
        raise SkillFileError("Skill 文件写入失败。") from None
    finally:
        if "temporary" in locals():
            shutil.rmtree(temporary, ignore_errors=True)


def _version_row(connection: Any, version_id: UUID) -> dict:
    with connection.cursor(row_factory=dict_row) as cursor:
        row = cursor.execute(
            "SELECT version.*,skill.name,skill.owner_id,skill.status AS skill_status FROM public.reply_skill_version AS version "
            "JOIN public.reply_skill AS skill ON skill.id=version.skill_id WHERE version.id=%s", (version_id,)).fetchone()
    if row is None or row["status"] != "active" or row["skill_status"] == "deleted":
        raise SkillFileError("Skill 文件不可用。")
    return row


def _read_document(row: dict) -> bytes:
    expected = _snapshot_relative(row["owner_id"], row["skill_id"], row["id"], row["name"]) + "/SKILL.md"
    if row["content_path"] != expected:
        raise SkillFileError("Skill 文件不可用。")
    try:
        data = LocalSkillPackageReader._read_file(_checked_path(expected).parent, "SKILL.md", 1024 * 1024)
    except (OSError, ValueError):
        raise SkillFileError("Skill 文件不可用。") from None
    if hashlib.sha256(data).hexdigest() != row["document_sha256"]:
        raise SkillFileError("Skill 文件校验失败。")
    return data


def read_version_content(connection: Any, version_id: UUID) -> str:
    row = _version_row(connection, version_id)
    try:
        _, _, content = SkillPackageValidator._parse_skill_document(_read_document(row), package_name=row["name"])
    except ValueError:
        raise SkillFileError("Skill 文件不可用。") from None
    if hashlib.sha256(content.encode("utf-8")).hexdigest() != row["content_sha256"]:
        raise SkillFileError("Skill 文件校验失败。")
    return content


def read_resource_content(connection: Any, version_id: UUID, relative_path: str) -> bytes:
    row = _version_row(connection, version_id)
    from notalone.persistence.skill_manifest import read_package_manifest
    manifest = read_package_manifest(connection, version_id)
    resource = next((item for item in manifest["resources"] if item["relative_path"] == relative_path), None)
    if resource is None:
        raise SkillFileError("Skill 资源不可用。")
    expected = _snapshot_relative(row["owner_id"], row["skill_id"], version_id, row["name"]) + "/" + relative_path
    try:
        path = _checked_path(expected)
        data = LocalSkillPackageReader._read_file(path.parent, path.name, 1024 * 1024)
    except (OSError, ValueError):
        raise SkillFileError("Skill 资源不可用。") from None
    if len(data) != resource["byte_size"] or hashlib.sha256(data).hexdigest() != resource["content_sha256"]:
        raise SkillFileError("Skill 资源校验失败。")
    return data


def version_content_available(connection: Any, version_id: UUID) -> bool:
    try:
        from notalone.persistence.skill_manifest import read_package_manifest
        read_package_manifest(connection, version_id)
        read_version_content(connection, version_id)
        return True
    except SkillFileError:
        return False


def queue_working_copy(connection: Any, skill_id: UUID, version_id: UUID) -> None:
    connection.execute("INSERT INTO public.reply_skill_working_copy(skill_id,version_id) VALUES(%s,%s) ON CONFLICT(skill_id) DO UPDATE SET version_id=excluded.version_id", (skill_id, version_id))


def synchronize_working_copies(connection: Any, *, owner_id: UUID | None = None) -> int:
    """只消费先前已提交的工作副本任务；失败保留任务并禁止目录发现。"""
    with connection.cursor(row_factory=dict_row) as cursor:
        rows = cursor.execute("SELECT job.skill_id,job.version_id,skill.owner_id,skill.name,skill.status FROM public.reply_skill_working_copy AS job JOIN public.reply_skill AS skill ON skill.id=job.skill_id WHERE (%s::uuid IS NULL OR skill.owner_id=%s) FOR UPDATE OF job", (owner_id, owner_id)).fetchall()
    count = 0
    for job in rows:
        try:
            row = _version_row(connection, job["version_id"])
            if not row["is_current"] or job["status"] == "deleted":
                connection.execute("DELETE FROM public.reply_skill_working_copy WHERE skill_id=%s", (job["skill_id"],))
                continue
            read_version_content(connection, row["id"])
            target = working_directory(job["owner_id"], job["name"])
            _checked_path(target.relative_to(skills_root()).as_posix())
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            staging = _checked_path(f".staging/{job['owner_id']}/{job['skill_id']}")
            staging.mkdir(parents=True, exist_ok=True, mode=0o700)
            temporary = Path(tempfile.mkdtemp(prefix="working-", dir=staging))
            replacement = temporary / job["name"]
            replacement.mkdir(mode=0o700)
            (replacement / "SKILL.md").write_bytes(_read_document(row))
            from notalone.persistence.skill_manifest import read_package_manifest
            resources = read_package_manifest(connection, row["id"])["resources"]
            for resource in resources:
                data = read_resource_content(connection, row["id"], resource["relative_path"])
                destination = replacement / resource["relative_path"]
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                destination.write_bytes(data)
            previous = temporary / "previous"
            try:
                if target.exists():
                    os.replace(target, previous)
                os.replace(replacement, target)
            except OSError:
                if previous.exists() and not target.exists():
                    os.replace(previous, target)
                raise
            finally:
                shutil.rmtree(temporary, ignore_errors=True)
            connection.execute("DELETE FROM public.reply_skill_working_copy WHERE skill_id=%s", (job["skill_id"],))
            count += 1
        except (OSError, SkillFileError) as error:
            _record_file_failure(
                job["owner_id"], operation="working_copy_sync", error=error,
                skill_id=job["skill_id"],
            )
            continue
        else:
            _clear_file_failure(
                job["owner_id"], operation="working_copy_sync",
                skill_id=job["skill_id"],
            )
    return count


def queue_skill_file_cleanup(connection: Any, *, skill_id: UUID, version_ids: set[UUID] | None = None) -> None:
    with connection.cursor(row_factory=dict_row) as cursor:
        skill = cursor.execute("SELECT owner_id,name FROM public.reply_skill WHERE id=%s", (skill_id,)).fetchone()
        if skill is None:
            return
        versions = cursor.execute("SELECT id,is_current FROM public.reply_skill_version WHERE skill_id=%s", (skill_id,)).fetchall()
    selected = [v for v in versions if version_ids is None or v["id"] in version_ids]
    paths = ([f".versions/{skill['owner_id']}/{skill_id}"] if version_ids is None else
             [f".versions/{skill['owner_id']}/{skill_id}/{version['id']}" for version in selected])
    paths.append(f".staging/{skill['owner_id']}/{skill_id}")
    if version_ids is None or any(v["is_current"] for v in selected):
        paths.append(f"{skill['owner_id']}/{skill['name']}")
        connection.execute("DELETE FROM public.reply_skill_working_copy WHERE skill_id=%s", (skill_id,))
    for relative in paths:
        connection.execute("INSERT INTO public.reply_skill_file_cleanup(relative_path) VALUES(%s) ON CONFLICT DO NOTHING", (relative,))
    if selected:
        connection.execute(
            "UPDATE public.reply_skill_version SET method_manifest_path=NULL,method_manifest_sha256=NULL WHERE id=ANY(%s)",
            ([version["id"] for version in selected],),
        )
    # 调用者同一删除语句清空版本定位，避免先清路径违反 active 约束。


def cleanup_pending_files(connection: Any, *, owner_id: UUID | None = None) -> int:
    with connection.cursor(row_factory=dict_row) as cursor:
        rows = cursor.execute("SELECT relative_path FROM public.reply_skill_file_cleanup WHERE (%s::uuid IS NULL OR relative_path LIKE %s OR relative_path LIKE %s OR relative_path LIKE %s) FOR UPDATE", (owner_id, f"{owner_id}/%", f".versions/{owner_id}/%", f".staging/{owner_id}/%")).fetchall()
    # 循环前一次性解析技能身份：失败/成功分支不得再查库，DB 抖动不能中断整批清理。
    skill_ids = _cleanup_skill_ids(connection, rows)
    count = 0
    for row in rows:
        relative_path = row["relative_path"]
        owner = _owner_from_relative(relative_path)
        skill_id = skill_ids.get(relative_path)
        try:
            _validate_relative_path(relative_path)
            relative = PurePosixPath(relative_path)
            parent_relative = relative.parent.as_posix()
            parent = skills_root() if parent_relative == "." else _checked_path(parent_relative)
            path = parent / relative.name
            if path.is_symlink():
                path.unlink()
            elif path.exists():
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink()
            connection.execute("DELETE FROM public.reply_skill_file_cleanup WHERE relative_path=%s", (relative_path,))
            count += 1
        except (OSError, SkillFileError) as error:
            if owner is not None:
                _record_file_failure(
                    owner, operation="cleanup", error=error, skill_id=skill_id,
                )
            else:
                logger.warning(
                    "skill_file_sync_failed operation=%s code=%s", "cleanup",
                    skill_file_failure_code(error),
                )
            continue
        else:
            if owner is not None:
                _clear_file_failure(owner, operation="cleanup", skill_id=skill_id)
    return count


def cleanup_unreferenced_snapshots(connection: Any, *, owner_id: UUID) -> None:
    """持有 owner 锁后回收失败发布留下的隐藏快照和暂存，绝不扫描工作目录。"""
    from notalone.persistence.locks import lock_owner_scope
    lock_owner_scope(connection, owner_id=owner_id)
    root = _checked_path(f".versions/{owner_id}")
    if root.exists():
        for skill in root.iterdir():
            try:
                skill_id = UUID(skill.name)
                if skill.is_symlink() or not skill.is_dir():
                    continue
                for version in skill.iterdir():
                    version_id = UUID(version.name)
                    found = connection.execute("SELECT 1 FROM public.reply_skill_version WHERE id=%s AND skill_id=%s", (version_id, skill_id)).fetchone()
                    if found is None:
                        relative = version.relative_to(skills_root()).as_posix()
                        connection.execute("INSERT INTO public.reply_skill_file_cleanup(relative_path) VALUES(%s) ON CONFLICT DO NOTHING", (relative,))
            except (ValueError, OSError):
                continue
    staging = _checked_path(f".staging/{owner_id}")
    if staging.exists():
        for skill in staging.iterdir():
            try:
                skill_id = UUID(skill.name)
                pending = connection.execute("SELECT 1 FROM public.reply_skill_working_copy WHERE skill_id=%s", (skill_id,)).fetchone()
                if not pending:
                    connection.execute("INSERT INTO public.reply_skill_file_cleanup(relative_path) VALUES(%s) ON CONFLICT DO NOTHING", (skill.relative_to(skills_root()).as_posix(),))
            except ValueError:
                continue
