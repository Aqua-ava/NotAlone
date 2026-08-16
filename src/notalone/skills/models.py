"""回复 Skill Module 的领域值对象。"""

from __future__ import annotations

import re
from dataclasses import dataclass
from uuid import UUID

from notalone.scopes import ContactScope


_SKILL_NAME_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def _validate_skill_name(name: str) -> None:
    if (
        not isinstance(name, str)
        or len(name) > 64
        or _SKILL_NAME_PATTERN.fullmatch(name) is None
    ):
        raise ValueError("Skill 名称必须是小写字母、数字和单连字符。")


@dataclass(frozen=True, slots=True)
class SkillCatalogEntry:
    """目录扫描可见的不可变 Skill 版本元数据。"""

    skill_id: UUID
    version_id: UUID
    name: str
    description: str
    owner_id: UUID
    contact_id: UUID | None

    def __post_init__(self) -> None:
        if not isinstance(self.skill_id, UUID) or not isinstance(
            self.version_id,
            UUID,
        ):
            raise TypeError("Skill 和版本标识必须是 UUID。")
        if not isinstance(self.owner_id, UUID) or (
            self.contact_id is not None
            and not isinstance(self.contact_id, UUID)
        ):
            raise TypeError("Skill 归属标识必须是 UUID。")
        _validate_skill_name(self.name)
        if not isinstance(self.description, str) or not self.description.strip():
            raise ValueError("Skill 描述不能为空。")

    def applies_to(self, scope: ContactScope) -> bool:
        return self.owner_id == scope.owner_id and self.contact_id in (
            None,
            scope.contact_id,
        )


@dataclass(frozen=True, slots=True)
class SkillCatalog:
    """一次调用绑定的 Skill 目录快照。"""

    scope: ContactScope
    revision: int
    entries: tuple[SkillCatalogEntry, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.scope, ContactScope):
            raise TypeError("Skill 目录必须绑定联系人范围。")
        if not isinstance(self.revision, int) or self.revision < 0:
            raise ValueError("Skill 目录修订号不能为负数。")
        if not isinstance(self.entries, tuple) or any(
            not isinstance(entry, SkillCatalogEntry)
            or not entry.applies_to(self.scope)
            for entry in self.entries
        ):
            raise ValueError("Skill 目录包含当前联系人范围之外的元数据。")
        names = tuple(entry.name for entry in self.entries)
        if len(names) != len(set(names)):
            raise ValueError("Skill 目录中存在重复名称。")
        version_ids = tuple(entry.version_id for entry in self.entries)
        if len(version_ids) != len(set(version_ids)):
            raise ValueError("Skill 目录中存在重复版本。")


@dataclass(frozen=True, slots=True, repr=False)
class SkillVersion:
    """应用已批准并按 owner/contact 隔离的 Skill 正文。"""

    owner_id: UUID
    contact_id: UUID | None
    skill_id: UUID
    version_id: UUID
    name: str
    description: str
    content: str
    enabled: bool

    def __post_init__(self) -> None:
        if (
            not isinstance(self.owner_id, UUID)
            or (
                self.contact_id is not None
                and not isinstance(self.contact_id, UUID)
            )
            or not isinstance(self.skill_id, UUID)
            or not isinstance(self.version_id, UUID)
        ):
            raise TypeError("Skill 版本标识和归属必须是 UUID。")
        _validate_skill_name(self.name)
        if (
            not isinstance(self.description, str)
            or not self.description.strip()
            or not isinstance(self.content, str)
            or not self.content.strip()
            or not isinstance(self.enabled, bool)
        ):
            raise ValueError("Skill 描述、正文或启用状态无效。")

    def applies_to(self, scope: ContactScope) -> bool:
        return self.owner_id == scope.owner_id and self.contact_id in (
            None,
            scope.contact_id,
        )

    def matches(self, entry: SkillCatalogEntry) -> bool:
        return (
            self.skill_id == entry.skill_id
            and self.version_id == entry.version_id
            and self.name == entry.name
            and self.description == entry.description
            and self.owner_id == entry.owner_id
            and self.contact_id == entry.contact_id
        )


def validate_skill_version(
    skill: object,
    *,
    scope: ContactScope,
    entry: SkillCatalogEntry,
) -> SkillVersion:
    """防御性验证 adapter 返回值，避免错误查询造成跨联系人泄漏。"""

    if not isinstance(skill, SkillVersion):
        raise PermissionError("SkillPort 返回了无效对象。")
    if not skill.enabled or not skill.applies_to(scope) or not skill.matches(entry):
        raise PermissionError("SkillPort 返回了当前联系人范围之外的数据。")
    return skill
