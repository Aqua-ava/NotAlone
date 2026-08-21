"""关系记忆的生命周期接口。"""

from __future__ import annotations

from typing import Protocol
from uuid import UUID

from notalone.memory.models import (
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
