"""PostgreSQL 主动表达样本、来源依赖与删除。"""

from __future__ import annotations

import builtins
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from notalone.application.style_sample_service import (
    SaveStyleSample, StyleSample, StyleSampleConflict, StyleSampleDeleted,
    StyleSampleError, StyleSampleNotFound,
)
from notalone.persistence.locks import lock_owner_scope
from notalone.reply.context import ReplyContext
from notalone.reply.errors import ReplyContextError, ReplyContextInvariantError, ReplyStoreInvariantError
from notalone.reply.style_reference import (
    STYLE_REFERENCE_LIMIT, STYLE_REFERENCE_CHAR_BUDGET, StyleReference, require_reference_contract,
)
from notalone.reply.store import ReplyRequest
from notalone.scopes import ContactScope


def manual_owner_evidence_is_current(connection: Any, *, owner_id: UUID, evidence_id: UUID,
                                     source_ids: tuple[UUID, ...], text: str | None = None) -> bool:
    """仅对真实手工本人记忆接受已实现的owner哨兵，不豁免任意owner引用。"""
    if source_ids != (owner_id,):
        return False
    row = connection.execute("""
        SELECT text_content FROM public.owner_memory WHERE owner_id=%s AND id=%s
          AND adoption_method='manual' AND status='active' AND source_ids=%s::uuid[]
    """, (owner_id, evidence_id, [owner_id])).fetchone()
    if row is None:
        return False
    return text is None or (row["text_content"] if isinstance(row, dict) else row[0]) == text


def reply_original_sources(connection: Any, request: ReplyRequest, context: ReplyContext) -> set[UUID]:
    """同一结果提交事务中记录全部实际原始来源，包括各类记忆的消息依赖。"""
    declared = {source_id for item in context.evidence for source_id in item.source_ids
                if not (item.kind == 'owner_memory' and manual_owner_evidence_is_current(
                    connection, owner_id=request.scope.owner_id, evidence_id=item.evidence_id,
                    source_ids=item.source_ids, text=item.text))}
    declared.update(item.evidence_id for item in context.evidence if item.kind == "message")
    declared.update(identifier for item in context.style_references for identifier in item.source_ids)
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


def _request_needs_source_snapshot(connection: Any, *, owner_id: UUID, request_id: UUID) -> bool:
    rows = connection.execute("""
        SELECT evidence_id,kind,source_ids,evidence_text FROM public.reply_context_evidence
        WHERE owner_id=%s AND reply_request_id=%s
    """, (owner_id, request_id)).fetchall()
    for row in rows:
        identifier, kind, source_ids, text = (tuple(row[key] for key in ('evidence_id', 'kind', 'source_ids', 'evidence_text'))
                                             if isinstance(row, dict) else row)
        try:
            sources = tuple(UUID(str(value)) for value in source_ids)
        except (ValueError, TypeError):
            raise ReplyStoreInvariantError("旧回复来源记录无效。") from None
        if kind == 'owner_memory' and manual_owner_evidence_is_current(
            connection, owner_id=owner_id, evidence_id=identifier, source_ids=sources, text=text,
        ):
            continue
        if kind == 'message' or sources:
            return True
    return False


@dataclass(slots=True, repr=False)
class _ReplySourceValidation:
    """仅一次同步复验内的ID去重；不缓存正文、不跨事务或调用保留结论。"""

    connection: Any
    owner_id: UUID
    active: set[UUID] = field(default_factory=set)
    verified: dict[UUID, frozenset[UUID]] = field(default_factory=dict)


_SOURCE_VALIDATION: ContextVar[_ReplySourceValidation | None] = ContextVar("reply_source_validation", default=None)


def require_reply_sources_current(connection: Any, *, owner_id: UUID, request_id: UUID) -> set[UUID]:
    """调用方持有owner锁；嵌套历史按真实请求去重，退出后下一读取仍完整复验。"""

    raw = getattr(connection, "connection", connection)
    validation = _SOURCE_VALIDATION.get()
    token = None
    if validation is None or validation.connection is not raw or validation.owner_id != owner_id:
        validation = _ReplySourceValidation(raw, owner_id)
        token = _SOURCE_VALIDATION.set(validation)
    try:
        if request_id in validation.verified:
            return set(validation.verified[request_id])
        if request_id in validation.active:
            raise ReplyStoreInvariantError("回复历史依赖存在循环，不能使用。")
        validation.active.add(request_id)
        try:
            with raw.cursor(row_factory=dict_row) as cursor:
                sources = _require_reply_sources_current(cursor, owner_id=owner_id, request_id=request_id)
            validation.verified[request_id] = frozenset(sources)
            return sources
        finally:
            validation.active.remove(request_id)
    finally:
        if token is not None:
            _SOURCE_VALIDATION.reset(token)


def _require_reply_sources_current(connection: Any, *, owner_id: UUID, request_id: UUID) -> set[UUID]:
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
        require_reply_discussion_dependencies(connection, ContactScope(owner_id, contact_id), identifier)
        captured = captured_reply_sources(connection, owner_id=owner_id, request_id=identifier)
        if not captured and _request_needs_source_snapshot(connection, owner_id=owner_id, request_id=identifier):
            raise ReplyStoreInvariantError("旧候选缺少当时原始来源记录，请重新生成。")
        sources.update(captured)
    sample_rows = connection.execute("""
        SELECT sample.* FROM public.reply_style_sample_use AS use
        JOIN public.style_sample AS sample ON sample.id=use.sample_id
          AND sample.owner_id=use.owner_id AND sample.contact_id=use.contact_id
        WHERE use.owner_id=%s AND use.reply_request_id=ANY(%s::uuid[])
    """, (owner_id, request_ids)).fetchall()
    try:
        for row in sample_rows:
            _current_sample(connection, row)
    except StyleSampleError:
        raise ReplyStoreInvariantError("候选使用的表达样本已失效。") from None
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
        identifiers.update(require_reply_sources_current(connection, owner_id=request.scope.owner_id, request_id=request_id))
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


def require_context_style_references(connection: Any, scope: ContactScope,
                                    references: tuple[StyleReference, ...]) -> None:
    """同owner事务复验实际参考，不能以当前新样本替换模型曾见的样本。"""
    require_reference_contract(scope, references)
    for reference in references:
        row = connection.execute("SELECT * FROM public.style_sample WHERE owner_id=%s AND contact_id=%s AND id=%s",
                                 (scope.owner_id, scope.contact_id, reference.sample_id)).fetchone()
        if row is None:
            raise ReplyStoreInvariantError("表达参考已失效。")
        try:
            sample = _current_sample(connection, row)
        except StyleSampleError:
            raise ReplyStoreInvariantError("表达参考已失效。") from None
        if sample.text != reference.text or sample.source_ids != reference.source_ids:
            raise ReplyStoreInvariantError("表达参考快照已变化。")


def capture_reply_style_references(connection: Any, request: ReplyRequest, context: ReplyContext) -> None:
    require_context_style_references(connection, request.scope, context.style_references)
    connection.execute("DELETE FROM public.reply_style_sample_use WHERE reply_request_id=%s", (request.request_id,))
    for item in context.style_references:
        connection.execute("""
            INSERT INTO public.reply_style_sample_use(reply_request_id,sample_id,owner_id,contact_id)
            VALUES (%s,%s,%s,%s)
        """, (request.request_id, item.sample_id, request.scope.owner_id, request.scope.contact_id))


def invalidate_reply_keys(connection: Any, *, owner_id: UUID, request_ids: list[UUID]) -> None:
    """只保留不可恢复正文的请求键；删除后同键不能悄悄变成一轮新生成。"""
    connection.execute("""
        INSERT INTO public.reply_invalidated_key(owner_id,contact_id,idempotency_key)
        SELECT owner_id,contact_id,idempotency_key FROM public.reply_request
        WHERE owner_id=%s AND id=ANY(%s::uuid[]) ON CONFLICT DO NOTHING
    """, (owner_id, request_ids))


def _contact_exists(connection: Any, scope: ContactScope) -> None:
    if connection.execute("SELECT 1 FROM public.contact WHERE owner_id=%s AND id=%s",
                          (scope.owner_id, scope.contact_id)).fetchone() is None:
        raise StyleSampleNotFound("当前范围不存在联系人。")


def _as_sample(row: dict[str, Any]) -> StyleSample:
    if row["status"] != "active":
        raise StyleSampleDeleted("表达样本已删除。")
    return StyleSample(row["id"], ContactScope(row["owner_id"], row["contact_id"]),
                       row["final_text"], row["origin_kind"], row["origin_id"],
                       tuple(row["source_ids"]), row["saved_at"])


def _current_sample(connection: Any, row: dict[str, Any]) -> StyleSample:
    sample = _as_sample(row)
    if connection.execute("""
        SELECT 1 FROM public.source_document
        WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND status<>'active'
        UNION ALL SELECT 1 FROM public.style_sample
        WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND status<>'active' LIMIT 1
    """, (sample.scope.owner_id, list(sample.source_ids), sample.scope.owner_id, row["dependency_sample_ids"])).fetchone():
        raise StyleSampleDeleted("样本依赖来源已失效。")
    return sample


def erase_style_sample_replies(connection: Any, *, owner_id: UUID, sample_ids: list[UUID]) -> list[UUID]:
    """实际使用记录及后继候选共同决定派生清理范围，不删除聊天资料。"""
    rows = connection.execute("""
        WITH RECURSIVE seeds(id) AS (
            SELECT use.reply_request_id FROM public.reply_style_sample_use AS use
            WHERE use.owner_id=%s AND use.sample_id=ANY(%s::uuid[])
            UNION SELECT request.id FROM public.reply_request AS request
            WHERE request.owner_id=%s AND request.context_snapshot->'assistant_discussion_style_sample_ids' ?| %s::text[]
        ), affected(id) AS (
            SELECT id FROM seeds
            UNION
            SELECT child.id FROM affected
            JOIN public.reply_candidate AS candidate ON candidate.reply_request_id=affected.id
            JOIN public.reply_request AS child ON child.continued_from_candidate_id=candidate.id
            WHERE child.owner_id=%s
        ) SELECT id FROM affected
    """, (owner_id, sample_ids, owner_id, [str(value) for value in sample_ids], owner_id)).fetchall()
    request_ids = [row["id"] if isinstance(row, dict) else row[0] for row in rows]
    if request_ids:
        # A会话记录必须在回复外键置空之前失效；无关联turn时无需载入适配器。
        table = connection.execute("SELECT to_regclass('public.assistant_session_turn')").fetchone()
        if table and (table["to_regclass"] if isinstance(table, dict) else table[0]) is not None:
            contacts = connection.execute("""
                SELECT turn.contact_id, array_agg(DISTINCT turn.id) AS turn_ids,
                       array_agg(DISTINCT request.id) AS request_ids
                FROM public.assistant_session_turn AS turn
                JOIN public.reply_request AS request ON request.owner_id=turn.owner_id
                  AND request.contact_id=turn.contact_id AND request.idempotency_key=turn.idempotency_key
                JOIN public.assistant_session AS session ON session.id=turn.session_id
                  AND session.owner_id=turn.owner_id AND session.contact_id=turn.contact_id
                WHERE turn.owner_id=%s AND request.id=ANY(%s::uuid[])
                GROUP BY turn.contact_id
            """, (owner_id, request_ids)).fetchall()
            if contacts:
                from notalone.persistence.assistant_session_store import erase_assistant_source_turns
                for row in contacts:
                    contact_id = row["contact_id"] if isinstance(row, dict) else row[0]
                    turn_ids = row["turn_ids"] if isinstance(row, dict) else row[1]
                    contact_request_ids = row["request_ids"] if isinstance(row, dict) else row[2]
                    erase_assistant_source_turns(connection, owner_id=owner_id, contact_id=contact_id,
                                                 removed_ids=set(sample_ids), reply_request_ids=contact_request_ids,
                                                 turn_ids=turn_ids)
        invalidate_reply_keys(connection, owner_id=owner_id, request_ids=request_ids)
        connection.execute("DELETE FROM public.reply_request WHERE owner_id=%s AND id=ANY(%s::uuid[])",
                           (owner_id, request_ids))
    return request_ids


def _erase_samples(connection: Any, *, owner_id: UUID, sample_ids: list[UUID]) -> list[UUID]:
    rows = connection.execute("""
        WITH RECURSIVE affected(id) AS (
            SELECT id FROM public.style_sample WHERE owner_id=%s AND id=ANY(%s::uuid[])
            UNION
            SELECT sample.id FROM public.style_sample AS sample JOIN affected
              ON affected.id=ANY(sample.dependency_sample_ids)
            WHERE sample.owner_id=%s AND sample.status='active'
        ) SELECT id FROM affected
    """, (owner_id, sample_ids, owner_id)).fetchall()
    affected = [row["id"] if isinstance(row, dict) else row[0] for row in rows]
    request_ids = erase_style_sample_replies(connection, owner_id=owner_id, sample_ids=affected)
    connection.execute("""
        UPDATE public.style_sample SET status='deleted', final_text=NULL,
          source_ids='{}', dependency_sample_ids='{}', deleted_at=coalesce(deleted_at,now())
        WHERE owner_id=%s AND id=ANY(%s::uuid[])
    """, (owner_id, affected))
    return request_ids


def erase_source_style_samples(connection: Any, *, owner_id: UUID, removed_ids: set[UUID]) -> list[UUID]:
    """来源删除沿真实依赖传递到样本；可覆盖本人记忆用于其他联系人的情形。"""
    rows = connection.execute("""
        SELECT id FROM public.style_sample
        WHERE owner_id=%s AND status='active' AND source_ids && %s::uuid[]
    """, (owner_id, list(removed_ids))).fetchall()
    identifiers = [row["id"] if isinstance(row, dict) else row[0] for row in rows]
    return _erase_samples(connection, owner_id=owner_id, sample_ids=identifiers)


class PostgresStyleSampleStore:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def select_references(self, scope: ContactScope) -> tuple[StyleReference, ...]:
        """最多取五个完整样本；只跳过不合界限的项，不截断用户保存文字。"""
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                connection.execute("SET LOCAL statement_timeout='500ms'")
                lock_owner_scope(connection, owner_id=scope.owner_id)
                _contact_exists(connection, scope)
                rows = connection.execute("""
                    SELECT * FROM public.style_sample WHERE owner_id=%s AND contact_id=%s
                      AND status='active' AND length(final_text)<=%s
                    ORDER BY saved_at DESC,id LIMIT %s
                """, (scope.owner_id, scope.contact_id, STYLE_REFERENCE_CHAR_BUDGET, STYLE_REFERENCE_LIMIT)).fetchall()
                selected: list[StyleReference] = []
                characters = 0
                for row in rows:
                    try:
                        sample = _current_sample(connection, row)
                    except StyleSampleDeleted:
                        continue
                    if characters + len(sample.text) > STYLE_REFERENCE_CHAR_BUDGET:
                        continue
                    selected.append(StyleReference(sample.sample_id, sample.scope, sample.text, sample.source_ids))
                    characters += len(sample.text)
                return tuple(selected)
        except (psycopg.Error, StyleSampleError):
            raise ReplyContextError("表达参考读取失败。") from None

    def validate_references(self, scope: ContactScope, references: tuple[StyleReference, ...]) -> None:
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                connection.execute("SET LOCAL statement_timeout='500ms'")
                lock_owner_scope(connection, owner_id=scope.owner_id)
                require_context_style_references(connection, scope, references)
        except ReplyStoreInvariantError:
            raise ReplyContextInvariantError("表达参考已失效。") from None
        except psycopg.Error:
            raise ReplyContextError("表达参考重新读取失败。") from None

    def list(self, scope: ContactScope) -> tuple[StyleSample, ...]:
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=scope.owner_id)
                _contact_exists(connection, scope)
                rows = connection.execute("""
                    SELECT * FROM public.style_sample WHERE owner_id=%s AND contact_id=%s
                    AND status='active' ORDER BY saved_at DESC,id
                """, (scope.owner_id, scope.contact_id)).fetchall()
                samples: list[StyleSample] = []
                for row in rows:
                    try:
                        samples.append(_current_sample(connection, row))
                    except StyleSampleDeleted:
                        continue
                return tuple(samples)
        except psycopg.Error:
            raise StyleSampleError("表达样本读取失败。") from None

    def read(self, scope: ContactScope, sample_id: UUID) -> StyleSample:
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=scope.owner_id)
                return _current_sample(connection, self._read(connection, scope, sample_id))
        except psycopg.Error:
            raise StyleSampleError("表达样本读取失败。") from None

    @staticmethod
    def _read(connection: Any, scope: ContactScope, sample_id: UUID) -> dict[str, Any]:
        row = connection.execute("SELECT * FROM public.style_sample WHERE owner_id=%s AND contact_id=%s AND id=%s",
                                 (scope.owner_id, scope.contact_id, sample_id)).fetchone()
        if row is None:
            raise StyleSampleNotFound("当前范围不存在表达样本。")
        return row

    def save(self, scope: ContactScope, command: SaveStyleSample) -> StyleSample:
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=scope.owner_id)
                _contact_exists(connection, scope)
                existing = connection.execute("SELECT * FROM public.style_sample WHERE owner_id=%s AND contact_id=%s AND save_key=%s",
                                              (scope.owner_id, scope.contact_id, command.save_key)).fetchone()
                if existing is not None:
                    sample = _current_sample(connection, existing)
                    if (sample.text, sample.origin_kind, sample.origin_id) != (command.text.strip(), command.origin_kind, command.origin_id):
                        raise StyleSampleConflict("保存键已用于其他样本。")
                    return sample
                sources, dependencies = self._origin(connection, scope, command)
                if sources and connection.execute("SELECT 1 FROM public.source_document WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND status<>'active' LIMIT 1",
                                                  (scope.owner_id, sources)).fetchone():
                    raise StyleSampleConflict("样本原始来源已失效。")
                row = connection.execute("""
                    INSERT INTO public.style_sample(owner_id,contact_id,save_key,final_text,origin_kind,origin_id,source_ids,dependency_sample_ids)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *
                """, (scope.owner_id, scope.contact_id, command.save_key, command.text.strip(),
                      command.origin_kind, command.origin_id, sources, dependencies)).fetchone()
                if row is None:
                    raise StyleSampleError("表达样本保存未返回记录。")
                return _as_sample(row)
        except psycopg.Error:
            raise StyleSampleError("表达样本保存失败。") from None

    @staticmethod
    def _origin(connection: Any, scope: ContactScope, command: SaveStyleSample) -> tuple[builtins.list[UUID], builtins.list[UUID]]:
        if command.origin_kind == "manual":
            # 公开候选保存路径始终携真实候选标识；已知原文不能改称无来源输入。
            known = connection.execute("""
                SELECT 1 FROM public.reply_candidate WHERE owner_id=%s AND contact_id=%s AND candidate_text=%s
                UNION ALL SELECT 1 FROM public.message WHERE owner_id=%s AND contact_id=%s AND text_content=%s
                UNION ALL SELECT 1 FROM public.style_sample WHERE owner_id=%s AND contact_id=%s AND final_text=%s AND status='active' AND origin_kind<>'manual'
                LIMIT 1
            """, (scope.owner_id, scope.contact_id, command.text.strip(), scope.owner_id, scope.contact_id, command.text.strip(),
                  scope.owner_id, scope.contact_id, command.text.strip())).fetchone()
            if known:
                raise StyleSampleConflict("请从候选或消息入口保存，以保留真实来源。")
            return [], []
        if command.origin_kind == "message":
            row = connection.execute("SELECT speaker FROM public.message WHERE owner_id=%s AND contact_id=%s AND id=%s",
                                     (scope.owner_id, scope.contact_id, command.origin_id)).fetchone()
            if row is None or row["speaker"] != "user":
                raise StyleSampleNotFound("当前范围不存在可保存的本人消息。")
            refs = connection.execute("SELECT source_document_id,observation_id FROM public.message_source_ref WHERE owner_id=%s AND contact_id=%s AND message_id=%s",
                                      (scope.owner_id, scope.contact_id, command.origin_id)).fetchall()
            if not refs:
                raise StyleSampleConflict("消息来源已失效。")
            return list({command.origin_id, *(row["source_document_id"] or row["observation_id"] for row in refs)}), []
        candidate = connection.execute("""
            SELECT candidate.reply_request_id FROM public.reply_candidate AS candidate
            JOIN public.reply_request AS request ON request.id=candidate.reply_request_id
            WHERE candidate.owner_id=%s AND candidate.contact_id=%s AND candidate.id=%s AND request.state='completed'
        """, (scope.owner_id, scope.contact_id, command.origin_id)).fetchone()
        if candidate is None:
            raise StyleSampleNotFound("当前范围不存在有效候选。")
        try:
            require_reply_sources_current(connection, owner_id=scope.owner_id, request_id=candidate["reply_request_id"])
        except ReplyStoreInvariantError:
            raise StyleSampleConflict("候选当时原始来源记录缺失或已失效，请重新生成。") from None
        request_ids = _reply_ancestor_ids(connection, owner_id=scope.owner_id, request_id=candidate["reply_request_id"])
        evidence = connection.execute("SELECT evidence_id,kind,source_ids FROM public.reply_context_evidence WHERE reply_request_id=ANY(%s::uuid[])",
                                      (request_ids,)).fetchall()
        sources = {UUID(value) for row in evidence for value in row["source_ids"]
                   if not (row["kind"] == 'owner_memory' and manual_owner_evidence_is_current(
                       connection, owner_id=scope.owner_id, evidence_id=row["evidence_id"],
                       source_ids=tuple(UUID(item) for item in row["source_ids"])))}
        sources.update(row["evidence_id"] for row in evidence if row["kind"] == "message")
        raw_sources = connection.execute("SELECT source_id FROM public.reply_original_source_use WHERE reply_request_id=ANY(%s::uuid[])",
                                         (request_ids,)).fetchall()
        if sources and not raw_sources:
            raise StyleSampleConflict("旧候选缺少当时原始来源记录，请重新生成后保存。")
        sources.update(row["source_id"] for row in raw_sources)
        from notalone.persistence.reply_discussion_dependencies import reply_style_sample_dependencies
        dependencies = reply_style_sample_dependencies(connection, scope, candidate["reply_request_id"])
        for sample_id in dependencies:
            sample = connection.execute("SELECT status,source_ids FROM public.style_sample WHERE owner_id=%s AND contact_id=%s AND id=%s",
                                        (scope.owner_id, scope.contact_id, sample_id)).fetchone()
            if sample is None or sample["status"] != "active":
                raise StyleSampleConflict("候选引用的样本已失效。")
            sources.update(sample["source_ids"])
        if sources and connection.execute("SELECT 1 FROM public.source_document WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND status<>'active' LIMIT 1",
                                          (scope.owner_id, list(sources))).fetchone():
            raise StyleSampleConflict("候选来源已失效。")
        return list(sources), list(set(dependencies))

    def delete(self, scope: ContactScope, sample_id: UUID) -> None:
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=scope.owner_id)
                self._read(connection, scope, sample_id)
                _erase_samples(connection, owner_id=scope.owner_id, sample_ids=[sample_id])
        except psycopg.Error:
            raise StyleSampleError("表达样本删除失败，可重试。") from None
