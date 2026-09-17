"""PostgreSQL 消息检索适配器。"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from notalone.memory import ConfirmedMemory, MemoryPort
from notalone.persistence.memory_store import (
    MemoryPersistenceError,
    PostgresMemoryStore,
)
from notalone.persistence.message_sources import (
    valid_source_ids_sql,
    valid_source_ref_exists_sql,
)
from notalone.retrieval.errors import RetrievalError, RetrievalInvariantError
from notalone.retrieval.models import (
    RetrievedMemory,
    RetrievedMessage,
    RetrievedOwnerMemory,
)
from notalone.retrieval.ranking import recall_memories, recall_owner_memories
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
        occurred_after: datetime | None = None,
        occurred_before: datetime | None = None,
        timeout_ms: int | None = None,
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
        _validate_window(occurred_after, occurred_before, timeout_ms)
        tokens = _query_tokens(query)

        try:
            with self._connect() as connection:
                connection.execute(
                    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
                )
                self._set_statement_timeout(connection, timeout_ms)
                if target_message_id is None:
                    rows = self._fetch_messages(
                        connection,
                        scope=scope,
                        tokens=tokens,
                        limit=limit,
                        occurred_after=occurred_after,
                        occurred_before=occurred_before,
                    )
                else:
                    target = self._fetch_target(
                        connection,
                        scope=scope,
                        target_message_id=target_message_id,
                        occurred_after=occurred_after,
                        occurred_before=occurred_before,
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
                            occurred_after=occurred_after,
                            occurred_before=occurred_before,
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
        memory_ids: tuple[UUID, ...] | None = None,
    ) -> tuple[RetrievedMemory, ...]:
        """返回当前联系人范围内 active 且有效的已确认记忆。"""

        self._validate_scope(scope)
        if query is not None and not isinstance(query, str):
            raise TypeError("关系记忆检索 query 必须是字符串或 None。")
        if not isinstance(limit, int) or not 1 <= limit <= 20:
            raise ValueError("检索 limit 超出模块预算。")
        if memory_ids is not None and (
            not isinstance(memory_ids, tuple)
            or any(not isinstance(memory_id, UUID) for memory_id in memory_ids)
        ):
            raise ValueError("关系记忆导航引用结构无效。")
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

    def search_owner_memories(
        self,
        *,
        owner_id: UUID,
        query: str | None = None,
        limit: int = 20,
        memory_ids: tuple[UUID, ...] | None = None,
    ) -> tuple[RetrievedOwnerMemory, ...]:
        """返回某位用户当前有效的本人记忆；query 提供时按同一评分器召回。"""

        if not isinstance(owner_id, UUID):
            raise TypeError("owner 记忆检索必须携带 owner ID。")
        if query is not None and not isinstance(query, str):
            raise TypeError("owner 记忆检索 query 必须是字符串或 None。")
        if not isinstance(limit, int) or not 1 <= limit <= 20:
            raise ValueError("检索 limit 超出模块预算。")
        if memory_ids is not None and (
            not isinstance(memory_ids, tuple)
            or any(not isinstance(memory_id, UUID) for memory_id in memory_ids)
        ):
            raise ValueError("owner 记忆导航引用结构无效。")
        if self._owner_memory_store is None:
            raise RetrievalError("owner 记忆检索失败。")
        try:
            memories = self._owner_memory_store.list_active(owner_id)
        except Exception:
            raise RetrievalError("owner 记忆检索失败。") from None
        if not isinstance(memories, tuple) or any(
            memory.owner_id != owner_id for memory in memories
        ):
            raise RetrievalInvariantError("owner 记忆检索结果超出 owner 范围。")
        retrieved = tuple(
            RetrievedOwnerMemory(
                memory_id=memory.memory_id,
                owner_id=memory.owner_id,
                text=memory.text,
                category=memory.category.value,
                topic=memory.topic.value,
                source_ids=memory.source_ids,
                adoption_method=memory.adoption_method.value,
                revision=memory.revision,
                status=memory.status.value,
                valid_at=memory.valid_at,
                invalid_at=memory.invalid_at,
                confidence=memory.confidence,
            )
            for memory in memories
            if memory_ids is None or memory.memory_id in memory_ids
        )
        return recall_owner_memories(retrieved, query=query, limit=limit)

    def _fetch_target(
        self,
        connection: psycopg.Connection[Any],
        *,
        scope: ContactScope,
        target_message_id: UUID,
        occurred_after: datetime | None = None,
        occurred_before: datetime | None = None,
    ) -> dict[str, Any] | None:
        conditions = [
            "m.owner_id = %s",
            "m.contact_id = %s",
            "m.id = %s",
            valid_source_ref_exists_sql("m"),
        ]
        parameters: list[Any] = [
            scope.owner_id,
            scope.contact_id,
            target_message_id,
        ]
        if occurred_after is not None:
            conditions.append("m.occurred_at >= %s")
            parameters.append(occurred_after)
        if occurred_before is not None:
            conditions.append("m.occurred_at <= %s")
            parameters.append(occurred_before)
        return connection.execute(
            f"""
            SELECT m.id AS message_id,
                   m.owner_id,
                   m.contact_id,
                   m.speaker,
                   {valid_source_ids_sql("m")} AS source_ids,
                   {_MESSAGE_TEXT_SQL} AS retrieved_text,
                   m.occurred_at
            FROM public.message AS m
            WHERE {' AND '.join(conditions)}
            """,
            parameters,
        ).fetchone()

    def _fetch_messages(
        self,
        connection: psycopg.Connection[Any],
        *,
        scope: ContactScope,
        tokens: tuple[str, ...],
        limit: int,
        excluded_message_id: UUID | None = None,
        occurred_after: datetime | None = None,
        occurred_before: datetime | None = None,
    ) -> tuple[dict[str, Any], ...]:
        conditions = [
            "m.owner_id = %s",
            "m.contact_id = %s",
            valid_source_ref_exists_sql("m"),
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
        if occurred_after is not None:
            conditions.append("m.occurred_at >= %s")
            parameters.append(occurred_after)
        if occurred_before is not None:
            conditions.append("m.occurred_at <= %s")
            parameters.append(occurred_before)
        parameters.append(limit)
        return tuple(
            connection.execute(
                f"""
                SELECT m.id AS message_id,
                       m.owner_id,
                       m.contact_id,
                       m.speaker,
                       {valid_source_ids_sql("m")} AS source_ids,
                       {_MESSAGE_TEXT_SQL} AS retrieved_text,
                       m.occurred_at
                FROM public.message AS m
                WHERE {' AND '.join(conditions)}
                ORDER BY m.occurred_at DESC NULLS LAST, m.id DESC
                LIMIT %s
                """,
                parameters,
            ).fetchall()
        )

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
        """按时间顺序读取当前联系人范围内的有限连续消息。"""

        self._validate_scope(scope)
        if anchor_message_id is not None and not isinstance(anchor_message_id, UUID):
            raise TypeError("消息锚点必须是 UUID 或 None。")
        if not isinstance(before, int) or not 0 <= before <= 10:
            raise ValueError("消息查询前置窗口超出预算。")
        if not isinstance(after, int) or not 0 <= after <= 10:
            raise ValueError("消息查询后置窗口超出预算。")
        if not isinstance(limit, int) or not 1 <= limit <= 20:
            raise ValueError("消息查询 limit 超出模块预算。")
        _validate_window(occurred_after, occurred_before, timeout_ms)

        try:
            with self._connect() as connection:
                connection.execute(
                    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
                )
                self._set_statement_timeout(connection, timeout_ms)
                if anchor_message_id is None:
                    rows = self._fetch_messages(
                        connection,
                        scope=scope,
                        tokens=(),
                        limit=limit,
                        occurred_after=occurred_after,
                        occurred_before=occurred_before,
                    )
                    return tuple(
                        self._message_from_row(row, scope)
                        for row in reversed(rows)
                    )

                anchor = self._fetch_target(
                    connection,
                    scope=scope,
                    target_message_id=anchor_message_id,
                    occurred_after=occurred_after,
                    occurred_before=occurred_before,
                )
                if anchor is None:
                    return ()
                anchor_time = anchor["occurred_at"]
                before_rows = self._fetch_adjacent(
                    connection,
                    scope=scope,
                    anchor_message_id=anchor_message_id,
                    anchor_time=anchor_time,
                    direction="before",
                    limit=before,
                    occurred_after=occurred_after,
                    occurred_before=occurred_before,
                )
                after_rows = self._fetch_adjacent(
                    connection,
                    scope=scope,
                    anchor_message_id=anchor_message_id,
                    anchor_time=anchor_time,
                    direction="after",
                    limit=after,
                    occurred_after=occurred_after,
                    occurred_before=occurred_before,
                )
                rows = (*reversed(before_rows), anchor, *after_rows)
                return tuple(
                    self._message_from_row(row, scope)
                    for row in rows[:limit]
                )
        except RetrievalError:
            raise
        except psycopg.Error:
            raise RetrievalError("消息顺序查询失败。") from None
        except (KeyError, TypeError, ValueError):
            raise RetrievalInvariantError("消息顺序查询结果结构无效。") from None

    def _fetch_adjacent(
        self,
        connection: psycopg.Connection[Any],
        *,
        scope: ContactScope,
        anchor_message_id: UUID,
        anchor_time: datetime | None,
        direction: str,
        limit: int,
        occurred_after: datetime | None,
        occurred_before: datetime | None,
    ) -> tuple[dict[str, Any], ...]:
        if limit == 0:
            return ()
        conditions = [
            "m.owner_id = %s",
            "m.contact_id = %s",
            "m.id <> %s",
            valid_source_ref_exists_sql("m"),
        ]
        parameters: list[Any] = [
            scope.owner_id,
            scope.contact_id,
            anchor_message_id,
        ]
        if anchor_time is None:
            conditions.append("m.occurred_at IS NULL")
            conditions.append(
                "m.id < %s" if direction == "before" else "m.id > %s"
            )
            parameters.append(anchor_message_id)
        elif direction == "before":
            conditions.append(
                "m.occurred_at IS NOT NULL AND "
                "(m.occurred_at < %s OR "
                "(m.occurred_at = %s AND m.id < %s))"
            )
            parameters.extend((anchor_time, anchor_time, anchor_message_id))
        else:
            conditions.append(
                "(m.occurred_at IS NULL OR "
                "(m.occurred_at > %s OR "
                "(m.occurred_at = %s AND m.id > %s)))"
            )
            parameters.extend((anchor_time, anchor_time, anchor_message_id))
        if occurred_after is not None:
            conditions.append("m.occurred_at >= %s")
            parameters.append(occurred_after)
        if occurred_before is not None:
            conditions.append("m.occurred_at <= %s")
            parameters.append(occurred_before)
        ordering = (
            "m.occurred_at DESC NULLS LAST, m.id DESC"
            if direction == "before"
            else "m.occurred_at ASC NULLS LAST, m.id ASC"
        )
        parameters.append(limit)
        return tuple(
            connection.execute(
                f"""
                SELECT m.id AS message_id,
                       m.owner_id,
                       m.contact_id,
                       m.speaker,
                       {valid_source_ids_sql("m")} AS source_ids,
                       {_MESSAGE_TEXT_SQL} AS retrieved_text,
                       m.occurred_at
                FROM public.message AS m
                WHERE {' AND '.join(conditions)}
                ORDER BY {ordering}
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
        source_ids = row["source_ids"]
        if (
            not isinstance(source_ids, list)
            or not source_ids
            or any(not isinstance(source_id, UUID) for source_id in source_ids)
        ):
            raise RetrievalInvariantError("消息来源引用结构无效。")
        return RetrievedMessage(
            message_id=row["message_id"],
            scope=scope,
            text=row["retrieved_text"],
            source_ids=tuple(source_ids),
            occurred_at=row["occurred_at"],
            role={
                "user": "owner",
                "contact": "contact",
                "system": "system",
            }.get(row.get("speaker"), "unknown"),
        )

    def _connect(self) -> Any:
        return psycopg.connect(self._database_url, row_factory=dict_row)

    @staticmethod
    def _set_statement_timeout(connection: Any, timeout_ms: int | None) -> None:
        if timeout_ms is not None:
            connection.execute(
                "SELECT set_config('statement_timeout', %s, true)",
                (f"{timeout_ms}ms",),
            )

    @staticmethod
    def _validate_scope(scope: ContactScope) -> None:
        if not isinstance(scope, ContactScope):
            raise TypeError("scope 必须是 ContactScope。")
