"""一次性升级已发布 Skill 的旧内容结构；运行时不读取这些兼容字段。"""

from __future__ import annotations

from dataclasses import replace
import hashlib
from pathlib import PurePosixPath
from typing import Any
from uuid import UUID

from psycopg.rows import dict_row

from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.skill_files import (
    SkillFileError,
    _checked_path,
    _snapshot_relative,
    queue_working_copy,
    serialize_skill_document,
    write_version_package,
)
from notalone.persistence.skill_manifest import read_package_manifest, write_package_manifest
from notalone.persistence.skill_methods import read_method_manifest, write_method_manifest
from notalone.skills import LocalSkillPackageReader, SkillPackageValidator
from notalone.skills.package import RawSkillPackage, RawSkillPackageResource


class SkillSchemaUpgradeError(RuntimeError):
    """升级失败的脱敏错误；调用者须回滚当前迁移事务。"""


def _ensure_manifest_column(connection: Any) -> None:
    # 与内容校验和删列共用调用者事务；失败不会遗留半升级结构。
    connection.execute(
        "ALTER TABLE public.reply_skill_version ADD COLUMN IF NOT EXISTS "
        "manifest_sha256 text CHECK (manifest_sha256 IS NULL OR "
        "manifest_sha256 ~ '^[0-9a-f]{64}$')"
    )


def _active_versions(connection: Any, owner_id: UUID | None) -> list[dict]:
    with connection.cursor(row_factory=dict_row) as cursor:
        return cursor.execute(
            "SELECT version.*,skill.owner_id,skill.name AS skill_name,"
            "skill.status AS skill_status FROM public.reply_skill_version AS version "
            "JOIN public.reply_skill AS skill ON skill.id=version.skill_id "
            "WHERE version.status='active' "
            "AND (%s::uuid IS NULL OR skill.owner_id=%s) "
            "ORDER BY skill.owner_id,version.id FOR UPDATE OF version",
            (owner_id, owner_id),
        ).fetchall()


def _resources(connection: Any, version_id: UUID) -> list[dict]:
    with connection.cursor(row_factory=dict_row) as cursor:
        return cursor.execute(
            "SELECT * FROM public.reply_skill_resource WHERE skill_version_id=%s "
            "ORDER BY relative_path", (version_id,),
        ).fetchall()


def _validate_resources(package: Any, resources: list[dict], content_path: str | None) -> None:
    expected = {item["relative_path"]: item for item in resources}
    if len(expected) != len(package.resources):
        raise SkillFileError("Skill 原始资源清单校验失败。")
    for item in package.resources:
        old = expected.get(item.relative_path)
        if old is None or (
            old["resource_kind"], old["media_type"], old["byte_size"], old["content_sha256"]
        ) != (
            item.resource_kind, item.media_type, len(item.content), item.content_sha256
        ):
            raise SkillFileError("Skill 原始资源校验失败。")
        if old["content"] is not None and bytes(old["content"]) != item.content:
            raise SkillFileError("Skill 原始资源校验失败。")
        if old["content_path"] is not None and (
            content_path is None or old["content_path"] != str(
                PurePosixPath(content_path).parent / item.relative_path
            )
        ):
            raise SkillFileError("Skill 原始资源定位校验失败。")


def _validated_package(row: dict, resources: list[dict]) -> Any:
    if row["name"] != row["skill_name"] or row["skill_status"] == "deleted":
        raise SkillFileError("Skill 原始身份校验失败。")
    if row["content_path"] is None:
        if not row["content"] or any(item["content"] is None for item in resources):
            raise SkillFileError("Skill 原始内容不可用。")
        raw = RawSkillPackage(
            row["name"], serialize_skill_document(row["name"], row["description"], row["content"]),
            tuple(RawSkillPackageResource(
                item["relative_path"], item["resource_kind"], item["media_type"], bytes(item["content"])
            ) for item in resources),
        )
    else:
        expected = _snapshot_relative(
            row["owner_id"], row["skill_id"], row["id"], row["name"]
        ) + "/SKILL.md"
        if row["content_path"] != expected:
            raise SkillFileError("Skill 原始文件定位校验失败。")
        raw = LocalSkillPackageReader().read(_checked_path(expected).parent)
        if hashlib.sha256(raw.skill_document).hexdigest() != row["document_sha256"]:
            raise SkillFileError("Skill 原始文件校验失败。")
        # MIME 是旧包已登记的元数据，不能因当前平台的扩展名猜测规则改变而丢失。
        metadata = {item["relative_path"]: item for item in resources}
        raw = replace(raw, resources=tuple(
            replace(item, media_type=metadata[item.relative_path]["media_type"])
            if item.relative_path in metadata else item
            for item in raw.resources
        ))
    package = SkillPackageValidator().validate(raw)
    if package.name != row["name"] or package.description != row["description"]:
        raise SkillFileError("Skill 原始目录校验失败。")
    if row["content_sha256"] is not None and row["content_sha256"] != package.content_sha256:
        raise SkillFileError("Skill 原始正文校验失败。")
    if row["content"] is not None and row["content"] != package.content:
        raise SkillFileError("Skill 原始正文校验失败。")
    _validate_resources(package, resources, row["content_path"])
    return replace(package, warnings=tuple(row["validation_warnings"]))


def migrate_legacy_packages(connection: Any, *, owner_id: UUID | None = None) -> int:
    """落盘及核对所有旧版本与清单；仅供逐版本升级，不供运行时调用。"""
    _ensure_manifest_column(connection)
    rows = _active_versions(connection, owner_id)
    for owner in sorted({row["owner_id"] for row in rows}):
        lock_owner_scope(connection, owner_id=owner)
    count = 0
    for row in rows:
        resources = _resources(connection, row["id"])
        package = _validated_package(row, resources)
        was_legacy = row["content_path"] is None
        if was_legacy:
            content_path, document_sha256 = write_version_package(
                owner_id=row["owner_id"], skill_id=row["skill_id"], version_id=row["id"], package=package,
            )
        else:
            content_path, document_sha256 = row["content_path"], row["document_sha256"]
        manifest_sha256 = write_package_manifest(content_path, package)
        if row["manifest_sha256"] is not None and row["manifest_sha256"] != manifest_sha256:
            raise SkillFileError("Skill 原始清单校验失败。")
        connection.execute(
            "UPDATE public.reply_skill_version SET content_path=%s,document_sha256=%s,"
            "content_sha256=%s,manifest_sha256=%s,content=NULL WHERE id=%s",
            (content_path, document_sha256, package.content_sha256, manifest_sha256, row["id"]),
        )
        # 使用新的无正文读取接口复验刚写入的清单，失败时保留旧表结构和字节。
        read_package_manifest(connection, row["id"])
        _validated_package(
            {**row, "content_path": content_path, "document_sha256": document_sha256}, resources,
        )
        for resource in resources:
            connection.execute(
                "UPDATE public.reply_skill_resource SET content_path=%s,content=NULL WHERE id=%s",
                (str(PurePosixPath(content_path).parent / resource["relative_path"]), resource["id"]),
            )
        if was_legacy and row["is_current"]:
            queue_working_copy(connection, row["skill_id"], row["id"])
        count += int(was_legacy)
    return count


def migrate_legacy_method_manifests(connection: Any, *, owner_id: UUID | None = None) -> int:
    """核对全部发布方法文件后清空旧正文；已有清单也必须通过完整校验。"""
    with connection.cursor(row_factory=dict_row) as cursor:
        rows = cursor.execute(
            "SELECT DISTINCT version.id,skill.owner_id,version.method_manifest_path "
            "FROM public.reply_skill_version AS version "
            "JOIN public.reply_skill AS skill ON skill.id=version.skill_id "
            "JOIN public.reply_skill_method AS method ON method.version_id=version.id "
            "WHERE version.status='active' AND (%s::uuid IS NULL OR skill.owner_id=%s) "
            "ORDER BY skill.owner_id,version.id", (owner_id, owner_id),
        ).fetchall()
    count = 0
    for row in rows:
        lock_owner_scope(connection, owner_id=row["owner_id"])
        with connection.cursor(row_factory=dict_row) as cursor:
            methods = cursor.execute(
                "SELECT method_id,title,instruction FROM public.reply_skill_method "
                "WHERE version_id=%s ORDER BY ordinal", (row["id"],),
            ).fetchall()
        has_legacy = any(item["title"] is not None or item["instruction"] is not None for item in methods)
        if has_legacy:
            if any(item["title"] is None or item["instruction"] is None for item in methods):
                raise SkillFileError("Skill 原始方法不完整。")
            write_method_manifest(connection, row["id"], methods)
        loaded = read_method_manifest(connection, row["id"])
        if has_legacy and loaded != methods:
            raise SkillFileError("Skill 原始方法校验失败。")
        if has_legacy:
            connection.execute(
                "UPDATE public.reply_skill_method SET title=NULL,instruction=NULL WHERE version_id=%s",
                (row["id"],),
            )
        count += int(row["method_manifest_path"] is None)
    return count


def upgrade_skill_business_state(connection: Any) -> None:
    """103 迁移的事务内入口：任何内容或文件损坏都先失败，再由外层回滚。"""
    try:
        migrate_legacy_packages(connection)
        migrate_legacy_method_manifests(connection)
    except (SkillFileError, OSError, TypeError, ValueError):
        raise SkillSchemaUpgradeError("Skill 内容升级未完成。") from None
