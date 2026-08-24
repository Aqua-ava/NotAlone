"""Skill Library 管理接口的 PostgreSQL 适配器。"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.skills import (
    LocalSkillPackageReader,
    SkillImportResult,
    SkillLibraryManagementPort,
    SkillPackageValidationError,
    SkillPackageValidator,
)


class SkillLibraryManagementError(RuntimeError):
    """Skill Library 管理失败，且不暴露 SQL、路径或正文。"""


class SkillOwnerNotFoundError(SkillLibraryManagementError):
    """目标 Owner 不存在。"""


class SkillNameConflictError(SkillLibraryManagementError):
    """同一 Owner 下已存在同名 Skill。"""


class SkillLibraryPersistenceError(SkillLibraryManagementError):
    """Skill Library 持久化失败。"""


class PostgresSkillLibrary(SkillLibraryManagementPort):
    """在 PostgreSQL 中原子发布用户明确选择的本地 Skill 包。"""

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
                owner_row = connection.execute(
                    "SELECT 1 FROM public.owner WHERE id = %s",
                    (owner_id,),
                ).fetchone()
                if owner_row is None:
                    raise SkillOwnerNotFoundError(
                        "Skill 导入失败：Owner 不存在。",
                    )

                connection.execute(
                    """
                    INSERT INTO public.skill_library (owner_id, revision)
                    VALUES (%s, 0)
                    ON CONFLICT (owner_id) DO NOTHING
                    """,
                    (owner_id,),
                )
                revision_row = connection.execute(
                    """
                    SELECT revision
                    FROM public.skill_library
                    WHERE owner_id = %s
                    FOR UPDATE
                    """,
                    (owner_id,),
                ).fetchone()
                if revision_row is None:
                    raise SkillLibraryPersistenceError("Skill 导入失败。")

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
                connection.execute(
                    """
                    INSERT INTO public.reply_skill_version (
                        id, skill_id, version_number, name, description, content,
                        content_sha256, source_locator, validation_warnings,
                        enabled, is_current, status
                    )
                    VALUES (
                        %s, %s, 1, %s, %s, %s, %s, %s, %s, TRUE, TRUE, 'active'
                    )
                    """,
                    (
                        version_id,
                        skill_id,
                        package.name,
                        package.description,
                        package.content,
                        package.content_sha256,
                        f"local-package:{package.package_sha256}",
                        Jsonb(list(package.warnings)),
                    ),
                )
                for resource in package.resources:
                    connection.execute(
                        """
                        INSERT INTO public.reply_skill_resource (
                            id, skill_version_id, relative_path, resource_kind,
                            media_type, byte_size, content_sha256, content
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        (
                            uuid4(),
                            version_id,
                            resource.relative_path,
                            resource.resource_kind,
                            resource.media_type,
                            len(resource.content),
                            resource.content_sha256,
                            resource.content,
                        ),
                    )
                updated_revision = connection.execute(
                    """
                    UPDATE public.skill_library
                    SET revision = revision + 1, updated_at = now()
                    WHERE owner_id = %s
                    RETURNING revision
                    """,
                    (owner_id,),
                ).fetchone()
                if updated_revision is None:
                    raise SkillLibraryPersistenceError("Skill 导入失败。")
                revision = updated_revision["revision"]
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

    def _connect(self) -> Any:
        return psycopg.connect(self._database_url, row_factory=dict_row)
