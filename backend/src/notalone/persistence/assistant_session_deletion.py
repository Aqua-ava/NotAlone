"""只清除一段助手会话的讨论与回复副本，独立资料继续保留。"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from notalone.application.assistant_session_service import (
    AssistantSessionNotFound,
    AssistantSessionPersistenceError,
)
from notalone.persistence.style_sample_store import invalidate_reply_keys
from notalone.scopes import ContactScope


def delete_assistant_session(
    connection: Any, scope: ContactScope, session_id: UUID,
) -> None:
    """复用调用方 owner 锁与事务，失败整体回滚，完成前复验不可恢复。

    请求键是尚未提交候选时的关联依据；仅按 reply_request_id 清理会遗留
    running/failed 请求，或让 reserve 后迟到的 start 重新写入旧正文。
    表达样本按 ADR-044 独立留存，不沿会话关联删除来源与关系资料。
    """

    parameters = {
        "owner_id": scope.owner_id, "contact_id": scope.contact_id,
        "session_id": session_id,
    }
    if not connection.execute(
        "SELECT 1 FROM public.contact WHERE owner_id = %(owner_id)s "
        "AND id = %(contact_id)s",
        parameters,
    ).fetchone():
        raise AssistantSessionNotFound("指定范围内不存在联系人。")
    if not connection.execute(
        "SELECT 1 FROM public.assistant_session "
        "WHERE owner_id = %(owner_id)s AND contact_id = %(contact_id)s "
        "AND id = %(session_id)s FOR UPDATE",
        parameters,
    ).fetchone():
        raise AssistantSessionNotFound("指定范围内不存在助手会话。")

    connection.execute(
        """
        INSERT INTO public.reply_invalidated_key (owner_id, contact_id, idempotency_key)
        SELECT owner_id, contact_id, idempotency_key
        FROM public.assistant_session_turn
        WHERE owner_id = %(owner_id)s AND contact_id = %(contact_id)s
          AND session_id = %(session_id)s
        ON CONFLICT (owner_id, contact_id, idempotency_key) DO NOTHING
        """,
        parameters,
    )
    rows = connection.execute(
        """
        WITH RECURSIVE affected(id) AS (
            SELECT request.id
            FROM public.reply_request AS request
            WHERE request.owner_id = %(owner_id)s AND request.contact_id = %(contact_id)s
              AND EXISTS (
                  SELECT 1 FROM public.assistant_session_turn AS turn
                  WHERE turn.owner_id = request.owner_id AND turn.contact_id = request.contact_id
                    AND turn.session_id = %(session_id)s
                    AND (turn.idempotency_key = request.idempotency_key
                         OR turn.reply_request_id = request.id)
              )
            UNION
            SELECT child.id
            FROM affected
            JOIN public.reply_candidate AS candidate ON candidate.reply_request_id = affected.id
            JOIN public.reply_request AS child ON child.continued_from_candidate_id = candidate.id
            WHERE candidate.owner_id = %(owner_id)s AND candidate.contact_id = %(contact_id)s
              AND child.owner_id = %(owner_id)s AND child.contact_id = %(contact_id)s
        )
        SELECT request.id, request.idempotency_key
        FROM public.reply_request AS request JOIN affected ON affected.id = request.id
        WHERE request.owner_id = %(owner_id)s AND request.contact_id = %(contact_id)s
        FOR UPDATE OF request
        """,
        parameters,
    ).fetchall()
    request_ids = [row["id"] if isinstance(row, dict) else row[0] for row in rows]
    # 在原版、选择回执和C快照清除前捕获真实父边，复用A唯一选择器。
    from notalone.persistence.assistant_candidate_carry import read_candidate_carry_lineage_for_deletion
    from notalone.persistence.assistant_input_lineage import select_assistant_input_dependents
    from notalone.persistence.reply_discussion_dependencies import captured_reply_discussion_uses

    carry_edges = read_candidate_carry_lineage_for_deletion(connection, owner_id=scope.owner_id)
    captured_uses = captured_reply_discussion_uses(connection, scope)
    original_turns = connection.execute(
        "SELECT id FROM public.assistant_session_turn WHERE owner_id=%s AND contact_id=%s AND session_id=%s",
        (scope.owner_id, scope.contact_id, session_id),
    ).fetchall()
    root_turn_ids = tuple(row["id"] if isinstance(row, dict) else row[0] for row in original_turns)
    selected = select_assistant_input_dependents(
        connection, owner_id=scope.owner_id, contact_id=scope.contact_id, removed_ids=set(),
        reply_request_ids=request_ids, turn_ids=root_turn_ids,
        carry_edges=carry_edges, captured_uses=captured_uses,
    )
    request_ids = sorted(set(request_ids) | set(selected.reply_request_ids))
    candidates = connection.execute(
        "SELECT id FROM public.reply_candidate WHERE owner_id = %s AND contact_id = %s "
        "AND reply_request_id = ANY(%s::uuid[])",
        (scope.owner_id, scope.contact_id, request_ids),
    ).fetchall()
    candidate_ids = [row["id"] if isinstance(row, dict) else row[0] for row in candidates]
    # reserve 已提交而 start 尚未建请求时，候选关联只存在于规范化 turn 输入中。
    reserved = connection.execute(
        "SELECT id FROM public.assistant_session_turn WHERE owner_id = %s AND contact_id = %s "
        "AND input_payload->>'continued_from_candidate_id' = ANY(%s::text[]) FOR UPDATE",
        (scope.owner_id, scope.contact_id, [str(identifier) for identifier in candidate_ids]),
    ).fetchall()
    turn_ids = [row["id"] if isinstance(row, dict) else row[0] for row in reserved]
    turn_ids = sorted(set(turn_ids) | set(selected.turn_ids))
    connection.execute(
        "INSERT INTO public.reply_invalidated_key (owner_id, contact_id, idempotency_key) "
        "SELECT owner_id, contact_id, idempotency_key FROM public.assistant_session_turn "
        "WHERE owner_id = %s AND contact_id = %s AND id = ANY(%s::uuid[]) "
        "ON CONFLICT (owner_id, contact_id, idempotency_key) DO NOTHING",
        (scope.owner_id, scope.contact_id, turn_ids),
    )
    invalidate_reply_keys(connection, owner_id=scope.owner_id, request_ids=request_ids)
    from notalone.persistence.assistant_session_store import erase_assistant_source_turns
    erase_assistant_source_turns(
        connection, owner_id=scope.owner_id, contact_id=scope.contact_id,
        removed_ids=set(candidate_ids), reply_request_ids=request_ids, turn_ids=turn_ids,
        carry_edges=carry_edges, captured_uses=captured_uses,
    )
    connection.execute(
        "DELETE FROM public.reply_request WHERE owner_id = %s AND contact_id = %s "
        "AND id = ANY(%s::uuid[])",
        (scope.owner_id, scope.contact_id, request_ids),
    )
    deleted = connection.execute(
        "DELETE FROM public.assistant_session WHERE owner_id = %(owner_id)s "
        "AND contact_id = %(contact_id)s AND id = %(session_id)s",
        parameters,
    ).rowcount
    if deleted != 1:
        raise AssistantSessionPersistenceError("助手会话尚未完整删除。")

    remaining = connection.execute(
        """
        SELECT 1 FROM public.assistant_session
        WHERE owner_id = %(owner_id)s AND contact_id = %(contact_id)s
          AND id = %(session_id)s
        UNION ALL
        SELECT 1 FROM public.assistant_session_turn
        WHERE owner_id = %(owner_id)s AND contact_id = %(contact_id)s
          AND session_id = %(session_id)s
        UNION ALL
        SELECT 1 FROM public.assistant_session_input
        WHERE owner_id = %(owner_id)s AND contact_id = %(contact_id)s
          AND session_id = %(session_id)s
        UNION ALL
        SELECT 1 FROM public.reply_request
        WHERE owner_id = %(owner_id)s AND contact_id = %(contact_id)s
          AND id = ANY(%(request_ids)s::uuid[])
        UNION ALL
        SELECT 1 FROM public.assistant_session_turn
        WHERE owner_id = %(owner_id)s AND contact_id = %(contact_id)s
          AND id = ANY(%(turn_ids)s::uuid[])
          AND (state <> 'redacted' OR input_payload IS NOT NULL OR input_digest IS NOT NULL
               OR reply_request_id IS NOT NULL OR cardinality(dependency_ids) <> 0)
        UNION ALL
        SELECT 1 FROM public.assistant_session_input
        WHERE owner_id = %(owner_id)s AND contact_id = %(contact_id)s
          AND turn_id = ANY(%(turn_ids)s::uuid[])
          AND (state <> 'redacted' OR content IS NOT NULL OR cardinality(dependency_ids) <> 0)
        """,
        {**parameters, "request_ids": request_ids, "turn_ids": turn_ids},
    ).fetchone()
    if remaining is not None:
        raise AssistantSessionPersistenceError("助手会话仍存在可恢复记录。")
