"""变化依据沿原来源世代、父版本与删除事务复验。"""
from dataclasses import replace
from uuid import UUID
from notalone.memory.evolution import MemoryEvolution
from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.persistence.correction_evidence import validate_frozen_snapshot, merge_frozen_snapshot


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


def bind_memory_evolution(connection, *, owner_id, raw, memory_id=None, revision=None):
    value = MemoryEvolution.from_payload(raw)
    if value is not None:
        try:
            validate_evolution(connection, owner_id=owner_id, evolution=value, allow_retired=True)
        except (MemoryCorrectionConflictError, KeyError, TypeError, ValueError):
            value = None
    # 只按已用事实ID+版本检索关联反证，不扫描联系人全部历史。
    if memory_id is not None:
        present = connection.execute("SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.memory_candidate'::regclass AND attname='evolution' AND NOT attisdropped) AS present").fetchone()
        if not (present["present"] if isinstance(present, dict) else present[0]):
            return value
        rows = connection.execute("SELECT evolution FROM public.memory_candidate WHERE owner_id=%s AND status='pending' "
            "AND evolution->>'kind'='unresolved_conflict' AND evolution->'related_versions' @> %s::jsonb ORDER BY created_at DESC LIMIT 8",
            (owner_id, __import__('json').dumps([{"memory_id": str(memory_id), "revision": revision}]))).fetchall()
        for row in rows:
            conflict = MemoryEvolution.from_payload(row["evolution"])
            try:
                validate_evolution(connection, owner_id=owner_id, evolution=conflict)
                return conflict
            except (MemoryCorrectionConflictError, KeyError, TypeError, ValueError):
                continue
    return value


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
