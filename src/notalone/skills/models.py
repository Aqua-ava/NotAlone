"""回复 Skill Module 的领域值对象。"""

from __future__ import annotations

import re
from dataclasses import dataclass
from hashlib import sha256
from typing import Literal
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
class SkillPackageResource:
    """已通过校验、绑定到 Skill 版本的本地辅助资源。"""

    relative_path: str
    resource_kind: Literal["reference", "asset"]
    media_type: str
    content: bytes
    content_sha256: str

    def __post_init__(self) -> None:
        parts = self.relative_path.split("/") if isinstance(
            self.relative_path,
            str,
        ) else ()
        if (
            not parts
            or parts[0] not in ("references", "assets")
            or any(not part or part in (".", "..") for part in parts)
            or any("\\" in part for part in parts)
        ):
            raise ValueError("Skill 辅助资源路径无效。")
        if self.resource_kind not in ("reference", "asset"):
            raise ValueError("Skill 辅助资源类型无效。")
        expected_kind = {
            "references": "reference",
            "assets": "asset",
        }[parts[0]]
        if self.resource_kind != expected_kind:
            raise ValueError("Skill 辅助资源类型与路径不一致。")
        if not isinstance(self.media_type, str) or not self.media_type.strip():
            raise ValueError("Skill 辅助资源媒体类型不能为空。")
        if not isinstance(self.content, bytes):
            raise TypeError("Skill 辅助资源内容必须是 bytes。")
        if (
            not isinstance(self.content_sha256, str)
            or self.content_sha256 != sha256(self.content).hexdigest()
        ):
            raise ValueError("Skill 辅助资源内容哈希无效。")


@dataclass(frozen=True, slots=True)
class SkillPackage:
    """本地 Skill 包通过完整校验后的内存表示。"""

    name: str
    description: str
    content: str
    content_sha256: str
    package_sha256: str
    resources: tuple[SkillPackageResource, ...]
    warnings: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _validate_skill_name(self.name)
        if not isinstance(self.description, str) or not self.description.strip():
            raise ValueError("Skill 描述不能为空。")
        if not isinstance(self.content, str) or not self.content.strip():
            raise ValueError("Skill 正文不能为空。")
        if self.content_sha256 != sha256(self.content.encode("utf-8")).hexdigest():
            raise ValueError("Skill 正文内容哈希无效。")
        if (
            not isinstance(self.package_sha256, str)
            or len(self.package_sha256) != 64
            or re.fullmatch(r"[0-9a-f]{64}", self.package_sha256) is None
        ):
            raise ValueError("Skill 包内容哈希无效。")
        if not isinstance(self.resources, tuple) or any(
            not isinstance(resource, SkillPackageResource)
            for resource in self.resources
        ):
            raise TypeError("Skill 辅助资源集合无效。")
        paths = tuple(resource.relative_path for resource in self.resources)
        if len(paths) != len(set(paths)):
            raise ValueError("Skill 辅助资源路径重复。")
        if not isinstance(self.warnings, tuple) or any(
            not isinstance(warning, str) or not warning.strip()
            for warning in self.warnings
        ):
            raise TypeError("Skill 校验警告无效。")


@dataclass(frozen=True, slots=True)
class SkillImportResult:
    """Skill 首次发布后返回给管理入口的非正文结果。"""

    owner_id: UUID
    skill_id: UUID
    version_id: UUID
    name: str
    version_number: int
    revision: int
    resource_paths: tuple[str, ...]
    warnings: tuple[str, ...] = ()
    status: Literal["active"] = "active"

    def __post_init__(self) -> None:
        if not all(
            isinstance(value, UUID)
            for value in (self.owner_id, self.skill_id, self.version_id)
        ):
            raise TypeError("Skill 导入结果标识必须是 UUID。")
        _validate_skill_name(self.name)
        if not isinstance(self.version_number, int) or self.version_number < 1:
            raise ValueError("Skill 版本号无效。")
        if not isinstance(self.revision, int) or self.revision < 1:
            raise ValueError("Skill 目录修订号无效。")
        if not isinstance(self.resource_paths, tuple) or any(
            not isinstance(path, str) or not path.strip()
            for path in self.resource_paths
        ):
            raise TypeError("Skill 资源路径结果无效。")
        if len(self.resource_paths) != len(set(self.resource_paths)):
            raise ValueError("Skill 资源路径结果重复。")
        if not isinstance(self.warnings, tuple) or any(
            not isinstance(warning, str) or not warning.strip()
            for warning in self.warnings
        ):
            raise TypeError("Skill 导入警告无效。")


_RESOURCE_PATH_PREFIXES = ("references", "assets")


def _validate_resource_relative_path(relative_path: str) -> tuple[str, ...]:
    parts = relative_path.split("/") if isinstance(relative_path, str) else ()
    if (
        not parts
        or parts[0] not in _RESOURCE_PATH_PREFIXES
        or any(not part or part in (".", "..") for part in parts)
        or any("\\" in part for part in parts)
    ):
        raise ValueError("Skill 辅助资源路径无效。")
    return tuple(parts)


@dataclass(frozen=True, slots=True)
class SkillResource:
    """按已验证范围读取一个版本允许的受控辅助资源后的结果。"""

    owner_id: UUID
    contact_id: UUID | None
    skill_id: UUID
    version_id: UUID
    relative_path: str
    resource_kind: Literal["reference", "asset"]
    media_type: str
    content: bytes
    content_sha256: str

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
            raise TypeError("Skill 资源归属和标识必须是 UUID。")
        parts = _validate_resource_relative_path(self.relative_path)
        if self.resource_kind not in ("reference", "asset"):
            raise ValueError("Skill 辅助资源类型无效。")
        expected_kind = {
            "references": "reference",
            "assets": "asset",
        }[parts[0]]
        if self.resource_kind != expected_kind:
            raise ValueError("Skill 辅助资源类型与路径不一致。")
        if not isinstance(self.media_type, str) or not self.media_type.strip():
            raise ValueError("Skill 辅助资源媒体类型不能为空。")
        if not isinstance(self.content, bytes):
            raise TypeError("Skill 辅助资源内容必须是 bytes。")
        if (
            not isinstance(self.content_sha256, str)
            or self.content_sha256 != sha256(self.content).hexdigest()
        ):
            raise ValueError("Skill 辅助资源内容哈希无效。")

    def applies_to(self, scope: ContactScope) -> bool:
        return self.owner_id == scope.owner_id and self.contact_id in (
            None,
            scope.contact_id,
        )

    def matches(self, version: SkillVersion) -> bool:
        return (
            self.skill_id == version.skill_id
            and self.version_id == version.version_id
            and self.owner_id == version.owner_id
            and self.contact_id == version.contact_id
            and self.relative_path in version.resource_paths
        )


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
    resource_paths: tuple[str, ...] = ()

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
        if not isinstance(self.resource_paths, tuple) or any(
            not isinstance(path, str) or not path.strip()
            for path in self.resource_paths
        ):
            raise TypeError("Skill 辅助资源路径清单无效。")
        if len(self.resource_paths) != len(set(self.resource_paths)):
            raise ValueError("Skill 辅助资源路径清单重复。")
        for path in self.resource_paths:
            _validate_resource_relative_path(path)

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
