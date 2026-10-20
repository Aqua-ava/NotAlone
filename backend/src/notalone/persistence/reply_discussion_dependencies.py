"""C唯一历史依赖记录：复用A身份协议，正文只随运行上下文存于内存。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.reply.assistant_discussion import (
    DiscussionDependencies, DiscussionSnapshot,
    discussion_snapshot_from_payload, discussion_snapshot_to_payload,
)
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.store import ReplyRequest
from notalone.persistence.reply_sources import _with_reply_source_validation
from notalone.scopes import ContactScope


_SNAPSHOT = "assistant_discussion_snapshot"


def _connection(connection: Any) -> Any:
    return getattr(connection, "connection", connection)


def _metadata(row: dict[str, Any], scope: ContactScope) -> tuple[DiscussionSnapshot] | None:
    payload = row["context_snapshot"]
    if payload is None:
        return None
    if not isinstance(payload, dict):
        raise ReplyStoreInvariantError("历史依赖记录结构无效。")
    if _SNAPSHOT not in payload:
        return None
    try:
        snapshot = discussion_snapshot_from_payload(payload[_SNAPSHOT])
        if snapshot.scope != scope or snapshot.request_key != row["idempotency_key"]:
            raise ValueError
    except (KeyError, TypeError, ValueError, AttributeError):
        raise ReplyStoreInvariantError("历史依赖记录结构无效。") from None
    return (snapshot,)


def _request_row(cursor: Any, scope: ContactScope, request_id: UUID) -> dict[str, Any]:
    row = cursor.execute(
        "SELECT idempotency_key,context_snapshot FROM public.reply_request "
        "WHERE owner_id=%s AND contact_id=%s AND id=%s",
        (scope.owner_id, scope.contact_id, request_id),
    ).fetchone()
    if row is None:
        raise ReplyStoreInvariantError("历史依赖请求已失效。")
    return row




def _raw_sources(cursor: Any, scope: ContactScope, identifiers: tuple[UUID, ...]) -> set[UUID]:
    # A已核验并捕获消息/记忆的raw根；这里仅取实际raw ID，不在保存或读取时重新展开ref。
    if not identifiers:
        return set()
    rows = cursor.execute(
        "SELECT id FROM public.source_document WHERE owner_id=%s AND id=ANY(%s::uuid[]) "
        "UNION SELECT id FROM public.local_wechat_observation WHERE owner_id=%s AND id=ANY(%s::uuid[])",
        (scope.owner_id, list(identifiers), scope.owner_id, list(identifiers)),
    ).fetchall()
    return {row["id"] for row in rows}


def capture_reply_discussion_dependencies(
    connection: Any, request: ReplyRequest, snapshot: DiscussionSnapshot | None,
) -> DiscussionDependencies | None:
    """调用方持有owner锁及当前租约；只记录实际交给模型的 A 快照身份。"""

    from notalone.persistence.assistant_discussion_context import require_assistant_discussion_current

    raw = _connection(connection)
    with raw.cursor(row_factory=dict_row) as cursor:
        row = _request_row(cursor, request.scope, request.request_id)
        existing = _metadata(row, request.scope)
        if snapshot is None:
            if existing is not None:
                raise ReplyStoreInvariantError("模型上下文不能丢弃已捕获的助手讨论。")
            return None
        if (not isinstance(snapshot, DiscussionSnapshot) or snapshot.scope != request.scope
                or snapshot.request_key != row["idempotency_key"]):
            raise ReplyStoreInvariantError("助手讨论不属于当前回复。")
        if existing is not None and existing[0] != snapshot:
            raise ReplyStoreInvariantError("模型上下文不能更换已捕获的助手讨论。")
        dependencies = require_assistant_discussion_current(raw, request.scope, snapshot)
        payload = dict(row["context_snapshot"] or {})
        payload.update({_SNAPSHOT: discussion_snapshot_to_payload(snapshot)})
        cursor.execute("UPDATE public.reply_request SET context_snapshot=%s WHERE id=%s",
                       (Jsonb(payload), request.request_id))
        for source_id in _raw_sources(cursor, request.scope, dependencies.source_ids):
            cursor.execute(
                "INSERT INTO public.reply_original_source_use(reply_request_id,source_id,owner_id,contact_id) "
                "VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                (request.request_id, source_id, request.scope.owner_id, request.scope.contact_id),
            )
        return dependencies


@_with_reply_source_validation
def require_reply_discussion_dependencies(
    connection: Any, scope: ContactScope, request_id: UUID, *, current: bool = False,
    expected_snapshot: DiscussionSnapshot | None = None,
) -> DiscussionDependencies | None:
    """模型前/save使用CURRENT；完成读取/重放/继续使用HISTORY，不要求旧输入仍当前。"""

    from notalone.persistence.assistant_discussion_context import (
        require_assistant_discussion_available, require_assistant_discussion_current,
    )

    raw = _connection(connection)
    with raw.cursor(row_factory=dict_row) as cursor:
        metadata = _metadata(_request_row(cursor, scope, request_id), scope)
        if metadata is None:
            if expected_snapshot is not None:
                raise ReplyStoreInvariantError("助手讨论缺少模型调用前的捕获记录。")
            return None
        (snapshot,) = metadata
        if (current or expected_snapshot is not None) and snapshot != expected_snapshot:
            raise ReplyStoreInvariantError("助手讨论与模型调用前的快照不一致。")
        guard = require_assistant_discussion_current if current else require_assistant_discussion_available
        dependencies = guard(raw, scope, snapshot)
        captured = {row["source_id"] for row in cursor.execute(
            "SELECT source_id FROM public.reply_original_source_use "
            "WHERE owner_id=%s AND contact_id=%s AND reply_request_id=%s",
            (scope.owner_id, scope.contact_id, request_id),
        ).fetchall()}
        if not _raw_sources(cursor, scope, dependencies.source_ids) <= captured:
            raise ReplyStoreInvariantError("助手讨论缺少当时原始来源记录。")
        return dependencies




def reply_discussion_request_dependencies(
    connection: Any, scope: ContactScope, request_id: UUID,
) -> tuple[UUID, ...]:
    """只返回实际交给模型的历史候选请求，先复验已有A身份协议。"""

    require_reply_discussion_dependencies(connection, scope, request_id)
    with _connection(connection).cursor(row_factory=dict_row) as cursor:
        metadata = _metadata(_request_row(cursor, scope, request_id), scope)
        if metadata is None:
            return ()
        candidate_ids = {record.candidate_id for record in metadata[0].records
                         if record.kind == "candidate_version"}
        if not candidate_ids:
            return ()
        rows = cursor.execute(
            "SELECT candidate.id,request.id AS request_id FROM public.reply_candidate AS candidate "
            "JOIN public.reply_request AS request ON request.id=candidate.reply_request_id "
            "WHERE candidate.owner_id=%s AND candidate.contact_id=%s AND candidate.id=ANY(%s::uuid[]) "
            "AND request.owner_id=%s AND request.contact_id=%s AND request.state='completed'",
            (scope.owner_id, scope.contact_id, list(candidate_ids), scope.owner_id, scope.contact_id),
        ).fetchall()
        if {row["id"] for row in rows} != candidate_ids:
            raise ReplyStoreInvariantError("历史候选请求已失效。")
        return tuple(sorted({row["request_id"] for row in rows}))


def reply_discussion_metadata(connection: Any, scope: ContactScope, request_id: UUID) -> dict[str, Any]:
    """提交最终现有快照时保留模型前metadata，不保存历史正文。"""

    with _connection(connection).cursor(row_factory=dict_row) as cursor:
        metadata = _metadata(_request_row(cursor, scope, request_id), scope)
    if metadata is None:
        return {}
    (snapshot,) = metadata
    return {_SNAPSHOT: discussion_snapshot_to_payload(snapshot)}


@dataclass(frozen=True, slots=True)
class CapturedReplyDiscussionUse:
    """删除预捕获的无正文边；A消费现有typed身份，不自行解码C快照。"""

    reply_request_id: UUID
    request_key: UUID
    snapshot: DiscussionSnapshot


def captured_reply_discussion_uses(
    connection: Any, scope: ContactScope,
) -> tuple[CapturedReplyDiscussionUse, ...]:
    """调用者持有owner事务锁，在清空快照前读取同联系人实际捕获身份。

    这里只检查保存身份的严格codec、scope和request key；不调用可用性门禁。
    A负责复验实际input/turn/version及内容指纹，再统一计算删除闭包。
    """

    if not isinstance(scope, ContactScope):
        raise ReplyStoreInvariantError("历史依赖范围无效。")
    with _connection(connection).cursor(row_factory=dict_row) as cursor:
        rows = cursor.execute(
            "SELECT id,idempotency_key,context_snapshot FROM public.reply_request "
            "WHERE owner_id=%s AND contact_id=%s AND context_snapshot IS NOT NULL ORDER BY id",
            (scope.owner_id, scope.contact_id),
        ).fetchall()
        result = []
        for row in rows:
            metadata = _metadata(row, scope)
            if metadata is None:
                continue
            payload = row["context_snapshot"]
            if "scope" in payload and payload["scope"] != {
                "owner_id": str(scope.owner_id), "contact_id": str(scope.contact_id),
            }:
                raise ReplyStoreInvariantError("历史依赖快照范围不一致。")
            result.append(CapturedReplyDiscussionUse(row["id"], row["idempotency_key"], metadata[0]))
        return tuple(result)


def captured_owner_reply_discussion_uses(
    connection: Any, *, owner_id: UUID,
) -> tuple[CapturedReplyDiscussionUse, ...]:
    """owner删除事务中按实际联系人聚合捕获身份，仍只由上述唯一codec解码。"""

    with _connection(connection).cursor(row_factory=dict_row) as cursor:
        rows = cursor.execute(
            "SELECT DISTINCT contact_id FROM public.reply_request "
            "WHERE owner_id=%s AND context_snapshot ? %s "
            "ORDER BY contact_id", (owner_id, _SNAPSHOT),
        ).fetchall()
    return tuple(use for row in rows for use in captured_reply_discussion_uses(
        connection, ContactScope(owner_id, row["contact_id"]),
    ))
