"""回复 Skill Module 暴露给消费者的 Port。"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol
from uuid import UUID

from notalone.scopes import ContactScope
from notalone.skills.models import SkillCatalog, SkillImportResult, SkillVersion


class SkillPort(Protocol):
    """按已验证联系人范围读取策略目录和不可变版本。"""

    def catalog(self, scope: ContactScope) -> SkillCatalog: ...

    def load_version(
        self,
        scope: ContactScope,
        version_id: UUID,
    ) -> SkillVersion: ...


class SkillLibraryManagementPort(Protocol):
    """供用户明确操作的 Skill Library 管理入口。"""

    def import_package(
        self,
        owner_id: UUID,
        package_path: str | Path,
    ) -> SkillImportResult: ...
