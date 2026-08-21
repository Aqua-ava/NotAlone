"""联系人范围检索的公共接口。"""

from __future__ import annotations

from typing import Protocol
from uuid import UUID

from notalone.retrieval.models import RetrievedMemory, RetrievedMessage
from notalone.scopes import ContactScope


class RetrievalPort(Protocol):
    """只负责查询，不拥有消息或关系记忆的生命周期。"""

    def search_messages(
        self,
        *,
        scope: ContactScope,
        target_message_id: UUID | None = None,
        query: str | None = None,
        limit: int = 50,
    ) -> tuple[RetrievedMessage, ...]:
        """查询指定联系人范围内的消息。"""

    def search_confirmed_memories(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
        limit: int = 20,
    ) -> tuple[RetrievedMemory, ...]:
        """查询指定联系人范围内当前有效的已确认关系记忆。"""
