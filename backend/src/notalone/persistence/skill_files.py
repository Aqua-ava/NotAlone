"""已发布 Skill 的受控目录、不可变快照及可重试删除。"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any
from uuid import UUID

from psycopg.rows import dict_row

from notalone.skills import LocalSkillPackageReader, SkillPackageValidator


class SkillFileError(RuntimeError):
    """文件不可用；不向调用方暴露实际路径或正文。"""


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


def _checked_path(relative: str) -> Path:
    parts = PurePosixPath(relative).parts
    if (not parts or relative.startswith("/") or "\\" in relative or
            any(part in (".", "..", "") for part in parts) or "//" in relative):
        raise SkillFileError("Skill 文件不可用。")
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
            if existing.skill_document != document or tuple((r.relative_path, r.content) for r in existing.resources) != tuple((r.relative_path, r.content) for r in package.resources):
                raise SkillFileError("Skill 文件校验失败。")
        else:
            os.replace(staged_package, target)
        return relative + "/SKILL.md", digest
    except (OSError, ValueError):
        raise SkillFileError("Skill 文件写入失败。") from None
    finally:
        if "temporary" in locals():
            shutil.rmtree(temporary, ignore_errors=True)


def _version_row(connection: Any, version_id: UUID) -> dict:
    with connection.cursor(row_factory=dict_row) as cursor:
        row = cursor.execute(
            "SELECT version.*,skill.owner_id,skill.status AS skill_status FROM public.reply_skill_version AS version "
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
    if row["content_path"] is None:
        if row["content"] and (row["content_sha256"] is None or hashlib.sha256(row["content"].encode("utf-8")).hexdigest() == row["content_sha256"]):
            return row["content"]
        raise SkillFileError("Skill 文件不可用。")
    try:
        _, _, content = SkillPackageValidator._parse_skill_document(_read_document(row), package_name=row["name"])
    except ValueError:
        raise SkillFileError("Skill 文件不可用。") from None
    if hashlib.sha256(content.encode("utf-8")).hexdigest() != row["content_sha256"]:
        raise SkillFileError("Skill 文件校验失败。")
    return content


def read_resource_content(connection: Any, version_id: UUID, relative_path: str) -> bytes:
    row = _version_row(connection, version_id)
    with connection.cursor(row_factory=dict_row) as cursor:
        resource = cursor.execute("SELECT * FROM public.reply_skill_resource WHERE skill_version_id=%s AND relative_path=%s", (version_id, relative_path)).fetchone()
    if resource is None:
        raise SkillFileError("Skill 资源不可用。")
    if row["content_path"] is None and resource["content"] is not None:
        data = bytes(resource["content"])
    else:
        expected = _snapshot_relative(row["owner_id"], row["skill_id"], version_id, row["name"]) + "/" + relative_path
        if resource["content_path"] != expected:
            raise SkillFileError("Skill 资源不可用。")
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
            with connection.cursor(row_factory=dict_row) as cursor:
                resources = cursor.execute("SELECT relative_path FROM public.reply_skill_resource WHERE skill_version_id=%s", (row["id"],)).fetchall()
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
            connection.execute("UPDATE public.reply_skill SET directory_managed=true WHERE id=%s", (job["skill_id"],))
            connection.execute("DELETE FROM public.reply_skill_working_copy WHERE skill_id=%s", (job["skill_id"],))
            count += 1
        except (OSError, SkillFileError):
            continue
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
    count = 0
    for row in rows:
        try:
            relative = PurePosixPath(row["relative_path"])
            parent = _checked_path(relative.parent.as_posix())
            path = parent / relative.name
            if path.is_symlink():
                path.unlink()
            elif path.exists():
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink()
            connection.execute("DELETE FROM public.reply_skill_file_cleanup WHERE relative_path=%s", (row["relative_path"],))
            count += 1
        except (OSError, SkillFileError):
            continue
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


def migrate_legacy_packages(connection: Any, *, owner_id: UUID | None = None) -> int:
    """可重试：全部字节落盘并复验后才在调用者事务中清空数据库字节。"""
    from notalone.skills.package import RawSkillPackage, RawSkillPackageResource
    from notalone.persistence.locks import lock_owner_scope
    with connection.cursor(row_factory=dict_row) as cursor:
        owners = cursor.execute("SELECT DISTINCT skill.owner_id FROM public.reply_skill_version AS version JOIN public.reply_skill AS skill ON skill.id=version.skill_id WHERE version.status='active' AND version.content IS NOT NULL AND version.content_path IS NULL AND (%s::uuid IS NULL OR skill.owner_id=%s) ORDER BY skill.owner_id", (owner_id, owner_id)).fetchall()
    for owner in owners:
        lock_owner_scope(connection, owner_id=owner["owner_id"])
    with connection.cursor(row_factory=dict_row) as cursor:
        rows = cursor.execute(
            "SELECT version.*,skill.owner_id FROM public.reply_skill_version AS version JOIN public.reply_skill AS skill ON skill.id=version.skill_id "
            "WHERE version.status='active' AND version.content IS NOT NULL AND version.content_path IS NULL AND (%s::uuid IS NULL OR skill.owner_id=%s) FOR UPDATE OF version", (owner_id, owner_id)).fetchall()
    for row in rows:
        with connection.cursor(row_factory=dict_row) as cursor:
            resources = cursor.execute("SELECT * FROM public.reply_skill_resource WHERE skill_version_id=%s ORDER BY relative_path", (row["id"],)).fetchall()
        package = SkillPackageValidator().validate(RawSkillPackage(row["name"], serialize_skill_document(row["name"], row["description"], row["content"]), tuple(
            RawSkillPackageResource(r["relative_path"], r["resource_kind"], r["media_type"], bytes(r["content"])) for r in resources)))
        if row["content_sha256"] is not None and row["content_sha256"] != package.content_sha256:
            raise SkillFileError("Skill 原始内容校验失败。")
        content_path, document_sha256 = write_version_package(owner_id=row["owner_id"], skill_id=row["skill_id"], version_id=row["id"], package=package)
        connection.execute("UPDATE public.reply_skill_version SET content_path=%s,document_sha256=%s,content_sha256=%s,content=NULL WHERE id=%s", (content_path, document_sha256, package.content_sha256, row["id"]))
        for resource in resources:
            connection.execute("UPDATE public.reply_skill_resource SET content_path=%s,content=NULL WHERE id=%s", (str(PurePosixPath(content_path).parent / resource["relative_path"]), resource["id"]))
            read_resource_content(connection, row["id"], resource["relative_path"])
        read_version_content(connection, row["id"])
        if row["is_current"]:
            queue_working_copy(connection, row["skill_id"], row["id"])
    return len(rows)
