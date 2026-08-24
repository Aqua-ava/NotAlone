"""关系记忆管理的统一应用层入口。

把联系人级记忆、owner 级记忆与 pending 候选的人工处理收敛到一个
框架无关的服务里；所有调用都经由端口，不直接触碰持久化。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from notalone.memory.models import (
    AdoptionMethod,
    ConfirmedMemory,
    MemoryCandidate,
    MemoryCategory,
    MemoryTopic,
    OwnerMemory,
)
from notalone.memory.ports import MemoryPort, OwnerMemoryPort
from notalone.scopes import ContactScope


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
            ContactScope(owner_id=owner_id, contact_id=contact_id)
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

    def list_owner_memories(self, *, owner_id: UUID) -> tuple[OwnerMemory, ...]:
        return self._owner_memory.list_active(owner_id)

    # -- pending 候选人工处理 ------------------------------------------

    def confirm_candidate(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        candidate_id: UUID,
    ) -> ConfirmedMemory:
        return self._contact_memory.confirm(
            scope=ContactScope(owner_id=owner_id, contact_id=contact_id),
            candidate_id=candidate_id,
            adoption_method=AdoptionMethod.MANUAL,
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
    ) -> OwnerMemory:
        from uuid import uuid4

        from notalone.memory.models import ConfirmedMemoryStatus

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
    ) -> ConfirmedMemory:
        return self._contact_memory.correct(
            scope=ContactScope(owner_id=owner_id, contact_id=contact_id),
            memory_id=memory_id,
            text=text,
            category=category,
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

    def delete_owner_memory(self, *, owner_id: UUID, memory_id: UUID) -> OwnerMemory:
        return self._owner_memory.delete(owner_id, memory_id)