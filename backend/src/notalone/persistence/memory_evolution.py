"""变化依据沿原来源世代、父版本与删除事务复验。"""
from dataclasses import replace
from collections.abc import Mapping, Sequence
from uuid import UUID

from notalone.memory.evolution import MemoryEvolution
from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.persistence.correction_evidence import validate_frozen_snapshot, merge_frozen_snapshot
from notalone.persistence.schema_capabilities import schema_capability


def validate_evolution(connection, *, owner_id, evolution, candidate=None, allow_retired=False, lock=False):
    if evolution is None:
        return
    proof = evolution.proof
    if not isinstance(proof, dict) or proof.get("sources") is None or proof.get("scope", {}).get("owner_id") != str(owner_id):
        raise MemoryCorrectionConflictError("变化依据未知。")
    from notalone.memory.evidence_binding import candidate_digest
    from notalone.persistence.memory_versions import raw_memory, version_record_digest
    if candidate is not None and (proof["candidate_sha256"] != candidate_digest(candidate)
                                 or str(candidate.scope.contact_id) != proof["scope"]["contact_id"]):
        raise MemoryCorrectionConflictError("变化候选身份已改变。")
    validate_frozen_snapshot(connection, owner_id=owner_id, evidence=proof["sources"])
    if set(proof["sources"]["message_scopes"].values()) != {proof["scope"]["contact_id"]}:
        raise MemoryCorrectionConflictError("变化来源超出联系人范围。")
    related = {str(identifier) for identifier, _ in evolution.related_versions}
    for parent in proof["parents"]:
        if parent["memory_id"] not in related:
            continue
        table = "owner_memory" if parent["subject"] == "self" else "confirmed_memory"
        row = connection.execute(f"SELECT * FROM public.{table} WHERE owner_id=%s AND id=%s" + (" FOR SHARE" if lock else ""), (owner_id, parent["memory_id"])).fetchone()
        if row is None or row["status"] == "deleted" or table == "confirmed_memory" and str(row["contact_id"]) != proof["scope"]["contact_id"]:
            raise MemoryCorrectionConflictError("关联版本已删除或越界。")
        if not allow_retired and (row["status"] != "active" or row["revision"] != parent["revision"]):
            raise MemoryCorrectionConflictError("关联版本已变化。")
        if allow_retired and row["revision"] not in {parent["revision"], parent["revision"] + 1}:
            raise MemoryCorrectionConflictError("关联版本已变化。")
        actual = raw_memory(row)
        if version_record_digest(actual, revision=parent["revision"], invalid_at=parent["invalid_at"]) != parent["record_sha256"]:
            raise MemoryCorrectionConflictError("关联版本内容已变化。")


def evolution_snapshot(connection, candidate, correction_evidence):
    if candidate.evolution is None:
        return correction_evidence
    validate_evolution(connection, owner_id=candidate.scope.owner_id, evolution=candidate.evolution, candidate=candidate, lock=True)
    if correction_evidence is None:
        correction_evidence = dict(candidate.evolution.proof["sources"])
    else:
        merge_frozen_snapshot(correction_evidence, candidate.evolution.proof["sources"])
    return correction_evidence


def _evolution_column_present(connection) -> bool:
    def probe() -> bool:
        present = connection.execute(
            "SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.memory_candidate'::regclass "
            "AND attname='evolution' AND NOT attisdropped) AS present",
        ).fetchone()
        return bool(present["present"] if isinstance(present, dict) else present[0])

    return schema_capability(connection, "memory_candidate.evolution", probe)


def _related_conflict_rows(connection, *, owner_id, memory_ids) -> list[dict]:
    """一次取回本批记忆关联的反证候选，保持既有 created_at 倒序。"""
    identifiers = [str(identifier) for identifier in dict.fromkeys(memory_ids)]
    if not identifiers:
        return []
    return connection.execute(
        "SELECT candidate.created_at, candidate.evolution FROM public.memory_candidate AS candidate "
        "WHERE candidate.owner_id=%s AND candidate.status='pending' "
        "AND candidate.evolution->>'kind'='unresolved_conflict' "
        "AND EXISTS (SELECT 1 FROM jsonb_array_elements(candidate.evolution->'related_versions') AS related "
        "            WHERE related->>'memory_id' = ANY(%s)) "
        "ORDER BY candidate.created_at DESC",
        (owner_id, identifiers),
    ).fetchall()


def _conflict_matches(payload, memory_id, revision) -> bool:
    """等价于 related_versions @> [{memory_id, revision}] 的当前记录匹配。"""
    related = payload.get("related_versions") if isinstance(payload, dict) else None
    if not isinstance(related, list):
        return False
    return any(
        isinstance(item, dict)
        and item.get("memory_id") == str(memory_id)
        and item.get("revision") == revision
        for item in related
    )


def bind_memory_evolutions(connection, rows: Sequence[Mapping]) -> list[MemoryEvolution | None]:
    """按批绑定变化依据：列探针与本批反证候选各一次查询，逐行只做内存关联。

    单行语义与 `bind_memory_evolution` 相同：先复验本行存储的变化依据，
    再按已用事实ID+版本找待处理反证并返回首个可复验投影。
    """
    values: list[MemoryEvolution | None] = []
    for row in rows:
        value = MemoryEvolution.from_payload(row.get("memory_evolution"))
        if value is not None:
            try:
                validate_evolution(connection, owner_id=row["owner_id"], evolution=value, allow_retired=True)
            except (MemoryCorrectionConflictError, KeyError, TypeError, ValueError):
                value = None
        values.append(value)
    pending = [(index, row) for index, row in enumerate(rows) if row.get("memory_id") is not None]
    if not pending or not _evolution_column_present(connection):
        return values
    by_owner: dict[UUID, list[tuple[int, Mapping]]] = {}
    for index, row in pending:
        by_owner.setdefault(row["owner_id"], []).append((index, row))
    for owner_id, owner_rows in by_owner.items():
        conflicts = _related_conflict_rows(
            connection, owner_id=owner_id, memory_ids=[row["memory_id"] for _, row in owner_rows],
        )
        for index, row in owner_rows:
            matched = 0
            for conflict_row in conflicts:
                if not _conflict_matches(conflict_row["evolution"], row["memory_id"], row["revision"]):
                    continue
                matched += 1
                if matched > 8:  # 对齐原查询的 LIMIT 8
                    break
                conflict = MemoryEvolution.from_payload(conflict_row["evolution"])
                try:
                    validate_evolution(connection, owner_id=owner_id, evolution=conflict)
                except (MemoryCorrectionConflictError, KeyError, TypeError, ValueError):
                    continue
                values[index] = conflict.as_projection(values[index])
                break
    return values


def bind_memory_evolution(connection, *, owner_id, raw, memory_id=None, revision=None):
    rows = [{
        "owner_id": owner_id, "memory_evolution": raw,
        "memory_id": memory_id, "revision": revision,
    }]
    return bind_memory_evolutions(connection, rows)[0]


def require_replacement_evolution(connection, candidate, parents, *, merge=False):
    """提交事务再次运行关系门，不能通过直接存储调用绕过裁决。"""
    from types import SimpleNamespace
    from notalone.memory_extraction.adjudication import AdjudicationAction, AdjudicationDecision
    from notalone.memory_extraction.timeline import replacement_supported
    decision = AdjudicationDecision(AdjudicationAction.MERGE if merge else AdjudicationAction.UPDATE,
        replaced_memory_id=None if merge else parents[0].memory_id,
        merged_memory_ids=tuple(parent.memory_id for parent in parents) if merge else (), evolution=candidate.evolution)
    if not replacement_supported(candidate, [SimpleNamespace(memory_id=parent.memory_id, version=parent) for parent in parents], decision):
        raise MemoryCorrectionConflictError("缺少可复验的新旧关系依据，自动替代未应用。")
    validate_evolution(connection, owner_id=candidate.scope.owner_id, evolution=candidate.evolution, candidate=candidate, lock=True)
