"""已发布教学方法正文的文件清单；方法身份和范围决定仍留在业务库。"""

import hashlib
import json
import os
from uuid import UUID, uuid4

from psycopg.rows import dict_row

from notalone.persistence.skill_files import SkillFileError, _checked_path
from notalone.skills import LocalSkillPackageReader


def _version(connection, version_id):
    with connection.cursor(row_factory=dict_row) as cursor:
        row = cursor.execute(
            "SELECT version.id,version.skill_id,version.status,version.content_path,"
            "version.method_manifest_path,version.method_manifest_sha256,skill.owner_id,"
            "skill.status AS skill_status FROM public.reply_skill_version AS version "
            "JOIN public.reply_skill AS skill ON skill.id=version.skill_id WHERE version.id=%s",
            (version_id,),
        ).fetchone()
    if row is None or row["status"] != "active" or row["skill_status"] == "deleted":
        raise SkillFileError("Skill 方法不可用。")
    return row


def _locator(row):
    return f".versions/{row['owner_id']}/{row['skill_id']}/{row['id']}/methods.json"


def _normalized(methods):
    if not isinstance(methods, (list, tuple)) or not 1 <= len(methods) <= 6:
        raise SkillFileError("Skill 方法清单无效。")
    result, seen = [], set()
    for method in methods:
        try:
            identifier = UUID(str(method["method_id"]))
            title, instruction = method["title"], method["instruction"]
            if (identifier in seen or not isinstance(title, str) or not title.strip()
                    or not isinstance(instruction, str) or not instruction.strip()):
                raise ValueError()
        except (KeyError, TypeError, ValueError):
            raise SkillFileError("Skill 方法清单无效。") from None
        seen.add(identifier)
        result.append({"method_id": str(identifier), "title": title, "instruction": instruction})
    return result


def read_method_manifest(connection, version_id):
    """仅从已登记、路径及哈希均有效的文件读取正文；不回退数据库副本。"""
    row = _version(connection, version_id)
    with connection.cursor(row_factory=dict_row) as cursor:
        identities = cursor.execute(
            "SELECT method_id FROM public.reply_skill_method WHERE version_id=%s ORDER BY ordinal", (version_id,)
        ).fetchall()
    if not identities:
        return []
    if row["method_manifest_path"] != _locator(row):
        raise SkillFileError("Skill 方法不可用。")
    path = _checked_path(row["method_manifest_path"])
    try:
        data = LocalSkillPackageReader._read_file(path.parent, path.name, 1024 * 1024)
        if hashlib.sha256(data).hexdigest() != row["method_manifest_sha256"]:
            raise ValueError()
        methods = _normalized(json.loads(data))
        if [item["method_id"] for item in methods] != [str(item["method_id"]) for item in identities]:
            raise ValueError()
    except (OSError, TypeError, ValueError):
        raise SkillFileError("Skill 方法文件校验失败。") from None
    return [{**method, "method_id": UUID(method["method_id"])} for method in methods]


def write_method_manifest(connection, version_id, methods):
    """先原子落盘并复验，再登记清单并移除数据库中的已发布正文。"""
    row = _version(connection, version_id)
    normalized = _normalized(methods)
    relative = _locator(row)
    path = _checked_path(relative)
    data = json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(data) > 1024 * 1024:
        raise SkillFileError("Skill 方法清单过大。")
    temporary = path.with_name(".methods-" + uuid4().hex)
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if path.exists():
            if LocalSkillPackageReader._read_file(path.parent, path.name, 1024 * 1024) != data:
                raise SkillFileError("不可变 Skill 方法清单不一致。")
        else:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        connection.execute(
            "UPDATE public.reply_skill_version SET method_manifest_path=%s,method_manifest_sha256=%s WHERE id=%s",
            (relative, hashlib.sha256(data).hexdigest(), version_id),
        )
        read_method_manifest(connection, version_id)
        connection.execute("UPDATE public.reply_skill_method SET title=NULL,instruction=NULL WHERE version_id=%s", (version_id,))
    except OSError:
        raise SkillFileError("Skill 方法文件发布失败。") from None
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def migrate_legacy_method_manifests(connection, *, owner_id):
    """仅迁该 Owner 的旧发布方法；失败保留数据库原文，可恢复重试。"""
    from notalone.persistence.locks import lock_owner_scope

    lock_owner_scope(connection, owner_id=owner_id)
    with connection.cursor(row_factory=dict_row) as cursor:
        rows = cursor.execute(
            "SELECT DISTINCT version.id FROM public.reply_skill_version AS version "
            "JOIN public.reply_skill AS skill ON skill.id=version.skill_id "
            "JOIN public.reply_skill_method AS method ON method.version_id=version.id "
            "WHERE skill.owner_id=%s AND skill.status<>'deleted' AND version.status='active' "
            "AND version.method_manifest_path IS NULL "
            "AND method.title IS NOT NULL AND method.instruction IS NOT NULL ORDER BY version.id",
            (owner_id,),
        ).fetchall()
        for row in rows:
            methods = cursor.execute(
                "SELECT method_id,title,instruction FROM public.reply_skill_method "
                "WHERE version_id=%s ORDER BY ordinal", (row["id"],),
            ).fetchall()
            write_method_manifest(connection, row["id"], methods)
    return len(rows)
