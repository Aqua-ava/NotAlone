"""检索的合成内存适配器。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Iterable
from uuid import UUID

from notalone.memory import MemoryPort
from notalone.retrieval.errors import RetrievalInvariantError
from notalone.retrieval.models import (
    RetrievedMemory,
    RetrievedMessage,
    RetrievedOwnerMemory,
)
from notalone.retrieval.ranking import recall_memories, recall_owner_memories
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


def _validate_window(
    occurred_after: datetime | None,
    occurred_before: datetime | None,
    timeout_ms: int | None,
) -> None:
    if occurred_after is not None and not isinstance(occurred_after, datetime):
        raise TypeError("检索起始时间结构无效。")
    if occurred_before is not None and not isinstance(occurred_before, datetime):
        raise TypeError("检索结束时间结构无效。")
    if (
        occurred_after is not None
        and occurred_before is not None
        and occurred_before < occurred_after
    ):
        raise ValueError("检索时间范围无效。")
    if timeout_ms is not None and (
        not isinstance(timeout_ms, int) or not 1 <= timeout_ms <= 1500
    ):
        raise ValueError("检索超时时间超出模块预算。")


def _in_time_window(
    message: RetrievedMessage,
    occurred_after: datetime | None,
    occurred_before: datetime | None,
) -> bool:
    if message.occurred_at is None:
        return occurred_after is None and occurred_before is None
    return (
        (occurred_after is None or message.occurred_at >= occurred_after)
        and (occurred_before is None or message.occurred_at <= occurred_before)
    )


def _chronological_key(message: RetrievedMessage) -> tuple[bool, datetime, str]:
    return (
        message.occurred_at is None,
        message.occurred_at or datetime.max,
        str(message.message_id),
    )


@dataclass(slots=True)
class InMemoryRetrieval:
    """用合成消息、MemoryPort 和本人记忆模拟范围检索。"""

    messages: tuple[RetrievedMessage, ...] = ()
    memory_store: MemoryPort | None = None
    owner_memories: tuple[RetrievedOwnerMemory, ...] = ()

    def __init__(
        self,
        *,
        messages: Iterable[RetrievedMessage] = (),
        memory_store: MemoryPort | None = None,
        owner_memories: Iterable[RetrievedOwnerMemory] = (),
    ) -> None:
        self.messages = tuple(messages)
        self.memory_store = memory_store
        self.owner_memories = tuple(owner_memories)
        if any(not isinstance(message, RetrievedMessage) for message in self.messages):
            raise TypeError("合成消息检索数据结构无效。")
        if any(
            not isinstance(memory, RetrievedOwnerMemory)
            for memory in self.owner_memories
        ):
            raise TypeError("合成 owner 记忆检索数据结构无效。")

    def search_messages(
        self,
        *,
        scope: ContactScope,
        target_message_id: UUID | None = None,
        query: str | None = None,
        limit: int = 50,
        occurred_after: datetime | None = None,
        occurred_before: datetime | None = None,
        timeout_ms: int | None = None,
    ) -> tuple[RetrievedMessage, ...]:
        _validate_limit(limit, 50)
        _validate_window(occurred_after, occurred_before, timeout_ms)
        if not isinstance(scope, ContactScope):
            raise TypeError("消息检索范围无效。")

        scoped = tuple(
            message
            for message in self.messages
            if message.scope == scope
            and _in_time_window(message, occurred_after, occurred_before)
        )
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

    def query_messages(
        self,
        *,
        scope: ContactScope,
        anchor_message_id: UUID | None = None,
        before: int = 3,
        after: int = 3,
        limit: int = 20,
        occurred_after: datetime | None = None,
        occurred_before: datetime | None = None,
        timeout_ms: int | None = None,
    ) -> tuple[RetrievedMessage, ...]:
        _validate_limit(limit, 20)
        _validate_window(occurred_after, occurred_before, timeout_ms)
        if not isinstance(scope, ContactScope):
            raise TypeError("消息查询范围无效。")
        if anchor_message_id is not None and not isinstance(anchor_message_id, UUID):
            raise TypeError("消息锚点必须是 UUID 或 None。")
        if not isinstance(before, int) or not 0 <= before <= 10:
            raise ValueError("消息查询前置窗口超出预算。")
        if not isinstance(after, int) or not 0 <= after <= 10:
            raise ValueError("消息查询后置窗口超出预算。")

        scoped = sorted(
            (
                message
                for message in self.messages
                if message.scope == scope
                and _in_time_window(message, occurred_after, occurred_before)
            ),
            key=_chronological_key,
        )
        if anchor_message_id is None:
            return tuple(scoped[-limit:])
        anchor_positions = [
            index
            for index, message in enumerate(scoped)
            if message.message_id == anchor_message_id
        ]
        if len(anchor_positions) != 1:
            return ()
        anchor_index = anchor_positions[0]
        start = max(0, anchor_index - before)
        end = min(len(scoped), anchor_index + after + 1)
        selected = scoped[start:end]
        return tuple(selected[:limit])

    def search_owner_memories(
        self,
        *,
        owner_id: UUID,
        query: str | None = None,
        limit: int = 20,
        memory_ids: tuple[UUID, ...] | None = None,
    ) -> tuple[RetrievedOwnerMemory, ...]:
        _validate_limit(limit, 20)
        if not isinstance(owner_id, UUID):
            raise TypeError("owner 记忆检索必须携带 owner ID。")
        if query is not None and not isinstance(query, str):
            raise TypeError("owner 记忆检索 query 必须是字符串或 None。")
        if memory_ids is not None and (
            not isinstance(memory_ids, tuple)
            or any(not isinstance(memory_id, UUID) for memory_id in memory_ids)
        ):
            raise ValueError("owner 记忆导航引用结构无效。")
        scoped = tuple(
            memory
            for memory in self.owner_memories
            if memory.owner_id == owner_id
            and (memory_ids is None or memory.memory_id in memory_ids)
        )
        return recall_owner_memories(scoped, query=query, limit=limit)

    def search_confirmed_memories(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
        limit: int = 20,
        memory_ids: tuple[UUID, ...] | None = None,
    ) -> tuple[RetrievedMemory, ...]:
        _validate_limit(limit, 20)
        if not isinstance(scope, ContactScope):
            raise TypeError("关系记忆检索范围无效。")
        if query is not None and not isinstance(query, str):
            raise TypeError("关系记忆检索 query 必须是字符串或 None。")
        if memory_ids is not None and (
            not isinstance(memory_ids, tuple)
            or any(not isinstance(memory_id, UUID) for memory_id in memory_ids)
        ):
            raise ValueError("关系记忆导航引用结构无效。")
        if self.memory_store is None:
            return ()
        memories = self.memory_store.list_confirmed(scope)
        if not isinstance(memories, tuple) or any(
            memory.scope != scope for memory in memories
        ):
            raise RetrievalInvariantError(
                "关系记忆检索结果超出联系人范围。"
            )
        retrieved = tuple(
            RetrievedMemory(
                memory_id=memory.memory_id,
                scope=memory.scope,
                text=memory.text,
                category=memory.category.value,
                source_ids=memory.source_ids,
                adoption_method=memory.adoption_method.value,
                revision=memory.revision,
                topic=memory.topic.value,
                status=memory.status.value,
                valid_at=memory.valid_at,
                invalid_at=memory.invalid_at,
                confidence=memory.confidence,
            )
            for memory in memories
            if memory_ids is None or memory.memory_id in memory_ids
        )
        return recall_memories(retrieved, query=query, limit=limit)
