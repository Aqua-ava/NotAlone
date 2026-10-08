"""从已有直接消息引用批量投影记忆时间，不改写任何业务记录。"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from typing import Any
from uuid import UUID

import psycopg

from notalone.memory.timing import MemoryTiming
from notalone.persistence.message_sources import valid_source_ref_exists_sql


def timed_memory_rows(
    connection: psycopg.Connection[Any],
    rows: Sequence[dict[str, Any]],
    *,
    source_ids_key: str,
    contact_scoped: bool = True,
) -> list[dict[str, Any]]:
    """仅查同范围的直接消息 ID；文档、观察、手动引用的时间保持未知。"""
    result = [dict(row) for row in rows]
    groups: dict[
        tuple[UUID, UUID | None], list[dict[str, Any]]
    ] = defaultdict(list)
    for row in result:
        group_key = (
            row["owner_id"], row["contact_id"] if contact_scoped else None,
        )
        groups[group_key].append(row)
    for (owner_id, contact_id), group in groups.items():
        source_ids = tuple(dict.fromkeys(
            source_id for row in group for source_id in row[source_ids_key]
        ))
        conditions = [
            "message.owner_id = %s", "message.id = ANY(%s)",
            valid_source_ref_exists_sql("message"),
        ]
        params: list[Any] = [owner_id, list(source_ids)]
        if contact_scoped:
            conditions.append("message.contact_id = %s")
            params.append(contact_id)
        known = connection.execute(
            "SELECT message.id, message.occurred_at FROM public.message AS message "
            "WHERE " + " AND ".join(conditions), params,
        ).fetchall()
        times = {row["id"]: row["occurred_at"] for row in known}
        for row in group:
            row["timing"] = MemoryTiming.from_source_times(
                tuple(times.get(source_id) for source_id in row[source_ids_key]),
                recorded_at=row["recorded_at"],
            )
    return result
