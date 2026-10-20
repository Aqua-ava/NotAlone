"""当前变化只投影元数据，历史正文与时间仍来自原始回复快照。"""

import hashlib
import json
from datetime import datetime
from collections.abc import Iterable
from typing import Any
from uuid import UUID

from psycopg import sql

from notalone.persistence.memory_timing import timed_memory_rows
from notalone.persistence.memory_events import bind_memory_event
from notalone.persistence.memory_conditions import bind_memory_conditions
from notalone.persistence.memory_evolution import bind_memory_evolution
from notalone.memory.retirement import is_generation_status_eligible
from notalone.reply.context import ContextEvidence
from notalone.retrieval.models import history_timing
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.interface import ReplyBasisChange
from notalone.scopes import ContactScope


def read_reply_basis_changes(
    connection: Any, scope: ContactScope, request_id: UUID,
) -> tuple[ReplyBasisChange, ...]:
    rows = connection.execute(
        """
        SELECT evidence.evidence_id, evidence.kind, evidence.owner_id, evidence.contact_id,
          evidence.evidence_status AS original_status, evidence.evidence_revision AS original_revision,
          coalesce(memory.status, own.status, candidate.status) AS current_status,
          coalesce(memory.retirement_reason, own.retirement_reason, 'unknown') AS retirement_reason,
          coalesce(memory.revision, own.revision) AS revision,
          coalesce(memory.category, own.category, candidate.category) AS category,
          coalesce(memory.event, own.event, candidate.event) AS event,
          coalesce(to_jsonb(memory)->'conditions', to_jsonb(own)->'conditions', to_jsonb(candidate)->'conditions') AS conditions,
          coalesce(to_jsonb(memory)->'evolution', to_jsonb(own)->'evolution', to_jsonb(candidate)->'evolution') AS evolution,
          coalesce(memory.source_candidate_id, own.source_candidate_id, candidate.id) AS event_candidate_id,
          coalesce(memory.text_content, own.text_content, candidate.text_content) AS text_content,
          coalesce(memory.source_ids, own.source_ids, candidate.source_ids) AS source_ids,
          coalesce(memory.created_at, own.created_at, candidate.created_at) AS recorded_at,
          coalesce(memory.valid_at, own.valid_at, candidate.valid_at) AS valid_at,
          coalesce(memory.invalid_at, own.invalid_at, candidate.invalid_at) AS invalid_at,
          coalesce(memory.valid_at, own.valid_at, candidate.valid_at) > now() AS future,
          coalesce(memory.invalid_at, own.invalid_at, candidate.invalid_at) <= now() AS expired
        FROM public.reply_context_evidence AS evidence
        LEFT JOIN public.confirmed_memory AS memory ON evidence.kind='confirmed_memory'
          AND memory.id=evidence.evidence_id AND memory.owner_id=evidence.owner_id
          AND memory.contact_id=evidence.contact_id
        LEFT JOIN public.owner_memory AS own ON evidence.kind='owner_memory'
          AND own.id=evidence.evidence_id AND own.owner_id=evidence.owner_id
        LEFT JOIN public.memory_candidate AS candidate ON evidence.kind='pending_candidate'
          AND candidate.id=evidence.evidence_id AND candidate.owner_id=evidence.owner_id
          AND candidate.contact_id=evidence.contact_id
        WHERE evidence.owner_id=%s AND evidence.contact_id=%s
          AND evidence.reply_request_id=%s
          AND evidence.kind IN ('confirmed_memory', 'owner_memory', 'pending_candidate')
        ORDER BY evidence.evidence_id, evidence.kind
        """,
        (scope.owner_id, scope.contact_id, request_id),
    ).fetchall()
    snapshot_row = connection.execute(
        "SELECT context_snapshot FROM public.reply_request WHERE owner_id=%s AND contact_id=%s AND id=%s",
        (scope.owner_id, scope.contact_id, request_id),
    ).fetchone()
    snapshot = snapshot_row["context_snapshot"] if snapshot_row else None
    original_items = {
        item["evidence_id"]: item
        for item in snapshot.get("evidence", [])
        if isinstance(item, dict) and isinstance(item.get("evidence_id"), str)
    } if isinstance(snapshot, dict) else {}
    current_rows = _current_timed_rows(connection, rows)
    changes: dict[tuple[UUID, str], ReplyBasisChange] = {}
    for row in current_rows:
        original = original_items.get(str(row["evidence_id"]), {})
        timing = original.get("timing")
        was_historical = bool(original.get("navigation")) and isinstance(timing, dict) and timing.get("current_status") == "historical"
        if was_historical:
            row["timing"] = history_timing(row["timing"], row["current_status"], row["invalid_at"])
        time_status_changed = (isinstance(timing, dict) and isinstance(timing.get("current_status"), str)
                               and row["timing"].current_status != timing["current_status"])
        reason = ("memory_generation_forbidden" if ((row["current_status"] in ("invalidated", "rejected") or row["expired"])
                  and not is_generation_status_eligible(row["current_status"], row.get("retirement_reason"), include_historical=True, invalid_at=row["invalid_at"]))
                  else "memory_revised" if ((row["current_status"] in ("invalidated", "rejected") and row["original_status"] != row["current_status"])
                  or row["current_status"] != row["original_status"]
                  or (row["original_revision"] is not None and row["revision"] != row["original_revision"])
                  or ("evolution" in original and original["evolution"] != _current_evolution(connection, row)))
                  else "memory_not_yet_valid" if row["future"]
                  else "memory_expired" if row["expired"] and not was_historical
                  else "memory_time_changed" if (
                      _period_changed(row, original) or time_status_changed
                      or ("event" in original and original["event"] != _current_event(connection, row))
                      or ("conditions" in original and original["conditions"] != _current_conditions(connection, row))
                  ) else None)
        if reason is not None:
            key = row["evidence_id"], row["kind"]
            changes[key] = ReplyBasisChange(*key, reason)
    # 派生资料和继承讨论即使没有直接引用记忆，也必须给旧结果显示禁用原因。
    from notalone.persistence.assistant_session_store import _reply_dependencies
    for identifier, kind in forbidden_generation_memory_dependencies(
        connection, scope, _reply_dependencies(connection, scope, request_id),
    ):
        changes[(identifier, kind)] = ReplyBasisChange(identifier, kind, "memory_generation_forbidden")
    from notalone.persistence.skill_execution_view import saved_skill_policy_change
    version = saved_skill_policy_change(connection, scope, request_id)
    if version is not None:
        changes[(version, 'reply_skill')] = ReplyBasisChange(version, 'reply_skill', 'skill_policy_changed')
    return tuple(changes.values())


def _period_changed(row: dict[str, Any], original: dict[str, Any]) -> bool:
    try:
        if not {"valid_at", "invalid_at"} <= set(original):
            return False
        return any(row[key] != (datetime.fromisoformat(original[key]) if original[key] is not None else None)
                   for key in ("valid_at", "invalid_at"))
    except (TypeError, ValueError):
        return False


def _current_timed_rows(connection: Any, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """只投影当前状态；旧快照缺少时间证明时不补造比较基线。"""
    return [row for own in (False, True) for row in timed_memory_rows(
        connection, [row for row in rows if (row["kind"] == "owner_memory") == own],
        source_ids_key="source_ids", contact_scoped=not own,
    )]


def _current_event(connection: Any, row: dict) -> dict | None:
    event = bind_memory_event(connection, owner_id=row["owner_id"],
        candidate_id=row.get("event_candidate_id"), raw=row.get("event"))
    return event.to_payload(current=True) if event else None


def require_current_reply_memory(
    connection: Any, scope: ContactScope, evidence: tuple[ContextEvidence, ...],
) -> None:
    """调用方持有实际候选 writer 的 owner 锁；本次资料必须仍等于模型所见版本。"""
    for kind, table in (("confirmed_memory", "confirmed_memory"), ("owner_memory", "owner_memory"),
                        ("pending_candidate", "memory_candidate")):
        expected = {item.evidence_id: item for item in evidence if item.kind == kind}
        if not expected:
            continue
        contact_clause = sql.SQL("") if kind == "owner_memory" else sql.SQL("AND contact_id=%(contact_id)s")
        revision = sql.SQL("NULL::integer") if kind == "pending_candidate" else sql.SQL("revision")
        event_candidate = sql.SQL("id" if kind == "pending_candidate" else "source_candidate_id")
        retirement = sql.SQL("'unknown'") if kind == "pending_candidate" else sql.SQL("retirement_reason")
        rows = connection.execute(sql.SQL(
            "SELECT id AS evidence_id,%(kind)s AS kind,owner_id,%(contact_id)s::uuid AS contact_id,"
            "status,text_content,source_ids,valid_at,invalid_at,category,created_at AS recorded_at,event,to_jsonb(" + table + ")->'conditions' AS conditions,"
            "to_jsonb(" + table + ")->'evolution' AS evolution,{} AS event_candidate_id,"
            "{} AS retirement_reason,{} AS revision,valid_at>now() AS future,invalid_at<=now() AS expired "
            "FROM public.{} WHERE owner_id=%(owner_id)s AND id=ANY(%(ids)s::uuid[]) {}"
        ).format(event_candidate, retirement, revision, sql.Identifier(table), contact_clause),
            {"owner_id": scope.owner_id, "contact_id": scope.contact_id, "kind": kind, "ids": list(expected)},
        ).fetchall()
        if len(rows) != len(expected):
            raise ReplyStoreInvariantError("本次新候选的记忆依据已不可用。")
        for row in _current_timed_rows(connection, rows):
            item = expected[row["evidence_id"]]
            historical = item.navigation is not None and item.timing.current_status == "historical"
            current_timing = history_timing(row["timing"], row["status"], row["invalid_at"]) if item.navigation else row["timing"]
            eligible = (row["status"] in ("pending", "confirmed") if kind == "pending_candidate" else
                        is_generation_status_eligible(row["status"], row.get("retirement_reason"), include_historical=historical))
            if (not eligible or row["status"] != item.status or row["future"] or row["expired"]
                    or row["text_content"] != item.text or row["revision"] != item.revision
                    or len(row["source_ids"]) != len(item.source_ids) or set(row["source_ids"]) != set(item.source_ids)
                    or row["valid_at"] != item.valid_at or row["invalid_at"] != item.invalid_at
                    or current_timing != item.timing
                    or _current_event(connection, row) != (item.event.to_payload(current=True) if item.event else None)
                    or _current_conditions(connection, row) != (item.conditions.to_payload(current=True) if item.conditions else None)
                    or _current_evolution(connection, row) != (item.evolution.to_payload(current=True) if item.evolution else None)):
                raise ReplyStoreInvariantError("本次新候选的记忆依据版本已变化。")


def historical_basis_revision_sha256(
    connection: Any, scope: ContactScope, dependencies: tuple[UUID, ...],
) -> str:
    """冻结实际使用历史的记忆版本链，不保存正文或重建旧证明。"""

    rows = connection.execute(
        """
        WITH RECURSIVE nodes AS (
          SELECT id, 'confirmed_memory' AS kind, supersedes_memory_id AS previous,
            revision, status, retirement_reason, text_content, source_ids, valid_at, invalid_at, category, created_at AS recorded_at, owner_id, contact_id, event, to_jsonb(confirmed_memory)->'conditions' AS conditions, to_jsonb(confirmed_memory)->'evolution' AS evolution
          FROM public.confirmed_memory WHERE owner_id=%s AND contact_id=%s
          UNION ALL
          SELECT id, 'owner_memory', supersedes_memory_id, revision, status, retirement_reason,
            text_content, source_ids, valid_at, invalid_at, category, created_at, owner_id, NULL::uuid, event, to_jsonb(owner_memory)->'conditions', to_jsonb(owner_memory)->'evolution'
          FROM public.owner_memory WHERE owner_id=%s
          UNION ALL
          SELECT id, 'pending_candidate', NULL::uuid, 0, status, 'unknown',
            text_content, source_ids, valid_at, invalid_at, category, created_at, owner_id, contact_id, event, to_jsonb(memory_candidate)->'conditions', to_jsonb(memory_candidate)->'evolution'
          FROM public.memory_candidate WHERE owner_id=%s AND contact_id=%s
        ), used AS (
          SELECT * FROM nodes WHERE id=ANY(%s::uuid[])
          UNION
          SELECT node.* FROM nodes AS node JOIN used ON node.previous=used.id AND node.kind=used.kind
        )
        SELECT *, valid_at > now() AS future, invalid_at <= now() AS expired
        FROM used ORDER BY kind, id
        """,
        (scope.owner_id, scope.contact_id, scope.owner_id, scope.owner_id, scope.contact_id, list(dependencies)),
    ).fetchall()
    rows = sorted(_current_timed_rows(connection, rows), key=lambda row: (row["kind"], row["id"]))
    for row in rows:
        row["evolution"] = _current_evolution(connection, row)
        row["text_digest"] = hashlib.sha256(row.pop("text_content").encode("utf-8")).hexdigest()
        row["timing"] = row["timing"].to_payload()
    payload = json.dumps(rows, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def require_generation_memory_dependencies(
    connection: Any, scope: ContactScope, dependencies: Iterable[UUID],
) -> None:
    """生成专用门：审计来源仍可回看，失效或过期记忆不能携入模型。

    调用方负责已有来源、范围和删除校验；此处沿同一依赖集合补充失效原因，
    并展开已捕获的整理版本，避免只引用派生文档时绕过底层事实。
    """
    if forbidden_generation_memory_dependencies(connection, scope, dependencies):
        raise ReplyStoreInvariantError("原记忆依据已失效或过期，只能回看，请重新生成。")


def forbidden_generation_memory_dependencies(
    connection: Any, scope: ContactScope, dependencies: Iterable[UUID],
) -> tuple[tuple[UUID, str], ...]:
    dependencies = set(dependencies)
    if not dependencies:
        return ()
    # 候选依赖沿派生记忆检查状态；只报告实际使用的身份。
    # 同一已使用记忆的内部候选不重复投影，未使用的删除指纹也不能冒充另一条记忆。
    rows = connection.execute("""
        WITH RECURSIVE used(id) AS (
          SELECT unnest(%(ids)s::uuid[])
          UNION
          SELECT unnest(batch.dependencies) FROM used JOIN (
            SELECT version.id,batch.dependency_ids AS dependencies
            FROM public.scenario_document_version AS version
            JOIN public.layered_memory_batch AS batch ON batch.id=version.batch_id
            WHERE batch.owner_id=%(owner_id)s
            UNION ALL
            SELECT version.id,batch.dependency_ids
            FROM public.layered_profile_version AS version
            JOIN public.layered_profile_batch AS batch ON batch.id=version.batch_id
            WHERE batch.owner_id=%(owner_id)s
          ) AS batch ON batch.id=used.id
        )
        SELECT DISTINCT memory.id,memory.kind FROM used JOIN (
          SELECT id,id AS match_id,'confirmed_memory' AS kind,status,retirement_reason,invalid_at FROM public.confirmed_memory
          WHERE owner_id=%(owner_id)s
          UNION ALL
          SELECT CASE WHEN id IN (SELECT id FROM used) THEN id ELSE source_candidate_id END,source_candidate_id,
            CASE WHEN id IN (SELECT id FROM used) THEN 'confirmed_memory' ELSE 'pending_candidate' END,status,retirement_reason,invalid_at FROM public.confirmed_memory
          WHERE owner_id=%(owner_id)s AND source_candidate_id IS NOT NULL
          UNION ALL
          SELECT id,id,'owner_memory',status,retirement_reason,invalid_at FROM public.owner_memory WHERE owner_id=%(owner_id)s
          UNION ALL
          SELECT CASE WHEN id IN (SELECT id FROM used) THEN id ELSE source_candidate_id END,source_candidate_id,
            CASE WHEN id IN (SELECT id FROM used) THEN 'owner_memory' ELSE 'pending_candidate' END,status,retirement_reason,invalid_at FROM public.owner_memory
          WHERE owner_id=%(owner_id)s AND source_candidate_id IS NOT NULL
          UNION ALL
          SELECT id,id,'pending_candidate',status,'unknown',invalid_at FROM public.memory_candidate WHERE owner_id=%(owner_id)s
        ) AS memory ON memory.match_id=used.id
        WHERE memory.status NOT IN ('active','pending','confirmed') OR memory.invalid_at<=now()
        ORDER BY memory.kind,memory.id
    """, {"ids": list(dependencies), "owner_id": scope.owner_id}).fetchall()
    return tuple((row["id"], row["kind"]) for row in rows)


def _current_conditions(connection: Any, row: dict) -> dict | None:
    value = bind_memory_conditions(connection, owner_id=row["owner_id"], candidate_id=row.get("event_candidate_id"), raw=row.get("conditions"), text=row["text_content"])
    return value.to_payload(current=True) if value else None


def _current_evolution(connection: Any, row: dict) -> dict | None:
    value = bind_memory_evolution(connection, owner_id=row["owner_id"], raw=row.get("evolution"),
        memory_id=(row.get("evidence_id", row.get("id")) if row["kind"] != "pending_candidate" else None),
        revision=row.get("revision"))
    return value.to_payload(current=True) if value else None
