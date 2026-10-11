"""已确认联系人范围内的助手会话目录及显式当前会话切换。"""

from __future__ import annotations

from contextlib import contextmanager
from typing import TYPE_CHECKING, Any, Iterator
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from notalone.application.assistant_session_service import (
    AssistantSessionNotFound, AssistantSessionPersistenceError, AssistantSessionSummary,
)
from notalone.persistence.assistant_session_store import _active_binding
from notalone.persistence.locks import lock_owner_scope
from notalone.scopes import ContactScope


if TYPE_CHECKING:
    from notalone.application.assistant_candidate_carry import CarriedAssistantSession, CarryAssistantCandidate


def new_assistant_session_in_transaction(connection: Any, scope: ContactScope) -> UUID:
    """同一owner事务中的唯一新会话writer，调用方负责提交或整体回滚。"""

    _active_binding(connection, scope)
    connection.execute(
        "UPDATE public.assistant_session SET is_default = FALSE "
        "WHERE owner_id = %s AND contact_id = %s AND is_default",
        (scope.owner_id, scope.contact_id),
    )
    row = connection.execute(
        "INSERT INTO public.assistant_session (owner_id, contact_id, is_default) "
        "VALUES (%s, %s, TRUE) RETURNING id",
        (scope.owner_id, scope.contact_id),
    ).fetchone()
    return row["id"]


class PostgresAssistantSessionCatalog:
    """新开只创建空会话；当前指针由用户动作决定，不改变旧会话记录。"""

    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    @contextmanager
    def _transaction(self, scope: ContactScope) -> Iterator[Any]:
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=scope.owner_id)
                if not connection.execute(
                    "SELECT 1 FROM public.contact WHERE owner_id = %s AND id = %s FOR SHARE",
                    (scope.owner_id, scope.contact_id),
                ).fetchone():
                    raise AssistantSessionNotFound("指定范围内不存在联系人。")
                yield connection
        except psycopg.Error:
            raise AssistantSessionPersistenceError("助手会话目录操作未可靠完成。") from None

    def new(self, scope: ContactScope) -> UUID:
        with self._transaction(scope) as connection:
            return new_assistant_session_in_transaction(connection, scope)

    def new_with_candidate(
        self, scope: ContactScope, session_id: UUID, command: CarryAssistantCandidate,
    ) -> CarriedAssistantSession:
        from notalone.persistence.assistant_candidate_carry import new_assistant_session_with_candidate
        with self._transaction(scope) as connection:
            return new_assistant_session_with_candidate(connection, scope, session_id, command)

    def list_sessions(self, scope: ContactScope) -> tuple[AssistantSessionSummary, ...]:
        with self._transaction(scope) as connection:
            rows = connection.execute(
                "SELECT id, is_default FROM public.assistant_session "
                "WHERE owner_id = %s AND contact_id = %s ORDER BY id",
                (scope.owner_id, scope.contact_id),
            ).fetchall()
            return tuple(
                AssistantSessionSummary(session_id=row["id"], is_current=row["is_default"])
                for row in rows
            )

    def select(self, scope: ContactScope, session_id: UUID) -> UUID:
        with self._transaction(scope) as connection:
            if not connection.execute(
                "SELECT 1 FROM public.assistant_session "
                "WHERE owner_id = %s AND contact_id = %s AND id = %s FOR UPDATE",
                (scope.owner_id, scope.contact_id, session_id),
            ).fetchone():
                raise AssistantSessionNotFound("指定范围内不存在助手会话。")
            connection.execute(
                "UPDATE public.assistant_session SET is_default = FALSE "
                "WHERE owner_id = %s AND contact_id = %s AND is_default AND id <> %s",
                (scope.owner_id, scope.contact_id, session_id),
            )
            connection.execute(
                "UPDATE public.assistant_session SET is_default = TRUE "
                "WHERE owner_id = %s AND contact_id = %s AND id = %s",
                (scope.owner_id, scope.contact_id, session_id),
            )
            return session_id
