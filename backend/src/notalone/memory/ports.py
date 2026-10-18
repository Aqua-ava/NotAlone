"""关系记忆的生命周期接口。"""

from __future__ import annotations

from typing import Protocol
from uuid import UUID

from notalone.memory.dimension_evidence import DimensionEvidence

from notalone.memory.models import (
    MemoryChangeKind, MemoryRetirementReason,
    OwnerMemory,
    AdoptionMethod,
    ConfirmedMemory,
    MemoryCandidate,
    MemoryCandidateStatus,
    MemoryCategory,
)
from notalone.scopes import ContactScope


class MemoryPort(Protocol):
    """管理候选和已确认关系记忆的业务边界。"""

    def create_candidate(self, candidate: MemoryCandidate) -> MemoryCandidate:
        """保存一条带来源和联系人范围的待处理候选。"""

    def create_manual_candidate(self, candidate: MemoryCandidate) -> MemoryCandidate:
        """为手动录入创建一条 manual 来源并保存候选（同一事务）。"""

    def list_pending_candidates(self, scope: ContactScope) -> tuple[MemoryCandidate, ...]:
        """返回联系人范围内所有尚未处理的候选。"""

    def get_candidate(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
    ) -> MemoryCandidate:
        """按联系人范围读取候选，包括已经处理的候选。"""

    def confirm(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
        adoption_method: AdoptionMethod = AdoptionMethod.AUTO,
        expected_dimension_evidence: DimensionEvidence | None = None,
        expected_correction_decision_ids: tuple[UUID, ...] | None = None,
        expected_previous: ConfirmedMemory | None = None,
    ) -> ConfirmedMemory:
        """确认候选；复验当前依据，自动替代原版本时新旧变化须原子提交。"""

    def correct(
        self,
        *,
        scope: ContactScope,
        memory_id: UUID,
        text: str,
        category: MemoryCategory | None = None,
        change_kind: MemoryChangeKind = MemoryChangeKind.ERROR_CORRECTION,
    ) -> ConfirmedMemory:
        """修正现有记忆并保留其来源链。"""

    def reject_candidate(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
    ) -> MemoryCandidate:
        """拒绝一条尚未进入长期记忆的候选。"""

    def discard_candidate_with_fingerprint(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
    ) -> MemoryCandidate:
        """拒绝候选并写入删除指纹，阻止同一文本自动复活。"""

    def invalidate_candidate(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
    ) -> MemoryCandidate:
        """使一条候选失效，使其不能再被确认。"""

    def invalidate(self, *, scope: ContactScope, memory_id: UUID) -> ConfirmedMemory:
        """使记忆失效，但保留可审计的状态记录。"""

    def delete(self, *, scope: ContactScope, memory_id: UUID) -> ConfirmedMemory:
        """标记记忆删除，使其不再进入检索。"""

    def list_confirmed(self, scope: ContactScope, *, include_expired: bool = False) -> tuple[ConfirmedMemory, ...]:
        """读取当前有效记忆；管理回看可包含已过期、仍有活动来源的 active 资料。"""

    def list_versions(self, *, scope: ContactScope, memory_id: UUID) -> tuple[ConfirmedMemory, ...]:
        """读取指定资料的新旧版本、状态、修订及仍合法的来源。"""

    def revert_auto_update(self, *, scope: ContactScope, memory_id: UUID, expected_revision: int) -> ConfirmedMemory:
        """原子撤销自动叶子并恢复仍合法的旧版，保留 auto 采纳方式。"""

    def deleted_texts(self, scope: ContactScope) -> tuple[str, ...]:
        """返回该联系人范围内已删除记忆的文本，用于阻止自动提取复活。"""


class OwnerMemoryPort(Protocol):
    """管理用户自身事实的 owner 级记忆边界。"""

    def create(self, memory: OwnerMemory) -> OwnerMemory:
        """保存一条带来源与主题的 owner 级记忆。"""

    def confirm_candidate(
        self,
        *,
        candidate: MemoryCandidate,
        adoption_method: AdoptionMethod = AdoptionMethod.MANUAL,
        expected_correction_decision_ids: tuple[UUID, ...] | None = None,
        expected_previous: OwnerMemory | None = None,
    ) -> OwnerMemory:
        """原子确认 self 候选；自动替代只操作复验通过的原版本。"""

    def list_active(self, owner_id: UUID, *, include_expired: bool = False) -> tuple[OwnerMemory, ...]:
        """读取当前有效本人资料；管理回看可包含仍有活动来源的过期资料。"""

    def list_versions(self, *, owner_id: UUID, memory_id: UUID) -> tuple[OwnerMemory, ...]:
        """读取本人资料的版本链，保留原联系人来源依赖。"""

    def revert_auto_update(self, *, owner_id: UUID, memory_id: UUID, expected_revision: int) -> OwnerMemory:
        """撤销本人自动更新前复验完整参与来源及旧版。"""

    def correct(
        self, *, owner_id: UUID, memory_id: UUID, text: str,
        category: MemoryCategory | None = None,
        change_kind: MemoryChangeKind = MemoryChangeKind.ERROR_CORRECTION,
    ) -> OwnerMemory:
        """在同一事务创建手动新版本并使原本人资料失效。"""

    def delete(self, owner_id: UUID, memory_id: UUID) -> OwnerMemory:
        """软删除一条 owner 级记忆，保留文本指纹。"""

    def invalidate(self, owner_id: UUID, memory_id: UUID) -> OwnerMemory:
        """使一条 owner 级记忆失效（被新事实取代），不再进入检索。"""

    def deleted_texts(self, owner_id: UUID) -> tuple[str, ...]:
        """返回该用户已软删除记忆的文本，用于阻止自动提取复活。"""
