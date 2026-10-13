"""来源删除时清除所有状态下失去来源的记忆正文。"""

from typing import Any
from uuid import UUID

import psycopg
from psycopg import sql

from notalone.persistence.dimension_evidence import erase_dimension_evidence


def erase_source_memories(
    connection: psycopg.Connection[Any],
    *,
    owner_id: UUID,
    contact_id: UUID,
    removed_ids: set[UUID],
) -> None:
    """共享来源仍保留；历史拒绝、失效或撤销记录也不能残留正文。

    调用方持有联系人和 owner 锁，先清理回复与索引，再进入这里。
    此规则只用于来源删除，不改变单条记忆撤销的防复活语义。
    """
    erase_dimension_evidence(
        connection, owner_id=owner_id, contact_id=contact_id,
        removed_ids=removed_ids,
    )
    for table in ("confirmed_memory", "owner_memory", "memory_candidate"):
        scope_sql: sql.Composable = sql.SQL("owner_id = %s")
        scope_args = [owner_id]
        if table != "owner_memory":
            scope_sql += sql.SQL(" AND contact_id = %s")
            scope_args.append(contact_id)
        rows = connection.execute(
            sql.SQL("SELECT id, source_ids FROM public.{} WHERE {} "
                    "AND source_ids && %s::uuid[] FOR UPDATE").format(
                        sql.Identifier(table), scope_sql,
                    ),
            (*scope_args, list(removed_ids)),
        ).fetchall()
        for memory_id, source_ids in rows:
            remaining = [item for item in source_ids if item not in removed_ids]
            if remaining:
                connection.execute(
                    sql.SQL("UPDATE public.{} SET source_ids = %s, updated_at = now() "
                            "WHERE {} AND id = %s").format(sql.Identifier(table), scope_sql),
                    (remaining, *scope_args, memory_id),
                )
                continue
            if table == "confirmed_memory":
                # 复合 SET NULL 外键会同时清空非空范围列，先解除版本关联。
                connection.execute(
                    "UPDATE public.confirmed_memory SET supersedes_memory_id = NULL "
                    "WHERE owner_id = %s AND contact_id = %s AND supersedes_memory_id = %s",
                    (owner_id, contact_id, memory_id),
                )
            elif table == "memory_candidate":
                # 保留仍有其他来源支持的记忆，避免候选外键级联误删。
                connection.execute(
                    "UPDATE public.confirmed_memory SET source_candidate_id = NULL "
                    "WHERE owner_id = %s AND contact_id = %s AND source_candidate_id = %s",
                    (owner_id, contact_id, memory_id),
                )
            connection.execute(
                sql.SQL("DELETE FROM public.{} WHERE {} AND id = %s").format(
                    sql.Identifier(table), scope_sql,
                ),
                (*scope_args, memory_id),
            )
    # 主题摘要可能混合已删除与保留资料，不能仅剔除 ID 后保留摘要正文。
    connection.execute(
        "UPDATE public.contact_memory_index SET topics = '[]'::jsonb, "
        "status = 'stale', updated_at = now() WHERE owner_id = %s AND contact_id = %s",
        (owner_id, contact_id),
    )
