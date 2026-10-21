"""只在已验证范围内读取记忆版本链。"""

from typing import Any
from copy import deepcopy
from dataclasses import replace
from datetime import datetime
import hashlib
import json
from uuid import UUID

from psycopg import sql

from notalone.memory.versions import MemoryVersionConflict
from notalone.memory.version_evidence import VersionEvidence
from notalone.memory.events import MemoryEvent
from notalone.memory.evolution import MemoryEvolution
from notalone.memory.conditions import MemoryConditions
from notalone.persistence.memory_conditions import conditions_clear_sql
from notalone.memory.models import AdoptionMethod, ConfirmedMemory, ConfirmedMemoryStatus, MemoryCategory, MemoryTopic, OwnerMemory, SourceDependencyMode
from notalone.memory.dimension_evidence import DimensionEvidence
from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.persistence.correction_evidence import validate_frozen_snapshot
from notalone.persistence.memory_correction import decision_sources_available
from notalone.scopes import ContactScope
from notalone.persistence.source_dependency import dependency_mode


def version_record_digest(memory: ConfirmedMemory | OwnerMemory, *, revision: int | None = None,
                          invalid_at: object = ..., current_projection: bool = False) -> str:
    """绑定实际版本完整采纳字段；正文只保留摘要。"""
    body = {"memory_id": str(memory.memory_id), "owner_id": str(memory.scope.owner_id
            if isinstance(memory, ConfirmedMemory) else memory.owner_id),
            "contact_id": str(memory.scope.contact_id) if isinstance(memory, ConfirmedMemory) else None,
            "text_sha256": hashlib.sha256(memory.text.encode()).hexdigest(),
            "category": memory.category.value, "topic": memory.topic.value,
            "source_ids": sorted(str(item) for item in memory.source_ids),
            "source_candidate_id": str(memory.source_candidate_id) if memory.source_candidate_id else None,
            "adoption_method": memory.adoption_method.value,
            "revision": memory.revision if revision is None else revision,
            "valid_at": memory.valid_at.isoformat() if memory.valid_at else None,
            "invalid_at": (memory.invalid_at.isoformat() if memory.invalid_at else None)
                          if invalid_at is ... else invalid_at,
            "confidence": memory.confidence, "risk_flags": list(memory.risk_flags),
            "supersedes_memory_id": str(memory.supersedes_memory_id) if memory.supersedes_memory_id else None,
            "event": memory.event.to_payload() if memory.event else None}
    evolution = memory.evolution
    if evolution is not None and evolution.projected and not current_projection:
        evolution = evolution.stored_evolution
    if evolution is not None:
        body["evolution"] = evolution.to_payload(include_proof=True)
    if memory.conditions is not None:
        body["conditions"] = memory.conditions.to_payload()
    if memory.requires_all_sources:
        body["requires_all_sources"] = True
    if memory.source_dependency_mode is SourceDependencyMode.ALL:
        body["source_dependency_mode"] = "all"
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def original_candidate_window(connection: Any, *, owner_id: UUID, candidate_id: UUID | None) -> dict | None:
    """仅组合原来已保存的DIM有序窗口与冻结世代，绝不捕获当前值回填。"""
    if candidate_id is None:
        return None
    row = connection.execute(
        "SELECT to_jsonb(memory_candidate)->'dimension_evidence' AS dimension, "
        "to_jsonb(memory_candidate)->'correction_evidence' AS frozen FROM public.memory_candidate "
        "WHERE owner_id=%s AND id=%s", (owner_id, candidate_id),
    ).fetchone()
    if row is None or row["dimension"] is None or row["frozen"] is None:
        return None
    try:
        dimension = DimensionEvidence.from_payload(row["dimension"])
        frozen = row["frozen"]
        ordered = [str(item.message_id) for item in dimension.messages]
        identifiers = set(ordered)
        if frozen.get("kind") == "generation_unknown" or not identifiers <= set(frozen["message_ids"]):
            return None
        refs = [ref for ref in frozen["source_refs"] if ref["message_id"] in identifiers]
        window = {"version": 1, "ordered_message_ids": ordered, "message_ids": sorted(identifiers),
                  "source_ids": sorted(identifiers | {ref["source_id"] for ref in refs}),
                  "source_refs": refs,
                  **{key: {identifier: frozen[key][identifier] for identifier in identifiers}
                     for key in ("message_digests", "message_snapshots", "message_scopes")}}
        # 与原DIM逐字段一致才是原来的窗口，不用存储中较新的值补旧证明。
        if any(message.to_payload() != window["message_snapshots"][str(message.message_id)]
               for message in dimension.messages):
            return None
        return deepcopy(window)
    except (KeyError, TypeError, ValueError):
        return None


def create_version_evidence(connection: Any, *, previous: ConfirmedMemory | OwnerMemory,
                            current: ConfirmedMemory | OwnerMemory) -> VersionEvidence:
    owner_id = previous.scope.owner_id if isinstance(previous, ConfirmedMemory) else previous.owner_id
    return VersionEvidence(
        {"memory_id": str(previous.memory_id), "revision": previous.revision,
         "adoption_method": previous.adoption_method.value,
         "valid_at": previous.valid_at.isoformat() if previous.valid_at else None,
         "invalid_at": previous.invalid_at.isoformat() if previous.invalid_at else None,
         "record_sha256": version_record_digest(previous)},
        {"memory_id": str(current.memory_id), "revision": current.revision,
         "record_sha256": version_record_digest(current)},
        original_candidate_window(connection, owner_id=owner_id, candidate_id=previous.source_candidate_id),
        original_candidate_window(connection, owner_id=owner_id, candidate_id=current.source_candidate_id),
    )


def validate_version_sources(connection: Any, *, owner_id: UUID, evidence: VersionEvidence) -> None:
    if evidence.previous_window is None or evidence.current_window is None:
        raise MemoryVersionConflict("原始版本窗口未知，不能自动替代或恢复。")
    for window in (evidence.previous_window, evidence.current_window):
        validate_frozen_snapshot(connection, owner_id=owner_id, evidence=window)
        if not decision_sources_available(connection, owner_id=owner_id, evidence=window):
            raise MemoryVersionConflict("版本依据已变化，不能自动替代或恢复。")


def raw_memory(row: dict) -> ConfirmedMemory | OwnerMemory:
    fields = dict(memory_id=row["id"], text=row["text_content"],
                  category=MemoryCategory(row["category"]), topic=MemoryTopic(row["topic"]),
                  source_ids=tuple(row["source_ids"]), source_candidate_id=row["source_candidate_id"],
                  adoption_method=AdoptionMethod(row["adoption_method"]),
                  status=ConfirmedMemoryStatus(row["status"]), valid_at=row["valid_at"],
                  invalid_at=row["invalid_at"], revision=row["revision"], confidence=row["confidence"],
                  risk_flags=tuple(row["risk_flags"] or ()), supersedes_memory_id=row["supersedes_memory_id"],
                  event=MemoryEvent.from_payload(row.get("event")), conditions=MemoryConditions.from_payload(row.get("conditions")), evolution=MemoryEvolution.from_payload(row.get("evolution")),
                  source_dependency_mode=dependency_mode(row.get("source_dependency_mode")),
                  requires_all_sources=bool(row.get("requires_all_sources")))
    return (ConfirmedMemory(scope=ContactScope(row["owner_id"], row["contact_id"]), **fields)
            if "contact_id" in row else OwnerMemory(owner_id=row["owner_id"], **fields))


def _evaluate_version_evidence(
    memory: ConfirmedMemory | OwnerMemory, evidence: VersionEvidence,
    previous: dict | None,
) -> tuple[VersionEvidence, bool]:
    """按已复验的来源窗口和父版本行判断版本依据当前是否仍成立。"""
    owner_id = memory.scope.owner_id if isinstance(memory, ConfirmedMemory) else memory.owner_id
    available = (previous is not None and previous["status"] == "invalidated"
                 and memory.supersedes_memory_id == UUID(evidence.previous["memory_id"])
                 and (not isinstance(memory, ConfirmedMemory) or previous["contact_id"] == memory.scope.contact_id)
                 and previous["revision"] == evidence.previous["revision"] + 1
                 and version_record_digest(raw_memory(previous), revision=evidence.previous["revision"],
                     invalid_at=evidence.previous["invalid_at"]) == evidence.previous["record_sha256"])
    current = (memory.memory_id == UUID(evidence.current["memory_id"])
               and memory.revision == evidence.current["revision"]
               and version_record_digest(memory) == evidence.current["record_sha256"])
    bound = evidence.with_current_sources(available and current)
    can_revert = (bound.source_current and memory.status is ConfirmedMemoryStatus.ACTIVE
                  and memory.adoption_method is AdoptionMethod.AUTO
                  and evidence.previous["adoption_method"] == "auto"
                  and memory.supersedes_memory_id == UUID(evidence.previous["memory_id"]))
    return bound, can_revert


def bind_version_evidence(connection: Any, *, memory: ConfirmedMemory | OwnerMemory,
                          raw: object) -> tuple[VersionEvidence | None, bool]:
    evidence = VersionEvidence.from_payload(raw)
    if evidence is None:
        return None, False
    owner_id = memory.scope.owner_id if isinstance(memory, ConfirmedMemory) else memory.owner_id
    try:
        validate_version_sources(connection, owner_id=owner_id, evidence=evidence)
    except (MemoryVersionConflict, MemoryCorrectionConflictError):
        return evidence, False
    table = "confirmed_memory" if isinstance(memory, ConfirmedMemory) else "owner_memory"
    previous = connection.execute(sql.SQL("SELECT * FROM public.{} WHERE owner_id=%s AND id=%s").format(
        sql.Identifier(table)), (owner_id, UUID(evidence.previous["memory_id"]))).fetchone()
    return _evaluate_version_evidence(memory, evidence, previous)


def bind_version_evidence_rows(
    connection: Any, *, rows, memory_from_row,
) -> list[tuple[VersionEvidence | None, bool]]:
    """按批绑定版本依据：父版本行整批读取一次，来源窗口仍逐行复验。"""
    prepared: list[dict[str, Any] | None] = []
    wanted: dict[tuple[str, UUID], list[UUID]] = {}
    for row in rows:
        evidence = VersionEvidence.from_payload(row.get("version_evidence"))
        if evidence is None:
            prepared.append(None)
            continue
        memory = memory_from_row(row)
        owner_id = memory.scope.owner_id if isinstance(memory, ConfirmedMemory) else memory.owner_id
        try:
            validate_version_sources(connection, owner_id=owner_id, evidence=evidence)
        except (MemoryVersionConflict, MemoryCorrectionConflictError):
            prepared.append({"memory": memory, "evidence": evidence, "validated": False})
            continue
        table = "confirmed_memory" if isinstance(memory, ConfirmedMemory) else "owner_memory"
        previous_id = UUID(evidence.previous["memory_id"])
        wanted.setdefault((table, owner_id), []).append(previous_id)
        prepared.append({
            "memory": memory, "evidence": evidence, "validated": True,
            "table": table, "owner_id": owner_id, "previous_id": previous_id,
        })
    previous_rows: dict[tuple[str, UUID, UUID], dict] = {}
    for (table, owner_id), previous_ids in wanted.items():
        fetched = connection.execute(sql.SQL(
            "SELECT * FROM public.{} WHERE owner_id=%s AND id=ANY(%s)"
        ).format(sql.Identifier(table)), (owner_id, list(dict.fromkeys(previous_ids)))).fetchall()
        for previous in fetched:
            previous_rows[(table, owner_id, previous["id"])] = previous
    result: list[tuple[VersionEvidence | None, bool]] = []
    for item in prepared:
        if item is None:
            result.append((None, False))
            continue
        if not item["validated"]:
            result.append((item["evidence"], False))
            continue
        previous = previous_rows.get((item["table"], item["owner_id"], item["previous_id"]))
        result.append(_evaluate_version_evidence(item["memory"], item["evidence"], previous))
    return result


def scoped_version_ids(
    connection: Any, *, table: str, owner_id: UUID,
    contact_id: UUID | None, memory_id: UUID,
) -> tuple[UUID, ...]:
    """返回新到旧的有界版本链；不越过已删记录或另一范围。"""
    if table not in {"confirmed_memory", "owner_memory"}:
        raise ValueError("记忆版本类型无效。")
    scope = sql.SQL("owner_id=%s")
    params = [owner_id]
    if table == "confirmed_memory":
        scope += sql.SQL(" AND contact_id=%s")
        params.append(contact_id)
    ids, pending, visited = [], [(memory_id, frozenset())], set()
    while pending:
        current, ancestors = pending.pop(0)
        if current in ancestors:
            raise MemoryVersionConflict("版本图存在循环。")
        if current in visited:
            continue
        if len(visited) >= 100:
            raise MemoryVersionConflict("版本图超出可核对范围。")
        visited.add(current)
        row = connection.execute(sql.SQL(
            "SELECT id, supersedes_memory_id, to_jsonb(memory)->'merge_parent_ids' AS merge_parents "
            "FROM public.{} AS memory WHERE {} AND id=%s AND status <> 'deleted'"
        ).format(sql.Identifier(table), scope), (*params, current)).fetchone()
        if row is None:
            if not ids:
                raise LookupError("资料版本不存在或已清除。")
            continue
        ids.append(row['id'])
        if row['supersedes_memory_id'] is not None:
            pending.append((row['supersedes_memory_id'], ancestors | {current}))
        pending.extend((UUID(item), ancestors | {current}) for item in (row.get('merge_parents') or []))
    return tuple(ids)


def prepare_auto_revert(
    connection: Any, *, table: str, owner_id: UUID,
    contact_id: UUID | None, memory_id: UUID, expected_revision: int,
) -> tuple[dict, dict]:
    """调用方持有范围锁；精确核对自动叶子与原始旧版，不追到其他新版本。"""
    if table not in {"confirmed_memory", "owner_memory"}:
        raise ValueError("记忆版本类型无效。")
    if type(expected_revision) is not int or expected_revision < 1:
        raise ValueError("资料修订号无效。")
    scope = sql.SQL("owner_id=%s")
    params = [owner_id]
    if table == "confirmed_memory":
        scope += sql.SQL(" AND contact_id=%s")
        params.append(contact_id)

    def load(identifier: UUID) -> dict | None:
        return connection.execute(sql.SQL("SELECT * FROM public.{} WHERE {} AND id=%s FOR UPDATE").format(
            sql.Identifier(table), scope,
        ), (*params, identifier)).fetchone()

    current = load(memory_id)
    if current is None:
        raise LookupError("资料版本不存在或已清除。")
    if (current["status"] != "active" or current["adoption_method"] != "auto"
            or current["revision"] != expected_revision or current["supersedes_memory_id"] is None):
        raise MemoryVersionConflict("只有仍合法的自动更新可以撤销。")
    previous = load(current["supersedes_memory_id"])
    original = VersionEvidence.from_payload(current.get("version_evidence"))
    if (previous is None or previous["status"] != "invalidated"
            or previous["adoption_method"] != "auto" or original is None
            or previous["revision"] != original.previous["revision"] + 1
            or connection.execute(sql.SQL(
                "SELECT 1 FROM public.{} WHERE {} AND supersedes_memory_id=%s AND status='active'"
            ).format(sql.Identifier(table), scope), (*params, memory_id)).fetchone() is not None):
        raise MemoryVersionConflict("原版本或人工决定已变化，不能恢复。")
    evidence, legal = bind_version_evidence(connection, memory=raw_memory(current),
                                           raw=current.get("version_evidence"))
    if not legal or evidence is None:
        raise MemoryVersionConflict("原始版本依据未知或已变化，不能恢复。")
    return current, previous


def restored_version_evidence(connection: Any, *, previous: dict, revision: int) -> VersionEvidence | None:
    """只改恢复回执的当前修订；两个实际原始窗口及旧版证明都保持原样。"""
    original = VersionEvidence.from_payload(previous.get("version_evidence"))
    if original is None:
        return None
    historical = replace(raw_memory(previous), status=ConfirmedMemoryStatus.ACTIVE,
                         revision=original.current["revision"])
    _, legal = bind_version_evidence(connection, memory=historical, raw=original.to_payload())
    if not legal:
        return original
    restored = replace(historical, revision=revision)
    return VersionEvidence(deepcopy(original.previous), {
        "memory_id": str(restored.memory_id), "revision": revision,
        "record_sha256": version_record_digest(restored),
    }, deepcopy(original.previous_window), deepcopy(original.current_window))


def erase_reverted_version(connection: Any, *, table: str, owner_id: UUID, current: dict) -> None:
    """撤销只清除所撤销版本及其依赖，不清除仍有合法依据的旧版。"""
    from notalone.persistence.memory_correction import candidate_from_row, erase_correction_dependencies, record_decision

    from notalone.persistence.extraction_trace import erase_record_traces
    if table not in {"confirmed_memory", "owner_memory"}:
        raise ValueError("记忆版本类型无效。")
    record_kind = "contact_memory" if table == "confirmed_memory" else "owner_memory"
    candidate_row = connection.execute(
        "SELECT * FROM public.memory_candidate WHERE owner_id=%s AND id=%s",
        (owner_id, current["source_candidate_id"]),
    ).fetchone()
    candidate = candidate_from_row(candidate_row) if candidate_row else None
    record_decision(
        connection, scope=ContactScope(owner_id, current["contact_id"]) if table == "confirmed_memory" else None,
        owner_id=owner_id, record_kind=record_kind, record_id=current["id"], rejected_text=None,
        source_ids=tuple(current["source_ids"]), candidate=candidate,
    )
    removed = {current["id"]}
    if current["source_candidate_id"] is not None:
        removed.add(current["source_candidate_id"])
    erase_record_traces(connection, owner_id=owner_id, record_kind=record_kind, record_id=current["id"])
    erase_correction_dependencies(connection, owner_id=owner_id, removed_ids=removed, record_deletion=True)
    connection.execute(sql.SQL(
        "UPDATE public.{} SET text_content='已删除的资料', status='deleted', revision=revision+1, "
        "risk_flags='{{}}'::text[], event=NULL, version_evidence=NULL" + conditions_clear_sql(connection) + ", updated_at=now() WHERE owner_id=%s AND id=%s"
    ).format(sql.Identifier(table)), (owner_id, current["id"]))
    connection.execute(
        "UPDATE public.memory_candidate SET text_content='已删除的资料', status='rejected', "
        "interpretation_reason='', alternatives='{}'::text[], risk_flags='{}'::text[], failure_reason=NULL, "
        "event=NULL, dimension_evidence=NULL, correction_evidence=NULL, correction_decision_ids=NULL" + conditions_clear_sql(connection) + ", updated_at=now() "
        "WHERE owner_id=%s AND id=%s", (owner_id, current["source_candidate_id"]),
    )
