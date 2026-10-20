"""关系记忆管理的统一应用层入口。

把联系人级记忆、owner 级记忆与 pending 候选的人工处理收敛到一个
框架无关的服务里；所有调用都经由端口，不直接触碰持久化。
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Protocol
from uuid import UUID

from notalone.memory.models import (
    AdoptionMethod,
    ConfirmedMemory,
    ConfirmedMemoryStatus,
    FactSubject,
    MemoryCandidate,
    MemoryCategory,
    MemoryChangeKind,
    MemoryTopic,
    OwnerMemory,
)
from notalone.memory.ports import MemoryPort, OwnerMemoryPort
from notalone.scopes import ContactScope
from notalone.memory.versions import MemoryVersionConflict


@dataclass(frozen=True, slots=True)
class ManualMemoryEntry:
    """手动录入的记忆输入，不含范围（范围由调用方提供）。"""

    text: str
    category: MemoryCategory
    topic: MemoryTopic = MemoryTopic.OTHER

    def __post_init__(self) -> None:
        if not isinstance(self.text, str) or not self.text.strip():
            raise ValueError("记忆文本不能为空。")
        if not isinstance(self.category, MemoryCategory):
            raise TypeError("记忆分类无效。")
        if not isinstance(self.topic, MemoryTopic):
            raise TypeError("记忆主题无效。")


class MemoryService:
    """连接 API 壳与记忆端口的管理服务。"""

    __slots__ = ("_contact_memory", "_owner_memory")

    def __init__(
        self,
        *,
        contact_memory: MemoryPort,
        owner_memory: OwnerMemoryPort,
    ) -> None:
        self._contact_memory = contact_memory
        self._owner_memory = owner_memory

    # -- 查询 ----------------------------------------------------------

    def list_contact_memories(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
    ) -> tuple[ConfirmedMemory, ...]:
        return self._contact_memory.list_confirmed(
            ContactScope(owner_id=owner_id, contact_id=contact_id), include_expired=True, include_invalidated=True,
        )

    def list_pending(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
    ) -> tuple[MemoryCandidate, ...]:
        return self._contact_memory.list_pending_candidates(
            ContactScope(owner_id=owner_id, contact_id=contact_id)
        )

    def list_owner_memories(self, *, owner_id: UUID, contact_id: UUID | None = None) -> tuple[OwnerMemory, ...]:
        return self._owner_memory.list_active(
            owner_id, include_expired=True, include_invalidated=True, **({"contact_id": contact_id} if contact_id is not None else {}),
        )

    def list_contact_owner_versions(
        self, *, owner_id: UUID, contact_id: UUID, memory_id: UUID,
    ) -> tuple[OwnerMemory, ...]:
        return self._owner_memory.list_versions(
            owner_id=owner_id, memory_id=memory_id, contact_id=contact_id,
        )

    def list_versions(
        self, *, owner_id: UUID, memory_id: UUID, contact_id: UUID | None = None,
    ) -> tuple[ConfirmedMemory, ...] | tuple[OwnerMemory, ...]:
        if contact_id is None:
            return self._owner_memory.list_versions(owner_id=owner_id, memory_id=memory_id)
        return self._contact_memory.list_versions(
            scope=ContactScope(owner_id=owner_id, contact_id=contact_id), memory_id=memory_id,
        )

    def revert_auto_update(
        self, *, owner_id: UUID, memory_id: UUID, expected_revision: int,
        contact_id: UUID | None = None,
    ) -> ConfirmedMemory | OwnerMemory:
        if contact_id is None:
            return self._owner_memory.revert_auto_update(
                owner_id=owner_id, memory_id=memory_id, expected_revision=expected_revision,
            )
        return self._contact_memory.revert_auto_update(
            scope=ContactScope(owner_id=owner_id, contact_id=contact_id),
            memory_id=memory_id, expected_revision=expected_revision,
        )

    def revert_contact_owner_update(
        self, *, owner_id: UUID, contact_id: UUID, memory_id: UUID, expected_revision: int,
    ) -> OwnerMemory:
        versions = self.list_contact_owner_versions(
            owner_id=owner_id, contact_id=contact_id, memory_id=memory_id,
        )
        if not versions[0].supersedes_memory_id:
            raise MemoryVersionConflict("没有可在当前联系人范围恢复的旧版。")
        return self._owner_memory.revert_auto_update(
            owner_id=owner_id, memory_id=memory_id, expected_revision=expected_revision,
        )

    # -- pending 候选人工处理 ------------------------------------------

    def confirm_candidate(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        candidate_id: UUID,
        expected_correction_decision_ids: tuple[UUID, ...] | None = None,
    ) -> ConfirmedMemory | OwnerMemory:
        scope = ContactScope(owner_id=owner_id, contact_id=contact_id)
        candidate = self._contact_memory.get_candidate(
            scope=scope,
            candidate_id=candidate_id,
        )
        expected = ({"expected_correction_decision_ids": expected_correction_decision_ids}
                    if expected_correction_decision_ids is not None else {})
        if candidate.subject is FactSubject.SELF:
            return self._owner_memory.confirm_candidate(
                candidate=candidate,
                adoption_method=AdoptionMethod.MANUAL,
                **expected,
            )
        return self._contact_memory.confirm(
            scope=scope,
            candidate_id=candidate_id,
            adoption_method=AdoptionMethod.MANUAL,
            **expected,
        )

    def discard_candidate(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        candidate_id: UUID,
    ) -> MemoryCandidate:
        return self._contact_memory.discard_candidate_with_fingerprint(
            scope=ContactScope(owner_id=owner_id, contact_id=contact_id),
            candidate_id=candidate_id,
        )

    def apply_candidate_update(
        self, *, owner_id: UUID, contact_id: UUID, candidate_id: UUID,
        previous_memory_id: UUID, expected_revision: int,
        expected_correction_decision_ids: tuple[UUID, ...] | None = None,
    ) -> ConfirmedMemory | OwnerMemory:
        scope = ContactScope(owner_id, contact_id)
        candidate = self._contact_memory.get_candidate(scope=scope, candidate_id=candidate_id)
        versions = self.list_versions(
            owner_id=owner_id, memory_id=previous_memory_id,
            contact_id=None if candidate.subject is FactSubject.SELF else contact_id,
        )
        previous = versions[0]
        if previous.memory_id != previous_memory_id:
            raise MemoryVersionConflict("所选旧版已变化，请刷新后核对。")
        if previous.status is ConfirmedMemoryStatus.INVALIDATED and previous.revision == expected_revision + 1:
            previous = replace(previous, status=ConfirmedMemoryStatus.ACTIVE, revision=expected_revision)
        elif previous.status is not ConfirmedMemoryStatus.ACTIVE or previous.revision != expected_revision:
            raise MemoryVersionConflict("所选旧版已变化，请刷新后核对。")
        if candidate.subject is FactSubject.SELF:
            return self._owner_memory.confirm_candidate(
                candidate=candidate, adoption_method=AdoptionMethod.MANUAL,
                expected_previous=previous,
                expected_correction_decision_ids=expected_correction_decision_ids,
            )
        return self._contact_memory.confirm(
            scope=scope, candidate_id=candidate_id,
            adoption_method=AdoptionMethod.MANUAL, expected_previous=previous,
            expected_correction_decision_ids=expected_correction_decision_ids,
        )

    # -- 手动录入 ------------------------------------------------------

    def add_manual_contact_memory(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        entry: ManualMemoryEntry,
    ) -> ConfirmedMemory:
        """手动录入联系人级记忆：建 manual 来源 + 候选后经确认路径落库。"""

        from uuid import uuid4

        candidate = MemoryCandidate(
            candidate_id=uuid4(),
            scope=ContactScope(owner_id=owner_id, contact_id=contact_id),
            text=entry.text,
            category=entry.category,
            topic=entry.topic,
            # 占位来源：create_manual_candidate 会在同一事务里用
            # manual 来源行替换，这里不需要指向真实来源。
            source_ids=(contact_id,),
        )
        created = self._contact_memory.create_manual_candidate(candidate)
        return self._contact_memory.confirm(
            scope=ContactScope(owner_id=owner_id, contact_id=contact_id),
            candidate_id=created.candidate_id,
            adoption_method=AdoptionMethod.MANUAL,
        )

    def add_manual_owner_memory(
        self,
        *,
        owner_id: UUID,
        entry: ManualMemoryEntry,
        contact_id: UUID | None = None,
    ) -> OwnerMemory:
        from uuid import uuid4

        from notalone.memory.models import ConfirmedMemoryStatus

        if contact_id is not None:
            candidate = self._contact_memory.create_manual_candidate(MemoryCandidate(
                candidate_id=uuid4(), scope=ContactScope(owner_id, contact_id),
                text=entry.text, category=entry.category, topic=entry.topic,
                subject=FactSubject.SELF, source_ids=(contact_id,),
            ))
            return self._owner_memory.confirm_candidate(candidate=candidate, adoption_method=AdoptionMethod.MANUAL)

        return self._owner_memory.create(
            OwnerMemory(
                memory_id=uuid4(),
                owner_id=owner_id,
                text=entry.text,
                category=entry.category,
                topic=entry.topic,
                source_ids=(owner_id,),
                adoption_method=AdoptionMethod.MANUAL,
                status=ConfirmedMemoryStatus.ACTIVE,
            )
        )

    # -- 修正与删除 ----------------------------------------------------

    def correct_memory(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        memory_id: UUID,
        text: str,
        category: MemoryCategory | None = None,
        change_kind: MemoryChangeKind = MemoryChangeKind.ERROR_CORRECTION,
    ) -> ConfirmedMemory:
        return self._contact_memory.correct(
            scope=ContactScope(owner_id=owner_id, contact_id=contact_id),
            memory_id=memory_id,
            text=text,
            category=category,
            change_kind=change_kind,
        )

    def delete_contact_memory(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        memory_id: UUID,
    ) -> ConfirmedMemory:
        return self._contact_memory.delete(
            scope=ContactScope(owner_id=owner_id, contact_id=contact_id),
            memory_id=memory_id,
        )

    def delete_owner_memory(self, *, owner_id: UUID, memory_id: UUID, contact_id: UUID | None = None) -> OwnerMemory:
        if contact_id is not None:
            self.list_contact_owner_versions(owner_id=owner_id, contact_id=contact_id, memory_id=memory_id)
        return self._owner_memory.delete(owner_id, memory_id)

    def correct_owner_memory(
        self, *, owner_id: UUID, memory_id: UUID, text: str,
        category: MemoryCategory | None = None,
        contact_id: UUID | None = None,
        change_kind: MemoryChangeKind = MemoryChangeKind.ERROR_CORRECTION,
    ) -> OwnerMemory:
        if contact_id is not None:
            self.list_contact_owner_versions(owner_id=owner_id, contact_id=contact_id, memory_id=memory_id)
        return self._owner_memory.correct(
            owner_id=owner_id, memory_id=memory_id, text=text, category=category,
            change_kind=change_kind,
        )
