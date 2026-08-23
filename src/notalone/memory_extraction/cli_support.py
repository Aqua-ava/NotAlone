"""记忆命令的组装辅助：模型、存储、消息加载。"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from notalone.memory_extraction.models import MessageRef, MessageSender
from notalone.persistence import (
    PostgresMemoryStore,
    PostgresOwnerMemoryStore,
    PostgresOutboundLedger,
    PostgresWatermarkStore,
)
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.scopes import ContactScope


@dataclass(frozen=True, slots=True)
class ExtractionComponents:
    """一次提取命令需要的全部外部依赖。"""

    model: object
    model_name: str
    memory_store: PostgresMemoryStore
    owner_store: PostgresOwnerMemoryStore
    ledger: PostgresOutboundLedger
    watermark: PostgresWatermarkStore


def build_extraction_components(database_url: str) -> ExtractionComponents:
    model = build_deepseek_model()
    return ExtractionComponents(
        model=model,
        model_name=getattr(model, "model_name", "deepseek"),
        memory_store=PostgresMemoryStore(database_url),
        owner_store=PostgresOwnerMemoryStore(database_url),
        ledger=PostgresOutboundLedger(database_url),
        watermark=PostgresWatermarkStore(database_url),
    )


def load_contact_messages(
    scope: ContactScope, database_url: str
) -> tuple[MessageRef, ...]:
    """按时间正序读取联系人范围内 active 来源的消息。"""

    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        rows = connection.execute(
            """
            SELECT message.id AS message_id,
                   message.speaker,
                   message.text_content,
                   message.media_placeholder,
                   message.occurred_at
            FROM public.message AS message
            JOIN public.source_document AS source
              ON source.id = message.source_document_id
            WHERE message.owner_id = %s
              AND message.contact_id = %s
              AND source.status = 'active'
            ORDER BY message.occurred_at NULLS LAST, message.id
            """,
            (scope.owner_id, scope.contact_id),
        ).fetchall()
    messages = []
    for row in rows:
        if row["speaker"] == "contact":
            sender = MessageSender.CONTACT
        elif row["speaker"] == "user":
            sender = MessageSender.SELF
        else:
            continue
        text = row["text_content"] or row["media_placeholder"] or ""
        if not text.strip():
            continue
        occurred = row["occurred_at"]
        if occurred is None:
            continue
        messages.append(
            MessageRef(
                message_id=row["message_id"],
                text=text,
                sender=sender,
                occurred_at=occurred,
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
