"""概览只引用已保存记忆，不产生新的关系事实。"""

from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol
from uuid import UUID

from notalone.memory.models import ConfirmedMemory, OwnerMemory
from notalone.scopes import ContactScope


@dataclass(frozen=True, slots=True, repr=False)
class OverviewSourceReference:
    source_id: UUID
    source_kind: Literal["source_document", "local_wechat_observation", "manual"]
    message_id: UUID | None = None
    source_ref_id: UUID | None = None
    locator: str | None = None
    contact_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class OverviewMemoryIdentity:
    memory_id: UUID
    revision: int


@dataclass(frozen=True, slots=True, repr=False)
class OverviewEntry:
    memory: ConfirmedMemory | OwnerMemory
    current_leaf: OverviewMemoryIdentity | None
    provenance_kind: Literal["manual_entry", "source_supported", "unknown"]
    references: tuple[OverviewSourceReference, ...]
    dependency_ids: tuple[UUID, ...] = ()

    @property
    def is_latest(self) -> bool:
        return self.current_leaf is not None and self.current_leaf.memory_id == self.memory.memory_id


@dataclass(frozen=True, slots=True, repr=False)
class RelationshipOverview:
    scope: ContactScope | UUID
    projection_revision: str
    memory_revision: int
    built_at: datetime
    entries: tuple[OverviewEntry, ...]


class OverviewUnavailable(RuntimeError):
    """投影不能可靠构建，错误不携带正文或底层连接信息。"""


class RelationshipOverviewPort(Protocol):
    def read_contact(self, scope: ContactScope) -> RelationshipOverview:
        """读取并原子重建当前投影；已删除资料不能从旧投影恢复。"""

    def read_owner(self, owner_id: UUID) -> RelationshipOverview:
        """读取本人资料，不能把联系人事实搬入本人范围。"""
