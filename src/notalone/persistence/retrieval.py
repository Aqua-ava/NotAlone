"""PostgreSQL 消息检索适配器。"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from notalone.memory import ConfirmedMemory, MemoryPort
from notalone.persistence.memory_store import (
    MemoryPersistenceError,
    PostgresMemoryStore,
)
from notalone.retrieval.errors import RetrievalError, RetrievalInvariantError
from notalone.retrieval.models import (
    RetrievedMemory,
    RetrievedMessage,
    RetrievedOwnerMemory,
)
from notalone.memory.ports import OwnerMemoryPort
from notalone.scopes import ContactScope


_MESSAGE_TEXT_SQL = """
CASE
    WHEN length(btrim(m.text_content)) > 0 THEN m.text_content
    ELSE m.media_placeholder
END
"""


def _query_tokens(query: str | None) -> tuple[str, ...]:
    if query is None:
        return ()
    if not isinstance(query, str):
        raise TypeError("消息检索 query 必须是字符串或 None。")
    if not query.strip():
        return ()
    return tuple(token.lower() for token in query.split() if token.strip())


def _validate_limit(limit: int) -> None:
    if not isinstance(limit, int) or not 1 <= limit <= 50:
        raise ValueError("检索 limit 超出模块预算。")


class PostgresRetrieval:
    """按联系人范围只读检索规范化消息。"""

    __slots__ = ("_database_url", "_memory_store", "_owner_memory_store")

    def __init__(
        self,
        database_url: str,
        *,
        memory_store: MemoryPort | None = None,
        owner_memory_store: OwnerMemoryPort | None = None,
    ) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url
        self._owner_memory_store = owner_memory_store
        self._memory_store = (
            memory_store
            if memory_store is not None
            else PostgresMemoryStore(database_url)
        )

    def search_messages(
        self,
        *,
        scope: ContactScope,
        target_message_id: UUID | None = None,
        query: str | None = None,
        limit: int = 50,
    ) -> tuple[RetrievedMessage, ...]:
        """返回当前联系人范围内来源有效的消息命中。"""

        self._validate_scope(scope)
        if target_message_id is not None and not isinstance(
            target_message_id,
            UUID,
        ):
            raise TypeError("target_message_id 必须是 UUID 或 None。")
        if query is not None and not isinstance(query, str):
            raise TypeError("消息检索 query 必须是字符串或 None。")
        _validate_limit(limit)
        tokens = _query_tokens(query)

        try:
            with self._connect() as connection:
                connection.execute(
                    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
                )
                if target_message_id is None:
                    rows = self._fetch_messages(
                        connection,
                        scope=scope,
                        tokens=tokens,
                        limit=limit,
                    )
                else:
                    target = self._fetch_target(
                        connection,
                        scope=scope,
                        target_message_id=target_message_id,
                    )
                    if target is None:
                        return ()
                    related = ()
                    if limit > 1:
                        related = self._fetch_messages(
                            connection,
                            scope=scope,
                            tokens=tokens,
                            limit=limit - 1,
                            excluded_message_id=target_message_id,
                        )
                    rows = (target, *related)
                return tuple(self._message_from_row(row, scope) for row in rows)
        except RetrievalError:
            raise
        except psycopg.Error:
            raise RetrievalError("消息检索失败。") from None
        except (KeyError, TypeError, ValueError):
            raise RetrievalInvariantError("消息检索结果结构无效。") from None

    def search_confirmed_memories(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
        limit: int = 20,
    ) -> tuple[RetrievedMemory, ...]:
        """返回当前联系人范围内 active 且有效的已确认记忆。"""

        self._validate_scope(scope)
        if query is not None and not isinstance(query, str):
            raise TypeError("关系记忆检索 query 必须是字符串或 None。")
        if not isinstance(limit, int) or not 1 <= limit <= 20:
            raise ValueError("检索 limit 超出模块预算。")
        try:
            memories = self._memory_store.list_confirmed(scope)
        except MemoryPersistenceError:
            raise RetrievalError("关系记忆检索失败。") from None
        except RetrievalError:
            raise
        except Exception:
            raise RetrievalError("关系记忆检索失败。") from None
        if not isinstance(memories, tuple) or any(
            not isinstance(memory, ConfirmedMemory) or memory.scope != scope
            for memory in memories
        ):
            raise RetrievalInvariantError("关系记忆检索结果超出联系人范围。")
        tokens = _query_tokens(query)
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
            if not tokens or all(token in memory.text.lower() for token in tokens)
        )[:limit]


    def search_owner_memories(
        self,
        *,
        owner_id,
        query: str | None = None,
        limit: int = 20,
    ) -> tuple[RetrievedOwnerMemory, ...]:
        """返回某位用户当前有效的 owner 级自我记忆。"""

        if not isinstance(owner_id, UUID):
            raise TypeError("owner 记忆检索必须携带 owner ID。")
        if query is not None and not isinstance(query, str):
            raise TypeError("owner 记忆检索 query 必须是字符串或 None。")
        if not isinstance(limit, int) or not 1 <= limit <= 20:
            raise ValueError("检索 limit 超出模块预算。")
        if self._owner_memory_store is None:
            raise RetrievalError("owner 记忆检索失败。")
        try:
            memories = self._owner_memory_store.list_active(owner_id)
        except Exception:
            raise RetrievalError("owner 记忆检索失败。") from None
        tokens = _query_tokens(query)
        return tuple(
            RetrievedOwnerMemory(
                memory_id=memory.memory_id,
                owner_id=memory.owner_id,
                text=memory.text,
                category=memory.category.value,
                topic=memory.topic.value,
                source_ids=memory.source_ids,
                adoption_method=memory.adoption_method.value,
                revision=memory.revision,
            )
            for memory in memories
            if not tokens or all(token in memory.text.lower() for token in tokens)
        )[:limit]

    def _fetch_target(
        self,
        connection: psycopg.Connection[Any],
        *,
        scope: ContactScope,
        target_message_id: UUID,
    ) -> dict[str, Any] | None:
        return connection.execute(
            f"""
            SELECT m.id AS message_id,
                   m.owner_id,
                   m.contact_id,
                   m.source_document_id,
                   {_MESSAGE_TEXT_SQL} AS retrieved_text,
                   m.occurred_at
            FROM public.message AS m
            JOIN public.source_document AS source
              ON source.id = m.source_document_id
             AND source.owner_id = m.owner_id
             AND source.contact_id = m.contact_id
            WHERE m.owner_id = %s
              AND m.contact_id = %s
              AND m.id = %s
              AND source.status = 'active'
            """,
            (scope.owner_id, scope.contact_id, target_message_id),
        ).fetchone()

    def _fetch_messages(
        self,
        connection: psycopg.Connection[Any],
        *,
        scope: ContactScope,
        tokens: tuple[str, ...],
        limit: int,
        excluded_message_id: UUID | None = None,
    ) -> tuple[dict[str, Any], ...]:
        conditions = [
            "m.owner_id = %s",
            "m.contact_id = %s",
            "source.status = 'active'",
        ]
        parameters: list[Any] = [scope.owner_id, scope.contact_id]
        if excluded_message_id is not None:
            conditions.append("m.id <> %s")
            parameters.append(excluded_message_id)
        for token in tokens:
            conditions.append(
                f"position(lower(%s) in lower({_MESSAGE_TEXT_SQL})) > 0"
            )
            parameters.append(token)
        parameters.append(limit)
        return tuple(
            connection.execute(
                f"""
                SELECT m.id AS message_id,
                       m.owner_id,
                       m.contact_id,
                       m.source_document_id,
                       {_MESSAGE_TEXT_SQL} AS retrieved_text,
                       m.occurred_at
                FROM public.message AS m
                JOIN public.source_document AS source
                  ON source.id = m.source_document_id
                 AND source.owner_id = m.owner_id
                 AND source.contact_id = m.contact_id
                WHERE {' AND '.join(conditions)}
                ORDER BY m.occurred_at DESC NULLS LAST, m.id DESC
                LIMIT %s
                """,
                parameters,
            ).fetchall()
        )

    def _message_from_row(
        self,
        row: dict[str, Any],
        scope: ContactScope,
    ) -> RetrievedMessage:
        if (
            row["owner_id"] != scope.owner_id
            or row["contact_id"] != scope.contact_id
        ):
            raise RetrievalInvariantError("消息检索结果超出联系人范围。")
        source_id = row["source_document_id"]
        if not isinstance(source_id, UUID):
            raise RetrievalInvariantError("消息来源引用结构无效。")
        return RetrievedMessage(
            message_id=row["message_id"],
            scope=scope,
            text=row["retrieved_text"],
            source_ids=(source_id,),
            occurred_at=row["occurred_at"],
        )

    def _connect(self) -> Any:
        return psycopg.connect(self._database_url, row_factory=dict_row)

    @staticmethod
    def _validate_scope(scope: ContactScope) -> None:
        if not isinstance(scope, ContactScope):
            raise TypeError("scope 必须是 ContactScope。")
