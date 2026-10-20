"""C提供typed捕获身份，A复用原指纹复验后向唯一选择器提供无正文边。"""

from __future__ import annotations

from typing import Any, NoReturn
from uuid import UUID

from notalone.persistence.assistant_candidate_versions import _history
from notalone.persistence.assistant_discussion_context import (
    _candidate_identity, _captured_anchor, _current_fingerprint, _discussion_identity,
    _generation_identity, _input_rows,
)
from notalone.persistence.assistant_session_store import _partition_assistant_dependencies, _reply_dependencies
from notalone.persistence.reply_discussion_dependencies import (
    CapturedReplyDiscussionUse,
)
from notalone.persistence.reply_sources import captured_reply_sources
from notalone.reply.assistant_discussion import (
    DiscussionDependencies, DiscussionIdentity, DiscussionSnapshot,
)
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.scopes import ContactScope


def _reject() -> NoReturn:
    raise ReplyStoreInvariantError("助手讨论捕获的删除身份无效。")


def _validate_use(use: CapturedReplyDiscussionUse, owner_id: UUID, contact_id: UUID | None) -> None:
    if (not isinstance(use, CapturedReplyDiscussionUse)
            or not isinstance(use.reply_request_id, UUID) or not isinstance(use.request_key, UUID)
            or not isinstance(use.snapshot, DiscussionSnapshot)):
        _reject()
    try:
        DiscussionSnapshot.__post_init__(use.snapshot)
        ContactScope.__post_init__(use.snapshot.scope)
        for identity in use.snapshot.records:
            DiscussionIdentity.__post_init__(identity)
    except (TypeError, ValueError, AttributeError):
        _reject()
    if (use.snapshot.scope.owner_id != owner_id
            or contact_id is not None and use.snapshot.scope.contact_id != contact_id
            or use.snapshot.request_key != use.request_key):
        _reject()


def _require_generation(cursor: Any, scope: ContactScope, row: dict[str, Any]) -> None:
    if (row["input_type"] != "generation" or row["state"] != "active"
            or row["turn_state"] not in ("running", "failed", "completed")
            or row["input_payload"] is None or row["input_digest"] is None):
        _reject()
    actual = cursor.execute(
        "SELECT turn.idempotency_key,turn.reply_request_id,request.id AS request_id,"
        "request.conversation_binding_id FROM public.assistant_session_turn AS turn "
        "LEFT JOIN public.reply_request AS request ON request.owner_id=turn.owner_id "
        "AND request.contact_id=turn.contact_id AND request.idempotency_key=turn.idempotency_key "
        "AND request.conversation_binding_id=turn.conversation_binding_id "
        "AND (turn.reply_request_id IS NULL OR request.id=turn.reply_request_id) "
        "WHERE turn.owner_id=%s AND turn.contact_id=%s AND turn.session_id=%s "
        "AND turn.id=%s AND turn.input_version_id=%s AND turn.conversation_binding_id=%s",
        (scope.owner_id, scope.contact_id, row["session_id"], row["turn_id"], row["id"],
         row["conversation_binding_id"]),
    ).fetchone()
    if (actual is None or actual["request_id"] != row["reply_request_id"]
            or row["turn_state"] == "completed" and actual["request_id"] is None
            or actual["reply_request_id"] is not None and actual["request_id"] is None):
        _reject()


def _dependencies(cursor: Any, scope: ContactScope, row: dict[str, Any]) -> DiscussionDependencies:
    sources = set(row["turn_dependencies"] or ())
    inherited = _partition_assistant_dependencies(cursor, scope, sources, require_available=False)
    sources = set(inherited.source_ids)
    request_id = row["reply_request_id"]
    if request_id is None:
        return inherited
    sources.update(_reply_dependencies(cursor, scope, request_id))
    sources.update(captured_reply_sources(cursor, owner_id=scope.owner_id, request_id=request_id))
    # 删除身份复验沿唯一 codec 保留已捕获的来源依赖。
    typed = _partition_assistant_dependencies(cursor, scope, sources, require_available=False)
    return DiscussionDependencies(typed.source_ids)


def _require_candidate_identity(cursor: Any, scope: ContactScope, row: dict[str, Any],
                                identity: DiscussionIdentity) -> DiscussionIdentity:
    if row["turn_state"] != "completed" or row["request_state"] != "completed":
        _reject()
    candidate = cursor.execute(
        "SELECT candidate.id,candidate.reply_request_id,candidate.ordinal,candidate.message_group,"
        "candidate.created_at,%s::uuid AS turn_id FROM public.reply_candidate AS candidate "
        "JOIN public.reply_request AS request ON request.id=candidate.reply_request_id "
        "AND request.owner_id=candidate.owner_id AND request.contact_id=candidate.contact_id "
        "AND request.conversation_binding_id=candidate.conversation_binding_id "
        "LEFT JOIN public.assistant_candidate_version AS version ON version.candidate_id=candidate.id "
        "AND version.owner_id=candidate.owner_id AND version.contact_id=candidate.contact_id "
        "AND version.id=%s AND version.session_id=%s AND version.turn_id=%s "
        "WHERE candidate.owner_id=%s AND candidate.contact_id=%s AND candidate.id=%s "
        "AND candidate.reply_request_id=%s AND candidate.conversation_binding_id=%s "
        "AND (version.id IS NOT NULL OR (candidate.id=%s AND NOT EXISTS ("
        "SELECT 1 FROM public.assistant_candidate_version AS original WHERE original.id=candidate.id)))",
        (row["turn_id"], identity.version_id, row["session_id"], row["turn_id"],
         scope.owner_id, scope.contact_id, identity.candidate_id,
         row["reply_request_id"], row["conversation_binding_id"], identity.version_id),
    ).fetchone()
    if candidate is None:
        _reject()
    # 原版可由权威候选直接投影；其他版本仍须真实保存并精确属于该会话和turn。
    # 纯重建已保存版本，不进入CURRENT/来源guard，也不补写原版。
    history = _history(cursor, scope, row["session_id"], candidate)
    version = next((item for item in history.versions if item.version_id == identity.version_id), None)
    if version is None:
        _reject()
    return _candidate_identity(row, history, version)


def verified_captured_input_edges(
    cursor: Any, *, owner_id: UUID, contact_id: UUID | None,
    captured_uses: tuple[CapturedReplyDiscussionUse, ...],
) -> tuple[tuple[UUID, UUID], ...]:
    """复验实际同范围会话、输入、turn、binding、请求和原指纹；不构造第二张图。"""

    if not isinstance(captured_uses, tuple):
        _reject()
    edges: set[tuple[UUID, UUID]] = set()
    seen: set[UUID] = set()
    for use in captured_uses:
        _validate_use(use, owner_id, contact_id)
        if use.reply_request_id in seen:
            _reject()
        seen.add(use.reply_request_id)
        snapshot, scope = use.snapshot, use.snapshot.scope
        request = cursor.execute(
            "SELECT idempotency_key,conversation_binding_id FROM public.reply_request "
            "WHERE owner_id=%s AND contact_id=%s AND id=%s",
            (scope.owner_id, scope.contact_id, use.reply_request_id),
        ).fetchone()
        anchor = _captured_anchor(cursor, scope, use.request_key)
        rows = {row["id"]: row for row in _input_rows(cursor, scope, snapshot.session_id)}
        current = rows.get(snapshot.current_input_version_id)
        if (request is None or anchor is None or current is None
                or request["idempotency_key"] != use.request_key
                or request["conversation_binding_id"] != anchor["conversation_binding_id"]
                or anchor["anchor_binding_id"] != anchor["conversation_binding_id"]
                or current["reply_request_id"] != use.reply_request_id
                or (anchor["session_id"], anchor["input_version_id"], anchor["id"],
                    _current_fingerprint(anchor)) != (
                    snapshot.session_id, snapshot.current_input_version_id,
                    snapshot.current_turn_id, snapshot.current_payload_sha256,
                )):
            _reject()
        _require_generation(cursor, scope, current)
        for identity in snapshot.records:
            row = rows.get(identity.input_version_id)
            if row is None or row["state"] != "active":
                _reject()
            if identity.kind == "discussion_input":
                if (row["input_type"] == "generation" or row["turn_id"] is not None
                        or row["content"] is None):
                    _reject()
                actual = _discussion_identity(row)
            else:
                if identity.turn_id != row["turn_id"]:
                    _reject()
                _require_generation(cursor, scope, row)
                if identity.kind == "generation_input":
                    actual = _generation_identity(row, _dependencies(cursor, scope, row))
                else:
                    actual = _require_candidate_identity(cursor, scope, row, identity)
            if actual != identity:
                _reject()
            edges.add((snapshot.current_input_version_id, identity.input_version_id))
    return tuple(sorted(edges))
