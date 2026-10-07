"""PostgreSQL 独立追踪存储，联系人隔离与水位同事务结束。"""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.memory_trace.context import event_payload, snapshot
from notalone.memory_trace.ports import TraceWriteError
from notalone.memory_trace.views import candidate_summaries
from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.scopes import ContactScope


class PostgresExtractionTraceStore:
    """记录正文与非正文运行状态分层；持久化错误不回显驱动详情。"""

    def __init__(self, database_url: str) -> None:
        if not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self.database_url = database_url

    def begin(
        self,
        scope: ContactScope,
        *,
        run_id: UUID,
        batch_key: str,
        payload: dict[str, Any],
    ) -> UUID:
        trace_id = uuid4()
        try:
            with psycopg.connect(self.database_url) as connection:
                lock_contact_scope(
                    connection,
                    owner_id=scope.owner_id,
                    contact_id=scope.contact_id,
                )
                lock_owner_scope(connection, owner_id=scope.owner_id)
                previous = connection.execute(
                    (
                        "SELECT trace_id FROM public.memory_extraction_trace WHERE "
                        "owner_id=%s AND contact_id=%s AND batch_key=%s ORDER BY "
                        "started_at DESC LIMIT 1"
                    ),
                    (scope.owner_id, scope.contact_id, batch_key),
                ).fetchone()
                connection.execute(
                    (
                        "INSERT INTO public.memory_extraction_trace "
                        "(trace_id,owner_id,contact_id,run_id,batch_key,retry_of) VALUES "
                        "(%s,%s,%s,%s,%s,%s)"
                    ),
                    (
                        trace_id,
                        scope.owner_id,
                        scope.contact_id,
                        run_id,
                        batch_key,
                        previous[0] if previous else None,
                    ),
                )
                self._append(
                    connection,
                    scope,
                    trace_id,
                    stage="window",
                    payload=payload,
                    dependency_ids=self._resolve_dependencies(
                        connection,
                        scope.owner_id,
                        tuple(
                            UUID(item["message_id"])
                            for item in payload["messages"]
                        ),
                    ),
                )
                if previous:
                    with connection.cursor(row_factory=dict_row) as cursor:
                        links = cursor.execute(
                            (
                                "SELECT candidate_trace_id,record_kind,record_id,commit_status "
                                "FROM public.memory_extraction_trace_link WHERE trace_id=%s AND "
                                "owner_id=%s AND contact_id=%s"
                            ),
                            (previous[0], scope.owner_id, scope.contact_id),
                        ).fetchall()
                        receipts = self._write_receipts(
                            cursor, scope, links, observed_after_failure=True
                        )
                    self._append(
                        connection,
                        scope,
                        trace_id,
                        stage="recovery_reconciliation",
                        payload={
                            "previous_trace_id": str(previous[0]),
                            "receipts": receipts,
                            "capture_layer": "authoritative_records_at_retry",
                            "historical_return_reconstructed": False,
                        },
                    )
        except Exception:
            raise TraceWriteError("window", trace_id) from None
        return trace_id

    def append(
        self,
        scope: ContactScope,
        trace_id: UUID,
        *,
        stage: str,
        payload: dict[str, Any],
        candidate_trace_id: UUID | None = None,
        call_id: UUID | None = None,
        links: tuple[dict[str, Any], ...] = (),
        dependency_ids: tuple[UUID, ...] = (),
    ) -> None:
        try:
            with psycopg.connect(self.database_url) as connection:
                lock_contact_scope(
                    connection,
                    owner_id=scope.owner_id,
                    contact_id=scope.contact_id,
                )
                lock_owner_scope(connection, owner_id=scope.owner_id)
                self._append(
                    connection,
                    scope,
                    trace_id,
                    stage=stage,
                    payload=payload,
                    candidate_trace_id=candidate_trace_id,
                    call_id=call_id,
                    links=links,
                    dependency_ids=self._resolve_dependencies(
                        connection, scope.owner_id, dependency_ids
                    ),
                )
        except Exception:
            raise TraceWriteError(stage, trace_id) from None

    @staticmethod
    def _resolve_dependencies(
        connection: psycopg.Connection, owner_id: UUID, ids: tuple[UUID, ...]
    ) -> tuple[UUID, ...]:
        if not ids:
            return ()
        existing = connection.execute(
            """
            SELECT id FROM public.source_document WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND status='active'
            UNION SELECT id FROM public.local_wechat_observation WHERE owner_id=%s AND id=ANY(%s::uuid[])
            UNION SELECT message.id FROM public.message AS message WHERE message.owner_id=%s AND message.id=ANY(%s::uuid[])
                AND EXISTS (SELECT 1 FROM public.message_source_ref AS ref WHERE ref.message_id=message.id
                    AND ref.owner_id=message.owner_id AND (ref.observation_id IS NOT NULL OR EXISTS(
                        SELECT 1 FROM public.source_document AS source WHERE source.id=ref.source_document_id
                          AND source.owner_id=ref.owner_id AND source.status='active')))
            UNION SELECT id FROM public.confirmed_memory WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND status <> 'deleted'
            UNION SELECT id FROM public.owner_memory WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND status <> 'deleted'
            UNION SELECT id FROM public.memory_candidate WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND status='pending'
        """,
            tuple(value for _ in range(6) for value in (owner_id, list(ids))),
        ).fetchall()
        if {row[0] for row in existing} != set(ids):
            raise TraceWriteError("source_dependency")
        rows = connection.execute(
            (
                "SELECT COALESCE(source_document_id,observation_id) FROM "
                "public.message_source_ref WHERE owner_id=%s AND "
                "message_id=ANY(%s::uuid[])"
            ),
            (owner_id, list(ids)),
        ).fetchall()
        return tuple(dict.fromkeys((*ids, *(row[0] for row in rows))))

    @staticmethod
    def _append(
        connection: psycopg.Connection,
        scope: ContactScope,
        trace_id: UUID,
        *,
        stage: str,
        payload: dict[str, Any],
        candidate_trace_id: UUID | None = None,
        call_id: UUID | None = None,
        links: tuple[dict[str, Any], ...] = (),
        dependency_ids: tuple[UUID, ...] = (),
    ) -> None:
        row = connection.execute(
            (
                "SELECT status FROM public.memory_extraction_trace WHERE "
                "trace_id=%s AND owner_id=%s AND contact_id=%s FOR UPDATE"
            ),
            (trace_id, scope.owner_id, scope.contact_id),
        ).fetchone()
        if row is None or row[0] != "running":
            raise TraceWriteError(stage, trace_id)
        stored_payload = (
            payload if "_execution" in payload else event_payload(payload)
        )
        connection.execute(
            (
                "INSERT INTO public.memory_extraction_trace_event "
                "(event_id,trace_id,owner_id,contact_id,position,stage,payload,candidate_trace_id,call_id) SELECT %s,%s,%s,%s,COALESCE(max(position),0)+1,%s,%s,%s,%s FROM public.memory_extraction_trace_event WHERE trace_id=%s"
            ),
            (
                uuid4(),
                trace_id,
                scope.owner_id,
                scope.contact_id,
                stage,
                Jsonb(snapshot(stored_payload)),
                candidate_trace_id,
                call_id,
                trace_id,
            ),
        )
        for link in links:
            connection.execute(
                (
                    "INSERT INTO public.memory_extraction_trace_link "
                    "(trace_id,owner_id,contact_id,candidate_trace_id,record_kind,record_id,commit_status) VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (trace_id,record_kind,record_id) DO UPDATE SET commit_status=EXCLUDED.commit_status"
                ),
                (
                    trace_id,
                    scope.owner_id,
                    scope.contact_id,
                    candidate_trace_id,
                    link["record_kind"],
                    UUID(str(link["record_id"])),
                    link["commit_status"],
                ),
            )
        for source_id in dependency_ids:
            connection.execute(
                (
                    "INSERT INTO public.memory_extraction_trace_dependency "
                    "(trace_id,owner_id,contact_id,source_id) VALUES (%s,%s,%s,%s) ON "
                    "CONFLICT DO NOTHING"
                ),
                (trace_id, scope.owner_id, scope.contact_id, source_id),
            )

    def complete(
        self,
        scope: ContactScope,
        trace_id: UUID,
        *,
        status: str,
        payload: dict[str, Any],
        watermark_port: Any = None,
        watermark_message_id: UUID | None = None,
        failure_state: Any = None,
        skipped_range: Any = None,
    ) -> None:
        try:
            with psycopg.connect(self.database_url) as connection:
                lock_contact_scope(
                    connection,
                    owner_id=scope.owner_id,
                    contact_id=scope.contact_id,
                )
                lock_owner_scope(connection, owner_id=scope.owner_id)
                if watermark_port is not None:
                    if (
                        getattr(watermark_port, "database_url", None)
                        != self.database_url
                    ):
                        raise TraceWriteError("batch_end", trace_id)
                    watermark_port.finish_in_transaction(
                        connection,
                        scope,
                        last_message_id=watermark_message_id,
                        failure_state=failure_state,
                        skipped_range=skipped_range,
                    )
                self._append(
                    connection,
                    scope,
                    trace_id,
                    stage="batch_end",
                    payload=payload,
                )
                connection.execute(
                    (
                        "UPDATE public.memory_extraction_trace SET "
                        "status=%s,finished_at=now() WHERE trace_id=%s AND owner_id=%s AND "
                        "contact_id=%s"
                    ),
                    (status, trace_id, scope.owner_id, scope.contact_id),
                )
        except Exception:
            raise TraceWriteError("batch_end", trace_id) from None

    def mark_failed(
        self,
        scope: ContactScope,
        trace_id: UUID,
        *,
        stage: str,
        error_code: str,
    ) -> None:
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                (
                    "UPDATE public.memory_extraction_trace SET "
                    "status=%s,failure_stage=%s,error_code=%s,finished_at=now() WHERE "
                    "trace_id=%s AND owner_id=%s AND contact_id=%s AND status = "
                    "'running'"
                ),
                (
                    (
                        "trace_failed"
                        if error_code == "trace_write_failed"
                        else "business_failed"
                    ),
                    stage,
                    error_code,
                    trace_id,
                    scope.owner_id,
                    scope.contact_id,
                ),
            )
            connection.execute(
                (
                    "UPDATE public.memory_extraction_trace_link SET "
                    "commit_status='unknown' WHERE trace_id=%s AND owner_id=%s AND "
                    "contact_id=%s AND commit_status='planned'"
                ),
                (trace_id, scope.owner_id, scope.contact_id),
            )

    def list_batches(
        self, scope: ContactScope, *, limit: int = 100
    ) -> tuple[dict[str, Any], ...]:
        if not 0 < limit <= 500:
            raise ValueError("查询数量必须在 1 到 500 之间。")
        try:
            with psycopg.connect(
                self.database_url, row_factory=dict_row
            ) as connection:
                rows = connection.execute(
                    (
                        "SELECT * FROM public.memory_extraction_trace WHERE owner_id=%s "
                        "AND contact_id=%s ORDER BY started_at DESC LIMIT %s"
                    ),
                    (scope.owner_id, scope.contact_id, limit),
                ).fetchall()
        except psycopg.Error:
            raise RuntimeError("记忆提取追踪读取失败。") from None
        return tuple(snapshot(row) for row in rows)

    def get_batch(
        self, scope: ContactScope, trace_id: UUID | str
    ) -> dict[str, Any]:
        try:
            with psycopg.connect(
                self.database_url, row_factory=dict_row
            ) as connection:
                connection.execute(
                    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
                )
                row = connection.execute(
                    (
                        "SELECT * FROM public.memory_extraction_trace WHERE trace_id=%s "
                        "AND owner_id=%s AND contact_id=%s"
                    ),
                    (trace_id, scope.owner_id, scope.contact_id),
                ).fetchone()
                if row is None:
                    raise LookupError("指定联系人范围内不存在该追踪。")
                events = connection.execute(
                    (
                        "SELECT * FROM public.memory_extraction_trace_event WHERE "
                        "trace_id=%s AND owner_id=%s AND contact_id=%s ORDER BY position"
                    ),
                    (trace_id, scope.owner_id, scope.contact_id),
                ).fetchall()
                links = connection.execute(
                    (
                        "SELECT candidate_trace_id,record_kind,record_id,commit_status "
                        "FROM public.memory_extraction_trace_link WHERE trace_id=%s AND "
                        "owner_id=%s AND contact_id=%s ORDER BY record_kind,record_id"
                    ),
                    (trace_id, scope.owner_id, scope.contact_id),
                ).fetchall()
                receipts = self._write_receipts(
                    connection,
                    scope,
                    links,
                    observed_after_failure=row["status"]
                    in {"trace_failed", "business_failed", "model_failed"},
                )
        except psycopg.Error:
            raise RuntimeError("记忆提取追踪读取失败。") from None
        return snapshot(
            {
                **row,
                "events": events,
                "links": links,
                "write_receipts": receipts,
                "candidates": candidate_summaries(events),
            }
        )

    @staticmethod
    def _write_receipts(
        connection: Any,
        scope: ContactScope,
        links: list[dict[str, Any]],
        *,
        observed_after_failure: bool,
    ) -> list[dict[str, Any]]:
        """只核对当前权威提交标识；不补造当时未记录的模型理由或返回快照。"""
        receipts = []
        tables = {
            "candidate": "memory_candidate",
            "contact_memory": "confirmed_memory",
            "owner_memory": "owner_memory",
        }
        for link in links:
            kind = link["record_kind"]
            clause = " AND contact_id=%s" if kind != "owner_memory" else ""
            parameters = (
                (scope.owner_id, link["record_id"], scope.contact_id)
                if clause
                else (scope.owner_id, link["record_id"])
            )
            row = connection.execute(
                f"SELECT id,status FROM public.{tables[kind]} WHERE owner_id=%s AND id=%s{clause}",
                parameters,
            ).fetchone()
            if link["commit_status"] != "committed":
                link["commit_status"] = (
                    "committed" if row is not None else "unknown"
                )
            receipts.append(
                {
                    "record_kind": kind,
                    "record_id": str(link["record_id"]),
                    "commit_status": link["commit_status"],
                    "current_record_status": (
                        row["status"] if row else "not_present"
                    ),
                    "observed_after_failure": observed_after_failure,
                    "capture_layer": "authoritative_current_record",
                    "historical_return_reconstructed": False,
                }
            )
            if kind == "candidate":
                for target_kind, table in (
                    ("contact_memory", "confirmed_memory"),
                    ("owner_memory", "owner_memory"),
                ):
                    memories = connection.execute(
                        f"SELECT id,status FROM public.{table} WHERE owner_id=%s AND source_candidate_id=%s",
                        (scope.owner_id, link["record_id"]),
                    ).fetchall()
                    receipts.extend(
                        {
                            "record_kind": target_kind,
                            "record_id": str(memory["id"]),
                            "source_candidate_id": str(link["record_id"]),
                            "commit_status": "committed",
                            "current_record_status": memory["status"],
                            "observed_after_failure": observed_after_failure,
                            "capture_layer": "authoritative_current_record",
                            "historical_return_reconstructed": False,
                        }
                        for memory in memories
                    )
        return receipts

    def find_record(
        self, scope: ContactScope, record_kind: str, record_id: UUID
    ) -> dict[str, Any]:
        if record_kind not in {"candidate", "contact_memory", "owner_memory"}:
            raise ValueError("追踪记录类型无效。")
        try:
            with psycopg.connect(
                self.database_url, row_factory=dict_row
            ) as connection:
                connection.execute(
                    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
                )
                candidate_id = None
                origin = None
                if record_kind == "contact_memory":
                    origin = connection.execute(
                        (
                            "SELECT source_candidate_id,source_ids FROM "
                            "public.confirmed_memory WHERE owner_id=%s AND contact_id=%s AND "
                            "id=%s"
                        ),
                        (scope.owner_id, scope.contact_id, record_id),
                    ).fetchone()
                    candidate_id = (
                        origin["source_candidate_id"] if origin else None
                    )
                elif record_kind == "owner_memory":
                    origin = connection.execute(
                        (
                            "SELECT memory.source_candidate_id,memory.source_ids FROM "
                            "public.owner_memory AS memory JOIN public.memory_candidate AS "
                            "candidate ON candidate.id=memory.source_candidate_id AND "
                            "candidate.owner_id=memory.owner_id WHERE memory.owner_id=%s AND "
                            "candidate.contact_id=%s AND memory.id=%s"
                        ),
                        (scope.owner_id, scope.contact_id, record_id),
                    ).fetchone()
                    candidate_id = (
                        origin["source_candidate_id"] if origin else None
                    )
                else:
                    origin = connection.execute(
                        (
                            "SELECT source_ids FROM public.memory_candidate WHERE owner_id=%s "
                            "AND contact_id=%s AND id=%s"
                        ),
                        (scope.owner_id, scope.contact_id, record_id),
                    ).fetchone()
                rows = connection.execute(
                    (
                        "SELECT DISTINCT trace.* FROM public.memory_extraction_trace AS "
                        "trace JOIN public.memory_extraction_trace_link AS link USING "
                        "(trace_id,owner_id,contact_id) WHERE link.owner_id=%s AND "
                        "link.contact_id=%s AND ((link.record_kind=%s AND "
                        "link.record_id=%s) OR (link.record_kind='candidate' AND "
                        "link.record_id=%s)) ORDER BY trace.started_at DESC"
                    ),
                    (
                        scope.owner_id,
                        scope.contact_id,
                        record_kind,
                        record_id,
                        candidate_id,
                    ),
                ).fetchall()
                manual_only = False
                if not rows and origin and origin["source_ids"]:
                    sources = connection.execute(
                        (
                            "SELECT id FROM public.source_document WHERE owner_id=%s AND "
                            "contact_id=%s AND source_type='manual' AND id=ANY(%s::uuid[])"
                        ),
                        (
                            scope.owner_id,
                            scope.contact_id,
                            origin["source_ids"],
                        ),
                    ).fetchall()
                    manual_only = {str(row["id"]) for row in sources} == {
                        str(value) for value in origin["source_ids"]
                    }
        except psycopg.Error:
            raise RuntimeError("记忆提取追踪读取失败。") from None
        return snapshot(
            {
                "availability": (
                    "recorded"
                    if any(row["status"] != "deleted" for row in rows)
                    else (
                        "deleted"
                        if rows
                        else (
                            "not_applicable" if manual_only else "not_recorded"
                        )
                    )
                ),
                "batches": rows,
            }
        )

    def delete_batch(self, scope: ContactScope, trace_id: UUID | str) -> None:
        try:
            with psycopg.connect(self.database_url) as connection:
                lock_contact_scope(
                    connection,
                    owner_id=scope.owner_id,
                    contact_id=scope.contact_id,
                )
                row = connection.execute(
                    (
                        "SELECT 1 FROM public.memory_extraction_trace WHERE trace_id=%s "
                        "AND owner_id=%s AND contact_id=%s FOR UPDATE"
                    ),
                    (trace_id, scope.owner_id, scope.contact_id),
                ).fetchone()
                if row is None:
                    raise LookupError("指定联系人范围内不存在该追踪。")
                erase_trace_bodies(
                    connection,
                    owner_id=scope.owner_id,
                    trace_ids=(UUID(str(trace_id)),),
                    reason="manual",
                )
        except psycopg.Error:
            raise RuntimeError("记忆提取追踪删除失败。") from None


def erase_trace_bodies(
    connection: psycopg.Connection,
    *,
    owner_id: UUID,
    trace_ids: tuple[UUID, ...],
    reason: str,
) -> None:
    if not trace_ids:
        return
    connection.execute(
        (
            "DELETE FROM public.memory_extraction_trace_event WHERE "
            "owner_id=%s AND trace_id=ANY(%s::uuid[])"
        ),
        (owner_id, list(trace_ids)),
    )
    connection.execute(
        (
            "DELETE FROM public.memory_extraction_trace_dependency WHERE "
            "owner_id=%s AND trace_id=ANY(%s::uuid[])"
        ),
        (owner_id, list(trace_ids)),
    )
    connection.execute(
        (
            "UPDATE public.memory_extraction_trace SET "
            "status='deleted',deletion_reason=%s,failure_stage=NULL,error_code=NULL WHERE owner_id=%s AND trace_id=ANY(%s::uuid[])"
        ),
        (reason, owner_id, list(trace_ids)),
    )


def erase_source_traces(
    connection: psycopg.Connection, *, owner_id: UUID, removed_ids: set[UUID]
) -> None:
    """删除来源的同一事务内清除包含它的整份追踪，覆盖其他联系人的本人记忆。"""
    rows = connection.execute(
        (
            "SELECT DISTINCT trace_id FROM "
            "public.memory_extraction_trace_dependency WHERE owner_id=%s AND "
            "source_id=ANY(%s::uuid[])"
        ),
        (owner_id, list(removed_ids)),
    ).fetchall()
    erase_trace_bodies(
        connection,
        owner_id=owner_id,
        trace_ids=tuple(row[0] for row in rows),
        reason="source_deleted",
    )


def erase_record_traces(
    connection: psycopg.Connection,
    *,
    owner_id: UUID,
    record_kind: str,
    record_id: UUID,
) -> None:
    """单条资料删除也清除含它的过程副本，保留无正文删除状态。"""
    candidate_id = None
    if record_kind in {"contact_memory", "owner_memory"}:
        table = (
            "confirmed_memory"
            if record_kind == "contact_memory"
            else "owner_memory"
        )
        row = connection.execute(
            f"SELECT source_candidate_id FROM public.{table} WHERE owner_id=%s AND id=%s",
            (owner_id, record_id),
        ).fetchone()
        candidate_id = (
            (row["source_candidate_id"] if isinstance(row, dict) else row[0])
            if row
            else None
        )
    rows = connection.execute(
        """
        SELECT trace_id FROM public.memory_extraction_trace_link WHERE owner_id=%s
            AND ((record_kind=%s AND record_id=%s) OR (record_kind='candidate' AND record_id=%s))
        UNION SELECT trace_id FROM public.memory_extraction_trace_dependency WHERE owner_id=%s AND source_id=%s
    """,
        (owner_id, record_kind, record_id, candidate_id, owner_id, record_id),
    ).fetchall()
    erase_trace_bodies(
        connection,
        owner_id=owner_id,
        trace_ids=tuple(
            row["trace_id"] if isinstance(row, dict) else row[0]
            for row in rows
        ),
        reason="memory_deleted",
    )
