"""来源删除时清除含有失效依据的回复副本。"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import psycopg


class ReplyCleanupError(RuntimeError):
    """回复副本未完整删除，调用方必须回滚整个来源删除事务。"""


def delete_source_replies(
    connection: psycopg.Connection[Any],
    *,
    owner_id: UUID,
    contact_id: UUID,
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
                (request.state = 'running' AND (
                    request.contact_id = %s OR EXISTS (
                        SELECT 1 FROM public.owner_memory AS memory
                        WHERE memory.owner_id = request.owner_id
                          AND memory.status = 'active'
                          AND memory.source_ids && %s::uuid[]
                    )
                ))
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
              ))
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
            owner_id, contact_id, list(removed_ids), contact_id,
            list(removed_ids), [str(i) for i in removed_ids], owner_id,
        ),
    ).fetchall()
    request_ids = [row[0] for row in rows]
    if not request_ids:
        return
    deleted = connection.execute(
        """
        DELETE FROM public.reply_request
        WHERE owner_id = %s AND id = ANY(%s::uuid[])
        """,
        (owner_id, request_ids),
    ).rowcount
    if deleted != len(request_ids):
        raise ReplyCleanupError("来源删除后仍存在回复副本。")
