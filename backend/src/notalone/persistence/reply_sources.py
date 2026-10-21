"""候选回复的原始来源捕获、复验与请求键失效。"""

from __future__ import annotations

from asyncio import current_task
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from functools import wraps
from threading import get_ident
from typing import Any
from uuid import UUID

from psycopg.rows import dict_row

from notalone.reply.context import ReplyContext
from notalone.reply.assistant_discussion import DiscussionDependencies
from notalone.reply.errors import ReplyContextError, ReplyContextInvariantError, ReplyStoreInvariantError
from notalone.reply.store import ReplyRequest
from notalone.scopes import ContactScope


def reply_evidence_sources(
    connection: Any, *, owner_id: UUID, evidence_id: UUID, kind: str,
    source_ids: tuple[UUID, ...], text: str | None = None,
    historical: bool = False,
) -> set[UUID]:
    """仅剔除已复验的本人手录归属引用；混合来源逐项保留。"""
    if kind != "owner_memory" or owner_id not in source_ids:
        return set(source_ids)
    from notalone.persistence.owner_memory_store import owner_memory_source_dependencies

    try:
        return set(owner_memory_source_dependencies(
            connection, owner_id=owner_id, memory_id=evidence_id,
            source_ids=source_ids, text=text,
            historical=historical,
        ))
    except PermissionError:
        raise ReplyStoreInvariantError("本人资料来源已变化。") from None


def reply_original_sources(connection: Any, request: ReplyRequest, context: ReplyContext) -> set[UUID]:
    """同一结果提交事务中记录全部实际原始来源，包括各类记忆的消息依赖。"""
    declared: set[UUID] = set()
    for item in context.evidence:
        if item.evolution is not None:
            declared.update(item.evolution.evidence_message_ids)
        declared.update(reply_evidence_sources(
            connection, owner_id=request.scope.owner_id, evidence_id=item.evidence_id,
            kind=item.kind, source_ids=item.source_ids, text=item.text,
            historical=item.navigation is not None and item.timing.current_status == "historical",
        ))
    declared.update(item.evidence_id for item in context.evidence if item.kind == "message")
    declared.update(identifier for item in context.expression_preferences for identifier in item.source_ids)
    from notalone.persistence.reply_overview_navigation import navigation_dependency_ids
    navigation_sources = {UUID(identifier) for identifier in navigation_dependency_ids(context)}
    # 导航依赖已在同连接复验为原窗口；仅解析其已登记原始来源身份，
    # 不拿当前新引用补旧证明。候选/决定等身份由快照删除依赖另行保存。
    if navigation_sources:
        rows = connection.execute("""
            SELECT id FROM public.source_document WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND status='active'
            UNION SELECT id FROM public.local_wechat_observation WHERE owner_id=%s AND id=ANY(%s::uuid[])
        """, (request.scope.owner_id, list(navigation_sources), request.scope.owner_id, list(navigation_sources))).fetchall()
        declared.update(row["id"] if isinstance(row, dict) else row[0] for row in rows)
    if not declared:
        return set()
    raw = connection.execute("""
        SELECT source.id FROM public.source_document AS source
        WHERE source.owner_id=%s AND source.id=ANY(%s::uuid[]) AND source.status='active'
        UNION SELECT observation.id FROM public.local_wechat_observation AS observation
        WHERE observation.owner_id=%s AND observation.id=ANY(%s::uuid[])
        UNION SELECT coalesce(ref.source_document_id,ref.observation_id) AS id
        FROM public.message_source_ref AS ref
        LEFT JOIN public.source_document AS source ON source.id=ref.source_document_id
        LEFT JOIN public.local_wechat_observation AS observation ON observation.id=ref.observation_id
        WHERE ref.owner_id=%s AND ref.message_id=ANY(%s::uuid[])
          AND (source.status='active' OR observation.id IS NOT NULL)
    """, (request.scope.owner_id, list(declared), request.scope.owner_id, list(declared),
          request.scope.owner_id, list(declared))).fetchall()
    identifiers = {row["id"] if isinstance(row, dict) else row[0] for row in raw}
    missing = connection.execute("""
        SELECT id FROM unnest(%s::uuid[]) AS dependency(id) WHERE NOT EXISTS (
          SELECT 1 FROM public.source_document AS source
            WHERE source.owner_id=%s AND source.id=dependency.id AND source.status='active'
          UNION ALL SELECT 1 FROM public.local_wechat_observation AS observation
            WHERE observation.owner_id=%s AND observation.id=dependency.id
          UNION ALL SELECT 1 FROM public.message_source_ref AS ref
            LEFT JOIN public.source_document AS source ON source.id=ref.source_document_id
            LEFT JOIN public.local_wechat_observation AS observation ON observation.id=ref.observation_id
            WHERE ref.owner_id=%s AND ref.message_id=dependency.id
              AND (source.status='active' OR observation.id IS NOT NULL)
        ) LIMIT 1
    """, (list(declared), request.scope.owner_id, request.scope.owner_id, request.scope.owner_id)).fetchone()
    if missing:
        raise ReplyStoreInvariantError("回复依据原始来源不可用。")
    return identifiers


def captured_reply_sources(connection: Any, *, owner_id: UUID, request_id: UUID) -> set[UUID]:
    rows = connection.execute("SELECT source_id FROM public.reply_original_source_use WHERE owner_id=%s AND reply_request_id=%s",
                              (owner_id, request_id)).fetchall()
    return {row["source_id"] if isinstance(row, dict) else row[0] for row in rows}


def _reply_ancestor_ids(connection: Any, *, owner_id: UUID, request_id: UUID) -> list[UUID]:
    rows = connection.execute("""
        WITH RECURSIVE ancestors(id,contact_id,continued_from_candidate_id) AS (
            SELECT id,contact_id,continued_from_candidate_id FROM public.reply_request
            WHERE owner_id=%s AND id=%s
            UNION
            SELECT parent.id,parent.contact_id,parent.continued_from_candidate_id FROM ancestors
            JOIN public.reply_candidate AS previous ON previous.id=ancestors.continued_from_candidate_id
            JOIN public.reply_request AS parent ON parent.id=previous.reply_request_id
            WHERE parent.owner_id=%s AND parent.contact_id=ancestors.contact_id
        ) SELECT id FROM ancestors
    """, (owner_id, request_id, owner_id)).fetchall()
    return [row["id"] if isinstance(row, dict) else row[0] for row in rows]


def _request_needs_source_snapshot(
    connection: Any, *, owner_id: UUID, request_id: UUID, historical: bool,
) -> bool:
    rows = connection.execute("""
        SELECT evidence_id,kind,source_ids,evidence_text FROM public.reply_context_evidence
        WHERE owner_id=%s AND reply_request_id=%s
    """, (owner_id, request_id)).fetchall()
    needs_snapshot = False
    for row in rows:
        identifier, kind, source_ids, text = (tuple(row[key] for key in ('evidence_id', 'kind', 'source_ids', 'evidence_text'))
                                             if isinstance(row, dict) else row)
        try:
            sources = tuple(UUID(str(value)) for value in source_ids)
        except (ValueError, TypeError):
            raise ReplyStoreInvariantError("旧回复来源记录无效。") from None
        actual_sources = reply_evidence_sources(
            connection, owner_id=owner_id, evidence_id=identifier, kind=kind,
            source_ids=sources, text=text, historical=historical,
        )
        if kind == 'message' or actual_sources:
            needs_snapshot = True
    return needs_snapshot


@dataclass(slots=True, repr=False)
class _ReplySourceValidation:
    """仅一次同步复验内复用已读来源与不可变历史，不跨事务或调用保留。"""

    connection: Any
    scope: ContactScope
    execution: tuple[int, Any]
    active: set[UUID] = field(default_factory=set)
    verified: dict[tuple[UUID, bool], frozenset[UUID]] = field(default_factory=dict)
    candidate_histories: dict[tuple[UUID, UUID], Any] = field(default_factory=dict)
    generation_inputs: set[tuple[str, bool]] = field(default_factory=set)
    generation_dependencies: dict[str, DiscussionDependencies] = field(default_factory=dict)


_SOURCE_VALIDATION: ContextVar[_ReplySourceValidation | None] = ContextVar("reply_source_validation", default=None)


@contextmanager
def _reply_source_validation_scope(
    connection: Any, scope: ContactScope,
) -> Iterator[_ReplySourceValidation]:
    """仅同连接、同联系人和同一同步调用共享；调用方持有owner事务锁。"""

    raw = getattr(connection, "connection", connection)
    try:
        task = current_task()
    except RuntimeError:
        task = None
    execution = (get_ident(), task)
    validation = _SOURCE_VALIDATION.get()
    token = None
    if (validation is None or validation.connection is not raw
            or validation.scope != scope or validation.execution != execution):
        validation = _ReplySourceValidation(raw, scope, execution)
        token = _SOURCE_VALIDATION.set(validation)
    try:
        yield validation
    finally:
        if token is not None:
            _SOURCE_VALIDATION.reset(token)


def _with_reply_source_validation(operation: Callable[..., Any]) -> Callable[..., Any]:
    """把一次同步讨论遍历内的兄弟来源核验放入同一作用域。"""

    @wraps(operation)
    def validate(connection: Any, scope: ContactScope, *args: Any, **kwargs: Any) -> Any:
        with _reply_source_validation_scope(connection, scope):
            return operation(connection, scope, *args, **kwargs)

    return validate


def require_reply_sources_current(
    connection: Any, *, owner_id: UUID, request_id: UUID, historical: bool = False,
) -> set[UUID]:
    """调用方持有owner锁；嵌套历史按真实请求去重，退出后下一读取仍完整复验。"""

    raw = getattr(connection, "connection", connection)
    with raw.cursor(row_factory=dict_row) as cursor:
        row = cursor.execute(
            "SELECT contact_id FROM public.reply_request WHERE owner_id=%s AND id=%s",
            (owner_id, request_id),
        ).fetchone()
    if row is None:
        raise ReplyStoreInvariantError("回复请求已失效。")
    with _reply_source_validation_scope(raw, ContactScope(owner_id, row["contact_id"])) as validation:
        key = (request_id, historical)
        if key in validation.verified:
            return set(validation.verified[key])
        if request_id in validation.active:
            raise ReplyStoreInvariantError("回复历史依赖存在循环，不能使用。")
        validation.active.add(request_id)
        try:
            with raw.cursor(row_factory=dict_row) as cursor:
                sources = _require_reply_sources_current(
                    cursor, owner_id=owner_id, request_id=request_id, historical=historical,
                )
            validation.verified[key] = frozenset(sources)
            return sources
        finally:
            validation.active.remove(request_id)


def _require_reply_sources_current(
    connection: Any, *, owner_id: UUID, request_id: UUID, historical: bool,
) -> set[UUID]:
    """逐请求核验祖先快照；后继自己的来源不能证明旧候选当时已捕获。"""
    from notalone.persistence.reply_discussion_dependencies import require_reply_discussion_dependencies

    request_ids = _reply_ancestor_ids(connection, owner_id=owner_id, request_id=request_id)
    if not request_ids:
        raise ReplyStoreInvariantError("回复请求已失效。")
    sources: set[UUID] = set()
    for identifier in request_ids:
        row = connection.execute("SELECT contact_id FROM public.reply_request WHERE owner_id=%s AND id=%s",
                                 (owner_id, identifier)).fetchone()
        contact_id = row["contact_id"] if isinstance(row, dict) else row[0]
        history = historical or identifier != request_id
        require_reply_discussion_dependencies(
            connection, ContactScope(owner_id, contact_id), identifier,
        )
        captured = captured_reply_sources(connection, owner_id=owner_id, request_id=identifier)
        needs_snapshot = _request_needs_source_snapshot(
            connection, owner_id=owner_id, request_id=identifier, historical=history,
        )
        if not captured and needs_snapshot:
            raise ReplyStoreInvariantError("旧候选缺少当时原始来源记录，请重新生成。")
        sources.update(captured)
    if sources and connection.execute("""
        SELECT id FROM unnest(%s::uuid[]) AS source(id) WHERE NOT EXISTS (
            SELECT 1 FROM public.source_document AS document WHERE document.owner_id=%s
              AND document.id=source.id AND document.status='active'
            UNION ALL SELECT 1 FROM public.local_wechat_observation AS observation
              WHERE observation.owner_id=%s AND observation.id=source.id
        ) LIMIT 1
    """, (list(sources), owner_id, owner_id)).fetchone():
        raise ReplyStoreInvariantError("候选使用的原始来源已失效。")
    return sources


def capture_reply_original_sources(connection: Any, request: ReplyRequest, context: ReplyContext) -> set[UUID]:
    identifiers = reply_original_sources(connection, request, context)
    if request.continued_from_candidate_id is not None:
        previous = connection.execute("SELECT reply_request_id FROM public.reply_candidate WHERE owner_id=%s AND contact_id=%s AND id=%s",
                                      (request.scope.owner_id, request.scope.contact_id, request.continued_from_candidate_id)).fetchone()
        if previous is None:
            raise ReplyStoreInvariantError("前序候选已失效。")
        request_id = previous["reply_request_id"] if isinstance(previous, dict) else previous[0]
        identifiers.update(require_reply_sources_current(connection, owner_id=request.scope.owner_id,
                                                         request_id=request_id, historical=True))
    for source_id in identifiers:
        connection.execute("""
            INSERT INTO public.reply_original_source_use(reply_request_id,source_id,owner_id,contact_id)
            VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING
        """, (request.request_id, source_id, request.scope.owner_id, request.scope.contact_id))
    return identifiers


def capture_declared_reply_sources(connection: Any, request: ReplyRequest, context: ReplyContext) -> None:
    """Tool产物已有明确原始UUID时直接留存；不在生成结束后展开消息的新ref。"""
    declared = {source_id for item in context.evidence for source_id in item.source_ids}
    rows = connection.execute("""
        SELECT id FROM public.source_document WHERE owner_id=%s AND id=ANY(%s::uuid[])
        UNION SELECT id FROM public.local_wechat_observation WHERE owner_id=%s AND id=ANY(%s::uuid[])
    """, (request.scope.owner_id, list(declared), request.scope.owner_id, list(declared))).fetchall()
    for row in rows:
        source_id = row["id"] if isinstance(row, dict) else row[0]
        connection.execute("""INSERT INTO public.reply_original_source_use(reply_request_id,source_id,owner_id,contact_id)
            VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                           (request.request_id, source_id, request.scope.owner_id, request.scope.contact_id))


def invalidate_reply_keys(connection: Any, *, owner_id: UUID, request_ids: list[UUID]) -> None:
    """只保留不可恢复正文的请求键；删除后同键不能悄悄变成一轮新生成。"""
    connection.execute("""
        INSERT INTO public.reply_invalidated_key(owner_id,contact_id,idempotency_key)
        SELECT owner_id,contact_id,idempotency_key FROM public.reply_request
        WHERE owner_id=%s AND id=ANY(%s::uuid[]) ON CONFLICT DO NOTHING
    """, (owner_id, request_ids))
