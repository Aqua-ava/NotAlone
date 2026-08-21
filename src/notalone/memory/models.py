"""关系记忆的领域值对象。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import StrEnum
from uuid import UUID

from notalone.scopes import ContactScope


class MemoryCategory(StrEnum):
    """v1 关系记忆的有限分类。"""

    COMMON_FACT = "common_fact"
    PREFERENCE = "preference"
    TABOO = "taboo"
    RECENT_STATE = "recent_state"
    RELATIONSHIP_NOTE = "relationship_note"


class MemoryCandidateStatus(StrEnum):
    """关系记忆候选的生命周期状态。"""

    PENDING = "pending"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"
    INVALIDATED = "invalidated"


class ConfirmedMemoryStatus(StrEnum):
    """已采纳关系记忆的可检索状态。"""

    ACTIVE = "active"
    INVALIDATED = "invalidated"
    DELETED = "deleted"


class AdoptionMethod(StrEnum):
    """关系记忆的采纳来源。"""

    AUTO = "auto"
    MANUAL = "manual"


def _validate_source_ids(source_ids: tuple[UUID, ...]) -> None:
    if (
        not isinstance(source_ids, tuple)
        or not source_ids
        or any(not isinstance(source_id, UUID) for source_id in source_ids)
    ):
        raise ValueError("关系记忆必须带至少一个来源引用。")


def _validate_datetime(value: datetime | None) -> None:
    if value is not None and (
        not isinstance(value, datetime) or value.tzinfo is None
    ):
        raise ValueError("关系记忆时间必须是带时区的 datetime。")


@dataclass(frozen=True, slots=True, repr=False)
class MemoryCandidate:
    """等待确认或自动采纳的关系记忆候选。"""

    candidate_id: UUID
    scope: ContactScope
    text: str
    category: MemoryCategory
    source_ids: tuple[UUID, ...]
    status: MemoryCandidateStatus = MemoryCandidateStatus.PENDING

    def __post_init__(self) -> None:
        if not isinstance(self.candidate_id, UUID):
            raise TypeError("memory_candidate_id 必须是 UUID。")
        if not isinstance(self.scope, ContactScope):
            raise TypeError("关系记忆候选必须带联系人范围。")
        if not isinstance(self.text, str) or not self.text.strip():
            raise ValueError("关系记忆候选正文不能为空。")
        if not isinstance(self.category, MemoryCategory):
            raise TypeError("关系记忆候选分类无效。")
        _validate_source_ids(self.source_ids)
        if not isinstance(self.status, MemoryCandidateStatus):
            raise TypeError("关系记忆候选状态无效。")


@dataclass(frozen=True, slots=True, repr=False)
class ConfirmedMemory:
    """已经进入关系记忆层、但仍可修正或失效的资料。"""

    memory_id: UUID
    scope: ContactScope
    text: str
    category: MemoryCategory
    source_ids: tuple[UUID, ...]
    source_candidate_id: UUID | None
    adoption_method: AdoptionMethod
    status: ConfirmedMemoryStatus = ConfirmedMemoryStatus.ACTIVE
    valid_at: datetime | None = None
    invalid_at: datetime | None = None
    revision: int = 1

    def __post_init__(self) -> None:
        if not isinstance(self.memory_id, UUID):
            raise TypeError("confirmed_memory_id 必须是 UUID。")
        if not isinstance(self.scope, ContactScope):
            raise TypeError("已确认关系记忆必须带联系人范围。")
        if not isinstance(self.text, str) or not self.text.strip():
            raise ValueError("已确认关系记忆正文不能为空。")
        if not isinstance(self.category, MemoryCategory):
            raise TypeError("已确认关系记忆分类无效。")
        _validate_source_ids(self.source_ids)
        if self.source_candidate_id is not None and not isinstance(
            self.source_candidate_id,
            UUID,
        ):
            raise TypeError("来源候选标识无效。")
        if not isinstance(self.adoption_method, AdoptionMethod):
            raise TypeError("关系记忆采纳方式无效。")
        if not isinstance(self.status, ConfirmedMemoryStatus):
            raise TypeError("已确认关系记忆状态无效。")
        _validate_datetime(self.valid_at)
        _validate_datetime(self.invalid_at)
        if not isinstance(self.revision, int) or self.revision < 1:
            raise ValueError("关系记忆修订号必须是正整数。")

    def is_retrievable(self, *, at: datetime | None = None) -> bool:
        """判断资料当前是否允许进入 Retrieval 结果。"""

        if self.status is not ConfirmedMemoryStatus.ACTIVE:
            return False
        current = at or datetime.now(timezone.utc)
        if self.valid_at is not None and current < self.valid_at:
            return False
        if self.invalid_at is not None and current >= self.invalid_at:
            return False
        return True
