"""只供显式合成执行使用的内存追踪，不用于生产持久化装配。"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from notalone.memory_trace.context import snapshot
from notalone.memory_trace.status import failure_status
from notalone.memory_trace.views import candidate_summaries
from notalone.scopes import ContactScope


class InMemoryTraceStore:
    """合成资料的可查询 Adapter，接口与 PostgreSQL 追踪一致。"""

    def __init__(self) -> None:
        self._batches: dict[UUID, dict[str, Any]] = {}

    def begin(
        self,
        scope: ContactScope,
        *,
        run_id: UUID,
        batch_key: str,
        payload: dict[str, Any],
    ) -> UUID:
        trace_id = uuid4()
        prior = next(
            (
                row["trace_id"]
                for row in reversed(list(self._batches.values()))
                if row["scope"] == scope and row["batch_key"] == batch_key
            ),
            None,
        )
        self._batches[trace_id] = {
            "trace_id": str(trace_id),
            "scope": scope,
            "run_id": str(run_id),
            "batch_key": batch_key,
            "retry_of": prior,
            "status": "running",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "events": [],
            "links": [],
            "calls": [],
        }
        self.append(
            scope,
            trace_id,
            stage="window",
            payload=payload,
            links=tuple(
                {
                    "record_kind": "message",
                    "record_id": item["message_id"],
                    "commit_status": "committed",
                    "operation": "input",
                }
                for item in payload.get("messages", ())
            ),
        )
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
        row = self._row(scope, trace_id)
        if row["status"] == "deleted":
            raise RuntimeError("追踪正文已删除。")
        row["events"].append(
            snapshot(
                {
                    "position": len(row["events"]) + 1,
                    "stage": stage,
                    "payload": payload,
                    "candidate_trace_id": candidate_trace_id,
                    "call_id": call_id,
                }
            )
        )
        for link in links:
            found = next(
                (
                    item
                    for item in row["links"]
                    if item["record_kind"] == link["record_kind"]
                    and item["record_id"] == str(link["record_id"])
                ),
                None,
            )
            if found:
                found.update(snapshot(link))
            else:
                row["links"].append(
                    snapshot(
                        {**link, "candidate_trace_id": candidate_trace_id}
                    )
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
        self.append(scope, trace_id, stage="batch_end", payload=payload)
        if watermark_port is not None:
            if skipped_range is not None:
                watermark_port.mark_skipped(scope, skipped_range)
            elif watermark_message_id is not None:
                watermark_port.set(scope, watermark_message_id)
            elif failure_state is not None:
                watermark_port.save_failure(scope, failure_state)
        self._row(scope, trace_id)["status"] = status

    def mark_failed(
        self,
        scope: ContactScope,
        trace_id: UUID,
        *,
        stage: str,
        error_code: str,
    ) -> None:
        row = self._row(scope, trace_id)
        if row["status"] == "running":
            row.update(
                status=failure_status(error_code),
                failure_stage=stage,
                error_code=error_code,
            )

    def record_call(
        self, scope: ContactScope, trace_id: UUID, *, receipt: dict[str, Any]
    ) -> None:
        row = self._row(scope, trace_id)
        for call in row["calls"]:
            if call["call_id"] == receipt["call_id"]:
                call.update(snapshot(receipt))
                return
        row["calls"].append(snapshot(receipt))

    def _row(
        self, scope: ContactScope, trace_id: UUID | str
    ) -> dict[str, Any]:
        row = self._batches.get(UUID(str(trace_id)))
        if row is None or row["scope"] != scope:
            raise LookupError("指定联系人范围内不存在该追踪。")
        return row

    def list_batches(
        self,
        scope: ContactScope,
        *,
        limit: int = 100,
        before: UUID | str | None = None,
    ) -> tuple[dict[str, Any], ...]:
        if not 0 < limit <= 500:
            raise ValueError("查询数量必须在 1 到 500 之间。")
        cursor = self._row(scope, before) if before is not None else None
        rows = sorted(
            self._batches.values(),
            key=lambda row: (row["started_at"], row["trace_id"]),
            reverse=True,
        )
        return tuple(
            snapshot(
                {
                    key: value
                    for key, value in row.items()
                    if key not in {"scope", "events", "links", "calls"}
                }
            )
            for row in rows
            if row["scope"] == scope
            and (
                cursor is None
                or (row["started_at"], row["trace_id"])
                < (cursor["started_at"], cursor["trace_id"])
            )
        )[:limit]

    def get_batch(
        self, scope: ContactScope, trace_id: UUID | str
    ) -> dict[str, Any]:
        row = self._row(scope, trace_id)
        return snapshot(
            {
                **{key: value for key, value in row.items() if key != "scope"},
                "candidates": candidate_summaries(row["events"]),
            }
        )

    def find_record(
        self, scope: ContactScope, record_kind: str, record_id: UUID
    ) -> dict[str, Any]:
        rows = [
            row
            for row in self.list_batches(scope)
            if any(
                link["record_kind"] == record_kind
                and link["record_id"] == str(record_id)
                for link in self._row(scope, row["trace_id"])["links"]
            )
        ]
        return {
            "availability": (
                "recorded"
                if any(row["status"] != "deleted" for row in rows)
                else "deleted" if rows else "not_recorded"
            ),
            "batches": rows,
        }

    def delete_batch(self, scope: ContactScope, trace_id: UUID | str) -> None:
        row = self._row(scope, trace_id)
        row.update(status="deleted", events=[])
