"""记忆命令的组装辅助：模型、存储、消息加载。"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID

import psycopg
from langchain_core.language_models import BaseChatModel
from psycopg.rows import dict_row

from notalone.memory_extraction.models import MessageRef, MessageSender
from notalone.memory_trace.context import event_payload, snapshot
from notalone.memory_trace.transport import build_trace_http_client
from notalone.persistence import (
    PostgresMemoryStore,
    PostgresOutboundLedger,
    PostgresOwnerMemoryStore,
    PostgresWatermarkStore,
)
from notalone.persistence.extraction_trace import PostgresExtractionTraceStore
from notalone.persistence.message_sources import (
    source_ref_content_sha_sql,
    active_source_ref_sql, valid_source_ref_exists_sql,
)
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.scopes import ContactScope


@dataclass(frozen=True, slots=True)
class ExtractionComponents:
    """一次提取命令需要的全部外部依赖。"""

    model: BaseChatModel
    model_name: str
    memory_store: PostgresMemoryStore
    owner_store: PostgresOwnerMemoryStore
    ledger: PostgresOutboundLedger
    watermark: PostgresWatermarkStore
    trace_store: PostgresExtractionTraceStore


def build_extraction_components(database_url: str, *, max_retries: int = 2) -> ExtractionComponents:
    model = build_deepseek_model(
        extra_body={"thinking": {"type": "enabled"}},
        http_client=build_trace_http_client(),
        max_retries=max_retries,
    )
    return ExtractionComponents(
        model=model,
        model_name=getattr(model, "model_name", "deepseek"),
        memory_store=PostgresMemoryStore(database_url),
        owner_store=PostgresOwnerMemoryStore(database_url),
        ledger=PostgresOutboundLedger(database_url),
        watermark=PostgresWatermarkStore(database_url),
        trace_store=PostgresExtractionTraceStore(database_url),
    )


def load_contact_messages(
    scope: ContactScope,
    database_url: str,
    *,
    selection_receipts: list[dict[str, Any]] | None = None,
    message_ids: tuple[UUID, ...] | None = None,
) -> tuple[MessageRef, ...]:
    """按时间正序读取联系人范围内 active 来源的消息。"""

    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        rows = connection.execute(
            f"""
            SELECT message.id AS message_id,
                   message.speaker,
                   message.message_type,
                   message.text_content,
                   message.media_placeholder,
                   message.occurred_at,
                   COALESCE((SELECT jsonb_agg(jsonb_build_object(
                       'source_ref_id', ref.id, 'source_id', COALESCE(ref.source_document_id,ref.observation_id),
                       'source_kind', ref.source_kind, 'locator', ref.source_locator,
                       'capture_layer', COALESCE(processing.payload->>'capture_layer', 'legacy_projection'),
                       'raw_payload', ref.raw_payload,
                       'source_content_sha256', ({source_ref_content_sha_sql()}),
                       'processing_status', CASE
                           WHEN processing.status='recorded'
                             AND processing.payload->>'capture_layer'='parsed_only' THEN 'partial'
                           ELSE COALESCE(processing.status, 'missing') END,
                       'processing_record', CASE WHEN processing.record_id IS NULL THEN NULL
                           ELSE to_jsonb(processing) END,
                       'source_recorded_at', ref.created_at
                   ) ORDER BY ref.created_at,ref.id) FROM public.message_source_ref AS ref
                   LEFT JOIN LATERAL (
                       SELECT record.*,batch.status FROM public.source_processing_record AS record
                       JOIN public.source_processing_batch AS batch USING (batch_id,owner_id,contact_id)
                       WHERE record.source_ref_id=ref.id AND record.owner_id=ref.owner_id
                         AND record.contact_id=ref.contact_id
                       ORDER BY batch.recorded_at DESC,batch.batch_id DESC LIMIT 1
                   ) AS processing ON true
                   WHERE ref.message_id=message.id AND ref.owner_id=message.owner_id
                     AND ref.contact_id=message.contact_id
                     AND {active_source_ref_sql()}), '[]'::jsonb) AS source_snapshots
            FROM public.message AS message
            WHERE message.owner_id = %s
              AND message.contact_id = %s
              AND (%s::uuid[] IS NULL OR message.id=ANY(%s::uuid[]))
              AND {valid_source_ref_exists_sql("message")}
            ORDER BY message.occurred_at NULLS LAST, message.created_at, message.id
            """,
            (scope.owner_id, scope.contact_id, list(message_ids) if message_ids is not None else None,
             list(message_ids) if message_ids is not None else None),
        ).fetchall()
    messages = []
    rule_version = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    for index, row in enumerate(rows):
        started_at = datetime.now(timezone.utc)
        text = row["text_content"] or row["media_placeholder"] or ""
        occurred = row["occurred_at"]
        reason = "selected"
        if row["speaker"] == "contact":
            sender = MessageSender.CONTACT
        elif row["speaker"] == "user":
            sender = MessageSender.SELF
        else:
            sender = None
            reason = "unsupported_sender"
        if reason == "selected" and not text.strip():
            reason = "empty_text"
        if reason == "selected" and occurred is None:
            reason = "missing_occurred_at"
        if selection_receipts is not None:
            selection_receipts.append(
                event_payload(
                    {
                        "message_id": str(row["message_id"]),
                        "read_position": index,
                        "speaker": row["speaker"],
                        "included": reason == "selected",
                        "reason": reason,
                        "sender": sender.value if sender else None,
                        "text_field": (
                            "text_content"
                            if row["text_content"]
                            else "media_placeholder"
                        ),
                        "occurred_at": snapshot(occurred),
                        "source_ref_ids": [
                            item["source_ref_id"]
                            for item in row["source_snapshots"]
                        ],
                    },
                    started_at=started_at,
                    rule_version=rule_version,
                    status="selected" if reason == "selected" else "filtered",
                )
            )
        if reason != "selected" or sender is None:
            continue
        messages.append(
            MessageRef(
                message_id=row["message_id"],
                text=text,
                sender=sender,
                occurred_at=occurred,
                source_snapshots=tuple(row["source_snapshots"]),
                message_type=row["message_type"],
                text_representation=(
                    "placeholder" if not row["text_content"]
                    else "text" if row["message_type"] == "text"
                    else "unknown"
                ),
                message_snapshot={
                    "capture_layer": "normalized_message_row",
                    "speaker": row["speaker"],
                    "message_type": row["message_type"],
                    "text_content": row["text_content"],
                    "media_placeholder": row["media_placeholder"],
                    "occurred_at": snapshot(occurred),
                },
            )
        )
    return tuple(messages)


def contact_exists(scope: ContactScope, database_url: str) -> bool:
    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            """
            SELECT 1 FROM public.contact
            WHERE owner_id = %s AND id = %s
            """,
            (scope.owner_id, scope.contact_id),
        ).fetchone()
    return row is not None


def owner_exists(owner_id: UUID, database_url: str) -> bool:
    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT 1 FROM public.owner WHERE id = %s",
            (owner_id,),
        ).fetchone()
    return row is not None
