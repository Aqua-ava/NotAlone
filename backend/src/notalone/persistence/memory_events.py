"""事件字段的当前来源复验；旧资料不重建证明。"""

from typing import Any
from uuid import UUID
from psycopg import sql
from psycopg.rows import dict_row

from notalone.memory.events import MemoryEvent
from notalone.persistence.memory_conditions import candidate_rows_by_id, conditions_clear_sql
from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.persistence.correction_evidence import validate_frozen_snapshot
from notalone.persistence.schema_capabilities import schema_capability


def has_event_schema(connection: Any) -> bool:
    def probe() -> bool:
        row = connection.execute(
            "SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.memory_candidate'::regclass "
            "AND attname='event' AND NOT attisdropped) AS present",
        ).fetchone()
        return bool(row["present"] if isinstance(row, dict) else row[0])

    return schema_capability(connection, "memory_candidate.event", probe)


def _bind_memory_event_from_row(
    connection: Any, *, owner_id: UUID, event: MemoryEvent, row: dict | None,
) -> MemoryEvent:
    if row is None:
        return event.with_current_sources(False)
    if row.get("correction_evidence") is None:
        return event.with_current_sources(False)
    try:
        from notalone.persistence.memory_correction import candidate_from_row, decision_sources_available
        from notalone.persistence.dimension_evidence import bind_stored_dimension_evidence
        candidate = candidate_from_row(row)
        current = bind_stored_dimension_evidence(connection, candidate)
        validate_frozen_snapshot(connection, owner_id=owner_id, evidence=row["correction_evidence"])
        if (candidate.event is None or candidate.event.to_payload() != event.to_payload()
                or current is None or not current.source_bound
                or not decision_sources_available(connection, owner_id=owner_id, evidence=row["correction_evidence"])):
            return event.with_current_sources(False)
    except (MemoryCorrectionConflictError, KeyError, TypeError, ValueError):
        return event.with_current_sources(False)
    return event


def bind_memory_event(connection: Any, *, owner_id: UUID, candidate_id: UUID | None,
                      raw: object) -> MemoryEvent | None:
    event = MemoryEvent.from_payload(raw)
    if event is None:
        return None
    row = connection.execute(
        "SELECT * "
        "FROM public.memory_candidate WHERE owner_id=%s AND id=%s",
        (owner_id, candidate_id),
    ).fetchone() if candidate_id is not None else None
    return _bind_memory_event_from_row(connection, owner_id=owner_id, event=event, row=row)


def bind_memory_events_rows(connection: Any, rows) -> list[MemoryEvent | None]:
    """按批绑定事件：候选行整批读取一次，逐行只做内存关联。

    返回顺序与输入一致；与单行 `bind_memory_event` 的判定相同。
    """
    values: list[MemoryEvent | None] = [None] * len(rows)
    grouped: dict[UUID, list[tuple[int, UUID | None, MemoryEvent]]] = {}
    for index, row in enumerate(rows):
        event = MemoryEvent.from_payload(row.get("memory_event"))
        if event is None:
            continue
        grouped.setdefault(row["owner_id"], []).append(
            (index, row["source_candidate_id"], event),
        )
    for owner_id, items in grouped.items():
        fetched = candidate_rows_by_id(
            connection, owner_id=owner_id,
            candidate_ids=[candidate_id for _, candidate_id, _ in items],
        )
        for index, candidate_id, event in items:
            values[index] = _bind_memory_event_from_row(
                connection, owner_id=owner_id, event=event,
                row=fetched.get(candidate_id) if candidate_id is not None else None,
            )
    return values


def _window_ids(window: dict | None) -> set[str]:
    if not isinstance(window, dict):
        return set()
    identifiers = set(window.get("source_ids", ())) | set(window.get("message_ids", ()))
    for ref in window.get("source_refs", ()):
        identifiers.update(ref.get(key) for key in ("message_id", "source_id", "ref_id"))
    for message in window.get("messages", ()):
        identifiers.add(message.get("message_id"))
        for ref in message.get("source_refs", ()):
            identifiers.update((ref.get("source_id"), ref.get("ref_id")))
    return identifiers


def erase_event_version_dependencies(connection: Any, *, owner_id: UUID, removed_ids: set[UUID]) -> None:
    """原始阶段、发生时间与两侧窗口的任何参与来源删除都撤下其派生副本。"""
    if not has_event_schema(connection):
        return
    clear_conditions = conditions_clear_sql(connection)
    removed = {str(item) for item in removed_ids}
    with connection.cursor(row_factory=dict_row) as cursor:
        candidates = cursor.execute(
            "SELECT id, contact_id, source_ids, correction_evidence, dimension_evidence, to_jsonb(memory_candidate)->'evolution' AS evolution "
            "FROM public.memory_candidate WHERE owner_id=%s AND (event IS NOT NULL OR jsonb_typeof(to_jsonb(memory_candidate)->'conditions')='object' OR jsonb_typeof(to_jsonb(memory_candidate)->'evolution')='object')", (owner_id,),
        ).fetchall()
        candidate_ids = {
            row["id"] for row in candidates if removed & (
                {str(item) for item in row["source_ids"]}
                | {ref["memory_id"] for ref in (row.get("evolution") or {}).get("related_versions", [])}
                | _window_ids(row["correction_evidence"]) | _window_ids(row["dimension_evidence"]))
        }
        affected = {}
        for table in ("confirmed_memory", "owner_memory"):
            rows = cursor.execute(sql.SQL(
                "SELECT id, source_candidate_id, source_ids, version_evidence, to_jsonb({})->'conditions' AS conditions FROM public.{} "
                "WHERE owner_id=%s AND (version_evidence IS NOT NULL OR event IS NOT NULL OR jsonb_typeof(to_jsonb({})->'conditions')='object' OR source_candidate_id=ANY(%s::uuid[]))"
            ).format(sql.Identifier(table), sql.Identifier(table), sql.Identifier(table)), (owner_id, list(candidate_ids))).fetchall()
            seeds = {row["id"] for row in rows if row["source_candidate_id"] in candidate_ids or (row.get("conditions") is not None and removed & {str(item) for item in row["source_ids"]}) or (
                row["version_evidence"] is not None and removed & (
                    _window_ids(row["version_evidence"].get("previous_window"))
                    | _window_ids(row["version_evidence"].get("current_window"))))}
            affected[table] = cursor.execute(sql.SQL(
                "WITH RECURSIVE affected(id) AS (SELECT id FROM public.{} WHERE owner_id=%s AND id=ANY(%s::uuid[]) "
                "UNION SELECT memory.id FROM public.{} memory JOIN affected ON memory.supersedes_memory_id=affected.id "
                "WHERE memory.owner_id=%s) SELECT memory.* FROM public.{} memory WHERE memory.owner_id=%s "
                "AND memory.id IN (SELECT id FROM affected)"
            ).format(sql.Identifier(table), sql.Identifier(table), sql.Identifier(table)),
                (owner_id, list(seeds), owner_id, owner_id)).fetchall()
        candidate_ids.update(row["source_candidate_id"] for rows in affected.values() for row in rows
                             if row["source_candidate_id"] is not None)
        affected_ids = candidate_ids | {row["id"] for rows in affected.values() for row in rows}
        if not affected_ids:
            return
        from notalone.persistence.extraction_trace import erase_record_traces, erase_source_traces
        from notalone.persistence.memory_correction import erase_correction_dependencies
        from notalone.persistence.reply_cleanup import delete_source_replies

        erase_source_traces(connection, owner_id=owner_id, removed_ids=affected_ids)
        contacts = {row["contact_id"] for row in candidates if row["id"] in candidate_ids}
        contacts.update(row["contact_id"] for row in affected["confirmed_memory"])
        for table, rows in affected.items():
            for row in rows:
                erase_record_traces(connection, owner_id=owner_id,
                    record_kind="contact_memory" if table == "confirmed_memory" else "owner_memory", record_id=row["id"])
            cursor.execute(sql.SQL(
                "UPDATE public.{} SET text_content='已删除的资料', status='deleted', revision=revision+1, "
                "risk_flags='{{}}'::text[], event=NULL, version_evidence=NULL" + clear_conditions + ", updated_at=now() "
                "WHERE owner_id=%s AND id=ANY(%s::uuid[])"
            ).format(sql.Identifier(table)), (owner_id, [row["id"] for row in rows]))
        cursor.execute(
            "UPDATE public.memory_candidate SET text_content='已删除的资料', status='invalidated', "
            "interpretation_reason='', alternatives='{}'::text[], risk_flags='{}'::text[], failure_reason=NULL, "
            "event=NULL, dimension_evidence=NULL, correction_evidence=NULL, correction_decision_ids=NULL" + clear_conditions + ", updated_at=now() "
            "WHERE owner_id=%s AND id=ANY(%s::uuid[])", (owner_id, list(candidate_ids)),
        )
        erase_correction_dependencies(connection, owner_id=owner_id, removed_ids=affected_ids, record_deletion=True)
        for contact_id in contacts:
            delete_source_replies(connection, owner_id=owner_id, contact_id=contact_id, removed_ids=affected_ids)
            cursor.execute(
                "UPDATE public.contact_memory_index SET topics='[]'::jsonb, status='stale', updated_at=now() "
                "WHERE owner_id=%s AND contact_id=%s", (owner_id, contact_id),
            )
            cursor.execute(
                "INSERT INTO public.contact_memory_state (owner_id,contact_id,memory_revision) VALUES (%s,%s,1) "
                "ON CONFLICT (owner_id,contact_id) DO UPDATE SET memory_revision=contact_memory_state.memory_revision+1,updated_at=now()",
                (owner_id, contact_id),
            )
        if affected["owner_memory"]:
            delete_source_replies(connection, owner_id=owner_id, contact_id=None,
                                  removed_ids=affected_ids, revoke_running_scope=False)
