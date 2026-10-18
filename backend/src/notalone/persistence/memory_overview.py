"""以合法底层记忆构建概览，只持久化无正文的依赖清单。"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from datetime import datetime, timezone
import hashlib
import json
from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.memory.models import ConfirmedMemory, ConfirmedMemoryStatus, OwnerMemory
from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.memory.overview import (
    OverviewEntry, OverviewMemoryIdentity, OverviewSourceReference,
    OverviewUnavailable, RelationshipOverview,
)
from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.persistence.memory_correction import (
    available_correction_memories, decision_sources_available, source_documents_available,
)
from notalone.persistence.correction_evidence import capture_message_snapshot, validate_frozen_snapshot
from notalone.persistence.memory_store import PostgresMemoryStore, _MEMORY_COLUMNS
from notalone.persistence.owner_memory_store import (
    _OWNER_MEMORY_COLUMNS, _ensure_memory_sources, _from_row, _timed_rows,
)
from notalone.persistence.memory_versions import version_record_digest
from notalone.persistence.message_sources import active_source_ref_sql
from notalone.scopes import ContactScope


def _digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":"), default=str).encode()).hexdigest()


def _memory_dependency(
    memory: ConfirmedMemory | OwnerMemory, lineage: dict, *, original_known: bool,
) -> dict:
    """统一单项无正文指纹；原证明是否已知由调用范围明确决定。"""
    return {"memory_id": str(memory.memory_id), "revision": memory.revision,
        "status": memory.status.value, "record_sha256": version_record_digest(memory),
        "timing_sha256": _digest(memory.timing.to_payload()),
        "version_evidence_sha256": _digest(memory.version_evidence.to_payload() if memory.version_evidence else None),
        "current_event_sha256": _digest(memory.event.to_payload(current=True) if memory.event else None),
        "version_evidence_source_current": bool(memory.version_evidence and memory.version_evidence.source_current),
        "source_generation_sha256": lineage["generation_sha256"], "original_known": original_known,
        "context_records": lineage["context_records"], "source_ids": lineage["source_ids"],
        "source_refs": lineage["source_refs"]}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class PostgresRelationshipOverviewStore:
    def __init__(self, database_url: str, *, clock: Callable[[], datetime] = _utc_now) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        if not callable(clock):
            raise ValueError("clock 必须可调用。")
        self._database_url = database_url
        self._clock = clock

    def read_owner(self, owner_id: UUID) -> RelationshipOverview:
        if not isinstance(owner_id, UUID):
            raise TypeError("本人概览必须限定用户范围。")
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=owner_id)
                return self.read_owner_in_transaction(connection, owner_id)
        except psycopg.Error:
            raise OverviewUnavailable("概览暂不可用。") from None

    def read_owner_in_transaction(self, connection, owner_id: UUID, *, organization: bool = False) -> RelationshipOverview:
        """调用方已经持有 owner 锁；复用当前连接，不再申请 contact 锁。"""
        if connection.execute("SELECT 1 FROM public.owner WHERE id=%s", (owner_id,)).fetchone() is None:
            raise LookupError("指定范围内的用户不存在。")
        state = connection.execute("SELECT memory_revision FROM public.owner_memory_state WHERE owner_id=%s",
                                   (owner_id,)).fetchone()
        memory_revision = state["memory_revision"] if state else 0
        rows = connection.execute(
            f"SELECT {_OWNER_MEMORY_COLUMNS} FROM public.owner_memory WHERE owner_id=%s "
            "AND status IN ('active','invalidated') "
            + ("" if organization else "AND category IN ('common_fact','preference','taboo') ")
            + "ORDER BY created_at,id", (owner_id,),
        ).fetchall()
        rows = available_correction_memories(connection, owner_id=owner_id,
                                             record_kind="owner_memory", rows=rows)
        entries = []
        dependencies = []
        for row in _timed_rows(connection, rows):
            try:
                _ensure_memory_sources(connection, owner_id=owner_id, row=row)
                lineage = self._lineage(connection, owner_id,
                    {**row, "memory_source_ids": row["source_ids"]})
            except (PermissionError, MemoryCorrectionConflictError):
                continue
            memory = _from_row(row)
            manual = memory.source_ids == (owner_id,)
            references = ((OverviewSourceReference(owner_id, "manual"),) if manual else self._references(
                connection, owner_id, memory.source_ids, ref_ids=lineage["original_ref_ids"],
            ))
            kind = ("manual_entry" if manual else "source_supported"
                    if references and lineage["original_known"] else "unknown")
            entries.append(OverviewEntry(memory, None, kind, references))
            dependencies.append(_memory_dependency(
                memory, lineage, original_known=manual or lineage["original_known"],
            ))
        entries = self._bind_dependencies(self._bind_leaves(entries), dependencies)
        manifest = {"version": 1, "memory_revision": memory_revision, "memories": dependencies}
        revision = _digest(manifest)
        saved = connection.execute(
            "SELECT projection_revision,built_at FROM public.relationship_overview_projection "
            "WHERE owner_id=%s AND scope_kind='owner'", (owner_id,),
        ).fetchone()
        built_at = saved["built_at"] if saved and saved["projection_revision"] == revision else self._now()
        if not saved or saved["projection_revision"] != revision:
            connection.execute(
                "INSERT INTO public.relationship_overview_projection "
                "(owner_id,scope_kind,contact_id,projection_revision,memory_ids,source_ids,manifest,built_at) "
                "VALUES (%s,'owner',NULL,%s,%s,%s,%s,%s) "
                "ON CONFLICT (owner_id) WHERE scope_kind='owner' DO UPDATE SET "
                "projection_revision=EXCLUDED.projection_revision,memory_ids=EXCLUDED.memory_ids,"
                "source_ids=EXCLUDED.source_ids,manifest=EXCLUDED.manifest,built_at=EXCLUDED.built_at",
                (owner_id, revision, [entry.memory.memory_id for entry in entries],
                 sorted({UUID(source) for item in dependencies for source in item["source_ids"]}),
                 Jsonb(manifest), built_at),
            )
        return RelationshipOverview(owner_id, revision, memory_revision, built_at, tuple(entries))

    def read_contact(self, scope: ContactScope) -> RelationshipOverview:
        if not isinstance(scope, ContactScope):
            raise TypeError("概览必须限定联系人范围。")
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
                lock_owner_scope(connection, owner_id=scope.owner_id)
                return self.read_contact_in_transaction(connection, scope)
        except psycopg.Error:
            raise OverviewUnavailable("概览暂不可用。") from None

    def read_contact_in_transaction(self, connection, scope: ContactScope) -> RelationshipOverview:
        """调用方已经持有 owner 锁；复用当前连接，不再申请 contact 锁。"""
        if connection.execute(
            "SELECT 1 FROM public.contact WHERE owner_id=%s AND id=%s",
            (scope.owner_id, scope.contact_id),
        ).fetchone() is None:
            raise LookupError("指定范围内的联系人不存在。")
        state = connection.execute(
            "SELECT memory_revision FROM public.contact_memory_state WHERE owner_id=%s AND contact_id=%s",
            (scope.owner_id, scope.contact_id),
        ).fetchone()
        memory_revision = state["memory_revision"] if state else 0
        rows = connection.execute(
            f"SELECT {_MEMORY_COLUMNS} FROM public.confirmed_memory "
            "WHERE owner_id=%s AND contact_id=%s AND status IN ('active','invalidated') "
            "ORDER BY created_at,id", (scope.owner_id, scope.contact_id),
        ).fetchall()
        rows = available_correction_memories(connection, owner_id=scope.owner_id,
                                             record_kind="contact_memory", rows=rows)
        entries = []
        dependencies = []
        for row in PostgresMemoryStore._timed_memories(connection, rows):
            try:
                PostgresMemoryStore._ensure_active_sources(connection, scope, tuple(row["memory_source_ids"]))
                lineage = self._lineage(connection, scope, row)
            except (PermissionError, MemoryCorrectionConflictError):
                continue
            memory = PostgresMemoryStore._memory_from_row(row)
            references = self._references(connection, scope, memory.source_ids,
                                          ref_ids=lineage["original_ref_ids"])
            kind = ("manual_entry" if references and all(ref.source_kind == "manual" for ref in references)
                    else "source_supported" if references and lineage["original_known"] else "unknown")
            entries.append(OverviewEntry(memory, None, kind, references))
            dependencies.append(_memory_dependency(
                memory, lineage, original_known=lineage["original_known"],
            ))
        entries = self._bind_dependencies(self._bind_leaves(entries), dependencies)
        manifest = {"version": 1, "memory_revision": memory_revision, "memories": dependencies}
        revision = _digest(manifest)
        saved = connection.execute(
            "SELECT projection_revision,built_at FROM public.relationship_overview_projection "
            "WHERE owner_id=%s AND contact_id=%s AND scope_kind='contact'",
            (scope.owner_id, scope.contact_id),
        ).fetchone()
        built_at = saved["built_at"] if saved and saved["projection_revision"] == revision else self._now()
        if not saved or saved["projection_revision"] != revision:
            source_ids = {UUID(identifier) for item in dependencies for identifier in item["source_ids"]}
            source_ids.update(ref.source_id for entry in entries for ref in entry.references)
            connection.execute(
                "INSERT INTO public.relationship_overview_projection "
                "(owner_id,scope_kind,contact_id,projection_revision,memory_ids,source_ids,manifest,built_at) "
                "VALUES (%s,'contact',%s,%s,%s,%s,%s,%s) "
                "ON CONFLICT (owner_id,contact_id) WHERE scope_kind='contact' DO UPDATE SET "
                "projection_revision=EXCLUDED.projection_revision,memory_ids=EXCLUDED.memory_ids,"
                "source_ids=EXCLUDED.source_ids,manifest=EXCLUDED.manifest,built_at=EXCLUDED.built_at",
                (scope.owner_id, scope.contact_id, revision, [entry.memory.memory_id for entry in entries],
                 sorted(source_ids), Jsonb(manifest), built_at),
            )
        return RelationshipOverview(scope, revision, memory_revision, built_at, tuple(entries))

    def _now(self) -> datetime:
        value = self._clock()
        if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
            raise OverviewUnavailable("概览构建时间不可核验。")
        return value.astimezone(timezone.utc)

    @staticmethod
    def _lineage(connection, scope: ContactScope | UUID, row: dict) -> dict:
        """沿当时保存的窗口复验；未知旧证明不会被当前捕获升级。"""
        owner_id = scope.owner_id if isinstance(scope, ContactScope) else scope
        contact_id = scope.contact_id if isinstance(scope, ContactScope) else None
        record_kind = "contact_memory" if contact_id else "owner_memory"
        windows = []
        sources = {str(item) for item in row["memory_source_ids"]}
        if contact_id is None:
            sources.update(PostgresRelationshipOverviewStore._owner_original_candidates(connection, owner_id, row))
        candidate = connection.execute(
            "SELECT correction_evidence,dimension_evidence,subject FROM public.memory_candidate "
            "WHERE owner_id=%s AND (%s::uuid IS NULL OR contact_id=%s) AND id=%s",
            (owner_id, contact_id, contact_id, row["source_candidate_id"]),
        ).fetchone() if row["source_candidate_id"] else None
        if contact_id is None and row["source_candidate_id"] and (candidate is None or candidate["subject"] != "self"):
            raise MemoryCorrectionConflictError("本人资料的原主体关联已变化。")
        frozen = candidate["correction_evidence"] if candidate else None
        original_known = frozen is not None and frozen.get("kind") != "generation_unknown"
        original_windows = [frozen] if original_known else []
        if original_known:
            windows.append(frozen)
        decisions = connection.execute(
            "SELECT id,evidence,decision,replacement_memory_id FROM public.memory_correction_decision "
            "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s::uuid "
            "AND record_kind=%s AND (record_id=%s OR replacement_memory_id=%s)",
            (owner_id, contact_id, record_kind, row["memory_id"], row["memory_id"]),
        ).fetchall()
        for decision in decisions:
            sources.add(str(decision["id"]))
            evidence = decision["evidence"]
            if evidence.get("kind") not in {"generation_unknown", "erased_guard"}:
                windows.append(evidence)
                # 只认本版本的人工更正冻结窗口，不把旧记录从当前来源补证。
                if (decision["decision"] == "corrected"
                        and decision["replacement_memory_id"] == row["memory_id"]):
                    original_windows.append(evidence)
        original_known = bool(original_windows)
        version = row.get("version_evidence")
        if version:
            windows.extend(window for window in (version.get("previous_window"), version.get("current_window"))
                           if window is not None)
        refs = {}
        for window in windows:
            validate_frozen_snapshot(connection, owner_id=owner_id, evidence=window)
            if not decision_sources_available(connection, owner_id=owner_id, evidence=window):
                raise MemoryCorrectionConflictError("概览参与来源已不可用。")
            sources.update(window["source_ids"])
            sources.update(window["message_ids"])
            for ref in window["source_refs"]:
                sources.update((ref["source_id"], ref["message_id"], ref["ref_id"]))
                refs[(ref["message_id"], ref["ref_id"], ref["source_id"])] = ref
        traces = connection.execute(
            "SELECT DISTINCT dependency.source_id FROM public.memory_extraction_trace_dependency AS dependency "
            "JOIN public.memory_extraction_trace_link AS link ON link.owner_id=dependency.owner_id "
            "AND link.trace_id=dependency.trace_id WHERE link.owner_id=%s AND "
            "((link.record_kind=%s AND link.record_id=%s) "
            "OR (link.record_kind='candidate' AND link.record_id=%s))",
            (owner_id, record_kind, row["memory_id"], row["source_candidate_id"]),
        ).fetchall()
        sources.update(str(trace["source_id"]) for trace in traces)
        if row["source_candidate_id"]:
            sources.add(str(row["source_candidate_id"]))
        if not source_documents_available(connection, owner_id=owner_id, source_ids=list(sources)):
            raise MemoryCorrectionConflictError("概览完整参与来源正在删除。")
        original_ref_ids = ({UUID(ref["ref_id"]) for window in original_windows for ref in window["source_refs"]}
                            if original_known else None)
        if contact_id is None and windows:
            original_ref_ids = {UUID(ref["ref_id"]) for window in windows for ref in window["source_refs"]}
        direct = capture_message_snapshot(connection, owner_id=owner_id,
            contact_id=contact_id, message_ids=set(row["memory_source_ids"]),
            source_ids=tuple(row["memory_source_ids"]), ref_ids=original_ref_ids)
        sources.update(direct["source_ids"])
        source_rows = connection.execute(
            "SELECT id,status,source_type,content_sha256 FROM public.source_document "
            "WHERE owner_id=%s AND id=ANY(%s::uuid[]) ORDER BY id", (owner_id, list(sources)),
        ).fetchall()
        # 只绑定实际冻结窗口／追踪已登记的记忆身份，不扫描或输出本人正文。
        context_records = []
        for kind, table in (("contact_memory", "confirmed_memory"), ("owner_memory", "owner_memory")):
            context = connection.execute(
                "SELECT id,revision,status,text_content,category,topic,source_ids,source_candidate_id,"
                "adoption_method,valid_at,invalid_at,supersedes_memory_id,event,version_evidence "
                f"FROM public.{table} WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND id<>%s ORDER BY id",
                (owner_id, list(sources), row["memory_id"]),
            ).fetchall()
            context_records.extend({"record_kind": kind, "memory_id": str(item["id"]),
                "revision": item["revision"], "status": item["status"], "record_sha256": _digest(item)}
                for item in context)
        return {"source_ids": sorted(sources), "source_refs": sorted(refs.values(), key=lambda item: item["ref_id"]),
                "context_records": context_records,
                "original_known": original_known or (
                    contact_id is None and row["source_candidate_id"] is None and bool(windows)
                ),
                "original_ref_ids": original_ref_ids,
                "generation_sha256": _digest({"frozen_windows": windows, "direct": direct,
                    "dimension_evidence": candidate["dimension_evidence"] if candidate else None,
                    "sources": source_rows, "context_records": context_records,
                    "trace_dependency_ids": sorted(str(item["source_id"]) for item in traces)})}

    @staticmethod
    def _owner_original_candidates(connection, owner_id: UUID, row: dict) -> set[str]:
        """修正版本仍须核对实际原 SELF 身份；不替旧 NULL 来源窗口补证。"""
        current = row
        visited = set()
        dependencies = set()
        for _ in range(100):
            identifier = current["memory_id"]
            if identifier in visited or current["owner_id"] != owner_id or current["status"] == "deleted":
                raise MemoryCorrectionConflictError("本人资料的原始版本关联不可核验。")
            visited.add(identifier)
            candidate_id = current["source_candidate_id"]
            if candidate_id is not None:
                candidate = connection.execute("SELECT subject FROM public.memory_candidate WHERE owner_id=%s AND id=%s",
                                               (owner_id, candidate_id)).fetchone()
                if candidate is None or candidate["subject"] != "self":
                    raise MemoryCorrectionConflictError("本人资料的原主体关联已变化。")
                dependencies.add(str(candidate_id))
            previous_id = current["supersedes_memory_id"]
            if previous_id is None:
                return dependencies
            dependencies.add(str(previous_id))
            current = connection.execute(
                f"SELECT {_OWNER_MEMORY_COLUMNS} FROM public.owner_memory WHERE owner_id=%s AND id=%s",
                (owner_id, previous_id),
            ).fetchone()
            if current is None:
                raise MemoryCorrectionConflictError("本人资料的原始版本已清除。")
        raise MemoryCorrectionConflictError("本人资料的原始版本链超出核对范围。")

    @staticmethod
    def _references(connection, scope: ContactScope | UUID, identifiers: tuple[UUID, ...],
                    *, ref_ids: set[UUID] | None) -> tuple[OverviewSourceReference, ...]:
        owner_id = scope.owner_id if isinstance(scope, ContactScope) else scope
        contact_id = scope.contact_id if isinstance(scope, ContactScope) else None
        refs = connection.execute(
            f"SELECT ref.id,ref.message_id,ref.contact_id,ref.source_kind,ref.source_locator,"
            "COALESCE(ref.source_document_id,ref.observation_id) AS source_id "
            "FROM public.message_source_ref AS ref JOIN public.contact AS contact "
            "ON contact.owner_id=ref.owner_id AND contact.id=ref.contact_id "
            "WHERE ref.owner_id=%s AND (%s::uuid IS NULL OR ref.contact_id=%s) "
            f"AND (ref.message_id=ANY(%s::uuid[]) OR ref.source_document_id=ANY(%s::uuid[]) "
            f"OR ref.observation_id=ANY(%s::uuid[])) AND {active_source_ref_sql()} "
            "AND (%s::uuid[] IS NULL OR ref.id=ANY(%s::uuid[])) ORDER BY ref.message_id,ref.id",
            (owner_id, contact_id, contact_id, list(identifiers), list(identifiers), list(identifiers),
             list(ref_ids) if ref_ids is not None else None, list(ref_ids) if ref_ids is not None else None),
        ).fetchall()
        result = [OverviewSourceReference(row["source_id"],
                  "local_wechat_observation" if row["source_kind"] == "local_wechat_observation" else "source_document",
                  row["message_id"], row["id"], row["source_locator"] if contact_id else None,
                  row["contact_id"] if not contact_id else None) for row in refs]
        represented = {ref.source_id for ref in result}
        sources = connection.execute(
            "SELECT id,source_type,contact_id FROM public.source_document WHERE owner_id=%s "
            "AND (%s::uuid IS NULL OR contact_id=%s) "
            "AND id=ANY(%s::uuid[]) AND status='active' ORDER BY id",
            (owner_id, contact_id, contact_id, list(identifiers)),
        ).fetchall()
        result.extend(OverviewSourceReference(row["id"], "manual" if row["source_type"] == "manual" else "source_document",
                                             contact_id=row["contact_id"] if contact_id is None else None)
                      for row in sources if row["id"] not in represented)
        return tuple(result)

    @staticmethod
    def _bind_dependencies(entries: list[OverviewEntry], dependencies: list[dict]) -> list[OverviewEntry]:
        by_id = {item["memory_id"]: item["source_ids"] for item in dependencies}
        return [replace(entry, dependency_ids=tuple(UUID(item) for item in by_id[str(entry.memory.memory_id)]))
                for entry in entries]

    @staticmethod
    def _bind_leaves(entries: list[OverviewEntry]) -> list[OverviewEntry]:
        children = {}
        for entry in entries:
            previous = entry.memory.supersedes_memory_id
            if previous is not None:
                if previous in children:
                    raise OverviewUnavailable("资料版本关系不唯一，请核对底层资料。")
                children[previous] = entry
        result = []
        for entry in entries:
            current, visited = entry, set()
            while current.memory.memory_id in children:
                if current.memory.memory_id in visited or len(visited) >= 100:
                    raise OverviewUnavailable("资料版本链超出可核对范围。")
                visited.add(current.memory.memory_id)
                current = children[current.memory.memory_id]
            leaf = (OverviewMemoryIdentity(current.memory.memory_id, current.memory.revision)
                    if current.memory.status is ConfirmedMemoryStatus.ACTIVE else None)
            result.append(OverviewEntry(entry.memory, leaf, entry.provenance_kind, entry.references, entry.dependency_ids))
        return result
