"""关系记忆的领域值对象。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import StrEnum
from uuid import UUID

from notalone.memory.dimension_evidence import DimensionEvidence
from notalone.memory.correction import CorrectionReview
from notalone.memory.events import MemoryEvent
from notalone.memory.version_evidence import VersionEvidence

from notalone.memory.timing import MemoryTiming
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
    EXTRACT_FAILED = "extract_failed"


class ConfirmedMemoryStatus(StrEnum):
    """已采纳关系记忆的可检索状态。"""

    ACTIVE = "active"
    INVALIDATED = "invalidated"
    DELETED = "deleted"


class AdoptionMethod(StrEnum):
    """关系记忆的采纳来源。"""

    AUTO = "auto"
    MANUAL = "manual"


class MemoryTopic(StrEnum):
    """记忆的受控粗筛主题，只用于缩小裁决检索范围。"""

    HEALTH = "health"
    WORK = "work"
    FAMILY = "family"
    TRAVEL = "travel"
    FINANCE = "finance"
    STUDY = "study"
    EMOTION = "emotion"
    OTHER = "other"


class FactSubject(StrEnum):
    """一条记忆事实的主体：谁的事。"""

    SELF = "self"
    CONTACT = "contact"
    SHARED = "shared"


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
    topic: MemoryTopic = MemoryTopic.OTHER
    subject: FactSubject = FactSubject.CONTACT
    status: MemoryCandidateStatus = MemoryCandidateStatus.PENDING
    valid_at: datetime | None = None
    invalid_at: datetime | None = None
    confidence: float = 1.0
    risk_flags: tuple[str, ...] = ()
    alternatives: tuple[str, ...] = ()
    interpretation_reason: str = ""
    failure_reason: str | None = None
    timing: MemoryTiming = MemoryTiming()
    event: MemoryEvent | None = None
    dimension_evidence: DimensionEvidence | None = None
    correction_review: tuple[CorrectionReview, ...] = ()

    def __post_init__(self) -> None:
        if self.event is not None and not isinstance(self.event, MemoryEvent):
            raise ValueError("记忆事件信息无效。")
        if self.dimension_evidence is not None and (
            not isinstance(self.dimension_evidence, DimensionEvidence)
            or self.dimension_evidence.scope != self.scope
        ):
            raise ValueError("候选维度依据必须属于同一联系人范围。")
        if not isinstance(self.candidate_id, UUID):
            raise TypeError("memory_candidate_id 必须是 UUID。")
        if not isinstance(self.scope, ContactScope):
            raise TypeError("关系记忆候选必须带联系人范围。")
        if not isinstance(self.text, str) or not self.text.strip():
            raise ValueError("关系记忆候选正文不能为空。")
        if not isinstance(self.category, MemoryCategory):
            raise TypeError("关系记忆候选分类无效。")
        if not isinstance(self.subject, FactSubject):
            raise TypeError("关系记忆候选主体必须是 self/contact/shared。")
        _validate_source_ids(self.source_ids)
        if not isinstance(self.status, MemoryCandidateStatus):
            raise TypeError("关系记忆候选状态无效。")
        if (
            not isinstance(self.confidence, (int, float))
            or not 0.0 <= float(self.confidence) <= 1.0
        ):
            raise ValueError("候选置信度必须在 0 到 1 之间。")
        if not isinstance(self.risk_flags, tuple) or any(
            not isinstance(flag, str) or not flag.strip()
            for flag in self.risk_flags
        ):
            raise ValueError("候选风险标记必须是非空字符串元组。")
        if not isinstance(self.alternatives, tuple) or any(
            not isinstance(item, str) or not item.strip()
            for item in self.alternatives
        ):
            raise ValueError("候选备选解释必须是非空字符串元组。")
        if not isinstance(self.interpretation_reason, str):
            raise ValueError("候选语用判断依据必须是字符串。")
        if self.failure_reason is not None and (
            not isinstance(self.failure_reason, str)
            or not self.failure_reason.strip()
        ):
            raise ValueError("候选失败原因必须是非空字符串。")
        _validate_datetime(self.valid_at)
        _validate_datetime(self.invalid_at)
        if not isinstance(self.timing, MemoryTiming):
            raise TypeError("记忆候选时间信息无效。")
        if (
            self.valid_at is not None
            and self.invalid_at is not None
            and self.invalid_at <= self.valid_at
        ):
            raise ValueError("候选失效时间必须晚于生效时间。")


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
    topic: MemoryTopic = MemoryTopic.OTHER
    status: ConfirmedMemoryStatus = ConfirmedMemoryStatus.ACTIVE
    valid_at: datetime | None = None
    invalid_at: datetime | None = None
    revision: int = 1
    confidence: float = 1.0
    risk_flags: tuple[str, ...] = ()
    supersedes_memory_id: UUID | None = None
    timing: MemoryTiming = MemoryTiming()
    event: MemoryEvent | None = None
    version_evidence: VersionEvidence | None = None
    can_revert_auto_update: bool = False

    def __post_init__(self) -> None:
        if self.event is not None and not isinstance(self.event, MemoryEvent):
            raise ValueError("记忆事件信息无效。")
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
        if not isinstance(self.timing, MemoryTiming):
            raise TypeError("关系记忆时间信息无效。")
        if not isinstance(self.revision, int) or self.revision < 1:
            raise ValueError("关系记忆修订号必须是正整数。")
        if (
            not isinstance(self.confidence, (int, float))
            or not 0.0 <= float(self.confidence) <= 1.0
        ):
            raise ValueError("关系记忆置信度必须在 0 到 1 之间。")
        if not isinstance(self.risk_flags, tuple) or any(
            not isinstance(flag, str) or not flag.strip()
            for flag in self.risk_flags
        ):
            raise ValueError("关系记忆风险标记必须是非空字符串元组。")
        if self.supersedes_memory_id is not None and not isinstance(
            self.supersedes_memory_id,
            UUID,
        ):
            raise TypeError("关系记忆版本链标识无效。")

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




@dataclass(frozen=True, slots=True)
class OwnerMemory:
    """用户自身事实的长期记忆；按 owner 归属，不携带联系人范围。"""

    memory_id: UUID
    owner_id: UUID
    text: str
    category: MemoryCategory
    topic: MemoryTopic
    source_ids: tuple[UUID, ...]
    adoption_method: AdoptionMethod
    status: ConfirmedMemoryStatus
    source_candidate_id: UUID | None = None
    valid_at: datetime | None = None
    invalid_at: datetime | None = None
    revision: int = 1
    confidence: float = 1.0
    risk_flags: tuple[str, ...] = ()
    supersedes_memory_id: UUID | None = None
    timing: MemoryTiming = MemoryTiming()
    event: MemoryEvent | None = None
    version_evidence: VersionEvidence | None = None
    can_revert_auto_update: bool = False

    def __post_init__(self) -> None:
        if self.event is not None and not isinstance(self.event, MemoryEvent):
            raise ValueError("记忆事件信息无效。")
        if not isinstance(self.memory_id, UUID) or not isinstance(
            self.owner_id, UUID
        ):
            raise ValueError("owner 记忆必须携带记忆 ID 与 owner ID。")
        if not isinstance(self.text, str) or not self.text.strip():
            raise ValueError("owner 记忆文本不能为空。")
        if not isinstance(self.timing, MemoryTiming):
            raise TypeError("owner 记忆时间信息无效。")
        if not isinstance(self.category, MemoryCategory):
            raise ValueError("owner 记忆分类必须使用既有五类。")
        if not isinstance(self.topic, MemoryTopic):
            raise ValueError("owner 记忆主题必须是受控主题。")
        if (
            not isinstance(self.source_ids, tuple)
            or not self.source_ids
            or any(not isinstance(item, UUID) for item in self.source_ids)
        ):
            raise ValueError("owner 记忆必须带至少一个来源引用。")
        if not isinstance(self.adoption_method, AdoptionMethod):
            raise ValueError("owner 记忆必须带采纳方式。")
        if not isinstance(self.status, ConfirmedMemoryStatus):
            raise ValueError("owner 记忆状态无效。")
        if self.source_candidate_id is not None and not isinstance(
            self.source_candidate_id,
            UUID,
        ):
            raise ValueError("owner 记忆来源候选标识无效。")
        if self.supersedes_memory_id is not None and not isinstance(
            self.supersedes_memory_id, UUID,
        ):
            raise ValueError("owner 记忆版本链标识无效。")
        if not isinstance(self.revision, int) or self.revision < 1:
            raise ValueError("owner 记忆版本必须从 1 开始。")
        if (
            not isinstance(self.confidence, (int, float))
            or not 0.0 <= float(self.confidence) <= 1.0
        ):
            raise ValueError("owner 记忆置信度必须在 0 到 1 之间。")
        if not isinstance(self.risk_flags, tuple) or any(
            not isinstance(flag, str) or not flag.strip()
            for flag in self.risk_flags
        ):
            raise ValueError("owner 记忆风险标记必须是非空字符串元组。")
        for value, label in (
            (self.valid_at, "生效时间"),
            (self.invalid_at, "失效时间"),
        ):
            if value is not None and (
                not isinstance(value, datetime) or value.tzinfo is None
            ):
                raise ValueError(f"owner 记忆{label}必须是带时区的 datetime。")
