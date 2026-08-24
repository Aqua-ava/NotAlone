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

    def rollback(
        self,
        owner_id: UUID,
        skill_id: UUID,
        version_id: UUID,
    ) -> SkillVersionResult:
        """把已保留的旧版本设为 current 并恢复可用。"""

        if not isinstance(owner_id, UUID) or not isinstance(
            skill_id,
            UUID,
        ) or not isinstance(version_id, UUID):
            raise TypeError("Skill 回滚标识必须是 UUID。")
        try:
            with self._connect() as connection:
                self._ensure_library_row(connection, owner_id)
                skill = connection.execute(
                    """
                    SELECT id, status
                    FROM public.reply_skill
                    WHERE id = %s AND owner_id = %s
                    FOR UPDATE
                    """,
                    (skill_id, owner_id),
                ).fetchone()
                if skill is None:
                    raise SkillNotFoundError("Skill 回滚失败：Skill 不存在。")
                if skill["status"] == "deleted":
                    raise SkillDeletedError("Skill 回滚失败：Skill 已删除。")
                target = connection.execute(
                    """
                    SELECT version_number
                    FROM public.reply_skill_version
                    WHERE id = %s AND skill_id = %s AND status = 'active'
                      AND content IS NOT NULL AND length(btrim(content)) > 0
                    FOR UPDATE
                    """,
                    (version_id, skill_id),
                ).fetchone()
                if target is None:
                    raise SkillVersionNotFoundError(
                        "Skill 回滚失败：目标版本不可用。",
                    )
                current = connection.execute(
                    """
                    SELECT id, is_current
                    FROM public.reply_skill_version
                    WHERE skill_id = %s AND is_current = TRUE
                    FOR UPDATE
                    """,
                    (skill_id,),
                ).fetchone()
                if current is not None and current["id"] == version_id:
                    if skill["status"] == "active":
                        revision = self._current_revision(connection, owner_id)
                        return self._result(
                            connection,
                            owner_id=owner_id,
                            skill_id=skill_id,
                            version_id=version_id,
                            version_number=target["version_number"],
                            revision=revision,
                            status="active",
                        )
                connection.execute(
                    """
                    UPDATE public.reply_skill_version
                    SET is_current = FALSE
                    WHERE skill_id = %s AND is_current = TRUE
                    """,
                    (skill_id,),
                )
                connection.execute(
                    """
                    UPDATE public.reply_skill_version
                    SET is_current = TRUE, enabled = TRUE, status = 'active'
                    WHERE id = %s AND skill_id = %s
                    """,
                    (version_id, skill_id),
                )
                connection.execute(
                    """
                    UPDATE public.reply_skill
                    SET status = 'active', updated_at = now()
                    WHERE id = %s
                    """,
                    (skill_id,),
                )
                revision = self._increment_revision(connection, owner_id)
                result = self._result(
                    connection,
                    owner_id=owner_id,
                    skill_id=skill_id,
                    version_id=version_id,
                    version_number=target["version_number"],
                    revision=revision,
                    status="active",
                )
        except (
            SkillNotFoundError,
            SkillDeletedError,
            SkillVersionNotFoundError,
            SkillLibraryPersistenceError,
        ):
            raise
        except psycopg.Error:
            raise SkillLibraryPersistenceError("Skill 回滚失败。") from None
        return result

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
                skill = connection.execute(
                    """
                    SELECT id, status
                    FROM public.reply_skill
                    WHERE id = %s AND owner_id = %s
                    FOR UPDATE
                    """,
                    (skill_id, owner_id),
                ).fetchone()
                if skill is None:
                    raise SkillNotFoundError(
                        f"Skill {operation}失败：Skill 不存在。",
                    )
                if skill["status"] == "deleted":
                    raise SkillDeletedError(
                        f"Skill {operation}失败：Skill 已删除。",
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

    @staticmethod
    def _ensure_owner(connection: Any, owner_id: UUID) -> None:
        owner_row = connection.execute(
            "SELECT 1 FROM public.owner WHERE id = %s",
            (owner_id,),
        ).fetchone()
        if owner_row is None:
            raise SkillOwnerNotFoundError("Skill 导入失败：Owner 不存在。")

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
    ) -> UUID:
        chosen_id = version_id or uuid4()
        connection.execute(
            """
            INSERT INTO public.reply_skill_version (
                id, skill_id, version_number, name, description, content,
                content_sha256, source_locator, validation_warnings,
                enabled, is_current, status
            )
            VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, TRUE, TRUE, 'active'
            )
            """,
            (
                chosen_id,
                skill_id,
                version_number,
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
                    chosen_id,
                    resource.relative_path,
                    resource.resource_kind,
                    resource.media_type,
                    len(resource.content),
                    resource.content_sha256,
                    resource.content,
                ),
            )
        return chosen_id

    def _connect(self) -> Any:
        return psycopg.connect(self._database_url, row_factory=dict_row)
