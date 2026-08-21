"""只读 Reply Skill 的 PostgreSQL SkillPort 适配器。"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from notalone.scopes import ContactScope
from notalone.skills.models import SkillCatalog, SkillCatalogEntry, SkillVersion


_SKILL_UNAVAILABLE = "Skill 不可用。"


class SkillPortPersistenceError(RuntimeError):
    """不暴露 SQL、连接信息或 Skill 正文的持久化错误。"""


class PostgresSkillPort:
    """按已验证联系人范围只读 Skill 目录和当前不可变版本。"""

    __slots__ = ("_database_url",)

    def __init__(self, database_url: str) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url

    def catalog(self, scope: ContactScope) -> SkillCatalog:
        """读取当前 owner/contact 的目录快照和 owner 级修订。"""

        self._validate_scope(scope)
        try:
            with self._connect() as connection:
                connection.execute(
                    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
                )
                revision_row = connection.execute(
                    """
                    SELECT revision
                    FROM public.skill_library
                    WHERE owner_id = %s
                    """,
                    (scope.owner_id,),
                ).fetchone()
                rows = connection.execute(
                    """
                    SELECT skill.id AS skill_id,
                           skill.owner_id AS skill_owner_id,
                           skill.contact_id AS skill_contact_id,
                           skill.name AS skill_name,
                           skill.description AS skill_description,
                           version.id AS version_id,
                           version.name AS version_name,
                           version.description AS version_description
                    FROM public.reply_skill AS skill
                    JOIN public.reply_skill_version AS version
                      ON version.skill_id = skill.id
                    WHERE skill.owner_id = %s
                      AND (
                          skill.contact_id IS NULL
                          OR skill.contact_id = %s
                      )
                      AND skill.status = 'active'
                      AND version.status = 'active'
                      AND version.enabled = TRUE
                      AND version.is_current = TRUE
                      AND version.content IS NOT NULL
                      AND length(btrim(version.content)) > 0
                      AND version.name = skill.name
                    ORDER BY skill.contact_id NULLS FIRST,
                             version.name,
                             version.id
                    """,
                    (scope.owner_id, scope.contact_id),
                ).fetchall()
                revision = 0 if revision_row is None else revision_row["revision"]
                entries = tuple(self._catalog_entry(row) for row in rows)
            return SkillCatalog(scope=scope, revision=revision, entries=entries)
        except psycopg.Error:
            raise SkillPortPersistenceError("Skill 目录读取失败。") from None
        except (TypeError, ValueError):
            raise SkillPortPersistenceError("Skill 目录读取失败。") from None

    def load_version(self, scope: ContactScope, version_id: UUID) -> SkillVersion:
        """读取当前联系人范围内的一个当前启用 Skill 版本。"""

        self._validate_scope(scope)
        if not isinstance(version_id, UUID):
            raise TypeError("version_id 必须是 UUID。")
        try:
            with self._connect() as connection:
                connection.execute(
                    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
                )
                row = connection.execute(
                    """
                    SELECT skill.id AS skill_id,
                           skill.owner_id AS skill_owner_id,
                           skill.contact_id AS skill_contact_id,
                           skill.name AS skill_name,
                           version.id AS version_id,
                           version.name AS version_name,
                           version.description AS version_description,
                           version.content AS version_content,
                           version.enabled AS version_enabled
                    FROM public.reply_skill AS skill
                    JOIN public.reply_skill_version AS version
                      ON version.skill_id = skill.id
                    WHERE skill.owner_id = %s
                      AND (
                          skill.contact_id IS NULL
                          OR skill.contact_id = %s
                      )
                      AND skill.status = 'active'
                      AND version.id = %s
                      AND version.status = 'active'
                      AND version.enabled = TRUE
                      AND version.is_current = TRUE
                      AND version.content IS NOT NULL
                      AND length(btrim(version.content)) > 0
                      AND version.name = skill.name
                    """,
                    (scope.owner_id, scope.contact_id, version_id),
                ).fetchone()
                if row is None:
                    raise PermissionError(_SKILL_UNAVAILABLE)
                return SkillVersion(
                    owner_id=row["skill_owner_id"],
                    contact_id=row["skill_contact_id"],
                    skill_id=row["skill_id"],
                    version_id=row["version_id"],
                    name=row["version_name"],
                    description=row["version_description"],
                    content=row["version_content"],
                    enabled=row["version_enabled"],
                )
        except PermissionError:
            raise
        except psycopg.Error:
            raise SkillPortPersistenceError("Skill 正文读取失败。") from None
        except (TypeError, ValueError):
            raise PermissionError(_SKILL_UNAVAILABLE) from None

    def _connect(self) -> Any:
        return psycopg.connect(self._database_url, row_factory=dict_row)

    @staticmethod
    def _validate_scope(scope: ContactScope) -> None:
        if not isinstance(scope, ContactScope):
            raise TypeError("scope 必须是 ContactScope。")

    @staticmethod
    def _catalog_entry(row: Any) -> SkillCatalogEntry:
        if row["skill_name"] != row["version_name"]:
            raise ValueError("Skill 目录元数据不一致。")
        if row["skill_description"] != row["version_description"]:
            raise ValueError("Skill 目录元数据不一致。")
        return SkillCatalogEntry(
            skill_id=row["skill_id"],
            version_id=row["version_id"],
            name=row["version_name"],
            description=row["version_description"],
            owner_id=row["skill_owner_id"],
            contact_id=row["skill_contact_id"],
        )
