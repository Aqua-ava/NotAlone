"""人工纠错保护：证据身份优先，无法证明不同含义时保守关闭。"""

from __future__ import annotations

from dataclasses import replace
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.memory.dimension_evidence import DimensionEvidence
from notalone.memory.models import (
    AdoptionMethod, FactSubject, MemoryCandidate, MemoryCandidateStatus, MemoryCategory, MemoryTopic,
)
from notalone.memory.correction import CorrectionReview, MemoryCorrectionConflictError
from notalone.memory.events import MemoryEvent
from notalone.memory.evolution import MemoryEvolution
from notalone.memory.conditions import MemoryConditions
from notalone.persistence.message_sources import active_source_ref_sql
from notalone.persistence.correction_evidence import (
    capture_message_snapshot, merge_frozen_snapshot, validate_frozen_snapshot,
)
from notalone.memory_trace.context import current_trace
from notalone.scopes import ContactScope


def has_correction_schema(connection: psycopg.Connection[Any]) -> bool:
    row = connection.execute(
        "SELECT to_regclass('public.memory_correction_decision') IS NOT NULL AS present"
    ).fetchone()
    return bool(row["present"] if isinstance(row, dict) else row[0])


def active_guard_messages(
    connection: psycopg.Connection[Any] | psycopg.Cursor[Any], *, owner_id: UUID,
    contact_id: UUID | None, canonical_ids: list[str],
) -> tuple[UUID, ...]:
    """墓碑只引用当前仍有活动来源的真实规范消息，不恢复旧来源世代。"""
    rows = connection.execute(
        f"""SELECT DISTINCT message.id FROM public.message AS message
        JOIN public.message_source_ref AS ref ON ref.owner_id=message.owner_id
          AND ref.contact_id=message.contact_id AND ref.message_id=message.id
        WHERE message.owner_id=%s AND message.id=ANY(%s::uuid[])
          AND (%s::uuid IS NULL OR message.contact_id=%s)
          AND {active_source_ref_sql()} ORDER BY message.id""",
        (owner_id, canonical_ids, contact_id, contact_id),
    ).fetchall()
    return tuple(row["id"] if isinstance(row, dict) else row[0] for row in rows)


def validate_erased_guard(
    connection: psycopg.Connection[Any] | psycopg.Cursor[Any], decision: dict[str, Any],
    *, require_current: bool = True,
) -> tuple[UUID, ...]:
    evidence = decision["evidence"]
    try:
        if (set(evidence) != {"version", "kind", "canonical_ids"}
                or evidence["version"] != 1 or evidence["kind"] != "erased_guard"
                or not isinstance(evidence["canonical_ids"], list) or not evidence["canonical_ids"]
                or decision["decision"] != "rejected"
                or decision["rejected_text"] is not None or decision["corrected_text"] is not None):
            raise ValueError
        identifiers = tuple(UUID(item) for item in evidence["canonical_ids"])
        if len(set(identifiers)) != len(identifiers):
            raise ValueError
    except (KeyError, ValueError, TypeError, AttributeError):
        raise MemoryCorrectionConflictError("已删除资料的保护元数据结构无效。") from None
    current = active_guard_messages(
        connection, owner_id=decision["owner_id"], contact_id=decision["contact_id"],
        canonical_ids=evidence["canonical_ids"],
    )
    if require_current and set(current) != set(identifiers):
        raise MemoryCorrectionConflictError("已删除资料的规范消息保护已失效。")
    return current


def source_documents_available(
    connection: psycopg.Connection[Any], *, owner_id: UUID, source_ids: list[UUID] | list[str],
) -> bool:
    unavailable = connection.execute(
        "SELECT EXISTS (SELECT 1 FROM public.source_document "
        "WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND status<>'active') AS unavailable",
        (owner_id, source_ids),
    ).fetchone()["unavailable"]
    return not unavailable


def decision_sources_available(
    connection: psycopg.Connection[Any], *, owner_id: UUID, evidence: dict[str, Any],
) -> bool:
    """排队删除即撤下旧比较；正文清除仍由原删除事务完成。"""
    if evidence.get("kind") == "generation_unknown":
        return False
    if not source_documents_available(connection, owner_id=owner_id, source_ids=evidence["source_ids"]):
        return False
    expected = {UUID(ref["ref_id"]) for ref in evidence["source_refs"]}
    rows = connection.execute(
        f"SELECT ref.id FROM public.message_source_ref AS ref "
        f"WHERE ref.owner_id=%s AND ref.id=ANY(%s::uuid[]) AND {active_source_ref_sql()}",
        (owner_id, list(expected)),
    ).fetchall()
    return {row["id"] for row in rows} == expected


def decision_available(connection: psycopg.Connection[Any], *, decision: dict[str, Any]) -> bool:
    """列表与追踪共用当前来源规则；已擦正文的墓碑只检查活动身份。"""
    if decision["evidence"].get("kind") == "erased_guard":
        return bool(validate_erased_guard(connection, decision, require_current=False))
    return decision_sources_available(connection, owner_id=decision["owner_id"], evidence=decision["evidence"])


def trace_sources_available(
    connection: psycopg.Connection[Any], *, owner_id: UUID, trace_id: UUID,
) -> bool:
    """追溯沿完整活动来源检查，失效旧记忆和自然过期不等同来源删除。"""
    dependencies = connection.execute(
        "SELECT source_id FROM public.memory_extraction_trace_dependency WHERE owner_id=%s AND trace_id=%s",
        (owner_id, trace_id),
    ).fetchall()
    if not source_documents_available(
        connection, owner_id=owner_id, source_ids=[row["source_id"] for row in dependencies],
    ):
        return False
    if not has_correction_schema(connection):
        return True
    candidates = connection.execute(
        "SELECT candidate.correction_evidence FROM public.memory_candidate AS candidate "
        "JOIN public.memory_extraction_trace_link AS link ON link.owner_id=candidate.owner_id "
        "AND link.record_kind='candidate' AND link.record_id=candidate.id "
        "WHERE link.owner_id=%s AND link.trace_id=%s",
        (owner_id, trace_id),
    ).fetchall()
    if any(row["correction_evidence"] is not None and not decision_sources_available(
        connection, owner_id=owner_id, evidence=row["correction_evidence"],
    ) for row in candidates):
        return False
    decisions = connection.execute(
        "SELECT DISTINCT decision.* FROM public.memory_correction_decision AS decision "
        "JOIN public.memory_extraction_trace_link AS link ON link.owner_id=decision.owner_id "
        "AND link.record_kind=decision.record_kind "
        "AND (link.record_id=decision.record_id OR link.record_id=decision.replacement_memory_id) "
        "WHERE link.owner_id=%s AND link.trace_id=%s", (owner_id, trace_id),
    ).fetchall()
    for decision in decisions:
        if not decision_available(connection, decision=decision):
            return False
    return True


def available_correction_memories(
    connection: psycopg.Connection[Any], *, owner_id: UUID, record_kind: str,
    rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """完整纠错依据不可用时撤下当前版本，保留删除事务和历史状态。"""
    if not rows or not has_correction_schema(connection):
        return rows
    identifiers = [row["memory_id"] for row in rows]
    decisions = connection.execute(
        "SELECT * FROM public.memory_correction_decision WHERE owner_id=%s AND record_kind=%s "
        "AND (record_id=ANY(%s::uuid[]) OR replacement_memory_id=ANY(%s::uuid[]))",
        (owner_id, record_kind, identifiers, identifiers),
    ).fetchall()
    unavailable = set()
    for decision in decisions:
        if not decision_available(connection, decision=decision):
            unavailable.update((decision["record_id"], decision["replacement_memory_id"]))
    table = "owner_memory" if record_kind == "owner_memory" else "confirmed_memory"
    candidates = connection.execute(
        f"""SELECT memory.id AS memory_id, candidate.correction_evidence
        FROM public.{table} AS memory JOIN public.memory_candidate AS candidate
          ON candidate.owner_id=memory.owner_id AND candidate.id=memory.source_candidate_id
        WHERE memory.owner_id=%s AND memory.id=ANY(%s::uuid[])""",
        (owner_id, identifiers),
    ).fetchall()
    for row in candidates:
        evidence = row["correction_evidence"]
        if evidence is not None and (evidence.get("decision_ids") or evidence.get("has_memory_context")) and not decision_sources_available(
            connection, owner_id=owner_id, evidence=evidence,
        ):
            unavailable.add(row["memory_id"])
    return [row for row in rows if row["memory_id"] not in unavailable]


def capture_evidence(
    connection: psycopg.Connection[Any], *, scope: ContactScope,
    source_ids: tuple[UUID, ...], candidate: MemoryCandidate | None = None,
    validate_generation: bool = True,
) -> dict[str, Any]:
    """保存规范消息身份和实际活动来源世代，不把新增引用当成新消息。"""
    direct_ids = set(source_ids)
    window_ids = set(direct_ids)
    stored_evidence = None
    if candidate is not None:
        stored = connection.execute(
            "SELECT to_jsonb(memory_candidate)->'correction_evidence' AS evidence "
            "FROM public.memory_candidate WHERE owner_id=%s AND contact_id=%s AND id=%s",
            (scope.owner_id, scope.contact_id, candidate.candidate_id),
        ).fetchone()
        stored_evidence = stored["evidence"] if stored else None
        if stored is not None and (stored_evidence is None or stored_evidence.get("kind") == "generation_unknown"
                or "message_snapshots" not in stored_evidence or "message_scopes" not in stored_evidence
                or set(stored_evidence["message_ids"]) != set(stored_evidence["message_snapshots"])
                or set(stored_evidence["message_ids"]) != set(stored_evidence["message_scopes"])):
            return {"version": 1, "kind": "generation_unknown", "direct_message_ids": [],
                    "message_ids": [], "source_ids": [], "source_refs": [], "message_digests": {},
                    "message_snapshots": {}, "message_scopes": {}, "manual_entry": False}
        if stored_evidence is not None:
            window_ids.update(UUID(item) for item in stored_evidence["message_ids"])
    if candidate is not None and candidate.dimension_evidence is not None:
        window_ids.update(item.message_id for item in candidate.dimension_evidence.messages)
    evidence = capture_message_snapshot(
        connection, owner_id=scope.owner_id, contact_id=scope.contact_id,
        message_ids=window_ids, source_ids=source_ids,
    )
    direct_messages = {UUID(ref["message_id"]) for ref in evidence["source_refs"]
                       if UUID(ref["message_id"]) in direct_ids or UUID(ref["source_id"]) in direct_ids}
    if stored_evidence is not None:
        if validate_generation:
            validate_frozen_snapshot(connection, owner_id=scope.owner_id, evidence=stored_evidence)
        merge_frozen_snapshot(evidence, stored_evidence)
        if stored_evidence.get("unknown_memory_context"):
            evidence["unknown_memory_context"] = True
    if validate_generation and candidate is not None and candidate.dimension_evidence is not None:
        original_window = candidate.dimension_evidence.messages
        current_window = capture_message_snapshot(
            connection, owner_id=scope.owner_id, contact_id=scope.contact_id,
            message_ids={item.message_id for item in original_window},
            ref_ids={ref_id for item in original_window for ref_id, _ in item.source_refs},
        )
        for message in candidate.dimension_evidence.messages:
            expected = message.to_payload()
            current = current_window["message_snapshots"].get(str(message.message_id), {})
            known = {key: value for key, value in expected.items()
                     if not (key == "source_state_sha256" and value is None
                             or key == "text_representation" and value == "unknown")}
            known["source_refs"] = sorted(expected["source_refs"], key=lambda ref: ref["ref_id"])
            if any(current.get(key) != value for key, value in known.items()):
                raise MemoryCorrectionConflictError("参与候选的来源世代已变化。")
    dependencies = {UUID(item) for item in evidence["source_ids"]}
    if candidate is not None:
        trace = current_trace()
        trace_id = trace.trace_id if trace is not None and trace.scope == scope else None
        if trace_id is not None:
            trace_row = connection.execute(
                "SELECT status FROM public.memory_extraction_trace WHERE owner_id=%s AND contact_id=%s AND trace_id=%s",
                (scope.owner_id, scope.contact_id, trace_id),
            ).fetchone()
            if trace_row is None or trace_row["status"] != "running":
                raise MemoryCorrectionConflictError("参与提取的来源追踪已不可用。")
        trace_dependencies = connection.execute(
            """SELECT DISTINCT dependency.source_id
            FROM public.memory_extraction_trace_dependency AS dependency
            WHERE dependency.owner_id=%s AND (dependency.trace_id=%s OR EXISTS (
                SELECT 1 FROM public.memory_extraction_trace_link AS link
                WHERE link.owner_id=dependency.owner_id AND link.trace_id=dependency.trace_id
                  AND link.record_kind='candidate' AND link.record_id=%s
            ))""",
            (scope.owner_id, trace_id, candidate.candidate_id),
        ).fetchall()
        dependencies.update(row["source_id"] for row in trace_dependencies)
        from notalone.persistence.memory_context_read import read_dependency_candidates
        dependency_candidates = read_dependency_candidates(connection, scope, dependencies)
        if dependency_candidates:
            evidence["has_memory_context"] = True
        for row in dependency_candidates:
            snapshot = row.get("correction_evidence")
            if snapshot is not None:
                if validate_generation:
                    validate_frozen_snapshot(connection, owner_id=scope.owner_id, evidence=snapshot)
                merge_frozen_snapshot(evidence, snapshot)
                dependencies.update(UUID(item) for item in snapshot["source_ids"])
            elif validate_generation:
                # 新候选自己的窗口可以保存，但缺失旧窗口不能替自动更新补认证。
                evidence["unknown_memory_context"] = True
            raw_dimension = row.get("dimension_evidence")
            if raw_dimension is not None:
                for message in DimensionEvidence.from_payload(raw_dimension).messages:
                    dependencies.add(message.message_id)
                    dependencies.update(source_id for _, source_id in message.source_refs)
        context_decisions = connection.execute(
            "SELECT evidence FROM public.memory_correction_decision WHERE owner_id=%s "
            "AND scope_kind='self' AND replacement_memory_id=ANY(%s::uuid[])",
            (scope.owner_id, list(dependencies)),
        ).fetchall()
        if context_decisions:
            evidence["has_memory_context"] = True
        for row in context_decisions:
            if validate_generation:
                validate_frozen_snapshot(connection, owner_id=scope.owner_id, evidence=row["evidence"])
            merge_frozen_snapshot(evidence, row["evidence"])
            dependencies.update(UUID(item) for item in row["evidence"]["source_ids"])
    evidence.update({
        "direct_message_ids": sorted(str(item) for item in direct_messages),
        "source_ids": sorted(str(item) for item in dependencies),
        "manual_entry": bool(not evidence["message_ids"] and connection.execute(
            "SELECT count(*) AS total FROM public.source_document WHERE owner_id=%s AND contact_id=%s "
            "AND id=ANY(%s) AND source_type='manual' AND status='active'",
            (scope.owner_id, scope.contact_id, list(source_ids)),
        ).fetchone()["total"] == len(set(source_ids))),
    })
    return evidence


def record_decision(
    connection: psycopg.Connection[Any], *, scope: ContactScope | None,
    record_kind: str, record_id: UUID, rejected_text: str | None,
    source_ids: tuple[UUID, ...], corrected_text: str | None = None,
    replacement_memory_id: UUID | None = None,
    candidate: MemoryCandidate | None = None,
    owner_id: UUID | None = None,
    change_kind: str | None = None,
) -> None:
    if not has_correction_schema(connection):
        return
    owner_id = scope.owner_id if scope is not None else owner_id
    if owner_id is None:
        raise ValueError("人工决定必须带用户范围。")
    self_scope = record_kind == "owner_memory" or candidate is not None and candidate.subject is FactSubject.SELF
    if scope is None and candidate is not None:
        scope = candidate.scope
    deleting = rejected_text is None and corrected_text is None
    if deleting:
        canonical_ids = selected_canonical_ids(
            connection, owner_id=owner_id, scope=None if self_scope else scope,
            record_kind=record_kind, record_id=record_id, source_ids=source_ids, candidate=candidate,
        )
        if not canonical_ids:
            return
        evidence = {"version": 1, "kind": "erased_guard", "canonical_ids": canonical_ids}
    elif scope is None:
        evidence = {"version": 1, "direct_message_ids": [], "message_ids": [],
                    "source_ids": [str(item) for item in source_ids], "source_refs": [],
                    "message_digests": {}, "message_snapshots": {}, "message_scopes": {},
                    "manual_entry": source_ids == (owner_id,)}
        scope_rows = connection.execute(
            """SELECT contact_id FROM public.message WHERE owner_id=%s AND id=ANY(%s)
            UNION SELECT contact_id FROM public.source_document WHERE owner_id=%s AND id=ANY(%s)
            UNION SELECT contact_id FROM public.local_wechat_observation WHERE owner_id=%s AND id=ANY(%s)""",
            (owner_id, list(source_ids), owner_id, list(source_ids), owner_id, list(source_ids)),
        ).fetchall()
        for row in scope_rows:
            captured = capture_evidence(connection, scope=ContactScope(owner_id, row["contact_id"]), source_ids=source_ids)
            evidence["direct_message_ids"] = sorted(set(evidence["direct_message_ids"]) | set(captured["direct_message_ids"]))
            merge_frozen_snapshot(evidence, captured)
    else:
        evidence = capture_evidence(connection, scope=scope, source_ids=source_ids, candidate=candidate)
    if record_kind == "candidate" and evidence.get("kind") == "generation_unknown":
        raise MemoryCorrectionConflictError("旧候选的来源快照已清除，不能回填人工否决。")
    if corrected_text is not None and evidence.get("kind") == "generation_unknown":
        evidence = capture_current_decision(
            connection, owner_id=owner_id, scope=scope, record_kind=record_kind,
            record_id=record_id, source_ids=source_ids, candidate=candidate,
        )
    ancestors = connection.execute(
        "SELECT evidence FROM public.memory_correction_decision WHERE owner_id=%s AND replacement_memory_id=%s",
        (owner_id, record_id),
    ).fetchall()
    if not deleting:
        for row in ancestors:
            validate_frozen_snapshot(connection, owner_id=owner_id, evidence=row["evidence"])
            merge_frozen_snapshot(evidence, row["evidence"])
    if change_kind is not None:
        if change_kind not in {"error_correction", "state_changed"}:
            raise ValueError("人工修改原因无效。")
        evidence["change_kind"] = change_kind
    connection.execute(
        """INSERT INTO public.memory_correction_decision
        (id, owner_id, contact_id, scope_kind, record_kind, record_id,
         replacement_memory_id, decision, rejected_text, corrected_text, evidence)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON CONFLICT (owner_id, record_kind, record_id) DO NOTHING""",
        (uuid4(), owner_id, None if self_scope else scope.contact_id,
         "self" if self_scope else "contact", record_kind, record_id,
         replacement_memory_id, "corrected" if corrected_text is not None else "rejected",
         rejected_text, corrected_text, Jsonb(evidence)),
    )
    rows = connection.execute(
        "SELECT * FROM public.memory_candidate WHERE owner_id=%s AND status='pending' AND ("
        "(%s AND (subject='self' OR source_ids && %s::uuid[])) OR (NOT %s AND contact_id=%s))",
        (owner_id, self_scope,
         [UUID(item) for item in set(evidence.get("message_ids", evidence.get("canonical_ids", ())))
          | set(evidence.get("source_ids", ()))],
         self_scope, scope.contact_id if scope is not None else None),
    ).fetchall()
    for row in rows:
        pending = candidate_from_row(row)
        try:
            protected, snapshot = protect_candidate(connection, pending)
        except MemoryCorrectionConflictError:
            # 迟到或失去依据的候选不能阻塞另一有效范围的人工决定，也不补造新世代。
            connection.execute(
                "UPDATE public.memory_candidate SET status='invalidated', "
                "failure_reason='correction:source_changed', updated_at=now() "
                "WHERE owner_id=%s AND contact_id=%s AND id=%s AND status='pending'",
                (pending.scope.owner_id, pending.scope.contact_id, pending.candidate_id),
            )
            continue
        if snapshot is not None:
            persist_protection(connection, protected, snapshot)


def selected_canonical_ids(
    connection: psycopg.Connection[Any], *, owner_id: UUID, scope: ContactScope | None,
    record_kind: str, record_id: UUID, source_ids: tuple[UUID, ...], candidate: MemoryCandidate | None,
) -> list[str]:
    """删除只沿所选版本的已知参与者留墓碑，不验证或恢复旧正文快照。"""
    identifiers = {str(item) for item in source_ids}
    candidate_id = candidate.candidate_id if candidate is not None else record_id
    snapshots = connection.execute(
        "SELECT correction_evidence AS evidence FROM public.memory_candidate WHERE owner_id=%s AND id=%s "
        "UNION ALL SELECT evidence FROM public.memory_correction_decision WHERE owner_id=%s "
        "AND (record_id=%s OR replacement_memory_id=%s)",
        (owner_id, candidate_id, owner_id, record_id, record_id),
    ).fetchall()
    for row in snapshots:
        if row["evidence"] is not None:
            identifiers.update(row["evidence"].get("message_ids", row["evidence"].get("canonical_ids", ())))
    if candidate is not None and candidate.dimension_evidence is not None:
        identifiers.update(str(item.message_id) for item in candidate.dimension_evidence.messages)
    _, messages, _ = selected_trace_members(
        connection, owner_id=owner_id, record_kind=record_kind,
        record_id=record_id, candidate_id=candidate_id,
    )
    identifiers.update(messages)
    return sorted(str(item) for item in active_guard_messages(
        connection, owner_id=owner_id, contact_id=scope.contact_id if scope is not None else None,
        canonical_ids=sorted(identifiers),
    ))


def selected_trace_members(
    connection: psycopg.Connection[Any], *, owner_id: UUID, record_kind: str,
    record_id: UUID, candidate_id: UUID,
) -> tuple[list[dict[str, Any]], set[str], set[UUID]]:
    """只取所选记录真正关联的窗口与依赖；旧 043 window 不补成旧证明。"""
    traces = connection.execute(
        """SELECT DISTINCT trace.trace_id, trace.status FROM public.memory_extraction_trace AS trace
        JOIN public.memory_extraction_trace_link AS link ON link.owner_id=trace.owner_id AND link.trace_id=trace.trace_id
        WHERE link.owner_id=%s AND ((link.record_kind=%s AND link.record_id=%s)
            OR (link.record_kind='candidate' AND link.record_id=%s))""",
        (owner_id, record_kind, record_id, candidate_id),
    ).fetchall()
    trace_ids = [row["trace_id"] for row in traces]
    inputs = connection.execute(
        """SELECT record_id::text AS message_id FROM public.memory_extraction_trace_link
        WHERE owner_id=%s AND trace_id=ANY(%s::uuid[]) AND record_kind='message' AND operation='input'
        UNION SELECT message->>'message_id' FROM public.memory_extraction_trace_event AS event
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(event.payload->'messages')='array'
            THEN event.payload->'messages' ELSE '[]'::jsonb END) AS message
        WHERE event.owner_id=%s AND event.trace_id=ANY(%s::uuid[]) AND event.stage='window'
          AND message->>'message_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'""",
        (owner_id, trace_ids, owner_id, trace_ids),
    ).fetchall()
    dependencies = connection.execute(
        "SELECT source_id FROM public.memory_extraction_trace_dependency WHERE owner_id=%s AND trace_id=ANY(%s::uuid[])",
        (owner_id, trace_ids),
    ).fetchall()
    return traces, {row["message_id"] for row in inputs}, {row["source_id"] for row in dependencies}


def capture_current_decision(
    connection: psycopg.Connection[Any], *, owner_id: UUID, scope: ContactScope,
    record_kind: str, record_id: UUID, source_ids: tuple[UUID, ...], candidate: MemoryCandidate,
    visited: set[UUID] | None = None,
) -> dict[str, Any]:
    """未知旧快照只允许当次人工决定沿精确追踪重新取当前依据，不回填候选。"""
    visited = set() if visited is None else visited
    if candidate.candidate_id in visited:
        raise MemoryCorrectionConflictError("旧资料的参与依赖无法精确展开。")
    visited.add(candidate.candidate_id)
    manual_count = connection.execute(
        "SELECT count(*) AS total FROM public.source_document WHERE owner_id=%s AND contact_id=%s "
        "AND id=ANY(%s::uuid[]) AND source_type='manual' AND status='active'",
        (owner_id, scope.contact_id, list(source_ids)),
    ).fetchone()["total"]
    if source_ids and manual_count == len(set(source_ids)):
        # 明确独立 manual 来源从未依赖提取窗口；这里只记录当次人工决定。
        manual = capture_evidence(connection, scope=scope, source_ids=source_ids)
        manual["kind"] = "current_user_decision"
        return manual
    traces, messages, dependencies = selected_trace_members(
        connection, owner_id=owner_id, record_kind=record_kind,
        record_id=record_id, candidate_id=candidate.candidate_id,
    )
    if not traces or not messages or any(row["status"] == "deleted" for row in traces):
        raise MemoryCorrectionConflictError("旧资料缺少仍可用的精确参与窗口，不能猜测人工纠错依据。")
    dependencies.update(source_ids)
    if not source_documents_available(connection, owner_id=owner_id, source_ids=list(dependencies)):
        raise MemoryCorrectionConflictError("当前人工决定的参与来源正在删除或已不可用。")
    evidence = capture_message_snapshot(
        connection, owner_id=owner_id, contact_id=scope.contact_id,
        message_ids={UUID(item) for item in messages},
    )
    if set(evidence["message_ids"]) != messages:
        raise MemoryCorrectionConflictError("旧资料的参与消息已经失去当前来源。")
    direct = {str(item) for item in source_ids}
    evidence.update({"kind": "current_user_decision", "manual_entry": False,
                     "direct_message_ids": sorted({ref["message_id"] for ref in evidence["source_refs"]
                                                   if ref["message_id"] in direct or ref["source_id"] in direct})})
    contexts = connection.execute(
        """SELECT 'contact_memory' AS record_kind, id, source_candidate_id, source_ids FROM public.confirmed_memory
        WHERE owner_id=%s AND contact_id=%s AND id=ANY(%s::uuid[]) AND status<>'deleted'
        UNION ALL SELECT 'owner_memory', id, source_candidate_id, source_ids FROM public.owner_memory
        WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND status<>'deleted'""",
        (owner_id, scope.contact_id, list(dependencies), owner_id, list(dependencies)),
    ).fetchall()
    for memory in contexts:
        dependencies.update(memory["source_ids"])
        if memory["source_candidate_id"] is None:
            decisions = connection.execute(
                "SELECT evidence FROM public.memory_correction_decision WHERE owner_id=%s AND replacement_memory_id=%s",
                (owner_id, memory["id"]),
            ).fetchall()
            if not decisions and tuple(memory["source_ids"]) != (owner_id,):
                raise MemoryCorrectionConflictError("参与纠错的旧记忆窗口未知。")
            snapshots = [row["evidence"] for row in decisions]
        else:
            old = connection.execute("SELECT * FROM public.memory_candidate WHERE owner_id=%s AND id=%s",
                                     (owner_id, memory["source_candidate_id"])).fetchone()
            if old is None:
                raise MemoryCorrectionConflictError("参与纠错的旧候选已经不可用。")
            snapshot = old["correction_evidence"]
            if snapshot is None or snapshot.get("kind") == "generation_unknown":
                old_candidate = candidate_from_row(old)
                snapshot = capture_current_decision(
                    connection, owner_id=owner_id, scope=old_candidate.scope,
                    record_kind=memory["record_kind"], record_id=memory["id"],
                    source_ids=tuple(memory["source_ids"]), candidate=old_candidate, visited=visited,
                )
            snapshots = [snapshot]
        for snapshot in snapshots:
            validate_frozen_snapshot(connection, owner_id=owner_id, evidence=snapshot)
            merge_frozen_snapshot(evidence, snapshot)
            dependencies.update(UUID(item) for item in snapshot["source_ids"])
    evidence["source_ids"] = sorted(set(evidence["source_ids"]) | {str(item) for item in dependencies})
    if not decision_sources_available(connection, owner_id=owner_id, evidence=evidence):
        raise MemoryCorrectionConflictError("当前人工决定的完整参与来源已经不可用。")
    return evidence


def candidate_from_row(row: dict[str, Any]) -> MemoryCandidate:
    """读取人工操作所需的候选原值，不推导缺失维度依据。"""
    from notalone.persistence.source_dependency import dependency_mode

    raw = row.get("dimension_evidence")
    return MemoryCandidate(
        candidate_id=row["id"], scope=ContactScope(row["owner_id"], row["contact_id"]),
        text=row["text_content"], category=MemoryCategory(row["category"]),
        topic=MemoryTopic(row["topic"]), subject=FactSubject(row["subject"]),
        source_ids=tuple(row["source_ids"]), status=MemoryCandidateStatus(row["status"]),
        confidence=row["confidence"], risk_flags=tuple(row["risk_flags"] or ()),
        alternatives=tuple(row["alternatives"] or ()),
        interpretation_reason=row["interpretation_reason"] or "",
        valid_at=row["valid_at"], invalid_at=row["invalid_at"],
        dimension_evidence=DimensionEvidence.from_payload(raw) if raw is not None else None,
        event=MemoryEvent.from_payload(row.get("event")), conditions=MemoryConditions.from_payload(row.get("conditions")), evolution=MemoryEvolution.from_payload(row.get("evolution")),
        source_dependency_mode=dependency_mode(row.get("source_dependency_mode")),
        requires_all_sources=bool(row.get("requires_all_sources")),
    )


def persist_protection(
    connection: psycopg.Connection[Any], candidate: MemoryCandidate, evidence: dict[str, Any],
) -> None:
    connection.execute(
        """UPDATE public.memory_candidate
        SET correction_evidence=%s, correction_decision_ids=%s,
            status=%s, failure_reason=%s, updated_at=now()
        WHERE owner_id=%s AND contact_id=%s AND id=%s AND status='pending'""",
        (Jsonb(evidence), [UUID(item) for item in evidence.get("decision_ids", ())],
         candidate.status.value, candidate.failure_reason,
         candidate.scope.owner_id, candidate.scope.contact_id, candidate.candidate_id),
    )


def require_reviewed_decisions(
    candidate: MemoryCandidate, adoption_method: AdoptionMethod,
    expected_decision_ids: tuple[UUID, ...] | None,
) -> None:
    """在提交事务核对人工确认时看到的决定集合。"""
    current = {review.decision_id for review in candidate.correction_review}
    if candidate.failure_reason == "correction:old_evidence" or (
        candidate.failure_reason == "version:original_window_unknown" and adoption_method is AdoptionMethod.AUTO
    ) or (
        current and adoption_method is AdoptionMethod.AUTO
    ) or (
        current and expected_decision_ids is None
    ) or (
        expected_decision_ids is not None and set(expected_decision_ids) != current
    ):
        raise MemoryCorrectionConflictError("人工决定已变化，请重新查看对照后确认。")


def protect_candidate(
    connection: psycopg.Connection[Any], candidate: MemoryCandidate,
    *, validate_generation: bool = True,
) -> tuple[MemoryCandidate, dict[str, Any] | None]:
    if not has_correction_schema(connection):
        return candidate, None
    evidence = capture_evidence(
        connection, scope=candidate.scope, source_ids=candidate.source_ids, candidate=candidate,
        validate_generation=validate_generation,
    )
    if evidence.get("kind") == "generation_unknown":
        if validate_generation:
            raise MemoryCorrectionConflictError("旧候选的来源快照已清除，不能回填复用。")
        return replace(candidate, status=(MemoryCandidateStatus.INVALIDATED
                       if candidate.status is MemoryCandidateStatus.PENDING else candidate.status),
                       failure_reason="correction:generation_unknown", correction_review=()), evidence
    if evidence.get("has_memory_context") and not decision_sources_available(
        connection, owner_id=candidate.scope.owner_id, evidence=evidence,
    ):
        if validate_generation:
            raise MemoryCorrectionConflictError("参与提取的旧记忆来源正在删除或已不可用。")
        return replace(candidate, status=(MemoryCandidateStatus.INVALIDATED
                       if candidate.status is MemoryCandidateStatus.PENDING else candidate.status),
                       failure_reason="correction:deleted_source", correction_review=()), evidence
    # 主动录入沿现有 manual 来源通道，仍由用户本人决定；不伪装成提取的新证据。
    if evidence["manual_entry"] and candidate.dimension_evidence is None:
        return candidate, evidence
    direct = set(evidence["direct_message_ids"])
    decisions = connection.execute(
        "SELECT id, owner_id, contact_id, scope_kind, evidence, decision, rejected_text, corrected_text "
        "FROM public.memory_correction_decision "
        "WHERE owner_id=%s AND (contact_id=%s OR (scope_kind='self' AND ("
        "%s OR evidence->'message_ids' ?| %s::text[] OR evidence->'canonical_ids' ?| %s::text[]))) "
        "ORDER BY created_at, id",
        (candidate.scope.owner_id, candidate.scope.contact_id, candidate.subject is FactSubject.SELF,
         sorted(direct), sorted(direct)),
    ).fetchall()
    reviews = []
    decision_ids = []
    dependencies = set(evidence["source_ids"])
    for decision in decisions:
        previous = decision["evidence"]
        erased_guard = previous.get("kind") == "erased_guard"
        old = ({str(item) for item in validate_erased_guard(
            connection, decision, require_current=validate_generation,
        )}
               if erased_guard else set(previous["message_ids"]))
        if not (
            decision["contact_id"] == candidate.scope.contact_id
            or decision["scope_kind"] == "self" and candidate.subject is FactSubject.SELF
            or direct & old
        ):
            continue
        available = bool(old) if erased_guard else decision_sources_available(
            connection, owner_id=candidate.scope.owner_id, evidence=previous,
        )
        if not available:
            if validate_generation:
                raise MemoryCorrectionConflictError("人工决定的参与来源正在删除或已不可用。")
            return replace(candidate, status=(MemoryCandidateStatus.INVALIDATED
                           if candidate.status is MemoryCandidateStatus.PENDING else candidate.status),
                           failure_reason="correction:deleted_source", correction_review=()), evidence
        if not erased_guard:
            if validate_generation:
                validate_frozen_snapshot(connection, owner_id=candidate.scope.owner_id, evidence=previous)
            merge_frozen_snapshot(evidence, previous)
        decision_ids.append(str(decision["id"]))
        previous_sources = old if erased_guard else set(previous["source_ids"])
        dependencies.update(previous_sources)
        evidence["decision_ids"] = decision_ids
        evidence["source_ids"] = sorted(dependencies)
        same_sources = set(evidence["source_ids"]) <= previous_sources
        if direct and direct <= old or not direct and same_sources:
            # 未取得可靠的不同含义证明，旧证据不发布；分类和主题不构成语义证明。
            return replace(candidate, status=(MemoryCandidateStatus.INVALIDATED
                           if candidate.status is MemoryCandidateStatus.PENDING else candidate.status),
                           failure_reason="correction:old_evidence"), evidence
        new_messages = direct - old
        if not new_messages:
            return replace(candidate, status=(MemoryCandidateStatus.INVALIDATED
                           if candidate.status is MemoryCandidateStatus.PENDING else candidate.status),
                           failure_reason="correction:old_evidence"), evidence
        new_sources = {ref["source_id"] for ref in evidence["source_refs"]
                       if ref["message_id"] in new_messages}
        reviews.append(CorrectionReview(
            decision_id=decision["id"], decision=decision["decision"],
            previous_text=(decision["rejected_text"] or "原资料已删除；旧证据上的人工否决继续有效。"),
            corrected_text=decision["corrected_text"],
            new_message_ids=tuple(UUID(item) for item in sorted(new_messages)),
            new_source_ids=tuple(UUID(item) for item in sorted(new_sources)),
            semantic_relation=("same" if "".join(candidate.text.split()).lower()
                               == "".join((decision["rejected_text"] or "").split()).lower()
                               else "uncertain"),
        ))
    evidence["decision_ids"] = decision_ids
    evidence["source_ids"] = sorted(dependencies)
    return replace(candidate, correction_review=tuple(reviews), failure_reason=(
        candidate.failure_reason or ("version:original_window_unknown" if evidence.get("unknown_memory_context") else None)
    )), evidence


def erase_deleted_memory_bodies(
    connection: psycopg.Connection[Any], *, owner_id: UUID,
    record_kind: str, memory_id: UUID,
) -> None:
    """保留无正文版本墓碑与证据保护；删除不提供旧记忆恢复入口。"""
    if not has_correction_schema(connection):
        return
    if record_kind not in {"contact_memory", "owner_memory"}:
        raise ValueError("记忆删除范围无效。")
    table = "confirmed_memory" if record_kind == "contact_memory" else "owner_memory"
    rows = connection.execute(
        f"""WITH RECURSIVE versions AS (
            SELECT id, supersedes_memory_id, source_candidate_id, to_jsonb({table})->'merge_parent_ids' AS merge_parents FROM public.{table}
            WHERE owner_id=%s AND id=%s
            UNION SELECT memory.id, memory.supersedes_memory_id, memory.source_candidate_id, to_jsonb(memory)->'merge_parent_ids'
            FROM public.{table} AS memory JOIN versions
              ON memory.id=versions.supersedes_memory_id OR memory.supersedes_memory_id=versions.id
              OR versions.merge_parents ? memory.id::text OR to_jsonb(memory)->'merge_parent_ids' ? versions.id::text
            WHERE memory.owner_id=%s
        ) SELECT id, source_candidate_id FROM versions""",
        (owner_id, memory_id, owner_id),
    ).fetchall()
    memory_ids = [row["id"] for row in rows]
    candidate_ids = [row["source_candidate_id"] for row in rows if row["source_candidate_id"] is not None]
    erase_correction_dependencies(
        connection, owner_id=owner_id, removed_ids=set(memory_ids + candidate_ids), record_deletion=True,
        preserved_record_ids=set(memory_ids + candidate_ids),
    )
    from notalone.persistence.extraction_trace import erase_record_traces, erase_source_traces
    from notalone.persistence.reply_cleanup import delete_source_replies
    for row in rows:
        erase_record_traces(connection, owner_id=owner_id, record_kind=record_kind, record_id=row["id"])
    erase_source_traces(connection, owner_id=owner_id, removed_ids=set(memory_ids + candidate_ids))
    contacts = connection.execute(
        "SELECT DISTINCT contact_id FROM public.memory_candidate WHERE owner_id=%s AND id=ANY(%s::uuid[])",
        (owner_id, candidate_ids),
    ).fetchall()
    if record_kind == "contact_memory":
        contacts = connection.execute(
            "SELECT DISTINCT contact_id FROM public.confirmed_memory WHERE owner_id=%s AND id=ANY(%s::uuid[])",
            (owner_id, memory_ids),
        ).fetchall()
    for contact in contacts:
        connection.execute(
            "UPDATE public.contact_memory_index SET topics='[]'::jsonb, status='stale', updated_at=now() "
            "WHERE owner_id=%s AND contact_id=%s", (owner_id, contact["contact_id"]),
        )
        delete_source_replies(connection, owner_id=owner_id, contact_id=contact["contact_id"],
                              removed_ids=set(memory_ids + candidate_ids), revoke_running_scope=False)
    if record_kind == "owner_memory":
        delete_source_replies(connection, owner_id=owner_id, contact_id=None,
                              removed_ids=set(memory_ids + candidate_ids), revoke_running_scope=False)
    decisions = connection.execute(
        """SELECT * FROM public.memory_correction_decision
        WHERE owner_id=%s AND (record_id=ANY(%s::uuid[]) OR replacement_memory_id=ANY(%s::uuid[]))""",
        (owner_id, memory_ids + candidate_ids, memory_ids),
    ).fetchall()
    for decision in decisions:
        erase_decision_body(connection, decision)
    from notalone.persistence.memory_events import has_event_schema
    from notalone.persistence.memory_conditions import conditions_clear_sql
    clear_conditions = conditions_clear_sql(connection)
    memory_event_fields = (", event=NULL, version_evidence=NULL" if has_event_schema(connection) else "") + clear_conditions
    candidate_event_fields = (", event=NULL" if has_event_schema(connection) else "") + clear_conditions
    connection.execute(
        f"UPDATE public.{table} SET text_content='已删除的资料', status='deleted', risk_flags='{{}}'::text[], "
        f"updated_at=now(){memory_event_fields} WHERE owner_id=%s AND id=ANY(%s::uuid[])",
        (owner_id, memory_ids),
    )
    connection.execute(
        f"""UPDATE public.memory_candidate SET text_content='已删除的资料', status='rejected',
        interpretation_reason='', alternatives='{{}}'::text[], risk_flags='{{}}'::text[],
        failure_reason=NULL, dimension_evidence=NULL, correction_evidence=NULL,
        correction_decision_ids=NULL, updated_at=now(){candidate_event_fields}
        WHERE owner_id=%s AND id=ANY(%s::uuid[])""", (owner_id, candidate_ids),
    )


def erase_decision_body(
    connection: psycopg.Connection[Any] | psycopg.Cursor[Any], decision: dict[str, Any],
) -> None:
    """删除正文和来源快照，仅保留当前活动规范消息上的无正文保护。"""
    if decision["evidence"].get("kind") == "erased_guard":
        retained = validate_erased_guard(connection, decision, require_current=False)
    else:
        retained = active_guard_messages(
            connection, owner_id=decision["owner_id"], contact_id=decision["contact_id"],
            canonical_ids=decision["evidence"]["message_ids"],
        )
    if retained:
        connection.execute(
            """UPDATE public.memory_correction_decision
            SET decision='rejected', rejected_text=NULL, corrected_text=NULL,
                replacement_memory_id=NULL, evidence=%s WHERE owner_id=%s AND id=%s""",
            (Jsonb({"version": 1, "kind": "erased_guard",
                    "canonical_ids": sorted(str(item) for item in retained)}),
             decision["owner_id"], decision["id"]),
        )
    else:
        connection.execute(
            "DELETE FROM public.memory_correction_decision WHERE owner_id=%s AND id=%s",
            (decision["owner_id"], decision["id"]),
        )


def erase_correction_dependencies(
    connection: psycopg.Connection[Any], *, owner_id: UUID, removed_ids: set[UUID],
    record_deletion: bool = False,
    preserved_record_ids: set[UUID] | frozenset[UUID] = frozenset(),
) -> None:
    """清除人工决定正文及受其影响的差异副本；共享消息不能恢复旧比较。"""
    from notalone.persistence.memory_upgrade import erase_memory_upgrades
    erase_memory_upgrades(connection, owner_id=owner_id, removed_ids=removed_ids)
    if not has_correction_schema(connection):
        return
    removed = [str(item) for item in removed_ids]
    with connection.cursor(row_factory=dict_row) as cursor:
        candidates = cursor.execute(
            """SELECT id, contact_id FROM public.memory_candidate WHERE owner_id=%s
            AND correction_evidence->'source_ids' ?| %s::text[]
            AND (%s OR jsonb_array_length(COALESCE(correction_evidence->'decision_ids','[]'::jsonb)) > 0
                 OR correction_evidence->>'has_memory_context'='true')""",
            (owner_id, removed, record_deletion),
        ).fetchall()
        decisions = cursor.execute(
            """SELECT *
            FROM public.memory_correction_decision WHERE owner_id=%s
            AND evidence->'source_ids' ?| %s::text[]""",
            (owner_id, removed),
        ).fetchall()
        candidate_ids = {row["id"] for row in candidates}
        candidate_ids.update(row["record_id"] for row in decisions if row["record_kind"] == "candidate")
        contact_seed = {row["record_id"] for row in decisions if row["record_kind"] == "contact_memory"}
        contact_seed.update(row["replacement_memory_id"] for row in decisions
                            if row["record_kind"] == "contact_memory" and row["replacement_memory_id"])
        contact_rows = cursor.execute(
            """WITH RECURSIVE affected(id) AS (
                SELECT id FROM public.confirmed_memory WHERE owner_id=%s
                  AND (id=ANY(%s::uuid[]) OR source_candidate_id=ANY(%s::uuid[]))
                UNION SELECT memory.id FROM public.confirmed_memory AS memory
                JOIN affected ON memory.supersedes_memory_id=affected.id OR to_jsonb(memory)->'merge_parent_ids' ? affected.id::text
                WHERE memory.owner_id=%s
            ) SELECT id, contact_id, source_candidate_id FROM public.confirmed_memory
              WHERE owner_id=%s AND id IN (SELECT id FROM affected)""",
            (owner_id, list(contact_seed), list(candidate_ids), owner_id, owner_id),
        ).fetchall()
        owner_seed = {row["record_id"] for row in decisions if row["record_kind"] == "owner_memory"}
        owner_seed.update(row["replacement_memory_id"] for row in decisions
                          if row["record_kind"] == "owner_memory" and row["replacement_memory_id"])
        owner_rows = cursor.execute(
            """WITH RECURSIVE affected(id) AS (
                SELECT id FROM public.owner_memory WHERE owner_id=%s
                  AND (id=ANY(%s::uuid[]) OR source_candidate_id=ANY(%s::uuid[]))
                UNION SELECT memory.id FROM public.owner_memory AS memory
                JOIN affected ON memory.supersedes_memory_id=affected.id OR to_jsonb(memory)->'merge_parent_ids' ? affected.id::text
                WHERE memory.owner_id=%s
            ) SELECT id, source_candidate_id FROM public.owner_memory WHERE owner_id=%s
              AND id IN (SELECT id FROM affected)""",
            (owner_id, list(owner_seed), list(candidate_ids), owner_id, owner_id),
        ).fetchall()
        candidate_ids.update(row["source_candidate_id"] for row in (*contact_rows, *owner_rows) if row["source_candidate_id"] is not None)
        cursor.execute(
            "UPDATE public.memory_candidate SET correction_evidence=%s, correction_decision_ids=NULL, updated_at=now() "
            "WHERE owner_id=%s AND correction_evidence->'source_ids' ?| %s::text[] "
            "AND NOT id=ANY(%s::uuid[])",
            (Jsonb({"version": 1, "kind": "generation_unknown"}), owner_id, removed, list(candidate_ids)),
        )
    from notalone.persistence.extraction_trace import erase_source_traces
    from notalone.persistence.reply_cleanup import delete_source_replies
    affected_ids = candidate_ids | {row["id"] for row in (*contact_rows, *owner_rows)}
    erase_source_traces(connection, owner_id=owner_id, removed_ids=affected_ids)
    contacts = {row["contact_id"] for row in (*candidates, *contact_rows)}
    if owner_rows:
        with connection.cursor(row_factory=dict_row) as cursor:
            running = cursor.execute(
                "SELECT DISTINCT contact_id FROM public.reply_request WHERE owner_id=%s AND state='running'",
                (owner_id,),
            ).fetchall()
        contacts.update(row["contact_id"] for row in running)
    for contact_id in contacts:
        delete_source_replies(connection, owner_id=owner_id, contact_id=contact_id,
                              removed_ids=affected_ids)
        connection.execute(
            "UPDATE public.contact_memory_index SET topics='[]'::jsonb, status='stale', updated_at=now() WHERE owner_id=%s AND contact_id=%s",
            (owner_id, contact_id),
        )
        connection.execute(
            "INSERT INTO public.contact_memory_state (owner_id,contact_id,memory_revision) VALUES (%s,%s,1) "
            "ON CONFLICT (owner_id,contact_id) DO UPDATE SET memory_revision=contact_memory_state.memory_revision+1,updated_at=now()",
            (owner_id, contact_id),
        )
    if owner_rows:
        delete_source_replies(connection, owner_id=owner_id, contact_id=None,
                              removed_ids=affected_ids, revoke_running_scope=False)
    contact_ids = [row["id"] for row in contact_rows if row["id"] not in preserved_record_ids]
    connection.execute(
        "UPDATE public.confirmed_memory SET supersedes_memory_id=NULL "
        "WHERE owner_id=%s AND supersedes_memory_id=ANY(%s::uuid[])",
        (owner_id, contact_ids),
    )
    connection.execute("DELETE FROM public.confirmed_memory WHERE owner_id=%s AND id=ANY(%s::uuid[])",
                       (owner_id, contact_ids))
    connection.execute("DELETE FROM public.owner_memory WHERE owner_id=%s AND id=ANY(%s::uuid[])",
                       (owner_id, [row["id"] for row in owner_rows if row["id"] not in preserved_record_ids]))
    connection.execute("DELETE FROM public.memory_candidate WHERE owner_id=%s AND id=ANY(%s::uuid[])",
                       (owner_id, list(candidate_ids - preserved_record_ids)))
    with connection.cursor(row_factory=dict_row) as cursor:
        tombstones = cursor.execute(
            "SELECT * FROM public.memory_correction_decision WHERE owner_id=%s AND evidence->>'kind'='erased_guard'",
            (owner_id,),
        ).fetchall()
        for decision in (*decisions, *tombstones):
            erase_decision_body(cursor, decision)


def has_correction_dependencies(
    connection: psycopg.Connection[Any], *, owner_id: UUID, source_id: UUID,
) -> bool:
    """来源删除复验也核对跨联系人决定与比较，旧 schema 仍可读取。"""
    if not has_correction_schema(connection):
        return False
    with connection.cursor(row_factory=dict_row) as cursor:
        tombstones = cursor.execute(
            "SELECT * FROM public.memory_correction_decision WHERE owner_id=%s AND evidence->>'kind'='erased_guard'",
            (owner_id,),
        ).fetchall()
        try:
            for decision in tombstones:
                validate_erased_guard(cursor, decision)
        except MemoryCorrectionConflictError:
            return True
    row = connection.execute(
        """SELECT EXISTS (
            SELECT 1 FROM public.memory_correction_decision WHERE owner_id=%s AND evidence->'source_ids' ? %s
            UNION SELECT 1 FROM public.memory_candidate WHERE owner_id=%s AND correction_evidence->'source_ids' ? %s
        ) AS present""",
        (owner_id, str(source_id), owner_id, str(source_id)),
    ).fetchone()
    return bool(row["present"] if isinstance(row, dict) else row[0])
