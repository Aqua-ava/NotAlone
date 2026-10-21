"""纠错依据的无正文窗口快照；只复验已参与的消息和引用。"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
from dataclasses import dataclass, field
import hashlib
import json
from typing import Any
from uuid import UUID

import psycopg

from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.memory.dimension_evidence import evidence_timestamp
from notalone.memory.evidence_binding import content_digest, source_state_digest
from notalone.persistence.message_sources import active_source_ref_sql, source_ref_content_sha_sql


@dataclass
class _SnapshotReadScope:
    connection: psycopg.Connection[Any]
    snapshots: dict[tuple, dict[str, Any]] = field(default_factory=dict)
    source_availability: dict[tuple, bool] = field(default_factory=dict)
    reference_rows: dict[tuple[UUID, UUID], dict[str, Any]] = field(default_factory=dict)
    reference_snapshots: dict[tuple[UUID, UUID], dict[str, Any]] = field(default_factory=dict)
    message_snapshots: dict[tuple, dict[str, Any]] = field(default_factory=dict)


_snapshot_read_scope: ContextVar[_SnapshotReadScope | None] = ContextVar(
    "message_snapshot_read_scope", default=None,
)


@contextmanager
def reuse_message_snapshots(connection: psycopg.Connection[Any]) -> Iterator[None]:
    """仅复用一次持 owner 锁或稳定只读事务中的来源读取。

    调用方不得在作用域中修改来源或提交事务；每次进入独立建表，退出立即
    丢弃。生成前、模型返回后与提交时的来源复验必须各自重新读取。
    """
    scope = _SnapshotReadScope(connection)
    token = _snapshot_read_scope.set(scope)
    try:
        yield
    finally:
        scope.snapshots.clear()
        scope.source_availability.clear()
        scope.reference_rows.clear()
        scope.reference_snapshots.clear()
        scope.message_snapshots.clear()
        _snapshot_read_scope.reset(token)


def read_source_availability(
    connection: psycopg.Connection[Any], *, owner_id: UUID, kind: str,
    identifiers: Iterable[UUID | str], read: Callable[[], bool],
) -> bool:
    """来源或引用活动性沿同一只读作用域复用；作用域外始终重新查询。"""
    scope = _snapshot_read_scope.get()
    if scope is None or scope.connection is not connection:
        return read()
    key = (owner_id, kind, frozenset(str(identifier) for identifier in identifiers))
    if key not in scope.source_availability:
        scope.source_availability[key] = read()
    return scope.source_availability[key]


def capture_message_snapshot(
    connection: psycopg.Connection[Any], *, owner_id: UUID, message_ids: set[UUID],
    contact_id: UUID | None = None, source_ids: tuple[UUID, ...] = (),
    ref_ids: set[UUID] | None = None,
) -> dict[str, Any]:
    """完整查询范围一致时复用本次读取；返回独立副本供后续合并。"""
    current = _read_message_snapshot(connection, owner_id=owner_id, message_ids=message_ids,
        contact_id=contact_id, source_ids=source_ids, ref_ids=ref_ids)
    scope = _snapshot_read_scope.get()
    return deepcopy(current) if scope is not None and scope.connection is connection else current


def _read_message_snapshot(
    connection: psycopg.Connection[Any], *, owner_id: UUID, message_ids: set[UUID],
    contact_id: UUID | None = None, source_ids: tuple[UUID, ...] = (),
    ref_ids: set[UUID] | None = None,
) -> dict[str, Any]:
    """内部只读视图；验证函数只比较，绝不修改或向调用者暴露缓存值。"""
    scope = _snapshot_read_scope.get()
    if scope is None or scope.connection is not connection:
        return _capture_message_snapshot(connection, owner_id=owner_id, message_ids=message_ids,
            contact_id=contact_id, source_ids=source_ids, ref_ids=ref_ids)
    key = (owner_id, contact_id, frozenset(message_ids), frozenset(source_ids),
           None if ref_ids is None else frozenset(ref_ids))
    if key not in scope.snapshots:
        scope.snapshots[key] = _capture_message_snapshot(connection,
            owner_id=owner_id, message_ids=message_ids, contact_id=contact_id,
            source_ids=source_ids, ref_ids=ref_ids)
    return scope.snapshots[key]


def _query_message_rows(connection, *, owner_id, contact_id, message_ids, source_ids, ref_ids):
    return connection.execute(
        f"""SELECT message.id, message.contact_id, message.text_content, message.media_placeholder,
                   message.speaker, message.message_type, message.occurred_at, ref.id AS ref_id,
                   COALESCE(ref.source_document_id, ref.observation_id) AS source_id,
                   ref.source_kind, ref.source_locator, ref.raw_payload,
                   ref.source_document_id, ref.observation_id,
                   ({source_ref_content_sha_sql()}) AS source_digest
        FROM public.message AS message
        JOIN public.message_source_ref AS ref ON ref.message_id=message.id
          AND ref.owner_id=message.owner_id AND ref.contact_id=message.contact_id
        WHERE message.owner_id=%s AND (%s::uuid IS NULL OR message.contact_id=%s)
          AND (message.id=ANY(%s::uuid[]) OR ref.source_document_id=ANY(%s::uuid[])
               OR ref.observation_id=ANY(%s::uuid[])) AND {active_source_ref_sql()}
          AND (%s::uuid[] IS NULL OR ref.id=ANY(%s::uuid[]))
        ORDER BY message.id, ref.id""",
        (owner_id, contact_id, contact_id, list(message_ids), list(source_ids), list(source_ids),
         list(ref_ids) if ref_ids is not None else None,
         list(ref_ids) if ref_ids is not None else None),
    ).fetchall()


def _snapshot_rows(connection, *, owner_id, contact_id, message_ids, source_ids, ref_ids):
    scope = _snapshot_read_scope.get()
    cache = scope.reference_rows if scope is not None and scope.connection is connection else None
    cached = []
    missing = ref_ids
    if cache is not None and ref_ids is not None:
        # 仅缓存原 SQL 实际返回的活动引用；受限查询未返回不表示全局不存在。
        missing = {identifier for identifier in ref_ids if (owner_id, identifier) not in cache}
        source_set = set(source_ids)
        for identifier in ref_ids - missing:
            row = cache[owner_id, identifier]
            if ((contact_id is None or row["contact_id"] == contact_id)
                    and (row["id"] in message_ids or row["source_document_id"] in source_set
                         or row["observation_id"] in source_set)):
                cached.append(row)
    if missing is None or missing:
        rows = _query_message_rows(connection, owner_id=owner_id, contact_id=contact_id,
            message_ids=message_ids, source_ids=source_ids, ref_ids=missing)
        if cache is not None:
            cache.update(((owner_id, row["ref_id"]), row) for row in rows)
        cached.extend(rows)
    return sorted(cached, key=lambda row: (row["id"], row["ref_id"]))


def _capture_message_snapshot(
    connection: psycopg.Connection[Any], *, owner_id: UUID, message_ids: set[UUID],
    contact_id: UUID | None = None, source_ids: tuple[UUID, ...] = (),
    ref_ids: set[UUID] | None = None,
) -> dict[str, Any]:
    """新捕获限制本联系人；旧上下文仅沿冻结 UUID 读取，不扫描其他联系人。"""
    rows = _snapshot_rows(connection, owner_id=owner_id, contact_id=contact_id,
        message_ids=message_ids, source_ids=source_ids, ref_ids=ref_ids)
    scope = _snapshot_read_scope.get()
    shared = scope if scope is not None and scope.connection is connection else None
    messages: dict[str, list[dict[str, Any]]] = {}
    refs = []
    sources = {str(item) for item in source_ids}
    for row in rows:
        key = str(row["id"])
        messages.setdefault(key, []).append(row)
        sources.update((key, str(row["source_id"])))
        reference_key = (owner_id, row["ref_id"])
        ref = shared.reference_snapshots.get(reference_key) if shared is not None else None
        if ref is None:
            ref = {"message_id": key, "ref_id": str(row["ref_id"]),
                   "source_id": str(row["source_id"]), "digest": hashlib.sha256(json.dumps(
                       [row["source_kind"], row["source_locator"], row["raw_payload"], row["source_digest"]],
                       sort_keys=True, ensure_ascii=False,
                   ).encode()).hexdigest()}
            if shared is not None:
                shared.reference_snapshots[reference_key] = ref
        refs.append(ref)
    snapshots = {}
    for key, group in messages.items():
        message_key = (owner_id, key, tuple(item["ref_id"] for item in group))
        if shared is not None and message_key in shared.message_snapshots:
            snapshots[key] = shared.message_snapshots[message_key]
            continue
        row = group[0]
        text = row["text_content"] or row["media_placeholder"] or ""
        # 字段沿 EvidenceMessage 的摘要约定；不保存正文或来源载荷副本。
        snapshots[key] = {
            "message_id": key, "text_sha256": content_digest(text), "text_length": len(text),
            "sender": "self" if row["speaker"] == "user" else row["speaker"],
            "message_type": row["message_type"], "occurred_at": evidence_timestamp(row["occurred_at"]),
            "text_representation": ("placeholder" if not row["text_content"]
                                    else "text" if row["message_type"] == "text" else "unknown"),
            "source_refs": [{"ref_id": str(item["ref_id"]), "source_id": str(item["source_id"])}
                            for item in group],
            "source_state_sha256": source_state_digest(tuple({
                "source_ref_id": str(item["ref_id"]), "source_id": str(item["source_id"]),
                "source_kind": item["source_kind"], "locator": item["source_locator"],
                "raw_payload": item["raw_payload"], "source_content_sha256": item["source_digest"],
            } for item in group)),
        }
        if shared is not None:
            shared.message_snapshots[message_key] = snapshots[key]
    return {"version": 1, "message_ids": sorted(messages), "source_ids": sorted(sources),
            "source_refs": refs, "message_digests": {key: value["text_sha256"] for key, value in snapshots.items()},
            "message_snapshots": snapshots,
            "message_scopes": {key: str(group[0]["contact_id"]) for key, group in messages.items()}}


def validate_frozen_snapshot(
    connection: psycopg.Connection[Any], *, owner_id: UUID, evidence: dict[str, Any],
) -> None:
    """旧字段缺失保持未知；绝不用当前摘要回填旧窗口的证明。"""
    if evidence.get("kind") == "generation_unknown":
        raise MemoryCorrectionConflictError("参与提取的旧窗口世代未知。")
    identifiers = set(evidence["message_ids"])
    if (set(evidence.get("message_snapshots", {})) != identifiers
            or set(evidence.get("message_scopes", {})) != identifiers):
        raise MemoryCorrectionConflictError("参与提取的旧窗口世代未知，请重新取得当前依据。")
    current = _read_message_snapshot(
        connection, owner_id=owner_id, message_ids={UUID(item) for item in identifiers},
        ref_ids={UUID(item["ref_id"]) for item in evidence["source_refs"]},
    )
    expected_refs = {(ref["message_id"], ref["ref_id"], ref["source_id"]): ref["digest"]
                     for ref in evidence["source_refs"]}
    current_refs = {(ref["message_id"], ref["ref_id"], ref["source_id"]): ref["digest"]
                    for ref in current["source_refs"]}
    if (current["message_digests"] != evidence["message_digests"]
            or current_refs != expected_refs
            or current["message_scopes"] != evidence["message_scopes"]
            or current["message_snapshots"] != evidence["message_snapshots"]):
        raise MemoryCorrectionConflictError("参与候选的规范消息或来源世代已变化。")


def merge_frozen_snapshot(current: dict[str, Any], frozen: dict[str, Any]) -> None:
    """并入完整旧窗口，冻结值优先；直接证据身份由调用者单独保留。"""
    frozen_ids = set(frozen["message_ids"])
    for key in ("message_ids", "source_ids"):
        current[key] = sorted(set(current[key]) | set(frozen[key]))
    refs = {(item["message_id"], item["ref_id"], item["source_id"]): item
            for item in current["source_refs"] if item["message_id"] not in frozen_ids}
    refs.update({(item["message_id"], item["ref_id"], item["source_id"]): item
                 for item in frozen["source_refs"]})
    current["source_refs"] = sorted(refs.values(), key=lambda item: (item["message_id"], item["ref_id"]))
    current["message_digests"].update(frozen["message_digests"])
    for key in ("message_snapshots", "message_scopes"):
        for identifier in frozen["message_ids"]:
            current[key].pop(identifier, None)
        current[key].update(frozen.get(key, {}))
    if frozen.get("has_memory_context"):
        current["has_memory_context"] = True
