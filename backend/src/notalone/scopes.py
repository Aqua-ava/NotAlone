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


@dataclass(frozen=True, slots=True)
class VerifiedConversationScope:
    """已验证的回复执行范围；兼容字段可引用显式手动确认，不能据此授权渠道读取。"""

    owner_id: UUID
    contact_id: UUID
    conversation_binding_id: UUID

    def __post_init__(self) -> None:
        if not isinstance(self.owner_id, UUID) or not isinstance(
            self.contact_id,
            UUID,
        ) or not isinstance(self.conversation_binding_id, UUID):
            raise TypeError(
                "owner_id、contact_id 和 conversation_binding_id 必须是 UUID。",
            )


@dataclass(frozen=True, slots=True)
class OwnerScope:
    """本人整理范围；不授权任何联系人正文读取。"""

    owner_id: UUID
    contact_id: None = None

    def __post_init__(self) -> None:
        if not isinstance(self.owner_id, UUID) or self.contact_id is not None:
            raise TypeError("本人范围只接受owner UUID。")


def organization_scope(owner_id: UUID, contact_id: UUID | None) -> ContactScope | OwnerScope:
    return OwnerScope(owner_id) if contact_id is None else ContactScope(owner_id, contact_id)
