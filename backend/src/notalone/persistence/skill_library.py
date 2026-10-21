"""Skill Library 管理接口的 PostgreSQL 适配器。"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.scopes import ContactScope
from notalone.persistence.skill_files import (
    SkillFileError, cleanup_pending_files, cleanup_unreferenced_snapshots, queue_skill_file_cleanup,
    queue_working_copy, read_resource_content, read_version_content,
    synchronize_working_copies, write_version_package,
)
from notalone.skills import (
    LocalSkillPackageReader,
    PreviewCandidate,
    SkillCatalog,
    SkillCatalogEntry,
    SkillDeletionResult,
    SkillExportResult,
    SkillImportResult,
    SkillLibraryManagementPort,
    SkillManagementEntry,
    SkillVersionEntry,
    SkillPackageValidationError,
    SkillPackageValidator,
    SkillPreview,
    SkillVersionResult,
)


class SkillLibraryManagementError(RuntimeError):
    """Skill Library 管理失败，且不暴露 SQL、路径或正文。"""


class SkillOwnerNotFoundError(SkillLibraryManagementError):
    """目标 Owner 不存在。"""


class SkillNameConflictError(SkillLibraryManagementError):
    """同一 Owner 下已存在同名 Skill，普通导入不会静默覆盖。"""


class SkillNotFoundError(SkillLibraryManagementError):
    """目标 Skill 不存在或不属于该 Owner。"""


class SkillVersionNotFoundError(SkillLibraryManagementError):
    """目标 Skill 版本不存在、不属于该 Skill 或已被删除。"""


class SkillDeletedError(SkillLibraryManagementError):
    """目标 Skill 已删除，不能再修改或回滚。"""


class SkillLibraryPersistenceError(SkillLibraryManagementError):
    """Skill Library 持久化失败。"""


class PostgresSkillLibrary(SkillLibraryManagementPort):
    """在 PostgreSQL 中原子发布和管理用户明确选择的本地 Skill 包。"""

    __slots__ = ("_database_url", "_reader", "_validator")

    def __init__(
        self,
        database_url: str,
        *,
        reader: LocalSkillPackageReader | None = None,
        validator: SkillPackageValidator | None = None,
    ) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url
        self._reader = reader or LocalSkillPackageReader()
        self._validator = validator or SkillPackageValidator()

    def list_owner_skills(self, owner_id: UUID) -> tuple[SkillManagementEntry, ...]:
        """返回 owner 的全部 skill 管理视图（含 disabled/删除）。"""

        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        try:
            from notalone.persistence.skill_directory import prepare_legacy_skill_directory
            prepare_legacy_skill_directory(self._database_url, owner_id)
            with self._connect() as connection:
                from notalone.persistence.skill_directory import synchronize_skill_directory
                synchronize_skill_directory(connection, owner_id)
                rows = connection.execute(
                    """
                    SELECT skill.id AS skill_id,
                           skill.name AS skill_name,
                           skill.description AS skill_description,
                           skill.contact_id AS skill_contact_id,
                           skill.status AS skill_status,
                           version.id AS current_version_id,
                           version.version_number AS current_version_number,
                           version.enabled AS current_enabled
                    FROM public.reply_skill AS skill
                    LEFT JOIN public.reply_skill_version AS version
                      ON version.skill_id = skill.id
                     AND version.is_current = TRUE
                     AND version.status = 'active'
                    WHERE skill.owner_id = %s
                    ORDER BY skill.created_at, skill.id
                    """,
                    (owner_id,),
                ).fetchall()
        except psycopg.Error:
            raise SkillLibraryPersistenceError(
                "Skill 目录读取失败。"
            ) from None
        return tuple(
            SkillManagementEntry(
                skill_id=row["skill_id"],
                name=row["skill_name"],
                description=row["skill_description"],
                status=row["skill_status"],
                contact_id=row["skill_contact_id"],
                current_version_id=row["current_version_id"],
                current_version_number=row["current_version_number"],
                enabled=bool(row["current_enabled"]),
            )
            for row in rows
        )

    def publish_reviewed(self, connection: Any, *, scope: ContactScope,
                         draft: dict, confirmed_scope: dict,
                         dependency_ids: list, source_generation: dict) -> dict:
        """在审核应用已持有的事务中发布；不向回复或学习模型暴露。"""
        from notalone.skills.package import RawSkillPackage
        from notalone.skills.learning import SkillLearningInvalid

        strategy = draft['sanitized_strategy']
        package = self._validator.validate(RawSkillPackage(
            strategy['name'], strategy['document'].encode('utf-8'), ()))
        skill_id = UUID(draft['logical_skill_id'])
        targets = draft['target_versions']
        skill = connection.execute(
            'SELECT id,name,status FROM public.reply_skill WHERE owner_id=%s AND id=%s FOR UPDATE',
            (scope.owner_id, skill_id)).fetchone()
        self._ensure_library_row(connection, scope.owner_id)
        conflict = connection.execute(
            'SELECT id FROM public.reply_skill WHERE owner_id=%s AND name=%s AND id<>%s',
            (scope.owner_id, package.name, skill_id)).fetchone()
        if conflict or skill and (skill['status'] != 'active' or skill['name'] != package.name):
            raise SkillLearningInvalid()
        if draft['proposal_kind'] == 'create':
            if skill is not None or targets:
                raise SkillLearningInvalid()
            connection.execute(
                "INSERT INTO public.reply_skill(id,owner_id,contact_id,name,description,status) VALUES(%s,%s,NULL,%s,%s,'active')",
                (skill_id, scope.owner_id, package.name, package.description))
        elif skill is None or not targets or UUID(targets[0]['skill_id']) != skill_id:
            raise SkillLearningInvalid()
        for target in targets:
            current = connection.execute(
                'SELECT version.id FROM public.reply_skill_version AS version '
                'JOIN public.reply_skill AS skill ON skill.id=version.skill_id '
                "WHERE skill.owner_id=%s AND skill.id=%s AND skill.status='active' "
                "AND version.id=%s AND version.is_current AND version.enabled AND version.status='active' FOR UPDATE OF version,skill",
                (scope.owner_id, UUID(target['skill_id']), UUID(target['version_id']))).fetchone()
            if current is None:
                raise SkillLearningInvalid()
        number = connection.execute(
            'SELECT coalesce(max(version_number),0)+1 AS number FROM public.reply_skill_version WHERE skill_id=%s',
            (skill_id,)).fetchone()['number']
        connection.execute('UPDATE public.reply_skill_version SET is_current=false WHERE skill_id=%s AND is_current', (skill_id,))
        version_id = self._insert_version_and_resources(connection, skill_id=skill_id,
                                                        package=package, version_number=number)
        connection.execute('UPDATE public.reply_skill_version SET source_locator=%s,review_origin=true WHERE id=%s',
                           ('reviewed-draft:' + draft['draft_id'], version_id))
        connection.execute(
            "UPDATE public.reply_skill SET description=%s,updated_at=now() WHERE id=%s",
            (package.description, skill_id))
        # 合并仅停用明确列出的目标；旧版本保留，回滚仍受独立政策和删除约束。
        for target in targets[1:]:
            connection.execute("UPDATE public.reply_skill SET status='disabled',updated_at=now() WHERE owner_id=%s AND id=%s",
                               (scope.owner_id, UUID(target['skill_id'])))
        connection.execute(
            'INSERT INTO public.reply_skill_publication(version_id,owner_id,origin_contact_id,draft_id,logical_skill_id,'
            'scope_kind,scope_contact_id,scene,dependency_ids,source_generation) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
            (version_id, scope.owner_id, scope.contact_id, UUID(draft['draft_id']), skill_id,
             confirmed_scope['kind'], UUID(confirmed_scope['contact_id']) if confirmed_scope['contact_id'] else None,
             confirmed_scope['scene'], dependency_ids, Jsonb(source_generation)))
        for ordinal, method in enumerate(strategy['methods']):
            connection.execute(
                'INSERT INTO public.reply_skill_method(version_id,method_id,logical_skill_id,ordinal,title,instruction,'
                'replaces_method_ids,mapping_state) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',
                (version_id, UUID(method['method_id']), UUID(method['logical_skill_id']), ordinal,
                 None, None, [UUID(value) for value in method['replaces_method_ids']],
                 'confirmed' if targets else 'new'))
        from notalone.persistence.skill_methods import write_method_manifest
        try:
            write_method_manifest(getattr(connection, 'connection', connection), version_id, strategy['methods'])
        except SkillFileError:
            raise SkillLibraryPersistenceError('Skill 方法文件发布失败。') from None
        revision = self._increment_revision(connection, scope.owner_id)
        return {'skill_id': str(skill_id), 'version_id': str(version_id), 'name': package.name,
                'version_number': number, 'revision': revision, 'scope': confirmed_scope}

    def read_current_version(
        self,
        owner_id: UUID,
        skill_id: UUID,
    ) -> tuple[str, str, int, tuple[str, ...]]:
        """返回当前版本投影（文档内容、描述、版本号、资源路径清单）。"""

        if not isinstance(owner_id, UUID) or not isinstance(skill_id, UUID):
            raise TypeError("Skill 读取标识必须是 UUID。")
        try:
            with self._connect() as connection:
                skill = connection.execute(
                    """
                    SELECT id, name
                    FROM public.reply_skill
                    WHERE id = %s AND owner_id = %s AND status <> 'deleted'
                    """,
                    (skill_id, owner_id),
                ).fetchone()
                if skill is None:
                    raise SkillNotFoundError("Skill 读取失败：Skill 不存在。")
                current = connection.execute(
                    """
                    SELECT id, version_number, description, content
                    FROM public.reply_skill_version
                    WHERE skill_id = %s AND is_current = TRUE
                      AND status = 'active' AND (content IS NOT NULL OR content_path IS NOT NULL)
                    """,
                    (skill_id,),
                ).fetchone()
                if current is None:
                    raise SkillVersionNotFoundError(
                        "Skill 读取失败：当前版本不可用。"
                    )
                self._require_version_sources(connection, owner_id, current['id'])
                current['content'] = read_version_content(connection, current['id'])
                resources = connection.execute(
                    """
                    SELECT relative_path
                    FROM public.reply_skill_resource
                    WHERE skill_version_id = %s
                    ORDER BY relative_path
                    """,
                    (current["id"],),
                ).fetchall()
        except (SkillNotFoundError, SkillVersionNotFoundError):
            raise
        except (psycopg.Error, SkillFileError):
            raise SkillLibraryPersistenceError(
                "Skill 读取失败。"
            ) from None
        return (
            current["content"],
            current["description"],
            current["version_number"],
            tuple(row["relative_path"] for row in resources),
        )

    def import_package(
        self,
        owner_id: UUID,
        package_path: str | Path,
    ) -> SkillImportResult:
        """校验并原子发布一个 Owner 全局的首个 Skill 版本。"""

        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        raw_package = self._reader.read(package_path)
        package = self._validator.validate(raw_package)
        skill_id = uuid4()
        version_id = uuid4()
        try:
            with self._connect() as connection:
                from notalone.persistence.locks import lock_owner_scope
                lock_owner_scope(connection, owner_id=owner_id)
                self._ensure_owner(connection, owner_id)
                self._ensure_library_row(connection, owner_id)
                existing = connection.execute(
                    """
                    SELECT id
                    FROM public.reply_skill
                    WHERE owner_id = %s AND name = %s
                    FOR UPDATE
                    """,
                    (owner_id, package.name),
                ).fetchone()
                if existing is not None:
                    raise SkillNameConflictError(
                        "Skill 名称已存在，请使用 update。",
                    )
                connection.execute(
                    """
                    INSERT INTO public.reply_skill (
                        id, owner_id, contact_id, name, description, status
                    )
                    VALUES (%s, %s, NULL, %s, %s, 'active')
                    """,
                    (skill_id, owner_id, package.name, package.description),
                )
                self._insert_version_and_resources(
                    connection,
                    skill_id=skill_id,
                    package=package,
                    version_number=1,
                    version_id=version_id,
                )
                revision = self._increment_revision(connection, owner_id)
        except (
            SkillPackageValidationError,
            SkillOwnerNotFoundError,
            SkillNameConflictError,
            SkillLibraryPersistenceError,
        ):
            raise
        except psycopg.errors.UniqueViolation:
            raise SkillNameConflictError(
                "Skill 名称已存在，请使用 update。",
            ) from None
        except psycopg.Error:
            raise SkillLibraryPersistenceError("Skill 导入失败。") from None
        self._synchronize_files(owner_id)
        return SkillImportResult(
            owner_id=owner_id,
            skill_id=skill_id,
            version_id=version_id,
            name=package.name,
            version_number=1,
            revision=revision,
            resource_paths=tuple(
                resource.relative_path for resource in package.resources
            ),
            warnings=package.warnings,
        )

    def update_package(
        self,
        owner_id: UUID,
        package_path: str | Path,
    ) -> SkillVersionResult:
        """在同名 Skill 下发布新的不可变版本，旧版本保留并可回滚。"""

        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        raw_package = self._reader.read(package_path)
        package = self._validator.validate(raw_package)
        try:
            with self._connect() as connection:
                from notalone.persistence.locks import lock_owner_scope
                lock_owner_scope(connection, owner_id=owner_id)
                self._ensure_owner(connection, owner_id)
                self._ensure_library_row(connection, owner_id)
                skill = connection.execute(
                    """
                    SELECT id, status
                    FROM public.reply_skill
                    WHERE owner_id = %s AND name = %s
                    FOR UPDATE
                    """,
                    (owner_id, package.name),
                ).fetchone()
                if skill is None:
                    raise SkillNotFoundError(
                        "Skill 更新失败：名称不存在，请先导入。",
                    )
                if skill["status"] == "deleted":
                    raise SkillDeletedError("Skill 更新失败：Skill 已删除。")
                next_number = connection.execute(
                    """
                    SELECT coalesce(max(version_number), 0) + 1 AS next
                    FROM public.reply_skill_version
                    WHERE skill_id = %s
                    """,
                    (skill["id"],),
                ).fetchone()["next"]
                connection.execute(
                    """
                    UPDATE public.reply_skill_version
                    SET is_current = FALSE
                    WHERE skill_id = %s AND is_current = TRUE
                    """,
                    (skill["id"],),
                )
                version_id = uuid4()
                self._insert_version_and_resources(
                    connection,
                    skill_id=skill["id"],
                    package=package,
                    version_number=next_number,
                    version_id=version_id,
                )
                # 保持 reply_skill 与 current 版本描述一致，避免目录一致性守卫误报。
                connection.execute(
                    """
                    UPDATE public.reply_skill
                    SET description = %s, updated_at = now()
                    WHERE id = %s
                    """,
                    (package.description, skill["id"]),
                )
                revision = self._increment_revision(connection, owner_id)
        except (
            SkillPackageValidationError,
            SkillNotFoundError,
            SkillDeletedError,
            SkillLibraryPersistenceError,
        ):
            raise
        except psycopg.Error:
            raise SkillLibraryPersistenceError("Skill 更新失败。") from None
        self._synchronize_files(owner_id)
        return SkillVersionResult(
            owner_id=owner_id,
            skill_id=skill["id"],
            version_id=version_id,
            name=package.name,
            version_number=next_number,
            revision=revision,
            status="active",
        )

    def enable(self, owner_id: UUID, skill_id: UUID) -> SkillVersionResult:
        """重新启用一个已停用的 Owner 全局 Skill。"""

        return self._set_skill_status(owner_id, skill_id, "active")

    def disable(self, owner_id: UUID, skill_id: UUID) -> SkillVersionResult:
        """停用一个 Owner 全局 Skill，使其不再进入运行目录。"""

        return self._set_skill_status(owner_id, skill_id, "disabled")

    def list_versions(
        self,
        owner_id: UUID,
        skill_id: UUID,
    ) -> tuple[SkillVersionEntry, ...]:
        """返回该 skill 的历史版本（新到旧），不含正文。"""

        if not isinstance(owner_id, UUID) or not isinstance(skill_id, UUID):
            raise TypeError("Skill 版本查询标识必须是 UUID。")
        try:
            with self._connect() as connection:
                rows = connection.execute(
                    """
                    SELECT version.id AS version_id,
                           version.version_number,
                           version.name,
                           version.description,
                           version.is_current,
                           version.enabled,
                           version.created_at
                    FROM public.reply_skill_version AS version
                    JOIN public.reply_skill AS skill
                      ON skill.id = version.skill_id
                    WHERE skill.owner_id = %s
                      AND version.skill_id = %s
                      AND version.status = 'active'
                    ORDER BY version.version_number DESC
                    """,
                    (owner_id, skill_id),
                ).fetchall()
        except psycopg.Error:
            raise SkillLibraryPersistenceError("Skill 版本读取失败。") from None
        return tuple(
            SkillVersionEntry(
                version_id=row["version_id"],
                version_number=row["version_number"],
                name=row["name"],
                description=row["description"],
                is_current=bool(row["is_current"]),
                enabled=bool(row["enabled"]),
                created_at=row["created_at"],
            )
            for row in rows
        )

    def rollback(
        self,
        owner_id: UUID,
        skill_id: UUID,
        version_id: UUID,
    ) -> SkillVersionResult:
        """把仍合法的保留版本设为current，保持用户的启用或停用状态。"""

        if not isinstance(owner_id, UUID) or not isinstance(
            skill_id,
            UUID,
        ) or not isinstance(version_id, UUID):
            raise TypeError("Skill 回滚标识必须是 UUID。")
        try:
            with self._connect() as connection:
                from notalone.persistence.locks import lock_owner_scope
                lock_owner_scope(connection, owner_id=owner_id)
                result = self.rollback_locked(connection, owner_id, skill_id, version_id)
            self._synchronize_files(owner_id)
            return result
        except psycopg.Error:
            raise SkillLibraryPersistenceError("Skill 回滚失败。") from None

    def rollback_locked(self, connection, owner_id, skill_id, version_id, *, scope=None):
        """调用方持有owner锁；回滚只切版本，绝不撤销用户停用。"""
        from notalone.persistence.skill_version_lineage import capture_parent_publications
        from notalone.skills.learning import SkillLearningInvalid
        self._ensure_library_row(connection, owner_id)
        skill = self._lock_skill(connection, owner_id=owner_id, skill_id=skill_id, operation="回滚")
        target = connection.execute(
            "SELECT id,version_number,description,review_origin FROM public.reply_skill_version "
            "WHERE id=%s AND skill_id=%s AND status='active' AND enabled AND (content IS NOT NULL OR content_path IS NOT NULL) FOR UPDATE",
            (version_id, skill_id)).fetchone()
        if target is None:
            raise SkillVersionNotFoundError("Skill 回滚失败：目标版本不可用。")
        try:
            read_version_content(connection, version_id)
        except SkillFileError:
            raise SkillVersionNotFoundError("Skill 回滚失败：目标文件不可用。") from None
        if target['review_origin']:
            origin = connection.execute(
                'SELECT origin_contact_id FROM public.reply_skill_publication WHERE version_id=%s AND owner_id=%s AND NOT deleted',
                (version_id, owner_id)).fetchone()
            if origin is None:
                raise SkillVersionNotFoundError("Skill 回滚失败：目标来源不可用。")
            scope = scope or ContactScope(owner_id, origin['origin_contact_id'])
        if scope is not None:
            try:
                proof, _ = capture_parent_publications(connection, scope, {version_id})
                if len(proof) != 1:
                    raise SkillLearningInvalid()
            except SkillLearningInvalid:
                raise SkillVersionNotFoundError("Skill 回滚失败：目标来源或范围不可用。") from None
        current_row = connection.execute('SELECT id FROM public.reply_skill_version WHERE skill_id=%s AND is_current', (skill_id,)).fetchone()
        current = current_row['id'] if current_row else None
        if current != version_id:
            connection.execute('UPDATE public.reply_skill_version SET is_current=false WHERE skill_id=%s AND is_current', (skill_id,))
            connection.execute('UPDATE public.reply_skill_version SET is_current=true WHERE id=%s', (version_id,))
            connection.execute('UPDATE public.reply_skill SET description=%s,updated_at=now() WHERE id=%s', (target['description'], skill_id))
            revision = self._increment_revision(connection, owner_id)
            queue_working_copy(connection, skill_id, version_id)
        else:
            revision = self._current_revision(connection, owner_id)
        return self._result(connection, owner_id=owner_id, skill_id=skill_id, version_id=version_id,
                            version_number=target['version_number'], revision=revision, status=skill['status'])

    @staticmethod
    def _require_version_sources(connection, owner_id, version_id):
        from notalone.persistence.skill_version_lineage import capture_parent_publications
        from notalone.skills.learning import SkillLearningInvalid
        row = connection.execute(
            'SELECT version.review_origin,publication.origin_contact_id FROM public.reply_skill_version AS version '
            'LEFT JOIN public.reply_skill_publication AS publication ON publication.version_id=version.id WHERE version.id=%s',
            (version_id,)).fetchone()
        if row is None or row['review_origin'] and row['origin_contact_id'] is None:
            raise SkillVersionNotFoundError('Skill 来源不可用。')
        if row['review_origin']:
            try:
                proof, _ = capture_parent_publications(connection, ContactScope(owner_id, row['origin_contact_id']), {version_id})
                if len(proof) != 1:
                    raise SkillLearningInvalid()
            except SkillLearningInvalid:
                raise SkillVersionNotFoundError('Skill 来源不可用。') from None

    def _set_skill_status(
        self,
        owner_id: UUID,
        skill_id: UUID,
        status: str,
    ) -> SkillVersionResult:
        if not isinstance(owner_id, UUID) or not isinstance(skill_id, UUID):
            raise TypeError("Skill 管理标识必须是 UUID。")
        operation = "启用" if status == "active" else "停用"
        try:
            with self._connect() as connection:
                self._ensure_library_row(connection, owner_id)
                skill = self._lock_skill(
                    connection,
                    owner_id=owner_id,
                    skill_id=skill_id,
                    operation=operation,
                )
                if skill["status"] != status:
                    connection.execute(
                        """
                        UPDATE public.reply_skill
                        SET status = %s, updated_at = now()
                        WHERE id = %s
                        """,
                        (status, skill_id),
                    )
                    revision = self._increment_revision(connection, owner_id)
                else:
                    revision = self._current_revision(connection, owner_id)
                result = self._result(
                    connection,
                    owner_id=owner_id,
                    skill_id=skill_id,
                    version_id=self._current_version_id(connection, skill_id),
                    version_number=self._current_version_number(
                        connection,
                        skill_id,
                    ),
                    revision=revision,
                    status=status,
                )
        except (
            SkillNotFoundError,
            SkillDeletedError,
            SkillLibraryPersistenceError,
        ):
            raise
        except psycopg.Error:
            raise SkillLibraryPersistenceError(
                f"Skill {operation}失败。"
            ) from None
        return result

    def delete(
        self,
        owner_id: UUID,
        skill_id: UUID,
    ) -> SkillDeletionResult:
        """清除 Skill 的全部版本正文、辅助资源、来源定位与内容哈希。

        事务成功后只保留不含正文和资源内容的最小删除凭证。
        """

        if not isinstance(owner_id, UUID) or not isinstance(skill_id, UUID):
            raise TypeError("Skill 删除标识必须是 UUID。")
        operation_id = uuid4()
        try:
            with self._connect() as connection:
                from notalone.persistence.locks import lock_owner_scope
                lock_owner_scope(connection, owner_id=owner_id)
                skill = connection.execute(
                    """
                    SELECT id, name, status, deletion_operation_id
                    FROM public.reply_skill
                    WHERE id = %s AND owner_id = %s
                    FOR UPDATE
                    """,
                    (skill_id, owner_id),
                ).fetchone()
                if skill is None:
                    raise SkillNotFoundError("Skill 删除失败：Skill 不存在。")
                from notalone.managed_update_backups import erase_managed_update_backups
                erase_managed_update_backups(connection)
                if skill["status"] == "deleted":
                    cleanup_pending_files(connection, owner_id=owner_id)
                    from notalone.persistence.skill_file_cleanup import _has_pending_files
                    if _has_pending_files(connection, owner_id):
                        raise SkillLibraryPersistenceError('Skill 文件删除尚未完成，请重试。')
                    revision = self._current_revision(connection, owner_id)
                    return SkillDeletionResult(
                        owner_id=owner_id,
                        skill_id=skill_id,
                        name=skill["name"],
                        revision=revision,
                        deletion_operation_id=skill["deletion_operation_id"],
                    )
                from notalone.persistence.skill_learning import erase_skill_learning
                version_rows = connection.execute('SELECT id FROM public.reply_skill_version WHERE skill_id=%s', (skill_id,)).fetchall()
                erase_skill_learning(connection, owner_id=owner_id,
                                     removed_ids={skill_id} | {row['id'] for row in version_rows})
                queue_skill_file_cleanup(connection, skill_id=skill_id)
                connection.execute(
                    """
                    UPDATE public.reply_skill_version
                    SET content = NULL,
                        content_path = NULL,
                        document_sha256 = NULL,
                        method_manifest_path = NULL,
                        method_manifest_sha256 = NULL,
                        content_sha256 = NULL,
                        source_locator = NULL,
                        validation_warnings = '[]'::jsonb,
                        enabled = FALSE,
                        is_current = FALSE,
                        status = 'deleted',
                        deleted_at = now()
                    WHERE skill_id = %s AND status = 'active'
                    """,
                    (skill_id,),
                )
                connection.execute(
                    """
                    DELETE FROM public.reply_skill_resource
                    WHERE skill_version_id IN (
                        SELECT id
                        FROM public.reply_skill_version
                        WHERE skill_id = %s
                    )
                    """,
                    (skill_id,),
                )
                connection.execute(
                    """
                    UPDATE public.reply_skill
                    SET status = 'deleted',
                        deleted_at = now(),
                        deletion_operation_id = %s,
                        deletion_error_code = NULL,
                        updated_at = now()
                    WHERE id = %s
                    """,
                    (operation_id, skill_id),
                )
                revision = self._increment_revision(connection, owner_id)
        except (
            SkillNotFoundError,
            SkillLibraryPersistenceError,
        ):
            raise
        except psycopg.Error:
            raise SkillLibraryPersistenceError("Skill 删除失败。") from None
        self._synchronize_files(owner_id)
        return SkillDeletionResult(
            owner_id=owner_id,
            skill_id=skill_id,
            name=skill["name"],
            revision=revision,
            deletion_operation_id=operation_id,
        )

    @staticmethod
    def _ensure_owner(connection: Any, owner_id: UUID) -> None:
        owner_row = connection.execute(
            "SELECT 1 FROM public.owner WHERE id = %s",
            (owner_id,),
        ).fetchone()
        if owner_row is None:
            raise SkillOwnerNotFoundError("Skill 导入失败：Owner 不存在。")

    def export_package(
        self,
        owner_id: UUID,
        skill_id: UUID,
        destination_path: str | Path,
    ) -> SkillExportResult:
        """把当前版本的 Skill 包内容导出到用户指定的本地目录。"""

        if not isinstance(owner_id, UUID) or not isinstance(skill_id, UUID):
            raise TypeError("Skill 导出标识必须是 UUID。")
        if not isinstance(destination_path, (str, Path)):
            raise TypeError("Skill 导出目标路径必须是 str 或 Path。")
        try:
            with self._connect() as connection:
                skill = connection.execute(
                    """
                    SELECT id, name
                    FROM public.reply_skill
                    WHERE id = %s AND owner_id = %s AND status <> 'deleted'
                    """,
                    (skill_id, owner_id),
                ).fetchone()
                if skill is None:
                    raise SkillNotFoundError("Skill 导出失败：Skill 不存在。")
                current = connection.execute(
                    """
                    SELECT id, version_number, name, description, content
                    FROM public.reply_skill_version
                    WHERE skill_id = %s AND is_current = TRUE
                      AND status = 'active' AND (content IS NOT NULL OR content_path IS NOT NULL)
                    """,
                    (skill_id,),
                ).fetchone()
                if current is None:
                    raise SkillVersionNotFoundError(
                        "Skill 导出失败：当前版本不可用。",
                    )
                self._require_version_sources(connection, owner_id, current['id'])
                current['content'] = read_version_content(connection, current['id'])
                resource_rows = connection.execute(
                    """
                    SELECT relative_path, content
                    FROM public.reply_skill_resource
                    WHERE skill_version_id = %s
                    ORDER BY relative_path
                    """,
                    (current["id"],),
                ).fetchall()
                for resource in resource_rows:
                    resource['content'] = read_resource_content(connection, current['id'], resource['relative_path'])
        except (SkillNotFoundError, SkillVersionNotFoundError):
            raise
        except (psycopg.Error, SkillFileError):
            raise SkillLibraryPersistenceError("Skill 导出失败。") from None

        skill_bytes = self._serialize_skill_document(
            current["name"],
            current["description"],
            current["content"],
        )
        destination = Path(destination_path)
        try:
            destination.mkdir(parents=True, exist_ok=True)
            (destination / "SKILL.md").write_bytes(skill_bytes)
            for resource in resource_rows:
                target = destination / resource["relative_path"]
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(bytes(resource["content"]))
        except OSError:
            raise SkillLibraryPersistenceError(
                "Skill 导出失败。"
            ) from None
        return SkillExportResult(
            owner_id=owner_id,
            skill_id=skill_id,
            name=current["name"],
            version_number=current["version_number"],
            resource_paths=tuple(
                resource["relative_path"] for resource in resource_rows
            ),
            destination=str(destination),
            package_sha256=self._exported_package_hash(
                skill_bytes,
                resource_rows,
            ),
        )

    def preview(
        self,
        *,
        scope: ContactScope,
        skill_id: UUID,
        context: object,
        engine: Any,
    ) -> SkillPreview:
        """验证范围与 Skill 版本后，用指定的单 Skill 目录执行试用预览。"""

        if not isinstance(scope, ContactScope):
            raise TypeError("Skill 试用范围必须是 ContactScope。")
        if not isinstance(skill_id, UUID):
            raise TypeError("skill_id 必须是 UUID。")
        if not callable(getattr(engine, "generate", None)):
            raise TypeError("Skill 试用必须提供预览执行器。")
        revision = 0
        entry: SkillCatalogEntry | None = None
        try:
            with self._connect() as connection:
                revision_row = connection.execute(
                    "SELECT revision FROM public.skill_library WHERE owner_id = %s",
                    (scope.owner_id,),
                ).fetchone()
                if revision_row is not None:
                    revision = revision_row["revision"]
                skill = connection.execute(
                    """
                    SELECT id, contact_id, status
                    FROM public.reply_skill
                    WHERE id = %s AND owner_id = %s AND status = 'active'
                    """,
                    (skill_id, scope.owner_id),
                ).fetchone()
                current = None
                if skill is not None and (
                    skill["contact_id"] is None
                    or skill["contact_id"] == scope.contact_id
                ):
                    current = connection.execute(
                        """
                        SELECT id, version_number, name, description
                        FROM public.reply_skill_version
                        WHERE skill_id = %s AND is_current = TRUE
                          AND status = 'active' AND enabled = TRUE
                          AND (content IS NOT NULL OR content_path IS NOT NULL)
                          AND name = (
                              SELECT name FROM public.reply_skill WHERE id = %s
                          )
                        """,
                        (skill_id, skill_id),
                    ).fetchone()
                if skill is not None and current is not None:
                    entry = SkillCatalogEntry(
                        skill_id=skill_id,
                        version_id=current["id"],
                        name=current["name"],
                        description=current["description"],
                        owner_id=scope.owner_id,
                        contact_id=skill["contact_id"],
                        version_number=current["version_number"],
                    )
        except psycopg.Error:
            raise SkillLibraryPersistenceError("Skill 试用失败。") from None
        if entry is None:
            return self._no_skill_preview(
                scope,
                "该 Skill 不可用于本次试用。",
            )
        catalog = SkillCatalog(
            scope=scope,
            revision=revision,
            entries=(entry,),
        )
        try:
            preview = engine.generate(
                scope=scope,
                context=context,
                catalog=catalog,
            )
        except Exception:
            return self._no_skill_preview(
                scope,
                "Skill 试用执行失败。",
            )
        if not isinstance(preview, SkillPreview) or preview.scope != scope:
            raise SkillLibraryPersistenceError("Skill 试用结果无效。")
        return preview

    @staticmethod
    def _no_skill_preview(scope: ContactScope, reason: str) -> SkillPreview:
        return SkillPreview(
            scope=scope,
            skill_id=None,
            version_id=None,
            name=None,
            candidates=(),
            selection_reason="未使用 Skill。",
            resource_paths=(),
            load_state="not_used",
            fallback_reason=reason,
        )

    @staticmethod
    def _serialize_skill_document(
        name: str,
        description: str,
        content: str,
    ) -> bytes:
        return (
            "---\n"
            f"name: {name}\n"
            f"description: {json.dumps(description, ensure_ascii=False)}\n"
            "---\n\n"
            f"{content}"
        ).encode("utf-8")

    @staticmethod
    def _exported_package_hash(
        skill_bytes: bytes,
        resources: list[Any],
    ) -> str:
        digest = hashlib.sha256()
        digest.update(b"SKILL.md\0")
        digest.update(skill_bytes)
        for resource in resources:
            digest.update(resource["relative_path"].encode("utf-8"))
            digest.update(b"\0")
            digest.update(bytes(resource["content"]))
            digest.update(b"\0")
        return digest.hexdigest()

    @staticmethod
    def _lock_skill(
        connection: Any,
        *,
        owner_id: UUID,
        skill_id: UUID,
        operation: str,
    ) -> Any:
        """锁定并校验一个属于该 Owner 且未删除的 Skill 行。"""

        skill = connection.execute(
            """
            SELECT id, name, status, deletion_operation_id
            FROM public.reply_skill
            WHERE id = %s AND owner_id = %s
            FOR UPDATE
            """,
            (skill_id, owner_id),
        ).fetchone()
        if skill is None:
            raise SkillNotFoundError(f"Skill {operation}失败：Skill 不存在。")
        if skill["status"] == "deleted":
            raise SkillDeletedError(f"Skill {operation}失败：Skill 已删除。")
        return skill

    @staticmethod
    def _ensure_library_row(connection: Any, owner_id: UUID) -> None:
        connection.execute(
            """
            INSERT INTO public.skill_library (owner_id, revision)
            VALUES (%s, 0)
            ON CONFLICT (owner_id) DO NOTHING
            """,
            (owner_id,),
        )

    @staticmethod
    def _increment_revision(connection: Any, owner_id: UUID) -> int:
        row = connection.execute(
            """
            UPDATE public.skill_library
            SET revision = revision + 1, updated_at = now()
            WHERE owner_id = %s
            RETURNING revision
            """,
            (owner_id,),
        ).fetchone()
        if row is None:
            raise SkillLibraryPersistenceError("Skill 目录修订写入失败。")
        return row["revision"]

    @staticmethod
    def _current_revision(connection: Any, owner_id: UUID) -> int:
        row = connection.execute(
            "SELECT revision FROM public.skill_library WHERE owner_id = %s",
            (owner_id,),
        ).fetchone()
        if row is None:
            raise SkillLibraryPersistenceError("Skill 目录修订读取失败。")
        return row["revision"]

    @staticmethod
    def _current_version_id(connection: Any, skill_id: UUID) -> UUID:
        row = connection.execute(
            """
            SELECT id FROM public.reply_skill_version
            WHERE skill_id = %s AND is_current = TRUE
            """,
            (skill_id,),
        ).fetchone()
        if row is None or row["id"] is None:
            raise SkillLibraryPersistenceError("Skill 当前版本读取失败。")
        return row["id"]

    @staticmethod
    def _current_version_number(connection: Any, skill_id: UUID) -> int:
        row = connection.execute(
            """
            SELECT version_number FROM public.reply_skill_version
            WHERE skill_id = %s AND is_current = TRUE
            """,
            (skill_id,),
        ).fetchone()
        if row is None or row["version_number"] is None:
            raise SkillLibraryPersistenceError("Skill 当前版本读取失败。")
        return row["version_number"]

    @staticmethod
    def _result(
        connection: Any,
        *,
        owner_id: UUID,
        skill_id: UUID,
        version_id: UUID,
        version_number: int,
        revision: int,
        status: str,
    ) -> SkillVersionResult:
        return SkillVersionResult(
            owner_id=owner_id,
            skill_id=skill_id,
            version_id=version_id,
            name=connection.execute(
                "SELECT name FROM public.reply_skill WHERE id = %s",
                (skill_id,),
            ).fetchone()["name"],
            version_number=version_number,
            revision=revision,
            status=status,
        )

    def _insert_version_and_resources(
        self,
        connection: Any,
        *,
        skill_id: UUID,
        package: Any,
        version_number: int,
        version_id: UUID | None = None,
        write_working: bool = True,
    ) -> UUID:
        chosen_id = version_id or uuid4()
        owner_id = connection.execute('SELECT owner_id FROM public.reply_skill WHERE id=%s', (skill_id,)).fetchone()['owner_id']
        try:
            content_path, document_sha256 = write_version_package(
                owner_id=owner_id, skill_id=skill_id, version_id=chosen_id, package=package)
        except SkillFileError:
            raise SkillLibraryPersistenceError('Skill 文件发布失败。') from None
        connection.execute(
            """
            INSERT INTO public.reply_skill_version (
                id, skill_id, version_number, name, description, content,
                content_sha256, source_locator, validation_warnings,
                enabled, is_current, status, content_path, document_sha256
            )
            VALUES (
                %s, %s, %s, %s, %s, NULL, %s, %s, %s, TRUE, TRUE, 'active', %s, %s
            )
            """,
            (
                chosen_id,
                skill_id,
                version_number,
                package.name,
                package.description,
                package.content_sha256,
                f"local-package:{package.package_sha256}",
                Jsonb(list(package.warnings)),
                content_path,
                document_sha256,
            ),
        )
        for resource in package.resources:
            connection.execute(
                """
                INSERT INTO public.reply_skill_resource (
                    id, skill_version_id, relative_path, resource_kind,
                    media_type, byte_size, content_sha256, content, content_path
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, NULL, %s)
                """,
                (
                    uuid4(),
                    chosen_id,
                    resource.relative_path,
                    resource.resource_kind,
                    resource.media_type,
                    len(resource.content),
                    resource.content_sha256,
                    str(Path(content_path).parent / resource.relative_path),
                ),
            )
        if write_working:
            queue_working_copy(connection, skill_id, chosen_id)
        return chosen_id

    def skill_file_health(self, owner_id: UUID) -> dict[str, Any]:
        """可查询的文件同步/清理健康状态；只含计数、固定错误码与不可识别 ID。"""
        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        try:
            with self._connect() as connection:
                from notalone.persistence.skill_files import skill_file_health
                return skill_file_health(connection, owner_id)
        except psycopg.Error:
            raise SkillLibraryPersistenceError("Skill 文件健康状态读取失败。") from None

    def _synchronize_files(self, owner_id: UUID) -> None:
        try:
            with self._connect() as connection:
                from notalone.persistence.locks import lock_owner_scope
                lock_owner_scope(connection, owner_id=owner_id)
                cleanup_pending_files(connection, owner_id=owner_id)
                synchronize_working_copies(connection, owner_id=owner_id)
                cleanup_unreferenced_snapshots(connection, owner_id=owner_id)
                cleanup_pending_files(connection, owner_id=owner_id)
                from notalone.persistence.skill_file_cleanup import _has_pending_files
                pending = _has_pending_files(connection, owner_id)
            if pending:
                raise SkillLibraryPersistenceError('Skill 文件删除尚未完成，请重试。')
        except (psycopg.Error, SkillFileError, OSError):
            raise SkillLibraryPersistenceError('Skill 目录同步暂不可用，请重试。') from None

    def _connect(self) -> Any:
        return psycopg.connect(self._database_url, row_factory=dict_row)
