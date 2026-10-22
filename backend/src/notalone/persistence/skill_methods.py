"""已发布教学方法正文的文件清单；方法身份和范围决定仍留在业务库。"""

import hashlib
import json
import os
import re
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


def _index_entries(raw):
    if not isinstance(raw, list) or not 1 <= len(raw) <= 6:
        raise SkillFileError("Skill 方法索引无效。")
    entries = []
    for item in raw:
        try:
            if set(item) != {"method_id", "relative_path", "content_sha256"}:
                raise ValueError()
            identifier = UUID(item["method_id"])
            if (item["relative_path"] != f"methods/{identifier}.json"
                    or not isinstance(item["content_sha256"], str)
                    or re.fullmatch(r"[0-9a-f]{64}", item["content_sha256"]) is None):
                raise ValueError()
        except (KeyError, TypeError, ValueError):
            raise SkillFileError("Skill 方法索引无效。") from None
        entries.append({**item, "method_id": identifier})
    return entries


def read_method_manifest(connection, version_id, *, method_ids=None):
    """先核验无正文索引，仅物化选中的方法正文；不回退数据库副本。"""
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
        entries = _index_entries(json.loads(data))
        if [item["method_id"] for item in entries] != [item["method_id"] for item in identities]:
            raise ValueError()
        selected = {item["method_id"] for item in entries} if method_ids is None else set(method_ids)
        if not selected <= {item["method_id"] for item in entries}:
            raise ValueError()
        methods = []
        for item in entries:
            if item["method_id"] not in selected:
                continue
            method_path = _checked_path(_locator(row).removesuffix("methods.json") + item["relative_path"])
            body = LocalSkillPackageReader._read_file(method_path.parent, method_path.name, 1024 * 1024)
            if hashlib.sha256(body).hexdigest() != item["content_sha256"]:
                raise ValueError()
            method = _normalized([json.loads(body)])[0]
            if UUID(method["method_id"]) != item["method_id"]:
                raise ValueError()
            methods.append({**method, "method_id": item["method_id"]})
    except (OSError, TypeError, ValueError):
        raise SkillFileError("Skill 方法文件校验失败。") from None
    return methods


def _write_immutable(path, data):
    if len(data) > 1024 * 1024:
        raise SkillFileError("Skill 方法文件过大。")
    temporary = path.with_name(".method-" + uuid4().hex)
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if path.exists():
            if LocalSkillPackageReader._read_file(path.parent, path.name, 1024 * 1024) != data:
                raise SkillFileError("不可变 Skill 方法文件不一致。")
            return
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def write_method_manifest(connection, version_id, methods):
    """先原子落盘并复验，再登记清单；数据库仅保存方法身份和映射。"""
    row = _version(connection, version_id)
    normalized = _normalized(methods)
    relative = _locator(row)
    path = _checked_path(relative)
    try:
        entries = []
        for method in normalized:
            body = json.dumps(method, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            method_relative = f"methods/{method['method_id']}.json"
            method_path = _checked_path(relative.removesuffix("methods.json") + method_relative)
            _write_immutable(method_path, body)
            entries.append({"method_id": method["method_id"], "relative_path": method_relative,
                            "content_sha256": hashlib.sha256(body).hexdigest()})
        data = json.dumps(entries, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        _write_immutable(path, data)
        connection.execute(
            "UPDATE public.reply_skill_version SET method_manifest_path=%s,method_manifest_sha256=%s WHERE id=%s",
            (relative, hashlib.sha256(data).hexdigest(), version_id),
        )
        read_method_manifest(connection, version_id)
    except OSError:
        raise SkillFileError("Skill 方法文件发布失败。") from None
