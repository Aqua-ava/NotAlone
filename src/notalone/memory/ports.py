"""关系记忆的生命周期接口。"""

from __future__ import annotations

from typing import Protocol
from uuid import UUID

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

    def confirm(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
        adoption_method: AdoptionMethod = AdoptionMethod.AUTO,
    ) -> ConfirmedMemory:
        """把同一联系人范围内的候选采纳为可检索记忆。"""

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

    def list_active(self, owner_id: UUID) -> tuple[OwnerMemory, ...]:
        """返回某位用户当前有效（active 且在有效期内）的 owner 级记忆。"""

    def delete(self, owner_id: UUID, memory_id: UUID) -> OwnerMemory:
        """软删除一条 owner 级记忆，保留文本指纹。"""

    def invalidate(self, owner_id: UUID, memory_id: UUID) -> OwnerMemory:
        """使一条 owner 级记忆失效（被新事实取代），不再进入检索。"""

    def deleted_texts(self, owner_id: UUID) -> tuple[str, ...]:
        """返回该用户已软删除记忆的文本，用于阻止自动提取复活。"""
