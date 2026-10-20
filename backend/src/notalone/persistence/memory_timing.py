"""从已有直接消息引用批量投影记忆时间，不改写任何业务记录。"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from typing import Any
from datetime import datetime
from uuid import UUID

import psycopg

from notalone.memory.timing import MemoryTiming
from notalone.memory.current_status import project_current_status
from notalone.persistence.message_sources import active_source_ref_sql, valid_source_ref_exists_sql


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
            "SELECT message.id, message.occurred_at, message.text_content, ARRAY("
            "SELECT ref.raw_payload->>'time_iso' FROM public.message_source_ref AS ref "
            "WHERE ref.message_id=message.id AND ref.owner_id=message.owner_id "
            "AND ref.contact_id=message.contact_id AND " + active_source_ref_sql() +
            ") AS source_times FROM public.message AS message "
            "WHERE " + " AND ".join(conditions), params,
        ).fetchall()
        times = {row["id"]: _source_anchor(row) or row["occurred_at"] for row in known}
        statements = {row["id"]: (row["text_content"], _source_anchor(row)) for row in known}
        for row in group:
            row["timing"] = MemoryTiming.from_source_times(
                tuple(times.get(source_id) for source_id in row[source_ids_key]),
                recorded_at=row["recorded_at"],
            )
            prefix = {"candidate_source_ids": "candidate_", "memory_source_ids": "memory_"}.get(source_ids_key, "")
            row["timing"] = project_current_status(
                row["timing"], category=row[f"{prefix}category"],
                text=row[f"{prefix}text"] if prefix else row["text_content"],
                valid_at=row["candidate_valid_at" if prefix == "candidate_" else "valid_at"],
                invalid_at=row["candidate_invalid_at" if prefix == "candidate_" else "invalid_at"],
                has_conditions=bool(row.get(f"{prefix}conditions") or row.get("conditions") or row.get("memory_conditions")),
                source_statements=tuple(statements[source_id] for source_id in row[source_ids_key] if source_id in statements),
            )
    return result


def _source_anchor(row: dict[str, Any]) -> datetime | None:
    """只复用与规范消息同一时刻的来源时区；不把会话／服务器时区代填。"""
    anchors = []
    for value in row["source_times"]:
        if not isinstance(value, str):
            continue
        try:
            anchor = datetime.fromisoformat(value)
        except ValueError:
            continue
        if anchor.tzinfo is not None and anchor.utcoffset() is not None and anchor == row["occurred_at"]:
            anchors.append(anchor)
    if not anchors or len({item.utcoffset() for item in anchors}) != 1:
        return None
    return anchors[0]
