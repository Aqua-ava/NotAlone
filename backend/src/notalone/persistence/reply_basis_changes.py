"""当前变化只投影元数据，历史正文与时间仍来自原始回复快照。"""

import hashlib
import json
from datetime import datetime
from typing import Any
from uuid import UUID

from psycopg import sql

from notalone.persistence.memory_timing import timed_memory_rows
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
          coalesce(memory.revision, own.revision) AS revision,
          coalesce(memory.category, own.category, candidate.category) AS category,
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
        reason = ("memory_revised" if ((row["current_status"] in ("invalidated", "rejected") and row["original_status"] != row["current_status"])
                  or row["current_status"] != row["original_status"]
                  or (row["original_revision"] is not None and row["revision"] != row["original_revision"]))
                  else "memory_not_yet_valid" if row["future"]
                  else "memory_expired" if row["expired"] and not was_historical
                  else "memory_time_changed" if (
                      _period_changed(row, original) or time_status_changed
                  ) else None)
        if reason is not None:
            key = row["evidence_id"], row["kind"]
            changes[key] = ReplyBasisChange(*key, reason)
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
        rows = connection.execute(sql.SQL(
            "SELECT id AS evidence_id,%(kind)s AS kind,owner_id,%(contact_id)s::uuid AS contact_id,"
            "status,text_content,source_ids,valid_at,invalid_at,category,created_at AS recorded_at,"
            "{} AS revision,valid_at>now() AS future,invalid_at<=now() AS expired "
            "FROM public.{} WHERE owner_id=%(owner_id)s AND id=ANY(%(ids)s::uuid[]) {}"
        ).format(revision, sql.Identifier(table), contact_clause),
            {"owner_id": scope.owner_id, "contact_id": scope.contact_id, "kind": kind, "ids": list(expected)},
        ).fetchall()
        if len(rows) != len(expected):
            raise ReplyStoreInvariantError("本次新候选的记忆依据已不可用。")
        for row in _current_timed_rows(connection, rows):
            item = expected[row["evidence_id"]]
            historical = item.navigation is not None and item.timing.current_status == "historical"
            current_timing = history_timing(row["timing"], row["status"], row["invalid_at"]) if item.navigation else row["timing"]
            if (row["status"] != item.status or row["future"] or (row["expired"] and not historical)
                    or row["text_content"] != item.text or row["revision"] != item.revision
                    or len(row["source_ids"]) != len(item.source_ids) or set(row["source_ids"]) != set(item.source_ids)
                    or row["valid_at"] != item.valid_at or row["invalid_at"] != item.invalid_at
                    or current_timing != item.timing):
                raise ReplyStoreInvariantError("本次新候选的记忆依据版本已变化。")


def historical_basis_revision_sha256(
    connection: Any, scope: ContactScope, dependencies: tuple[UUID, ...],
) -> str:
    """冻结实际使用历史的记忆版本链，不保存正文或重建旧证明。"""

    rows = connection.execute(
        """
        WITH RECURSIVE nodes AS (
          SELECT id, 'confirmed_memory' AS kind, supersedes_memory_id AS previous,
            revision, status, text_content, source_ids, valid_at, invalid_at, category, created_at AS recorded_at, owner_id, contact_id
          FROM public.confirmed_memory WHERE owner_id=%s AND contact_id=%s
          UNION ALL
          SELECT id, 'owner_memory', supersedes_memory_id, revision, status,
            text_content, source_ids, valid_at, invalid_at, category, created_at, owner_id, NULL::uuid
          FROM public.owner_memory WHERE owner_id=%s
          UNION ALL
          SELECT id, 'pending_candidate', NULL::uuid, 0, status,
            text_content, source_ids, valid_at, invalid_at, category, created_at, owner_id, contact_id
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
        row["text_digest"] = hashlib.sha256(row.pop("text_content").encode("utf-8")).hexdigest()
        row["timing"] = row["timing"].to_payload()
    payload = json.dumps(rows, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
