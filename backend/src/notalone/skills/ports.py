"""回复 Skill Module 暴露给消费者的 Port。"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol
from uuid import UUID

from notalone.scopes import ContactScope
from notalone.skills.models import (
    SkillCatalog,
    SkillDeletionResult,
    SkillExportResult,
    SkillImportResult,
    SkillManagementEntry,
    SkillPreview,
    SkillResource,
    SkillVersion,
    SkillVersionResult,
    SkillVersionEntry,
)


class SkillPort(Protocol):
    """按已验证联系人范围读取策略目录、不可变版本和受控辅助资源。"""

    def catalog(self, scope: ContactScope) -> SkillCatalog: ...

    def load_version(
        self,
        scope: ContactScope,
        version_id: UUID,
    ) -> SkillVersion: ...

    def load_resource(
        self,
        scope: ContactScope,
        version_id: UUID,
        relative_path: str,
    ) -> SkillResource: ...


class SkillPreviewEngine(Protocol):
    """由应用层提供、在已验证范围内运行一次 Skill 试用的执行器。"""

    def generate(
        self,
        *,
        scope: ContactScope,
        context: object,
        catalog: SkillCatalog,
    ) -> SkillPreview: ...


class SkillLibraryManagementPort(Protocol):
    """供用户明确操作的 Skill Library 管理入口。"""

    def list_owner_skills(self, owner_id: UUID) -> tuple[SkillManagementEntry, ...]:
        """返回 owner 的全部 skill 管理视图（含 disabled/删除，不含资源内容）。"""

    def import_package(
        self,
        owner_id: UUID,
        package_path: str | Path,
    ) -> SkillImportResult: ...

    def update_package(
        self,
        owner_id: UUID,
        package_path: str | Path,
    ) -> SkillVersionResult: ...

    def enable(self, owner_id: UUID, skill_id: UUID) -> SkillVersionResult: ...

    def disable(self, owner_id: UUID, skill_id: UUID) -> SkillVersionResult: ...

    def list_versions(
        self,
        owner_id: UUID,
        skill_id: UUID,
    ) -> tuple[SkillVersionEntry, ...]:
        """返回该 skill 的历史版本（新到旧），供用户选择回滚目标。"""

    def rollback(
        self,
        owner_id: UUID,
        skill_id: UUID,
        version_id: UUID,
    ) -> SkillVersionResult: ...

    def delete(
        self,
        owner_id: UUID,
        skill_id: UUID,
    ) -> SkillDeletionResult: ...

    def export_package(
        self,
        owner_id: UUID,
        skill_id: UUID,
        destination_path: str | Path,
    ) -> SkillExportResult: ...

    def preview(
        self,
        *,
        scope: ContactScope,
        skill_id: UUID,
        context: object,
        engine: SkillPreviewEngine,
    ) -> SkillPreview: ...
