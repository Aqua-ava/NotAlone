"""把 Owner 可编辑目录投影成通过校验的不可变 Skill 版本。"""

from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row

from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.skill_files import SkillFileError
from notalone.skills import LocalSkillPackageReader, SkillPackageValidator
from notalone.skills.package import SkillPackageValidationError


class SkillDirectorySyncError(RuntimeError):
    """显式目录同步失败；不回传实际路径、正文或连接信息，可重试。"""


def synchronize_skill_library(
    database_url: str, owner_id: UUID, *, migrate_legacy: bool = True,
) -> int:
    """每轮生成/管理刷新的显式同步入口；SkillPort 读路径不执行迁移或写入。

    旧库迁移与目录发现都在此提交边界内完成；失败整体回滚并抛领域错误，
    调用方可在下一轮重试。返回同步后的 Skill 库修订号。
    """
    if not isinstance(owner_id, UUID):
        raise TypeError("owner_id 必须是 UUID。")
    try:
        if migrate_legacy:
            prepare_legacy_skill_directory(database_url, owner_id)
        with psycopg.connect(database_url, row_factory=dict_row) as connection:
            # 库修订行同时是可查询的已同步标记；同步入口负责创建并递增。
            connection.execute(
                "INSERT INTO public.skill_library (owner_id, revision) VALUES (%s, 0) "
                "ON CONFLICT (owner_id) DO NOTHING",
                (owner_id,),
            )
            synchronize_skill_directory(connection, owner_id)
            row = connection.execute(
                "SELECT revision FROM public.skill_library WHERE owner_id=%s",
                (owner_id,),
            ).fetchone()
            return row["revision"] if row is not None else 0
    except (psycopg.Error, OSError, SkillFileError, TypeError, ValueError):
        raise SkillDirectorySyncError("Skill 目录同步失败。") from None


def prepare_legacy_skill_directory(database_url, owner_id: UUID) -> None:
    """独立事务迁移旧正文，提交后调用方才能消费工作副本，不提交其业务事务。"""
    from notalone.persistence.skill_files import migrate_legacy_packages
    from notalone.persistence.skill_methods import migrate_legacy_method_manifests

    if not isinstance(owner_id, UUID):
        raise TypeError("owner_id 必须是 UUID。")
    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        lock_owner_scope(connection, owner_id=owner_id)
        migrate_legacy_packages(connection, owner_id=owner_id)
        migrate_legacy_method_manifests(connection, owner_id=owner_id)


def prepare_skill_directory(database_url, owner_id: UUID) -> None:
    """供历史管理页刷新：先提交旧包迁移，再提交目录发现，最后独立读取业务视图。"""
    prepare_legacy_skill_directory(database_url, owner_id)
    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        synchronize_skill_directory(connection, owner_id)


class _DictConnection:
    """同一事务内复用管理库的字典行接口，不改变调用方 row_factory。"""

    def __init__(self, connection):
        self.connection = connection

    def execute(self, query, params=None):
        return self.connection.cursor(row_factory=dict_row).execute(query, params)

    def cursor(self, **kwargs):
        return self.connection.cursor(**kwargs)


@dataclass(frozen=True, slots=True)
class _ReadPackages:
    """一次目录扫描结果；区分「没有包」与「读取失败保留上一有效状态」。"""

    packages: dict[str, Any]
    failed_names: frozenset[str] = frozenset()
    root_failed: bool = False
    failure_code: str | None = None


def _package_directories(root: Path) -> tuple[Path, ...]:
    """列出 owner 管理目录；单独抽出以便根读取失败降级与故障注入。"""
    return tuple(root.iterdir())


def _read_packages(owner_id, *, excluded_names=()) -> _ReadPackages:
    from notalone.persistence.skill_files import (
        SkillFileError, _checked_path, skill_file_failure_code,
    )

    try:
        root = _checked_path(str(owner_id))
        if root.is_symlink():
            raise SkillFileError("Skill 文件不可用。")
        if not root.exists():
            # 目录确实不存在：合法空集，既有目录版本随之失效是正确语义。
            return _ReadPackages({})
        directories = _package_directories(root)
    except (OSError, SkillFileError) as error:
        # 根不可读/配置异常不是「没有包」：不批量下架，记录脱敏错误码后重试。
        return _ReadPackages(
            {}, root_failed=True, failure_code=skill_file_failure_code(error),
        )
    reader, validator = LocalSkillPackageReader(), SkillPackageValidator()
    packages: dict[str, Any] = {}
    failed: set[str] = set()
    code: str | None = None
    for directory in directories:
        if directory.name.startswith(".") or directory.name in excluded_names:
            continue
        if directory.is_symlink():
            # 不跟随子目录符号链接：拒绝把根外文件导入已发布版本。
            failed.add(directory.name)
            code = code or "symlink_rejected"
            continue
        try:
            packages[directory.name] = validator.validate(reader.read(directory))
        except SkillPackageValidationError:
            # 包确实非法只影响自身；不能回退到已失效工作副本对应的旧正文。
            code = code or "invalid_package"
        except OSError as error:
            # 单包瞬时读取失败：保留该技能上一有效状态，等待下次重试。
            failed.add(directory.name)
            code = code or skill_file_failure_code(error)
        except ValueError:
            code = code or "invalid_package"
    return _ReadPackages(packages, frozenset(failed), False, code)


def _blocked_working_directories(cursor, owner_id):
    """未完成替换及删除的目录不得作为新包来源；队列存续跨越业务级联删除。"""
    names = {row["name"] for row in cursor.execute(
        "SELECT skill.name FROM public.reply_skill_working_copy AS job "
        "JOIN public.reply_skill AS skill ON skill.id=job.skill_id WHERE skill.owner_id=%s", (owner_id,)
    ).fetchall()}
    cleanups = cursor.execute(
        "SELECT relative_path FROM public.reply_skill_file_cleanup "
        "WHERE relative_path=%s OR starts_with(relative_path,%s)"
        " OR starts_with(relative_path,%s) OR starts_with(relative_path,%s)",
        (str(owner_id), f"{owner_id}/", f".versions/{owner_id}/", f".staging/{owner_id}/"),
    ).fetchall()
    for row in cleanups:
        relative = row["relative_path"]
        if relative == str(owner_id):
            return names, True
        # 只有可编辑工作目录的待清理副本会影响目录发现；隐藏快照/暂存不映射技能名。
        if relative.startswith(f"{owner_id}/"):
            parts = relative.split("/")
            if len(parts) >= 2 and parts[1]:
                names.add(parts[1])
    return names, False


def _matches(cursor, row, package):
    if package is None or row["content_sha256"] != package.content_sha256:
        return False
    resources = cursor.execute(
        "SELECT relative_path,resource_kind,media_type,byte_size,content_sha256 "
        "FROM public.reply_skill_resource WHERE skill_version_id=%s ORDER BY relative_path",
        (row["version_id"],),
    ).fetchall()
    # 路径是资源身份；PG collation 与 Python Unicode 排序不应影响版本判断。
    stored = {item["relative_path"]: (item["resource_kind"], item["media_type"],
                                     item["byte_size"], item["content_sha256"]) for item in resources}
    proposed = {item.relative_path: (item.resource_kind, item.media_type,
                                    len(item.content), item.content_sha256) for item in package.resources}
    return (row["name"] == package.name and row["description"] == package.description
            and stored == proposed)


def synchronize_skill_directory(connection, owner_id: UUID, *, check_only=False) -> bool:
    """发现新增与修改；检查模式只判断变化，供提交前拒绝迟到候选。"""
    if not isinstance(owner_id, UUID):
        raise TypeError("owner_id 必须是 UUID。")
    from notalone.persistence.skill_library import PostgresSkillLibrary

    management_connection = _DictConnection(connection)
    if not check_only:
        lock_owner_scope(connection, owner_id=owner_id)
        from notalone.persistence.skill_files import (
            cleanup_pending_files,
            cleanup_unreferenced_snapshots,
            synchronize_working_copies,
        )
        synchronize_working_copies(connection, owner_id=owner_id)
        cleanup_unreferenced_snapshots(connection, owner_id=owner_id)
        cleanup_pending_files(connection, owner_id=owner_id)
    with connection.cursor(row_factory=dict_row) as cursor:
        rows = cursor.execute(
            "SELECT skill.id AS skill_id,skill.name,skill.description,skill.status,"
            "skill.directory_managed,version.id AS version_id,version.content_sha256,"
            "version.version_number,version.review_origin,version.enabled,version.directory_available "
            "FROM public.reply_skill AS skill LEFT JOIN public.reply_skill_version AS version "
            "ON version.skill_id=skill.id AND version.is_current AND version.status='active' "
            "WHERE skill.owner_id=%s ORDER BY skill.id",
            (owner_id,),
        ).fetchall()
        known = {row["name"]: row for row in rows}
        blocked_names, all_blocked = _blocked_working_directories(cursor, owner_id)
        if all_blocked:
            read = _ReadPackages({})
        else:
            read = _read_packages(owner_id, excluded_names=blocked_names)
        if not check_only and not all_blocked:
            from notalone.persistence.skill_files import (
                clear_skill_file_failure, record_skill_file_failure,
            )
            if read.failure_code is not None:
                record_skill_file_failure(
                    owner_id, operation="directory_discovery", code=read.failure_code,
                )
            else:
                clear_skill_file_failure(owner_id, operation="directory_discovery")
        packages = read.packages
        changed = False
        library = PostgresSkillLibrary("postgresql:///directory")
        for name, package in packages.items():
            if name in known:
                continue
            changed = True
            if check_only:
                continue
            library._ensure_owner(management_connection, owner_id)
            library._ensure_library_row(management_connection, owner_id)
            skill_id = uuid4()
            cursor.execute(
                "INSERT INTO public.reply_skill(id,owner_id,name,description,status,directory_managed) "
                "VALUES (%s,%s,%s,%s,'active',true)",
                (skill_id, owner_id, package.name, package.description),
            )
            library._insert_version_and_resources(management_connection, skill_id=skill_id, package=package,
                                                 version_number=1, write_working=False)
        for row in rows:
            if not row["directory_managed"] or row["status"] == "deleted" or row["version_id"] is None:
                continue
            if (all_blocked or read.root_failed or row["name"] in blocked_names
                    or row["name"] in read.failed_names):
                # 待重试的替换/清理任务、根读取失败或单包读取失败保留上一有效目录状态；
                # 运行资格仍按查询 fail-closed，失败原因由 skill_file_health 可查询，
                # 重试成功后自动恢复。
                continue
            package = packages.get(row["name"])
            matches = _matches(cursor, row, package)
            available = matches or package is not None and not row["review_origin"]
            if matches and row["directory_available"]:
                continue
            if not available:
                if row["directory_available"]:
                    changed = True
                    if not check_only:
                        cursor.execute("UPDATE public.reply_skill_version SET directory_available=false WHERE id=%s",
                                       (row["version_id"],))
                continue
            changed = True
            if check_only:
                continue
            if matches:
                cursor.execute("UPDATE public.reply_skill_version SET directory_available=true WHERE id=%s",
                               (row["version_id"],))
                continue
            # 用户停用状态、联系人身份、审核来源和政策都不由文件改变。
            cursor.execute("UPDATE public.reply_skill_version SET is_current=false WHERE id=%s", (row["version_id"],))
            number = cursor.execute("SELECT coalesce(max(version_number),0)+1 AS number "
                                    "FROM public.reply_skill_version WHERE skill_id=%s", (row["skill_id"],)).fetchone()["number"]
            version_id = library._insert_version_and_resources(
                management_connection, skill_id=row["skill_id"], package=package, version_number=number, write_working=False)
            if not row["enabled"]:
                cursor.execute("UPDATE public.reply_skill_version SET enabled=false WHERE id=%s", (version_id,))
            cursor.execute("UPDATE public.reply_skill SET description=%s,updated_at=now() WHERE id=%s",
                           (package.description, row["skill_id"]))
        if changed and not check_only:
            library._ensure_library_row(management_connection, owner_id)
            library._increment_revision(management_connection, owner_id)
        return changed
