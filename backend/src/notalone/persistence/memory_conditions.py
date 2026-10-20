"""条件的当前来源复验，不补造旧资料证据。"""
from typing import Any
from uuid import UUID
from notalone.memory.conditions import MemoryConditions
from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.persistence.correction_evidence import validate_frozen_snapshot

def bind_memory_conditions(connection: Any, *, owner_id: UUID, candidate_id: UUID | None,
                      raw: object, text: str) -> MemoryConditions | None:
    conditions = MemoryConditions.from_payload(raw)
    if conditions is None:
        return None
    row = connection.execute(
        "SELECT * "
        "FROM public.memory_candidate WHERE owner_id=%s AND id=%s",
        (owner_id, candidate_id),
    ).fetchone() if candidate_id is not None else None
    if row is None or row.get("correction_evidence") is None:
        return conditions.with_current_sources(False)
    try:
        from notalone.persistence.memory_correction import candidate_from_row, decision_sources_available
        from notalone.persistence.dimension_evidence import bind_stored_dimension_evidence
        candidate = candidate_from_row(row)
        current = bind_stored_dimension_evidence(connection, candidate)
        validate_frozen_snapshot(connection, owner_id=owner_id, evidence=row["correction_evidence"])
        if (candidate.text != text or candidate.conditions is None or candidate.conditions.to_payload() != conditions.to_payload()
                or current is None or not current.source_bound
                or not decision_sources_available(connection, owner_id=owner_id, evidence=row["correction_evidence"])):
            return conditions.with_current_sources(False)
    except (MemoryCorrectionConflictError, KeyError, TypeError, ValueError):
        return conditions.with_current_sources(False)
    return conditions



def manual_conditions(connection, *, owner_id, previous, proposed, source_ids):
    """缺省保留限定但不复用旧证明；显式空清除，手写限定只保存未核验。"""
    from dataclasses import replace
    value = MemoryConditions.from_payload(previous) if proposed is ... else proposed
    if value is None:
        return None
    if not isinstance(value, MemoryConditions):
        raise ValueError("手动条件无效。")
    refs = tuple(ref for item in value.items for ref in item.evidence)
    if any(ref.message_id not in source_ids for ref in refs):
        raise MemoryCorrectionConflictError("条件位置超出本资料来源。")
    if refs:
        rows = connection.execute("SELECT id,length(text_content) AS length FROM public.message WHERE owner_id=%s AND id=ANY(%s::uuid[])", (owner_id, list({ref.message_id for ref in refs}))).fetchall()
        lengths = {row["id"]: row["length"] for row in rows}
        if any(ref.message_id not in lengths or ref.char_end > lengths[ref.message_id] for ref in refs):
            raise MemoryCorrectionConflictError("条件位置已不可用。")
    return MemoryConditions(tuple(replace(item, source_supported=False) for item in value.items))


def conditions_clear_sql(connection):
    rows = connection.execute("SELECT attname FROM pg_attribute WHERE attrelid='public.memory_candidate'::regclass AND attname IN ('conditions','evolution') AND NOT attisdropped").fetchall()
    names = {row["attname"] if isinstance(row, dict) else row[0] for row in rows}
    return "".join(", " + name + "=NULL" for name in ("conditions", "evolution") if name in names)
