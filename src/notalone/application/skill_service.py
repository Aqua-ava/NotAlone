"""Skill 管理与台账概览的统一应用层入口。

Skill 管理操作直接复用既有管理端口（PostgresSkillLibrary），列表与
预览只投影元数据与受控资源，不暴露联系人资料；台账概览只含调用
元数据，不含正文，按 owner 隔离。
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol
from uuid import UUID

from notalone.persistence.skill_library import SkillNameConflictError
from notalone.skills import SkillPackageValidationError
from notalone.skills.models import (
    SkillDeletionResult,
    SkillImportResult,
    SkillManagementEntry,
    SkillVersionResult,
)


class SkillManagement(Protocol):
    """复用既有 Skill Library 管理端口的最小边界。"""

    def list_owner_skills(self, owner_id: UUID) -> tuple[SkillManagementEntry, ...]: ...

    def read_current_version(
        self,
        owner_id: UUID,
        skill_id: UUID,
    ) -> tuple[str, str, int, tuple[str, ...]]:
        """返回当前版本投影（文档内容、描述、版本号、资源路径清单）。"""

    def import_package(
        self,
        owner_id: UUID,
        package_path: str | Path,
    ) -> SkillImportResult: ...

    def enable(self, owner_id: UUID, skill_id: UUID) -> SkillVersionResult: ...

    def disable(self, owner_id: UUID, skill_id: UUID) -> SkillVersionResult: ...

    def rollback(
        self,
        owner_id: UUID,
        skill_id: UUID,
        version_id: UUID,
    ) -> SkillVersionResult: ...

    def delete(self, owner_id: UUID, skill_id: UUID) -> SkillDeletionResult: ...

    def export_package(
        self,
        owner_id: UUID,
        skill_id: UUID,
        destination_path: str | Path,
    ) -> object: ...


class SkillImportRejected(Exception):
    """Skill 包校验或发布被拒绝；reason 为稳定码。"""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


class SkillService:
    """Skill 管理的薄壳：列表、导入、生命周期与版本预览。"""

    __slots__ = ("_management",)

    def __init__(self, *, management: SkillManagement) -> None:
        self._management = management

    def list(self, *, owner_id: UUID) -> dict[str, object]:
        return {
            "skills": [
                {
                    "skill_id": str(entry.skill_id),
                    "name": entry.name,
                    "description": entry.description,
                    "status": entry.status,
                    "contact_id": (
                        None
                        if entry.contact_id is None
                        else str(entry.contact_id)
                    ),
                    "current_version_id": (
                        None
                        if entry.current_version_id is None
                        else str(entry.current_version_id)
                    ),
                    "current_version_number": entry.current_version_number,
                    "enabled": entry.enabled,
                }
                for entry in self._management.list_owner_skills(owner_id)
            ]
        }

    def import_skill(
        self,
        *,
        owner_id: UUID,
        package_path: str,
    ) -> dict[str, object]:
        try:
            result = self._management.import_package(
                owner_id,
                Path(package_path),
            )
        except SkillNameConflictError as error:
            # 名称已存在：需要显式 update，界面可据此提示。
            raise SkillImportRejected("name_conflict") from error
        except SkillPackageValidationError as error:
            raise SkillImportRejected("package_invalid") from error
        return {
            "skill_id": str(result.skill_id),
            "name": result.name,
            "version_number": result.version_number,
            "revision": result.revision,
            "warnings": list(result.warnings),
        }

    def enable(self, *, owner_id: UUID, skill_id: UUID) -> dict[str, object]:
        result = self._management.enable(owner_id, skill_id)
        return {"skill_id": str(result.skill_id), "status": result.status}

    def disable(self, *, owner_id: UUID, skill_id: UUID) -> dict[str, object]:
        result = self._management.disable(owner_id, skill_id)
        return {"skill_id": str(result.skill_id), "status": result.status}

    def rollback(
        self,
        *,
        owner_id: UUID,
        skill_id: UUID,
        version_id: UUID,
    ) -> dict[str, object]:
        result = self._management.rollback(owner_id, skill_id, version_id)
        return {
            "skill_id": str(result.skill_id),
            "version_number": result.version_number,
            "status": result.status,
        }

    def delete(self, *, owner_id: UUID, skill_id: UUID) -> dict[str, object]:
        result = self._management.delete(owner_id, skill_id)
        return {
            "skill_id": str(result.skill_id),
            "name": result.name,
            "deleted": True,
        }

    def preview(self, *, owner_id: UUID, skill_id: UUID) -> dict[str, object]:
        """投影当前版本内容与资源清单（不落盘、不暴露联系人资料）。"""

        document, description, version_number, resource_paths = (
            self._management.read_current_version(owner_id, skill_id)
        )
        return {
            "skill_id": str(skill_id),
            "name": None,
            "description": description,
            "version_number": version_number,
            "document": document,
            "resources": list(resource_paths),
        }


class LedgerQuery(Protocol):
    """出站台账的最小查询边界（与 OutboundLedgerPort.list_by_owner 一致）。"""

    def list_by_owner(self, owner_id: UUID) -> tuple: ...


class LedgerService:
    """出站台账概览的薄壳：只投影元数据，不含正文，按 owner 隔离。"""

    __slots__ = ("_ledger",)

    def __init__(self, *, ledger: LedgerQuery) -> None:
        self._ledger = ledger

    def summary(self, *, owner_id: UUID) -> dict[str, object]:
        from notalone.ledger.models import LedgerOutcome

        entries = self._ledger.list_by_owner(owner_id)
        provider_counts: dict[str, int] = {}
        outcome_counts: dict[str, int] = {}
        total_input = 0
        total_output = 0
        for entry in entries:
            provider_counts[entry.provider] = (
                provider_counts.get(entry.provider, 0) + 1
            )
            outcome_counts[entry.outcome.value] = (
                outcome_counts.get(entry.outcome.value, 0) + 1
            )
            if entry.input_tokens is not None:
                total_input += entry.input_tokens
            if entry.output_tokens is not None:
                total_output += entry.output_tokens
        recent = [
            {
                "entry_id": str(entry.entry_id),
                "contact_id": str(entry.contact_id),
                "provider": entry.provider,
                "model_name": entry.model_name,
                "input_tokens": entry.input_tokens,
                "output_tokens": entry.output_tokens,
                "latency_ms": entry.latency_ms,
                "outcome": entry.outcome.value,
                "called_at": entry.called_at.isoformat(),
            }
            for entry in entries[-10:]
        ]
        return {
            "total_calls": len(entries),
            "provider_counts": provider_counts,
            "outcome_counts": outcome_counts,
            "total_input_tokens": total_input,
            "total_output_tokens": total_output,
            "recent": recent,
        }