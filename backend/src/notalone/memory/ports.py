"""关系记忆的生命周期接口。"""

from __future__ import annotations

from typing import Protocol
from uuid import UUID

from notalone.memory.dimension_evidence import DimensionEvidence

from notalone.memory.models import (
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
    ) -> ConfirmedMemory:
        """确认候选；提供当前依据时须在写入事务复核且不得丢失。"""

    def correct(
        self,
        *,
        scope: ContactScope,
        memory_id: UUID,
        text: str,
        category: MemoryCategory | None = None,
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

    def list_confirmed(self, scope: ContactScope) -> tuple[ConfirmedMemory, ...]:
        """返回指定联系人范围内当前有效的已确认记忆。"""

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
    ) -> OwnerMemory:
        """原子确认 self 候选并写入 owner 级记忆。"""

    def list_active(self, owner_id: UUID) -> tuple[OwnerMemory, ...]:
        """返回某位用户当前有效（active 且在有效期内）的 owner 级记忆。"""

    def correct(
        self, *, owner_id: UUID, memory_id: UUID, text: str,
        category: MemoryCategory | None = None,
    ) -> OwnerMemory:
        """在同一事务创建手动新版本并使原本人资料失效。"""

    def delete(self, owner_id: UUID, memory_id: UUID) -> OwnerMemory:
        """软删除一条 owner 级记忆，保留文本指纹。"""

    def invalidate(self, owner_id: UUID, memory_id: UUID) -> OwnerMemory:
        """使一条 owner 级记忆失效（被新事实取代），不再进入检索。"""

    def deleted_texts(self, owner_id: UUID) -> tuple[str, ...]:
        """返回该用户已软删除记忆的文本，用于阻止自动提取复活。"""
