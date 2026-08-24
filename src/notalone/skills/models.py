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


def validate_resource_relative_path(relative_path: str) -> tuple[str, ...]:
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
        parts = validate_resource_relative_path(self.relative_path)
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
class SkillVersionResult:
    """更新、启用、停用或回滚后返回的最小非正文生命周期结果。"""

    owner_id: UUID
    skill_id: UUID
    version_id: UUID
    name: str
    version_number: int
    revision: int
    status: Literal["active", "disabled"] = "active"

    def __post_init__(self) -> None:
        if not all(
            isinstance(value, UUID)
            for value in (self.owner_id, self.skill_id, self.version_id)
        ):
            raise TypeError("Skill 生命周期结果标识必须是 UUID。")
        _validate_skill_name(self.name)
        if not isinstance(self.version_number, int) or self.version_number < 1:
            raise ValueError("Skill 版本号无效。")
        if not isinstance(self.revision, int) or self.revision < 1:
            raise ValueError("Skill 目录修订号无效。")
        if self.status not in ("active", "disabled"):
            raise ValueError("Skill 状态无效。")


@dataclass(frozen=True, slots=True)
class SkillDeletionResult:
    """删除完成后保留的最小不可恢复删除凭证。"""

    owner_id: UUID
    skill_id: UUID
    name: str
    revision: int
    deletion_operation_id: UUID | None = None

    def __post_init__(self) -> None:
        if (
            not isinstance(self.owner_id, UUID)
            or not isinstance(self.skill_id, UUID)
        ):
            raise TypeError("Skill 删除凭证标识必须是 UUID。")
        _validate_skill_name(self.name)
        if not isinstance(self.revision, int) or self.revision < 1:
            raise ValueError("Skill 目录修订号无效。")
        if self.deletion_operation_id is not None and not isinstance(
            self.deletion_operation_id,
            UUID,
        ):
            raise TypeError("Skill 删除操作标识必须是 UUID。")


@dataclass(frozen=True, slots=True)
class SkillExportResult:
    """导出可移植 Skill 包后返回的非正文结果。"""

    owner_id: UUID
    skill_id: UUID
    name: str
    version_number: int
    resource_paths: tuple[str, ...]
    destination: str
    package_sha256: str

    def __post_init__(self) -> None:
        if not isinstance(self.owner_id, UUID) or not isinstance(
            self.skill_id,
            UUID,
        ):
            raise TypeError("Skill 导出结果标识必须是 UUID。")
        _validate_skill_name(self.name)
        if not isinstance(self.version_number, int) or self.version_number < 1:
            raise ValueError("Skill 版本号无效。")
        if not isinstance(self.resource_paths, tuple) or any(
            not isinstance(path, str) or not path.strip()
            for path in self.resource_paths
        ):
            raise TypeError("Skill 导出资源路径无效。")
        if len(self.resource_paths) != len(set(self.resource_paths)):
            raise ValueError("Skill 导出资源路径重复。")
        if not isinstance(self.destination, str) or not self.destination.strip():
            raise ValueError("Skill 导出目标路径不能为空。")
        if (
            not isinstance(self.package_sha256, str)
            or re.fullmatch(r"[0-9a-f]{64}", self.package_sha256) is None
        ):
            raise ValueError("Skill 导出包哈希无效。")


@dataclass(frozen=True, slots=True)
class PreviewCandidate:
    """试用预览中的一条可编辑候选回复，不落库。"""

    text: str
    basis: str
    risk_notes: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.text, str) or not self.text.strip():
            raise ValueError("预览候选正文不能为空。")
        if not isinstance(self.basis, str) or not self.basis.strip():
            raise ValueError("预览候选依据不能为空。")
        if not isinstance(self.risk_notes, tuple) or any(
            not isinstance(note, str) or not note.strip()
            for note in self.risk_notes
        ):
            raise TypeError("预览候选风险提示无效。")


@dataclass(frozen=True, slots=True)
class SkillPreview:
    """在选定 Reply Task 上试用指定 Skill 的应用内候选预览。"""

    scope: ContactScope
    skill_id: UUID | None
    version_id: UUID | None
    name: str | None
    candidates: tuple[PreviewCandidate, ...]
    selection_reason: str
    resource_paths: tuple[str, ...]
    load_state: Literal["loaded", "resource_failed", "not_used"]
    fallback_reason: str = ""

    def __post_init__(self) -> None:
        if not isinstance(self.scope, ContactScope):
            raise TypeError("Skill 试用预览必须绑定联系人范围。")
        if self.load_state == "not_used":
            if (
                self.skill_id is not None
                or self.version_id is not None
                or self.name is not None
            ):
                raise ValueError("Skill 无 Skill 预览状态不一致。")
        else:
            if (
                not isinstance(self.skill_id, UUID)
                or not isinstance(self.version_id, UUID)
                or not isinstance(self.name, str)
                or not self.name.strip()
            ):
                raise ValueError("Skill 试用预览 Skill 摘要无效。")
            if not isinstance(self.candidates, tuple) or not self.candidates or any(
                not isinstance(candidate, PreviewCandidate)
                for candidate in self.candidates
            ):
                raise ValueError("Skill 试用预览必须包含候选。")
        if not isinstance(self.candidates, tuple) or any(
            not isinstance(candidate, PreviewCandidate)
            for candidate in self.candidates
        ):
            raise TypeError("Skill 试用预览候选无效。")
        if not isinstance(self.selection_reason, str) or not self.selection_reason:
            raise ValueError("Skill 选择原因不能为空。")
        if not isinstance(self.resource_paths, tuple) or any(
            not isinstance(path, str) or not path.strip()
            for path in self.resource_paths
        ):
            raise TypeError("Skill 预览资源路径无效。")
        if not isinstance(self.fallback_reason, str):
            raise TypeError("Skill 预览回退原因必须是字符串。")


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
            validate_resource_relative_path(path)

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
