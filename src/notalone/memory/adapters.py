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

    def create_manual_candidate(self, candidate: MemoryCandidate) -> MemoryCandidate:
        """保存一条由用户主动录入、随后可走确认流程的候选。"""

        return self.create_candidate(candidate)

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
            topic=candidate.topic,
            source_ids=candidate.source_ids,
            source_candidate_id=candidate.candidate_id,
            adoption_method=adoption_method,
            confidence=candidate.confidence,
            risk_flags=candidate.risk_flags,
            valid_at=candidate.valid_at,
            invalid_at=candidate.invalid_at,
        )
        self._candidates[candidate_id] = replace(
            candidate,
            status=MemoryCandidateStatus.CONFIRMED,
        )
        self._memories[memory.memory_id] = memory
        self._candidate_memory_ids[candidate_id] = memory.memory_id
        return memory

    def get_candidate(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
    ) -> MemoryCandidate:
        return self._candidate(scope=scope, candidate_id=candidate_id)

    def correct(
        self,
        *,
        scope: ContactScope,
        memory_id: UUID,
        text: str,
        category: MemoryCategory | None = None,
    ) -> ConfirmedMemory:
        memory = self._current_memory(scope=scope, memory_id=memory_id)
        if memory.status is not ConfirmedMemoryStatus.ACTIVE:
            raise RuntimeError("失效或删除的关系记忆不能直接修正。")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("修正后的关系记忆不能为空。")
        if category is not None and not isinstance(category, MemoryCategory):
            raise TypeError("关系记忆分类无效。")
        invalidated = replace(
            memory,
            status=ConfirmedMemoryStatus.INVALIDATED,
            invalid_at=memory.invalid_at or datetime.now(timezone.utc),
            revision=memory.revision + 1,
        )
        corrected = replace(
            memory,
            memory_id=uuid4(),
            text=text,
            category=category or memory.category,
            source_candidate_id=None,
            adoption_method=AdoptionMethod.MANUAL,
            revision=memory.revision + 1,
            supersedes_memory_id=memory.memory_id,
        )
        self._memories[memory.memory_id] = invalidated
        self._memories[corrected.memory_id] = corrected
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

    def discard_candidate_with_fingerprint(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
    ) -> MemoryCandidate:
        """拒绝候选并写入删除指纹，阻止同一文本自动复活。

        手动录入不走该路径。
        """

        candidate = self._candidate(scope=scope, candidate_id=candidate_id)
        rejected = self.reject_candidate(
            scope=scope,
            candidate_id=candidate_id,
        )
        fingerprint = ConfirmedMemory(
            memory_id=uuid4(),
            scope=scope,
            text=candidate.text,
            category=candidate.category,
            source_ids=candidate.source_ids,
            source_candidate_id=candidate.candidate_id,
            adoption_method=AdoptionMethod.AUTO,
            topic=candidate.topic,
            status=ConfirmedMemoryStatus.DELETED,
        )
        self._memories[fingerprint.memory_id] = fingerprint
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
        memory = self._current_memory(scope=scope, memory_id=memory_id)
        if memory.status is ConfirmedMemoryStatus.DELETED:
            raise RuntimeError("已删除的关系记忆不能再次失效。")
        invalidated = replace(
            memory,
            status=ConfirmedMemoryStatus.INVALIDATED,
            invalid_at=memory.invalid_at or datetime.now(timezone.utc),
            revision=memory.revision + 1,
        )
        self._memories[memory.memory_id] = invalidated
        return invalidated

    def delete(self, *, scope: ContactScope, memory_id: UUID) -> ConfirmedMemory:
        memory = self._current_memory(scope=scope, memory_id=memory_id)
        deleted = replace(
            memory,
            status=ConfirmedMemoryStatus.DELETED,
            invalid_at=memory.invalid_at or datetime.now(timezone.utc),
            revision=memory.revision + 1,
        )
        self._memories[memory.memory_id] = deleted
        return deleted

    def list_confirmed(self, scope: ContactScope) -> tuple[ConfirmedMemory, ...]:
        if not isinstance(scope, ContactScope):
            raise TypeError("关系记忆查询范围无效。")
        return tuple(
            memory
            for memory in self._memories.values()
            if memory.scope == scope and memory.is_retrievable()
        )

    def list_pending_candidates(
        self,
        scope: ContactScope,
    ) -> tuple[MemoryCandidate, ...]:
        """返回指定联系人范围内仍待处理的候选。"""

        if not isinstance(scope, ContactScope):
            raise TypeError("关系记忆查询范围无效。")
        return tuple(
            candidate
            for candidate in self._candidates.values()
            if candidate.scope == scope
            and candidate.status is MemoryCandidateStatus.PENDING
        )

    def deleted_texts(self, scope: ContactScope) -> tuple[str, ...]:
        """返回删除指纹，阻止自动提取复活相同记忆。"""

        if not isinstance(scope, ContactScope):
            raise TypeError("关系记忆查询范围无效。")
        return tuple(
            memory.text
            for memory in self._memories.values()
            if memory.scope == scope
            and memory.status is ConfirmedMemoryStatus.DELETED
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

    def _current_memory(
        self,
        *,
        scope: ContactScope,
        memory_id: UUID,
    ) -> ConfirmedMemory:
        """解析旧版本 ID 到当前 active 版本，保留旧客户端的幂等性。"""

        memory = self._memory(scope=scope, memory_id=memory_id)
        visited: set[UUID] = set()
        while memory.memory_id not in visited:
            visited.add(memory.memory_id)
            children = tuple(
                candidate
                for candidate in self._memories.values()
                if candidate.scope == scope
                and candidate.supersedes_memory_id == memory.memory_id
            )
            active_children = tuple(
                candidate
                for candidate in children
                if candidate.status is ConfirmedMemoryStatus.ACTIVE
            )
            if not active_children:
                return memory
            memory = max(active_children, key=lambda item: item.revision)
        raise RuntimeError("关系记忆版本链无效。")
