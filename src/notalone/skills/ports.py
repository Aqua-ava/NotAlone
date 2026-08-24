"""回复 Skill Module 暴露给消费者的 Port。"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol
from uuid import UUID

from notalone.scopes import ContactScope
from notalone.skills.models import (
    SkillCatalog,
    SkillDeletionResult,
    SkillImportResult,
    SkillResource,
    SkillVersion,
    SkillVersionResult,
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


class SkillLibraryManagementPort(Protocol):
    """供用户明确操作的 Skill Library 管理入口。"""

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
