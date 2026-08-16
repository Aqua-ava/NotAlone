"""跨 Module 共用的联系人范围值对象。"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID


@dataclass(frozen=True, slots=True)
class ContactScope:
    """一次操作唯一允许访问的用户与联系人范围。"""

    owner_id: UUID
    contact_id: UUID

    def __post_init__(self) -> None:
        if not isinstance(self.owner_id, UUID) or not isinstance(
            self.contact_id,
            UUID,
        ):
            raise TypeError("owner_id 和 contact_id 必须是 UUID。")
