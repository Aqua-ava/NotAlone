"""检索的合成内存适配器。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable
from uuid import UUID

from notalone.memory import MemoryPort
from notalone.retrieval.errors import RetrievalInvariantError
from notalone.retrieval.models import RetrievedMemory, RetrievedMessage
from notalone.scopes import ContactScope


def _tokens(query: str | None) -> tuple[str, ...]:
    if query is None or not query.strip():
        return ()
    return tuple(token.lower() for token in query.split() if token.strip())


def _matches(text: str, query: str | None) -> bool:
    tokens = _tokens(query)
    if not tokens:
        return True
    lowered = text.lower()
    return all(token in lowered for token in tokens)


def _validate_limit(limit: int, maximum: int) -> None:
    if not isinstance(limit, int) or not 1 <= limit <= maximum:
        raise ValueError("检索 limit 超出模块预算。")


@dataclass(slots=True)
class InMemoryRetrieval:
    """用合成消息和 MemoryPort 模拟联系人范围检索。"""

    messages: tuple[RetrievedMessage, ...] = ()
    memory_store: MemoryPort | None = None

    def __init__(
        self,
        *,
        messages: Iterable[RetrievedMessage] = (),
        memory_store: MemoryPort | None = None,
    ) -> None:
        self.messages = tuple(messages)
        self.memory_store = memory_store
        if any(not isinstance(message, RetrievedMessage) for message in self.messages):
            raise TypeError("合成消息检索数据结构无效。")

    def search_messages(
        self,
        *,
        scope: ContactScope,
        target_message_id: UUID | None = None,
        query: str | None = None,
        limit: int = 50,
    ) -> tuple[RetrievedMessage, ...]:
        _validate_limit(limit, 50)
        if not isinstance(scope, ContactScope):
            raise TypeError("消息检索范围无效。")

        scoped = tuple(message for message in self.messages if message.scope == scope)
        if target_message_id is not None:
            target = tuple(
                message
                for message in scoped
                if message.message_id == target_message_id
            )
            if not target:
                return ()
            related = tuple(
                message
                for message in scoped
                if message.message_id != target_message_id
                and _matches(message.text, query)
            )
            return (target[0], *related[: limit - 1])

        return tuple(
            message for message in scoped if _matches(message.text, query)
        )[:limit]

    def search_confirmed_memories(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
        limit: int = 20,
    ) -> tuple[RetrievedMemory, ...]:
        _validate_limit(limit, 20)
        if not isinstance(scope, ContactScope):
            raise TypeError("关系记忆检索范围无效。")
        if self.memory_store is None:
            return ()
        memories = self.memory_store.list_confirmed(scope)
        if not isinstance(memories, tuple) or any(
            memory.scope != scope for memory in memories
        ):
            raise RetrievalInvariantError(
                "关系记忆检索结果超出联系人范围。"
            )
        return tuple(
            RetrievedMemory(
                memory_id=memory.memory_id,
                scope=memory.scope,
                text=memory.text,
                category=memory.category.value,
                source_ids=memory.source_ids,
                adoption_method=memory.adoption_method.value,
                revision=memory.revision,
            )
            for memory in memories
            if _matches(memory.text, query)
        )[:limit]
