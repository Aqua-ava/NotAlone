"""来源处理正文与业务资料同事务保存，公开查询始终校验范围。"""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.memory_trace.context import snapshot
from notalone.persistence.extraction_trace import erase_source_traces
from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.scopes import ContactScope
from notalone.source_processing.models import ProcessingRecord


class SourceProcessingWriteError(RuntimeError):
    """写入失败关闭；错误不包含正文、SQL 或连接配置。"""

    def __init__(self) -> None:
        super().__init__("来源处理记录写入失败，本批未继续保存。")


def save_processing_batch(
    connection: psycopg.Connection[Any],
    *,
    scope: ContactScope,
    source_kind: str,
    source_id: UUID | None,
    records: tuple[ProcessingRecord, ...],
    receipts: dict[str, dict[str, Any]],
    status: str = "recorded",
) -> UUID:
    """只在已校验授权范围的调用方事务内保存真实处理和提交收据。"""

    batch_id = uuid4()
    try:
        for record in records:
            deleted_capture = connection.execute(
                "SELECT 1 FROM public.source_processing_capture_tombstone WHERE owner_id=%s AND contact_id=%s AND capture_record_id=%s",
                (scope.owner_id, scope.contact_id, record.record_id),
            ).fetchone()
            if deleted_capture is not None:
                raise SourceProcessingWriteError()
        connection.execute(
            "INSERT INTO public.source_processing_batch (batch_id, owner_id, contact_id, source_kind, source_id, status) VALUES (%s, %s, %s, %s, %s, %s)",
            (
                batch_id,
                scope.owner_id,
                scope.contact_id,
                source_kind,
                source_id,
                status,
            ),
        )
        for position, record in enumerate(records):
            receipt = receipts.get(
                str(record.record_id), receipts.get(record.locator, {})
            )
            payload = record.payload()
            outcome = receipt.get(
                "outcome", payload.get("outcome", "filtered")
            )
            connection.execute(
                "INSERT INTO public.source_processing_record (record_id, batch_id, owner_id, contact_id, position, locator, message_id, source_ref_id, outcome, payload) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    uuid4(),
                    batch_id,
                    scope.owner_id,
                    scope.contact_id,
                    position,
                    record.locator,
                    receipt.get("message_id"),
                    receipt.get("source_ref_id"),
                    outcome,
                    Jsonb(
                        {
                            **payload,
                            "capture_record_id": str(record.record_id),
                            "persistence": snapshot(receipt),
                            "model_read_status": "not_claimed",
                        }
                    ),
                ),
            )
    except (psycopg.Error, TypeError, ValueError):
        raise SourceProcessingWriteError() from None
    return batch_id


class PostgresSourceProcessingStore:
    """导入／同步处理记录的可查询、可手动删除边界。"""

    def __init__(self, database_url: str):
        if not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self.database_url = database_url

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
                    "SELECT * FROM public.source_processing_batch WHERE owner_id=%s AND contact_id=%s ORDER BY recorded_at DESC, batch_id LIMIT %s",
                    (scope.owner_id, scope.contact_id, limit),
                ).fetchall()
        except psycopg.Error:
            raise RuntimeError("来源处理记录读取失败。") from None
        return tuple(snapshot(row) for row in rows)

    def get_batch(
        self, scope: ContactScope, batch_id: UUID | str
    ) -> dict[str, Any]:
        try:
            with psycopg.connect(
                self.database_url, row_factory=dict_row
            ) as connection:
                connection.execute(
                    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
                )
                row = connection.execute(
                    "SELECT * FROM public.source_processing_batch WHERE batch_id=%s AND owner_id=%s AND contact_id=%s",
                    (batch_id, scope.owner_id, scope.contact_id),
                ).fetchone()
                if row is None:
                    raise LookupError("指定联系人范围内不存在该处理记录。")
                records = connection.execute(
                    "SELECT * FROM public.source_processing_record WHERE batch_id=%s AND owner_id=%s AND contact_id=%s ORDER BY position",
                    (batch_id, scope.owner_id, scope.contact_id),
                ).fetchall()
        except psycopg.Error:
            raise RuntimeError("来源处理记录读取失败。") from None
        return snapshot({**row, "records": records})

    def find_record(
        self, scope: ContactScope, record_kind: str, record_id: UUID | str
    ) -> dict[str, Any]:
        column = {
            "message": "record.message_id",
            "source_ref": "record.source_ref_id",
            "source_document": "batch.source_id",
            "local_wechat_observation": "batch.source_id",
        }.get(record_kind)
        if column is None:
            raise ValueError("不支持的来源处理关联类型。")
        source_kind_filter = (
            f" AND batch.source_kind='{record_kind}'"
            if record_kind in {"source_document", "local_wechat_observation"}
            else ""
        )
        try:
            with psycopg.connect(
                self.database_url, row_factory=dict_row
            ) as connection:
                rows = connection.execute(
                    f"SELECT DISTINCT batch.* FROM public.source_processing_batch AS batch JOIN public.source_processing_record AS record USING (batch_id, owner_id, contact_id) WHERE batch.owner_id=%s AND batch.contact_id=%s AND {column}=%s{source_kind_filter} ORDER BY batch.recorded_at DESC, batch.batch_id",
                    (scope.owner_id, scope.contact_id, record_id),
                ).fetchall()
        except psycopg.Error:
            raise RuntimeError("来源处理记录读取失败。") from None
        return snapshot(
            {
                "availability": (
                    "recorded"
                    if any(row["status"] != "deleted" for row in rows)
                    else "deleted" if rows else "not_recorded"
                ),
                "batches": rows,
            }
        )

    def delete_batch(self, scope: ContactScope, batch_id: UUID | str) -> None:
        try:
            with psycopg.connect(self.database_url) as connection:
                lock_contact_scope(
                    connection,
                    owner_id=scope.owner_id,
                    contact_id=scope.contact_id,
                )
                lock_owner_scope(connection, owner_id=scope.owner_id)
                row = connection.execute(
                    "SELECT source_id FROM public.source_processing_batch WHERE batch_id=%s AND owner_id=%s AND contact_id=%s FOR UPDATE",
                    (batch_id, scope.owner_id, scope.contact_id),
                ).fetchone()
                if row is None:
                    raise LookupError("指定联系人范围内不存在该处理记录。")
                erase_processing_batches(
                    connection, scope=scope, batch_ids=[batch_id]
                )
                if row[0] is not None:
                    # 原行可能已进入多个窗口；保守清除全部来源相关追踪副本。
                    erase_source_traces(
                        connection,
                        owner_id=scope.owner_id,
                        removed_ids={row[0]},
                        reason="source_processing_deleted",
                    )
        except psycopg.Error:
            raise RuntimeError("来源处理记录删除失败。") from None


def erase_processing_batches(
    connection: psycopg.Connection[Any],
    *,
    scope: ContactScope,
    batch_ids: list[Any],
) -> None:
    connection.execute(
        "INSERT INTO public.source_processing_capture_tombstone (owner_id,contact_id,capture_record_id) SELECT owner_id,contact_id,(payload->>'capture_record_id')::uuid FROM public.source_processing_record WHERE owner_id=%s AND contact_id=%s AND batch_id=ANY(%s::uuid[]) AND payload->>'capture_record_id' IS NOT NULL ON CONFLICT DO NOTHING",
        (scope.owner_id, scope.contact_id, batch_ids),
    )
    connection.execute(
        "UPDATE public.source_processing_record SET payload=NULL, locator=NULL, outcome='deleted' WHERE owner_id=%s AND contact_id=%s AND batch_id=ANY(%s::uuid[])",
        (scope.owner_id, scope.contact_id, batch_ids),
    )
    connection.execute(
        "UPDATE public.source_processing_batch SET status='deleted', deleted_at=COALESCE(deleted_at,now()) WHERE owner_id=%s AND contact_id=%s AND batch_id=ANY(%s::uuid[])",
        (scope.owner_id, scope.contact_id, batch_ids),
    )


def erase_source_processing(
    connection: psycopg.Connection[Any],
    *,
    scope: ContactScope,
    source_id: UUID,
) -> None:
    rows = connection.execute(
        "SELECT batch_id FROM public.source_processing_batch WHERE owner_id=%s AND contact_id=%s AND source_id=%s FOR UPDATE",
        (scope.owner_id, scope.contact_id, source_id),
    ).fetchall()
    erase_processing_batches(
        connection, scope=scope, batch_ids=[row[0] for row in rows]
    )
