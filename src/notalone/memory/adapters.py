"""关系记忆的内存适配器，仅用于模块测试和本地原型。"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from uuid import UUID, uuid4

from notalone.memory.models import (
    AdoptionMethod,
    ConfirmedMemory,
    ConfirmedMemoryStatus,
    MemoryCandidate,
    MemoryCandidateStatus,
    MemoryCategory,
)
from notalone.scopes import ContactScope


@dataclass(slots=True)
class InMemoryMemoryStore:
    """用内存字典模拟 Memory 权威状态，供合成测试使用。"""

    _candidates: dict[UUID, MemoryCandidate] = field(default_factory=dict)
    _memories: dict[UUID, ConfirmedMemory] = field(default_factory=dict)
    _candidate_memory_ids: dict[UUID, UUID] = field(default_factory=dict)

    def create_candidate(self, candidate: MemoryCandidate) -> MemoryCandidate:
        if not isinstance(candidate, MemoryCandidate):
            raise TypeError("关系记忆候选结构无效。")
        if candidate.candidate_id in self._candidates:
            raise ValueError("关系记忆候选标识重复。")
        self._candidates[candidate.candidate_id] = candidate
        return candidate

    def confirm(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
        adoption_method: AdoptionMethod = AdoptionMethod.AUTO,
    ) -> ConfirmedMemory:
        candidate = self._candidate(scope=scope, candidate_id=candidate_id)
        if candidate.status is MemoryCandidateStatus.CONFIRMED:
            memory_id = self._candidate_memory_ids.get(candidate_id)
            if memory_id is not None:
                return self._memories[memory_id]
        if candidate.status is not MemoryCandidateStatus.PENDING:
            raise RuntimeError("关系记忆候选当前不可确认。")
        if not isinstance(adoption_method, AdoptionMethod):
            raise TypeError("关系记忆采纳方式无效。")
        memory = ConfirmedMemory(
            memory_id=uuid4(),
            scope=scope,
            text=candidate.text,
            category=candidate.category,
            source_ids=candidate.source_ids,
            source_candidate_id=candidate.candidate_id,
            adoption_method=adoption_method,
        )
        self._candidates[candidate_id] = replace(
            candidate,
            status=MemoryCandidateStatus.CONFIRMED,
        )
        self._memories[memory.memory_id] = memory
        self._candidate_memory_ids[candidate_id] = memory.memory_id
        return memory

    def correct(
        self,
        *,
        scope: ContactScope,
        memory_id: UUID,
        text: str,
        category: MemoryCategory | None = None,
    ) -> ConfirmedMemory:
        memory = self._memory(scope=scope, memory_id=memory_id)
        if memory.status is not ConfirmedMemoryStatus.ACTIVE:
            raise RuntimeError("失效或删除的关系记忆不能直接修正。")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("修正后的关系记忆不能为空。")
        if category is not None and not isinstance(category, MemoryCategory):
            raise TypeError("关系记忆分类无效。")
        corrected = replace(
            memory,
            text=text,
            category=category or memory.category,
            revision=memory.revision + 1,
        )
        self._memories[memory_id] = corrected
        return corrected

    def reject_candidate(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
    ) -> MemoryCandidate:
        candidate = self._candidate(scope=scope, candidate_id=candidate_id)
        if candidate.status is not MemoryCandidateStatus.PENDING:
            raise RuntimeError("当前关系记忆候选不能拒绝。")
        rejected = replace(candidate, status=MemoryCandidateStatus.REJECTED)
        self._candidates[candidate_id] = rejected
        return rejected

    def invalidate_candidate(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
    ) -> MemoryCandidate:
        candidate = self._candidate(scope=scope, candidate_id=candidate_id)
        if candidate.status is not MemoryCandidateStatus.PENDING:
            raise RuntimeError("当前关系记忆候选不能失效。")
        invalidated = replace(candidate, status=MemoryCandidateStatus.INVALIDATED)
        self._candidates[candidate_id] = invalidated
        return invalidated

    def invalidate(self, *, scope: ContactScope, memory_id: UUID) -> ConfirmedMemory:
        memory = self._memory(scope=scope, memory_id=memory_id)
        if memory.status is ConfirmedMemoryStatus.DELETED:
            raise RuntimeError("已删除的关系记忆不能再次失效。")
        invalidated = replace(
            memory,
            status=ConfirmedMemoryStatus.INVALIDATED,
            invalid_at=memory.invalid_at or datetime.now(timezone.utc),
            revision=memory.revision + 1,
        )
        self._memories[memory_id] = invalidated
        return invalidated

    def delete(self, *, scope: ContactScope, memory_id: UUID) -> ConfirmedMemory:
        memory = self._memory(scope=scope, memory_id=memory_id)
        deleted = replace(
            memory,
            status=ConfirmedMemoryStatus.DELETED,
            invalid_at=memory.invalid_at or datetime.now(timezone.utc),
            revision=memory.revision + 1,
        )
        self._memories[memory_id] = deleted
        return deleted

    def list_confirmed(self, scope: ContactScope) -> tuple[ConfirmedMemory, ...]:
        if not isinstance(scope, ContactScope):
            raise TypeError("关系记忆查询范围无效。")
        return tuple(
            memory
            for memory in self._memories.values()
            if memory.scope == scope and memory.is_retrievable()
        )

    def _candidate(self, *, scope: ContactScope, candidate_id: UUID) -> MemoryCandidate:
        candidate = self._candidates.get(candidate_id)
        if candidate is None:
            raise LookupError("关系记忆候选不存在。")
        if candidate.scope != scope:
            raise PermissionError("关系记忆范围校验失败。")
        return candidate

    def _memory(self, *, scope: ContactScope, memory_id: UUID) -> ConfirmedMemory:
        memory = self._memories.get(memory_id)
        if memory is None:
            raise LookupError("关系记忆不存在。")
        if memory.scope != scope:
            raise PermissionError("关系记忆范围校验失败。")
        return memory
