"""候选版本与明确选择；原版消息组和来源守卫沿用既有权威。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from contextlib import contextmanager
from typing import Any, Iterator, Protocol
from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.persistence.assistant_session_store import _dependencies_available
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.style_sample_store import require_reply_sources_current
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.interface import CandidateMessage
from notalone.scopes import ContactScope


class AssistantCandidateVersionError(RuntimeError):
    """错误只含稳定分类，不回显消息、修改要求或数据库异常。"""


class AssistantCandidateVersionNotFound(AssistantCandidateVersionError):
    pass


class AssistantCandidateVersionConflict(AssistantCandidateVersionError):
    def __init__(self, reason: str) -> None:
        super().__init__("候选版本请求发生冲突。")
        self.reason = reason


class AssistantCandidateVersionPersistenceError(AssistantCandidateVersionError):
    pass


class AssistantCandidateVersionRequestInvalid(ValueError):
    """公开命令结构无效，不携带不可信字段内容。"""


@dataclass(frozen=True, slots=True, repr=False)
class EditAssistantCandidate:
    edit_key: UUID
    parent_version_id: UUID
    messages: tuple[CandidateMessage, ...]
    requirements: str | None = None


@dataclass(frozen=True, slots=True, repr=False)
class AssistantCandidateVersion:
    version_id: UUID
    version_number: int
    parent_version_id: UUID | None
    messages: tuple[CandidateMessage, ...]
    requirements: str | None
    created_at: datetime

    @property
    def text(self) -> str:
        return "\n\n".join(message.text for message in self.messages)


@dataclass(frozen=True, slots=True, repr=False)
class AssistantCandidateHistory:
    session_id: UUID
    turn_id: UUID
    candidate_id: UUID
    candidate_group_id: UUID
    candidate_number: int
    default_display_version_id: UUID
    selected_version_id: UUID | None
    versions: tuple[AssistantCandidateVersion, ...]


@dataclass(frozen=True, slots=True)
class AssistantCandidateSelection:
    selection_id: UUID
    selection_number: int
    session_id: UUID
    candidate_id: UUID
    version_id: UUID


class AssistantCandidateVersions(Protocol):
    """每条读写路径均须同锁复验会话成员、A turn及C实际来源守卫。

    原版消息来自B的reply_candidate.message_group，不复制原文或另造来源权威。
    新版默认展示不能创建selection，编辑也不隐式采用新版。显式选择只记录使用痕迹。
    """

    def read(
        self, scope: ContactScope, session_id: UUID, candidate_id: UUID,
    ) -> AssistantCandidateHistory: ...

    def edit(
        self, scope: ContactScope, session_id: UUID, candidate_id: UUID,
        command: EditAssistantCandidate,
    ) -> AssistantCandidateHistory: ...

    def select(
        self, scope: ContactScope, session_id: UUID, candidate_id: UUID,
        version_id: UUID, selection_key: UUID,
    ) -> AssistantCandidateSelection: ...

    def selected(
        self, scope: ContactScope, session_id: UUID,
    ) -> AssistantCandidateSelection | None: ...


def _validate_scope(scope: ContactScope, session_id: UUID, *identifiers: UUID) -> None:
    if not isinstance(scope, ContactScope) or any(not isinstance(value, UUID) for value in (
        scope.owner_id, scope.contact_id, session_id, *identifiers,
    )):
        raise AssistantCandidateVersionRequestInvalid("候选版本请求结构无效。")


def _require_session(connection: Any, scope: ContactScope, session_id: UUID) -> None:
    if connection.execute(
        "SELECT 1 FROM public.assistant_session WHERE owner_id=%s AND contact_id=%s AND id=%s",
        (scope.owner_id, scope.contact_id, session_id),
    ).fetchone() is None:
        raise AssistantCandidateVersionNotFound("当前范围不存在助手会话。")


def _require_candidate(
    connection: Any, scope: ContactScope, session_id: UUID, candidate_id: UUID,
) -> dict[str, Any]:
    row = connection.execute("""
        SELECT candidate.id, candidate.reply_request_id, candidate.ordinal,
               candidate.message_group, candidate.created_at,
               turn.id AS turn_id, turn.state AS turn_state,
               turn.input_payload, turn.dependency_ids, request.state AS request_state,
               request.idempotency_key
        FROM public.reply_candidate AS candidate
        JOIN public.reply_request AS request ON request.id=candidate.reply_request_id
          AND request.owner_id=candidate.owner_id AND request.contact_id=candidate.contact_id
          AND request.conversation_binding_id=candidate.conversation_binding_id
        JOIN public.assistant_session_turn AS turn ON turn.reply_request_id=request.id
          AND turn.owner_id=candidate.owner_id AND turn.contact_id=candidate.contact_id
          AND turn.conversation_binding_id=candidate.conversation_binding_id
        WHERE candidate.owner_id=%s AND candidate.contact_id=%s AND candidate.id=%s
          AND turn.session_id=%s
    """, (scope.owner_id, scope.contact_id, candidate_id, session_id)).fetchone()
    if row is None:
        raise AssistantCandidateVersionNotFound("当前助手会话不存在指定候选。")
    if connection.execute(
        "SELECT 1 FROM public.reply_invalidated_key WHERE owner_id=%s AND contact_id=%s AND idempotency_key=%s",
        (scope.owner_id, scope.contact_id, row["idempotency_key"]),
    ).fetchone() is not None:
        raise AssistantCandidateVersionConflict("request_invalidated")
    if row["turn_state"] != "completed" or row["request_state"] != "completed" or row["input_payload"] is None:
        raise AssistantCandidateVersionConflict("candidate_unavailable")
    if not _dependencies_available(connection, scope.owner_id, set(row["dependency_ids"])):
        raise AssistantCandidateVersionConflict("source_unavailable")
    try:
        require_reply_sources_current(connection, owner_id=scope.owner_id, request_id=row["reply_request_id"])
    except ReplyStoreInvariantError:
        raise AssistantCandidateVersionConflict("source_unavailable") from None
    return row


def _messages(value: Any) -> tuple[CandidateMessage, ...]:
    try:
        return tuple(CandidateMessage(UUID(item["message_id"]), item["text"]) for item in value)
    except (TypeError, KeyError, ValueError):
        raise AssistantCandidateVersionPersistenceError("候选消息组保存记录无效。") from None


def _ensure_original(connection: Any, scope: ContactScope, session_id: UUID, candidate: dict[str, Any]) -> None:
    connection.execute("""
        INSERT INTO public.assistant_candidate_version
          (id,owner_id,contact_id,session_id,turn_id,candidate_id,version_number,created_at)
        VALUES (%s,%s,%s,%s,%s,%s,0,%s)
        ON CONFLICT (candidate_id,version_number) DO NOTHING
    """, (candidate["id"], scope.owner_id, scope.contact_id, session_id,
          candidate["turn_id"], candidate["id"], candidate["created_at"]))


def _selection(row: dict[str, Any]) -> AssistantCandidateSelection:
    return AssistantCandidateSelection(row["id"], row["selection_number"], row["session_id"],
                                       row["candidate_id"], row["version_id"])


def _history(
    connection: Any, scope: ContactScope, session_id: UUID, candidate: dict[str, Any],
) -> AssistantCandidateHistory:
    rows = connection.execute("""
        SELECT * FROM public.assistant_candidate_version
        WHERE owner_id=%s AND contact_id=%s AND session_id=%s AND candidate_id=%s
        ORDER BY version_number
    """, (scope.owner_id, scope.contact_id, session_id, candidate["id"])).fetchall()
    original_group = _messages(candidate["message_group"])
    records = tuple(AssistantCandidateVersion(
        row["id"], row["version_number"], row["parent_version_id"],
        original_group if row["version_number"] == 0 else _messages(row["message_group"]),
        row["requirements"], row["created_at"],
    ) for row in rows)
    if not records or records[0].version_number != 0:
        raise AssistantCandidateVersionPersistenceError("候选原版引用缺失。")
    chosen = connection.execute("""
        SELECT version_id FROM public.assistant_candidate_selection
        WHERE owner_id=%s AND contact_id=%s AND session_id=%s AND candidate_id=%s AND is_current
    """, (scope.owner_id, scope.contact_id, session_id, candidate["id"])).fetchone()
    return AssistantCandidateHistory(
        session_id, candidate["turn_id"], candidate["id"], candidate["reply_request_id"],
        candidate["ordinal"] + 1, records[-1].version_id,
        chosen["version_id"] if chosen is not None else None, records,
    )


def read_candidate_versions(
    connection: Any, scope: ContactScope, session_id: UUID, candidate_id: UUID,
) -> AssistantCandidateHistory:
    """可在调用方既有事务重读；复用同一connection的owner锁及来源守卫。"""
    _validate_scope(scope, session_id, candidate_id)
    lock_owner_scope(connection, owner_id=scope.owner_id)
    with connection.cursor(row_factory=dict_row) as cursor:
        _require_session(cursor, scope, session_id)
        candidate = _require_candidate(cursor, scope, session_id, candidate_id)
        _ensure_original(cursor, scope, session_id, candidate)
        return _history(cursor, scope, session_id, candidate)


def read_candidate_selection(
    connection: Any, scope: ContactScope, session_id: UUID,
) -> AssistantCandidateSelection | None:
    """当前选择只来自显式current投影；来源删除后不推断历史回退。"""
    _validate_scope(scope, session_id)
    lock_owner_scope(connection, owner_id=scope.owner_id)
    with connection.cursor(row_factory=dict_row) as cursor:
        _require_session(cursor, scope, session_id)
        row = cursor.execute("""
            SELECT * FROM public.assistant_candidate_selection
            WHERE owner_id=%s AND contact_id=%s AND session_id=%s AND is_current
        """, (scope.owner_id, scope.contact_id, session_id)).fetchone()
        if row is None:
            return None
        _require_candidate(cursor, scope, session_id, row["candidate_id"])
        return _selection(row)


def _validate_edit(command: EditAssistantCandidate) -> None:
    if (not isinstance(command, EditAssistantCandidate)
            or not isinstance(command.edit_key, UUID)
            or not isinstance(command.parent_version_id, UUID)
            or not isinstance(command.messages, tuple) or not 1 <= len(command.messages) <= 8
            or any(not isinstance(message, CandidateMessage) or not isinstance(message.message_id, UUID)
                   or not isinstance(message.text, str) or not message.text.strip()
                   or len(message.text) > (65536 if len(command.messages) == 1 else 8192)
                   for message in command.messages)
            or len("\n\n".join(message.text for message in command.messages)) > 65536
            or command.requirements is not None and (
                not isinstance(command.requirements, str) or not command.requirements.strip()
                or len(command.requirements) > 4096)):
        raise AssistantCandidateVersionRequestInvalid("候选编辑请求结构无效。")


def edit_candidate_version(
    connection: Any, scope: ContactScope, session_id: UUID, candidate_id: UUID,
    command: EditAssistantCandidate,
) -> AssistantCandidateHistory:
    """同一owner锁内只新增不可变版本，不改变当前选择或调用模型。"""
    _validate_scope(scope, session_id, candidate_id)
    _validate_edit(command)
    lock_owner_scope(connection, owner_id=scope.owner_id)
    with connection.cursor(row_factory=dict_row) as cursor:
        _require_session(cursor, scope, session_id)
        candidate = _require_candidate(cursor, scope, session_id, candidate_id)
        _ensure_original(cursor, scope, session_id, candidate)
        parent = cursor.execute("""
            SELECT 1 FROM public.assistant_candidate_version
            WHERE owner_id=%s AND contact_id=%s AND session_id=%s AND candidate_id=%s AND id=%s
        """, (scope.owner_id, scope.contact_id, session_id, candidate_id, command.parent_version_id)).fetchone()
        if parent is None:
            raise AssistantCandidateVersionNotFound("当前候选不存在指定父版本。")
        group = [{"message_id": str(message.message_id), "text": message.text} for message in command.messages]
        if not cursor.execute(
            "SELECT public.valid_assistant_candidate_edit_group(%s,%s) AS valid",
            (Jsonb(candidate["message_group"]), Jsonb(group)),
        ).fetchone()["valid"]:
            raise AssistantCandidateVersionConflict("message_group_mismatch")
        existing = cursor.execute("""
            SELECT parent_version_id,message_group,requirements FROM public.assistant_candidate_version
            WHERE owner_id=%s AND contact_id=%s AND session_id=%s AND candidate_id=%s AND edit_key=%s
        """, (scope.owner_id, scope.contact_id, session_id, candidate_id, command.edit_key)).fetchone()
        if existing is not None:
            if (existing["parent_version_id"], existing["message_group"], existing["requirements"]) != (
                command.parent_version_id, group, command.requirements,
            ):
                raise AssistantCandidateVersionConflict("edit_key_conflict")
            return _history(cursor, scope, session_id, candidate)
        number = cursor.execute("""
            SELECT coalesce(max(version_number),0)+1 AS next_number FROM public.assistant_candidate_version
            WHERE owner_id=%s AND contact_id=%s AND session_id=%s AND candidate_id=%s
        """, (scope.owner_id, scope.contact_id, session_id, candidate_id)).fetchone()["next_number"]
        cursor.execute("""
            INSERT INTO public.assistant_candidate_version
              (owner_id,contact_id,session_id,turn_id,candidate_id,version_number,
               parent_version_id,edit_key,message_group,requirements)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (scope.owner_id, scope.contact_id, session_id, candidate["turn_id"], candidate_id,
              number, command.parent_version_id, command.edit_key, Jsonb(group), command.requirements))
        return _history(cursor, scope, session_id, candidate)


def select_candidate_version(
    connection: Any, scope: ContactScope, session_id: UUID, candidate_id: UUID,
    version_id: UUID, selection_key: UUID,
) -> AssistantCandidateSelection:
    """明确点击才创建选择；幂等旧键不倒转当前投影，也不宣称发送。"""
    _validate_scope(scope, session_id, candidate_id, version_id, selection_key)
    lock_owner_scope(connection, owner_id=scope.owner_id)
    with connection.cursor(row_factory=dict_row) as cursor:
        _require_session(cursor, scope, session_id)
        candidate = _require_candidate(cursor, scope, session_id, candidate_id)
        _ensure_original(cursor, scope, session_id, candidate)
        if cursor.execute("""
            SELECT 1 FROM public.assistant_candidate_version
            WHERE owner_id=%s AND contact_id=%s AND session_id=%s AND candidate_id=%s AND id=%s
        """, (scope.owner_id, scope.contact_id, session_id, candidate_id, version_id)).fetchone() is None:
            raise AssistantCandidateVersionNotFound("当前候选不存在指定版本。")
        existing = cursor.execute("""
            SELECT * FROM public.assistant_candidate_selection
            WHERE owner_id=%s AND contact_id=%s AND session_id=%s AND selection_key=%s
        """, (scope.owner_id, scope.contact_id, session_id, selection_key)).fetchone()
        if existing is not None:
            if (existing["candidate_id"], existing["version_id"]) != (candidate_id, version_id):
                raise AssistantCandidateVersionConflict("selection_key_conflict")
            return _selection(existing)
        number = cursor.execute("""
            SELECT coalesce(max(selection_number),0)+1 AS next_number FROM public.assistant_candidate_selection
            WHERE owner_id=%s AND contact_id=%s AND session_id=%s
        """, (scope.owner_id, scope.contact_id, session_id)).fetchone()["next_number"]
        cursor.execute("""
            UPDATE public.assistant_candidate_selection SET is_current=FALSE
            WHERE owner_id=%s AND contact_id=%s AND session_id=%s AND is_current
        """, (scope.owner_id, scope.contact_id, session_id))
        row = cursor.execute("""
            INSERT INTO public.assistant_candidate_selection
              (owner_id,contact_id,session_id,selection_key,selection_number,candidate_id,version_id)
            VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *
        """, (scope.owner_id, scope.contact_id, session_id, selection_key, number, candidate_id, version_id)).fetchone()
        return _selection(row)


class PostgresAssistantCandidateVersions:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    @contextmanager
    def _transaction(self) -> Iterator[Any]:
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                yield connection
        except psycopg.Error:
            raise AssistantCandidateVersionPersistenceError("候选版本未可靠保存。") from None

    def read(self, scope: ContactScope, session_id: UUID, candidate_id: UUID) -> AssistantCandidateHistory:
        with self._transaction() as connection:
            return read_candidate_versions(connection, scope, session_id, candidate_id)

    def selected(self, scope: ContactScope, session_id: UUID) -> AssistantCandidateSelection | None:
        with self._transaction() as connection:
            return read_candidate_selection(connection, scope, session_id)

    def edit(
        self, scope: ContactScope, session_id: UUID, candidate_id: UUID, command: EditAssistantCandidate,
    ) -> AssistantCandidateHistory:
        with self._transaction() as connection:
            return edit_candidate_version(connection, scope, session_id, candidate_id, command)

    def select(
        self, scope: ContactScope, session_id: UUID, candidate_id: UUID,
        version_id: UUID, selection_key: UUID,
    ) -> AssistantCandidateSelection:
        with self._transaction() as connection:
            return select_candidate_version(connection, scope, session_id, candidate_id, version_id, selection_key)
