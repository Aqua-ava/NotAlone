"""来源删除时清除含有失效依据的回复副本。"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import psycopg
from notalone.persistence.style_sample_store import invalidate_reply_keys

from notalone.persistence.assistant_session_store import erase_assistant_source_turns


class ReplyCleanupError(RuntimeError):
    """回复副本未完整删除，调用方必须回滚整个来源删除事务。"""


def delete_source_replies(
    connection: psycopg.Connection[Any],
    *,
    owner_id: UUID,
    contact_id: UUID | None,
    removed_ids: set[UUID],
) -> None:
    """删除完整请求，由外键级联清除证据、候选、引用及尝试记录。

    调用方持有 owner 锁，且尚未改写记忆来源。运行中的请求还没有完整
    证据快照，因此撤销受影响范围内的租约，阻止旧上下文在删除后落库。
    本人记忆可用于同一用户的其他联系人，按其实际引用清理完成的回复。
    """

    rows = connection.execute(
        """
        WITH RECURSIVE affected(id) AS (
            SELECT request.id
            FROM public.reply_request AS request
            WHERE request.owner_id = %s
              AND (
                (request.state = 'running' AND %s::uuid IS NOT NULL AND (
                    request.contact_id = %s OR EXISTS (
                        SELECT 1 FROM public.owner_memory AS memory
                        WHERE memory.owner_id = request.owner_id
                          AND memory.status = 'active'
                          AND memory.source_ids && %s::uuid[]
                    )
                ))
                OR EXISTS (
                    SELECT 1 FROM public.assistant_session_turn AS turn
                    WHERE turn.owner_id = request.owner_id AND turn.contact_id = request.contact_id
                      AND turn.idempotency_key = request.idempotency_key
                      AND turn.dependency_ids && %s::uuid[]
                )
                OR EXISTS (
                  SELECT 1 FROM public.reply_context_evidence AS evidence
                  WHERE evidence.reply_request_id = request.id
                    AND (
                        evidence.contact_id = %s OR evidence.kind = 'owner_memory'
                    )
                    AND (
                        evidence.evidence_id = ANY(%s::uuid[])
                        OR evidence.source_ids ?| %s::text[]
                    )
              )
              OR EXISTS (
                SELECT 1 FROM public.reply_original_source_use AS used
                WHERE used.reply_request_id=request.id AND used.owner_id=%s
                  AND used.source_id=ANY(%s::uuid[])
              )
              )
            UNION
            SELECT child.id
            FROM affected
            JOIN public.reply_candidate AS candidate
              ON candidate.reply_request_id = affected.id
            JOIN public.reply_request AS child
              ON child.continued_from_candidate_id = candidate.id
            WHERE child.owner_id = %s
              AND child.contact_id = candidate.contact_id
        )
        SELECT id FROM affected
        """,
        (
            owner_id, contact_id, contact_id, list(removed_ids), list(removed_ids), contact_id,
            list(removed_ids), [str(i) for i in removed_ids], owner_id, list(removed_ids), owner_id,
        ),
    ).fetchall()
    request_ids = [row["id"] if isinstance(row, dict) else row[0] for row in rows]
    erase_assistant_source_turns(
        connection, owner_id=owner_id, contact_id=contact_id,
        removed_ids=removed_ids, reply_request_ids=request_ids,
    )
    if not request_ids:
        return
    invalidate_reply_keys(connection, owner_id=owner_id, request_ids=request_ids)
    deleted = connection.execute(
        """
        DELETE FROM public.reply_request
        WHERE owner_id = %s AND id = ANY(%s::uuid[])
        """,
        (owner_id, request_ids),
    ).rowcount
    if deleted != len(request_ids):
        raise ReplyCleanupError("来源删除后仍存在回复副本。")


def delete_owner_memory_replies(
    connection: psycopg.Connection[Any], *, owner_id: UUID, memory_id: UUID,
) -> None:
    """同 owner 锁内仅清除依赖指定本人记忆的请求，不猜测联系人或撤销无关租约。"""

    delete_source_replies(connection, owner_id=owner_id, contact_id=None, removed_ids={memory_id})
