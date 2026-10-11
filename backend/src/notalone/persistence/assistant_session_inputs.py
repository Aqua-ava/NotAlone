"""助手会话的稳定输入索引；生成正文与来源仍由既有 turn 持有。"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator
from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.application.assistant_session_service import (
    AssistantSessionConflict, AssistantSessionNotFound,
    AssistantSessionPersistenceError, AssistantSessionRejected,
)
from notalone.persistence.assistant_session_store import (
    _active_binding, _dependencies_available, _expand_message_sources,
)
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.message_sources import valid_source_ref_exists_sql
from notalone.persistence.style_sample_store import require_reply_sources_current
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.scopes import ContactScope


@dataclass(frozen=True, slots=True, repr=False)
class AssistantInput:
    input_version_id: UUID
    session_id: UUID
    type: str
    conversation_binding_id: UUID
    turn_id: UUID | None
    state: str
    content: dict[str, Any] | None


def require_input_session(connection: Any, scope: ContactScope, session_id: UUID) -> dict[str, Any]:
    row = connection.execute(
        "SELECT current_input_version_id FROM public.assistant_session "
        "WHERE owner_id = %s AND contact_id = %s AND id = %s FOR UPDATE",
        (scope.owner_id, scope.contact_id, session_id),
    ).fetchone()
    if row is None:
        raise AssistantSessionNotFound("指定范围内不存在助手会话。")
    return row


def check_expected_input(session: dict[str, Any], expected_input_version_id: UUID | None) -> None:
    if expected_input_version_id is None:
        return
    if not isinstance(expected_input_version_id, UUID):
        raise AssistantSessionRejected("invalid_discussion_input")
    if session["current_input_version_id"] != expected_input_version_id:
        raise AssistantSessionConflict("助手会话已采用新的输入，请重新读取后继续。")


def normalize_discussion_content(content: dict[str, Any]) -> dict[str, Any]:
    """仅保存本轮用户讨论与选择，未知字段和超长文字明确拒绝。"""

    if not isinstance(content, dict):
        raise AssistantSessionRejected("invalid_discussion_input")
    text_fields = ("correction", "requirements", "answer", "confirmed_intent")
    common = {"type", "skill_mode", "skill_version_id", *text_fields}
    input_type = content.get("type")
    if input_type == "response_exploration":
        allowed = common | {"target_message_id"}
        target_id = content.get("target_message_id")
        if not isinstance(target_id, (str, UUID)):
            raise AssistantSessionRejected("invalid_discussion_input")
        try:
            normalized = {"type": input_type, "target_message_id": str(UUID(str(target_id)))}
        except ValueError:
            raise AssistantSessionRejected("invalid_discussion_input") from None
    elif input_type == "purpose_exploration":
        allowed = common | {"purpose_hint"}
        purpose_hint = content.get("purpose_hint")
        if not isinstance(purpose_hint, str):
            raise AssistantSessionRejected("invalid_discussion_input")
        normalized = {"type": input_type, "purpose_hint": purpose_hint}
    else:
        raise AssistantSessionRejected("invalid_discussion_input")
    if set(content) - allowed:
        raise AssistantSessionRejected("invalid_discussion_input")
    for field in text_fields:
        value = content.get(field, "")
        if not isinstance(value, str) or len(value) > 4096:
            raise AssistantSessionRejected("invalid_discussion_input")
        normalized[field] = value
    skill_mode = content.get("skill_mode", "auto")
    if skill_mode not in ("auto", "disabled", "user"):
        raise AssistantSessionRejected("invalid_discussion_input")
    version_id = content.get("skill_version_id")
    if skill_mode == "user":
        if not isinstance(version_id, (str, UUID)):
            raise AssistantSessionRejected("invalid_discussion_input")
        try:
            version_id = str(UUID(str(version_id)))
        except ValueError:
            raise AssistantSessionRejected("invalid_discussion_input") from None
    elif version_id is not None:
        raise AssistantSessionRejected("invalid_discussion_input")
    normalized["skill_mode"] = skill_mode
    normalized["skill_version_id"] = version_id
    return normalized


def verified_discussion_dependencies(
    connection: Any, scope: ContactScope, dependencies: tuple[UUID, ...],
) -> set[UUID]:
    """服务端检索元数据仍复核归属，跨联系人来源必须沿实际本人记忆证明。"""

    if (not isinstance(dependencies, tuple) or any(not isinstance(item, UUID) for item in dependencies)
            or scope.owner_id in dependencies):
        raise AssistantSessionRejected("invalid_discussion_dependencies")
    declared = set(dependencies)
    if not declared:
        return set()
    parameters = {"owner_id": scope.owner_id, "contact_id": scope.contact_id,
                  "dependencies": list(declared)}
    scoped_rows = connection.execute(
        f"""
        SELECT source.id, 'original' AS kind FROM public.source_document AS source
        WHERE source.owner_id = %(owner_id)s AND source.contact_id = %(contact_id)s
          AND source.status = 'active' AND source.id = ANY(%(dependencies)s::uuid[])
        UNION
        SELECT observation.id, 'original' AS kind FROM public.local_wechat_observation AS observation
        WHERE observation.owner_id = %(owner_id)s AND observation.contact_id = %(contact_id)s
          AND observation.id = ANY(%(dependencies)s::uuid[])
        UNION
        SELECT message.id, 'original' AS kind FROM public.message AS message
        WHERE message.owner_id = %(owner_id)s AND message.contact_id = %(contact_id)s
          AND message.id = ANY(%(dependencies)s::uuid[]) AND {valid_source_ref_exists_sql('message')}
        UNION
        SELECT memory.id, 'memory' AS kind FROM public.confirmed_memory AS memory
        WHERE memory.owner_id = %(owner_id)s AND memory.contact_id = %(contact_id)s
          AND memory.status = 'active' AND memory.id = ANY(%(dependencies)s::uuid[])
          AND (memory.valid_at IS NULL OR memory.valid_at <= now())
          AND (memory.invalid_at IS NULL OR now() < memory.invalid_at)
        UNION
        SELECT candidate.id, 'memory' AS kind FROM public.memory_candidate AS candidate
        WHERE candidate.owner_id = %(owner_id)s AND candidate.contact_id = %(contact_id)s
          AND candidate.status IN ('pending', 'confirmed')
          AND candidate.id = ANY(%(dependencies)s::uuid[])
          AND (candidate.valid_at IS NULL OR candidate.valid_at <= now())
          AND (candidate.invalid_at IS NULL OR now() < candidate.invalid_at)
        """, parameters,
    ).fetchall()
    allowed = {row["id"] for row in scoped_rows}
    owner_memories = connection.execute(
        "SELECT id, source_ids, adoption_method FROM public.owner_memory "
        "WHERE owner_id = %s AND status = 'active' AND id = ANY(%s::uuid[]) "
        "AND (valid_at IS NULL OR valid_at <= now()) AND (invalid_at IS NULL OR now() < invalid_at)",
        (scope.owner_id, list(declared)),
    ).fetchall()
    owner_refs: set[UUID] = set()
    for memory in owner_memories:
        allowed.add(memory["id"])
        refs = set(memory["source_ids"])
        if memory["adoption_method"] == "manual":
            refs.discard(scope.owner_id)
        owner_refs.update(refs)
    owner_sources = _capture_original_dependencies(connection, scope, owner_refs, current_contact=False)
    allowed.update(owner_sources)
    if not declared <= allowed:
        raise AssistantSessionRejected("invalid_discussion_dependencies")
    scoped_memories = connection.execute(
        "SELECT source_ids, adoption_method FROM public.confirmed_memory "
        "WHERE owner_id = %s AND contact_id = %s AND status = 'active' AND id = ANY(%s::uuid[]) "
        "AND (valid_at IS NULL OR valid_at <= now()) AND (invalid_at IS NULL OR now() < invalid_at) "
        "UNION ALL SELECT source_ids, 'auto' AS adoption_method FROM public.memory_candidate "
        "WHERE owner_id = %s AND contact_id = %s AND status IN ('pending', 'confirmed') "
        "AND id = ANY(%s::uuid[]) "
        "AND (valid_at IS NULL OR valid_at <= now()) AND (invalid_at IS NULL OR now() < invalid_at)",
        (scope.owner_id, scope.contact_id, list(declared), scope.owner_id, scope.contact_id, list(declared)),
    ).fetchall()
    contact_refs = {row["id"] for row in scoped_rows if row["kind"] == "original"}
    for memory in scoped_memories:
        refs = set(memory["source_ids"])
        if memory["adoption_method"] == "manual":
            refs.discard(scope.contact_id)
        contact_refs.update(refs)
    contact_sources = _capture_original_dependencies(connection, scope, contact_refs, current_contact=True)
    captured = declared | owner_sources | contact_sources
    if not _dependencies_available(connection, scope.owner_id, captured):
        raise AssistantSessionRejected("source_unavailable")
    return captured


def _capture_original_dependencies(
    connection: Any, scope: ContactScope, refs: set[UUID], *, current_contact: bool,
) -> set[UUID]:
    sources = _expand_message_sources(connection, scope.owner_id, refs)
    contact_filter = "AND {alias}.contact_id = %(contact_id)s" if current_contact else ""
    raw_rows = connection.execute(
        f"""
        SELECT source.id FROM public.source_document AS source
        WHERE source.owner_id = %(owner_id)s AND source.status = 'active'
          AND source.id = ANY(%(sources)s::uuid[])
          {contact_filter.format(alias='source')}
        UNION
        SELECT observation.id FROM public.local_wechat_observation AS observation
        WHERE observation.owner_id = %(owner_id)s AND observation.id = ANY(%(sources)s::uuid[])
          {contact_filter.format(alias='observation')}
        UNION
        SELECT message.id FROM public.message AS message
        WHERE message.owner_id = %(owner_id)s AND message.id = ANY(%(sources)s::uuid[])
          AND {valid_source_ref_exists_sql('message')}
          {contact_filter.format(alias='message')}
        """, {"owner_id": scope.owner_id, "contact_id": scope.contact_id, "sources": list(sources)},
    ).fetchall()
    proven_sources = {row["id"] for row in raw_rows}
    if sources != proven_sources:
        raise AssistantSessionRejected("source_unavailable")
    return proven_sources


def _input_rows(
    connection: Any, scope: ContactScope, session_id: UUID,
) -> list[dict[str, Any]]:
    return connection.execute(
        "SELECT input.*, turn.state AS turn_state, turn.dependency_ids AS turn_dependencies, "
        "turn.reply_request_id AS turn_reply_request_id "
        "FROM public.assistant_session_input AS input "
        "LEFT JOIN public.assistant_session_turn AS turn ON turn.id = input.turn_id "
        "AND turn.input_version_id = input.id AND turn.owner_id = input.owner_id "
        "AND turn.contact_id = input.contact_id AND turn.session_id = input.session_id "
        "WHERE input.owner_id = %s AND input.contact_id = %s AND input.session_id = %s "
        "ORDER BY input.created_at, coalesce(input.turn_id, input.id)",
        (scope.owner_id, scope.contact_id, session_id),
    ).fetchall()


def _input_state(connection: Any, scope: ContactScope, row: dict[str, Any]) -> str:
    if row["state"] == "redacted" or row["turn_state"] == "redacted":
        return "redacted"
    if row["input_type"] == "generation" and row["turn_state"] is None:
        return "unavailable"
    dependencies = row["turn_dependencies"] if row["input_type"] == "generation" else row["dependency_ids"]
    if not _dependencies_available(connection, scope.owner_id, set(dependencies or ())):
        return "unavailable"
    if row["input_type"] == "generation" and row["turn_state"] == "completed":
        request_id = row["turn_reply_request_id"]
        if request_id is None:
            return "unavailable"
        # 只复用当时捕获的来源事实；运行中或失败输入仍可继续，不读取候选正文。
        try:
            require_reply_sources_current(connection, owner_id=scope.owner_id, request_id=request_id)
        except ReplyStoreInvariantError:
            return "unavailable"
    return "active"


def read_input_records(
    connection: Any, scope: ContactScope, session_id: UUID,
) -> tuple[AssistantInput, ...]:
    records = []
    for row in _input_rows(connection, scope, session_id):
        state = _input_state(connection, scope, row)
        records.append(AssistantInput(
            input_version_id=row["id"], session_id=row["session_id"],
            type=row["input_type"], conversation_binding_id=row["conversation_binding_id"],
            turn_id=row["turn_id"], state=state,
            content=row["content"] if state == "active" else None,
        ))
    return tuple(records)


def require_current_input(
    connection: Any, scope: ContactScope, session_id: UUID, input_version_id: UUID,
) -> None:
    """复用调用方事务；局部 dict cursor 兼容默认 tuple row，不更换调用方 factory。"""

    if not isinstance(input_version_id, UUID):
        raise AssistantSessionRejected("input_version_stale")
    lock_owner_scope(connection, owner_id=scope.owner_id)
    with connection.cursor(row_factory=dict_row) as cursor:
        session = require_input_session(cursor, scope, session_id)
        binding_id = _active_binding(cursor, scope)
        if session["current_input_version_id"] != input_version_id:
            raise AssistantSessionRejected("input_version_stale")
        row = cursor.execute(
            "SELECT input.input_type, input.conversation_binding_id, input.state, input.dependency_ids, "
            "turn.state AS turn_state, turn.dependency_ids AS turn_dependencies, "
            "turn.reply_request_id AS turn_reply_request_id "
            "FROM public.assistant_session_input AS input "
            "LEFT JOIN public.assistant_session_turn AS turn ON turn.id = input.turn_id "
            "AND turn.input_version_id = input.id AND turn.owner_id = input.owner_id "
            "AND turn.contact_id = input.contact_id AND turn.session_id = input.session_id "
            "WHERE input.owner_id = %s AND input.contact_id = %s "
            "AND input.session_id = %s AND input.id = %s",
            (scope.owner_id, scope.contact_id, session_id, input_version_id),
        ).fetchone()
        if row is None:
            raise AssistantSessionRejected("input_version_stale")
        if row["conversation_binding_id"] != binding_id:
            raise AssistantSessionRejected("binding_changed")
        state = _input_state(cursor, scope, row)
        if state != "active":
            raise AssistantSessionRejected("source_deleted" if state == "redacted" else "source_unavailable")


def erase_assistant_source_inputs(connection: Any, *, owner_id: UUID, removed_ids: set[UUID]) -> None:
    """同事务清正文及失效的当前指针；生成索引只随权威 turn 留占位。"""

    connection.execute(
        "WITH erased AS (UPDATE public.assistant_session_input AS input SET state = 'redacted', content = NULL, "
        "dependency_ids = '{}', updated_at = now() WHERE input.owner_id = %s AND input.state <> 'redacted' "
        "AND (input.dependency_ids && %s::uuid[] OR EXISTS ("
        "SELECT 1 FROM public.assistant_session_turn AS turn WHERE turn.id = input.turn_id "
        "AND turn.input_version_id = input.id AND turn.owner_id = input.owner_id "
        "AND turn.contact_id = input.contact_id AND turn.session_id = input.session_id AND turn.state = 'redacted')) "
        "RETURNING input.id, input.session_id, input.owner_id, input.contact_id) "
        "UPDATE public.assistant_session AS session SET current_input_version_id = NULL, updated_at = now() "
        "FROM erased WHERE session.id = erased.session_id AND session.owner_id = erased.owner_id "
        "AND session.contact_id = erased.contact_id AND session.current_input_version_id = erased.id",
        (owner_id, list(removed_ids)),
    )


def record_discussion_input_in_transaction(
    connection: Any, scope: ContactScope, session_id: UUID, content: dict[str, Any],
    expected_input_version_id: UUID | None = None,
    *, verified_dependencies: tuple[UUID, ...] = (),
) -> UUID:
    """沿用调用方事务记录输入；不另开连接或提交，不更换调用方 row factory。"""

    normalized = normalize_discussion_content(content)
    lock_owner_scope(connection, owner_id=scope.owner_id)
    with connection.cursor(row_factory=dict_row) as cursor:
        session = require_input_session(cursor, scope, session_id)
        binding_id = _active_binding(cursor, scope)
        check_expected_input(session, expected_input_version_id)
        dependencies = verified_discussion_dependencies(cursor, scope, verified_dependencies)
        if normalized["type"] == "response_exploration":
            target_id = UUID(normalized["target_message_id"])
            target = cursor.execute(
                "SELECT 1 FROM public.message AS message WHERE owner_id = %s "
                "AND contact_id = %s AND id = %s "
                f"AND {valid_source_ref_exists_sql('message')}",
                (scope.owner_id, scope.contact_id, target_id),
            ).fetchone()
            if target is None:
                raise AssistantSessionRejected("target_message_unavailable")
            dependencies.update(_expand_message_sources(cursor, scope.owner_id, {target_id}))
        if not _dependencies_available(cursor, scope.owner_id, dependencies):
            raise AssistantSessionRejected("source_unavailable")
        row = cursor.execute(
            "INSERT INTO public.assistant_session_input "
            "(session_id, owner_id, contact_id, conversation_binding_id, input_type, content, dependency_ids) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (session_id, scope.owner_id, scope.contact_id, binding_id,
             normalized["type"], Jsonb(normalized), list(dependencies)),
        ).fetchone()
        version = row["id"]
        cursor.execute(
            "UPDATE public.assistant_session SET current_input_version_id = %s, updated_at = now() "
            "WHERE owner_id = %s AND contact_id = %s AND id = %s",
            (version, scope.owner_id, scope.contact_id, session_id),
        )
        return version


class PostgresAssistantSessionInputs:
    """所有读写使用同一 owner 事务锁，与来源清除保持顺序。"""

    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    @contextmanager
    def _transaction(self, scope: ContactScope) -> Iterator[Any]:
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=scope.owner_id)
                yield connection
        except psycopg.Error:
            raise AssistantSessionPersistenceError("助手输入未可靠保存。") from None

    def read_inputs(self, scope: ContactScope, session_id: UUID) -> tuple[AssistantInput, ...]:
        with self._transaction(scope) as connection:
            require_input_session(connection, scope, session_id)
            return read_input_records(connection, scope, session_id)

    def current_input_version_id(self, scope: ContactScope, session_id: UUID) -> UUID | None:
        with self._transaction(scope) as connection:
            return require_input_session(connection, scope, session_id)["current_input_version_id"]

    def record_discussion_input(
        self, scope: ContactScope, session_id: UUID, content: dict[str, Any],
        expected_input_version_id: UUID | None = None,
        *, verified_dependencies: tuple[UUID, ...] = (),
    ) -> UUID:
        with self._transaction(scope) as connection:
            return record_discussion_input_in_transaction(
                connection, scope, session_id, content, expected_input_version_id,
                verified_dependencies=verified_dependencies,
            )

    def is_current_input(self, scope: ContactScope, session_id: UUID, input_version_id: UUID) -> bool:
        if not isinstance(input_version_id, UUID):
            return False
        with self._transaction(scope) as connection:
            try:
                require_current_input(connection, scope, session_id, input_version_id)
            except (AssistantSessionNotFound, AssistantSessionRejected):
                return False
            return True
