"""关系记忆的内存适配器，仅用于模块测试和本地原型。"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from uuid import UUID, uuid4

from notalone.memory.dimension_evidence import (
    DimensionEvidence,
    require_current_dimension_evidence,
)

from notalone.memory.models import (
    MemoryChangeKind, MemoryRetirementReason,
    AdoptionMethod,
    ConfirmedMemory,
    ConfirmedMemoryStatus,
    MemoryCandidate,
    MemoryCandidateStatus,
    MemoryCategory,
    SourceDependencyMode,
)
from notalone.memory.versions import (
    MemoryVersionConflict, require_auto_previous, require_auto_update_previous,
    require_auto_update_receipt, require_version_receipt,
)
from notalone.scopes import ContactScope
from notalone.memory.candidates import same_pending_identity


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
        for stored in self._candidates.values():
            if stored.status is MemoryCandidateStatus.PENDING and same_pending_identity(stored, candidate):
                return stored
        candidate = replace(candidate, timing=replace(
            candidate.timing, recorded_at=datetime.now(timezone.utc),
        ))
        self._candidates[candidate.candidate_id] = candidate
        return candidate

    def create_manual_candidate(self, candidate: MemoryCandidate) -> MemoryCandidate:
        """保存一条由用户主动录入、随后可走确认流程的候选。"""

        if candidate.source_dependency_mode is not SourceDependencyMode.ANY:
            raise ValueError("独立手动录入必须使用ANY来源。")
        return self.create_candidate(candidate)

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
        candidate = self._candidate(scope=scope, candidate_id=candidate_id)
        if candidate.status is MemoryCandidateStatus.CONFIRMED:
            memory_id = self._candidate_memory_ids.get(candidate_id)
            if memory_id is not None:
                actual = self._memories[memory_id]
                if expected_previous is not None:
                    if adoption_method is AdoptionMethod.AUTO:
                        require_auto_update_receipt(actual, expected_previous)
                    else:
                        require_version_receipt(actual, expected_previous, adoption_method)
                    require_auto_update_previous(
                        self._memory(scope=scope, memory_id=expected_previous.memory_id),
                        expected_previous, allow_manual=adoption_method is AdoptionMethod.MANUAL,
                    )
                return actual
        if candidate.status is not MemoryCandidateStatus.PENDING:
            raise RuntimeError("关系记忆候选当前不可确认。")
        if not isinstance(adoption_method, AdoptionMethod):
            raise TypeError("关系记忆采纳方式无效。")
        if expected_previous is not None:
            require_auto_previous(
                self._memory(scope=scope, memory_id=expected_previous.memory_id),
                expected_previous, allow_manual=adoption_method is AdoptionMethod.MANUAL,
            )
        if expected_dimension_evidence is not None:
            require_current_dimension_evidence(
                candidate.dimension_evidence, expected_dimension_evidence
            )
        sources = candidate.source_ids
        if expected_previous is not None:
            if adoption_method is AdoptionMethod.AUTO and not set(sources) - set(expected_previous.source_ids):
                raise MemoryVersionConflict("版本更新需要新依据和当前叶子版本。")
            sources = tuple(dict.fromkeys((*expected_previous.source_ids, *sources)))
        memory = ConfirmedMemory(
            memory_id=uuid4(),
            scope=scope,
            text=candidate.text,
            category=candidate.category,
            topic=candidate.topic,
            source_ids=sources,
            requires_all_sources=candidate.requires_all_sources or bool(expected_previous and expected_previous.requires_all_sources),
            source_dependency_mode=(SourceDependencyMode.ALL if expected_previous is not None
                and expected_previous.source_dependency_mode is SourceDependencyMode.ALL
                else candidate.source_dependency_mode),
            source_candidate_id=candidate.candidate_id,
            adoption_method=adoption_method,
            confidence=candidate.confidence,
            risk_flags=candidate.risk_flags,
            valid_at=candidate.valid_at,
            invalid_at=candidate.invalid_at,
            timing=replace(candidate.timing, recorded_at=datetime.now(timezone.utc)),
            revision=expected_previous.revision + 1 if expected_previous else 1,
            supersedes_memory_id=expected_previous.memory_id if expected_previous else None,
            event=candidate.event,
        )
        if expected_previous is not None:
            self._memories[expected_previous.memory_id] = replace(
                expected_previous, status=ConfirmedMemoryStatus.INVALIDATED,
                revision=expected_previous.revision + 1,
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
        change_kind: MemoryChangeKind = MemoryChangeKind.ERROR_CORRECTION,
    ) -> ConfirmedMemory:
        change_kind = MemoryChangeKind(change_kind)
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
            retirement_reason=MemoryRetirementReason(change_kind.value),
            retired_at=datetime.now(timezone.utc),
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
            timing=replace(memory.timing, recorded_at=datetime.now(timezone.utc)),
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
        rejected = replace(
            candidate, status=MemoryCandidateStatus.REJECTED,
            dimension_evidence=None,
        )
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
            source_dependency_mode=candidate.source_dependency_mode,
            requires_all_sources=candidate.requires_all_sources,
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
        invalidated = replace(
            candidate, status=MemoryCandidateStatus.INVALIDATED,
            dimension_evidence=None,
        )
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
        memory = self._memory(scope=scope, memory_id=memory_id)
        if memory.status is ConfirmedMemoryStatus.DELETED:
            return memory
        if any(item.scope == scope and item.supersedes_memory_id == memory_id
               and item.status is not ConfirmedMemoryStatus.DELETED
               for item in self._memories.values()):
            raise MemoryVersionConflict("资料版本已变化，请重新查看当前版本后删除。")
        # 当前叶删除同时撤下祖先；历史资料不能绕过用户的整条资料删除。
        versions = self.list_versions(scope=scope, memory_id=memory_id)
        for version in versions:
            self._memories[version.memory_id] = replace(
                version, status=ConfirmedMemoryStatus.DELETED,
                invalid_at=version.invalid_at or datetime.now(timezone.utc),
                revision=version.revision + 1,
            )
        return self._memories[memory.memory_id]

    def list_confirmed(self, scope: ContactScope, *, include_expired: bool = False) -> tuple[ConfirmedMemory, ...]:
        if not isinstance(scope, ContactScope):
            raise TypeError("关系记忆查询范围无效。")
        return tuple(
            memory
            for memory in self._memories.values()
            if memory.scope == scope and memory.status is ConfirmedMemoryStatus.ACTIVE
            and (memory.valid_at is None or memory.valid_at <= datetime.now(timezone.utc))
            and (include_expired or memory.is_retrievable())
        )

    def list_versions(self, *, scope: ContactScope, memory_id: UUID) -> tuple[ConfirmedMemory, ...]:
        versions = []
        seen: set[UUID] = set()
        current: UUID | None = memory_id
        while current is not None:
            if current in seen or len(versions) >= 100:
                raise MemoryVersionConflict("版本链超出可核对范围。")
            memory = self._memory(scope=scope, memory_id=current)
            if memory.status is ConfirmedMemoryStatus.DELETED:
                if not versions:
                    raise LookupError("资料版本不存在或已清除。")
                break
            versions.append(memory)
            seen.add(current)
            current = memory.supersedes_memory_id
        return tuple(versions)

    def revert_auto_update(self, *, scope: ContactScope, memory_id: UUID, expected_revision: int) -> ConfirmedMemory:
        current = self._memory(scope=scope, memory_id=memory_id)
        if not current.can_revert_auto_update:
            raise MemoryVersionConflict("原始版本依据未知或已变化，不能恢复。")
        if (type(expected_revision) is not int or expected_revision < 1
                or current.status is not ConfirmedMemoryStatus.ACTIVE
                or current.adoption_method is not AdoptionMethod.AUTO
                or current.revision != expected_revision or current.supersedes_memory_id is None):
            raise MemoryVersionConflict("只有仍合法的自动更新可以撤销。")
        previous = self._memory(scope=scope, memory_id=current.supersedes_memory_id)
        if (previous.status is not ConfirmedMemoryStatus.INVALIDATED
                or previous.adoption_method is not AdoptionMethod.AUTO or previous.revision != expected_revision
                or any(item.scope == scope and item.supersedes_memory_id == current.memory_id
                       and item.status is ConfirmedMemoryStatus.ACTIVE for item in self._memories.values())):
            raise MemoryVersionConflict("原版本或人工决定已变化，不能恢复。")
        restored = replace(previous, status=ConfirmedMemoryStatus.ACTIVE, revision=expected_revision + 1)
        self._memories[current.memory_id] = replace(current, status=ConfirmedMemoryStatus.DELETED,
                                                   revision=expected_revision + 1)
        self._memories[previous.memory_id] = restored
        return restored

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
