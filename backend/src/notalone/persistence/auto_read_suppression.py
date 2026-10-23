"""自动来源删除后的稳定身份抑制；调用方持有联系人锁并管理事务。"""
from __future__ import annotations
from typing import Any
import re
from uuid import UUID
import psycopg
from notalone.ingest.models import NormalizedMessage
from notalone.source_processing.models import ProcessingRecord


def suppress_source(connection: psycopg.Connection[Any], *, owner_id: UUID,
                    contact_id: UUID, source_id: UUID) -> None:
    """在移除引用前登记，保留其他有效来源，不保存正文或来源标识。"""
    connection.execute("""
        INSERT INTO public.wechat_auto_read_suppression
            (owner_id, contact_id, external_local_id, identity_create_time)
        SELECT DISTINCT m.owner_id, m.contact_id, m.external_local_id,
               COALESCE(m.source_create_time, -1)
        FROM public.wechat_message_metadata m
        JOIN public.message_source_ref r ON r.owner_id=m.owner_id
          AND r.contact_id=m.contact_id AND r.message_id=m.message_id
        WHERE m.owner_id=%s AND m.contact_id=%s
          AND (r.source_document_id=%s OR r.observation_id=%s)
        ON CONFLICT DO NOTHING
    """, (owner_id, contact_id, source_id, source_id))


def _record_identity(record: ProcessingRecord) -> tuple[int, int] | None:
    parsed = record.payload().get("parsed")
    if not isinstance(parsed, dict):
        return None
    event = parsed.get("message", parsed)
    if not isinstance(event, dict):
        return None
    identity = event.get("message_id", event.get("id"))
    if not isinstance(identity, dict):
        return None
    local_id, time = identity.get("local_id"), event.get("create_time")
    # 接受无损十进制整数表示；不截断浮点、不用布尔值或缺失身份猜测。
    def integer(value: object) -> int | None:
        if type(value) is int:
            return value
        if isinstance(value, str) and re.fullmatch(r"-?(?:0|[1-9][0-9]*)", value):
            return int(value)
        return None
    local_id = integer(local_id)
    time = -1 if time is None else integer(time)
    if local_id is None or time is None:
        return None
    return local_id, time


def _message_identity(message: NormalizedMessage) -> tuple[int, int] | None:
    metadata = message.wechat_metadata
    if metadata is None:
        return None
    return (metadata.external_local_id,
            metadata.source_create_time if metadata.source_create_time is not None else -1)


def filter_auto_read(connection: psycopg.Connection[Any], *, owner_id: UUID,
                     contact_id: UUID, messages: tuple[NormalizedMessage, ...],
                     records: tuple[ProcessingRecord, ...] = (),
                     ) -> tuple[tuple[NormalizedMessage, ...], tuple[ProcessingRecord, ...]]:
    """仅批量查询当前页稳定身份；消息与原始处理记录统一过滤。"""
    message_keys = [_message_identity(message) for message in messages]
    record_keys = [_record_identity(record) for record in records]
    candidates = {key for key in (*message_keys, *record_keys) if key is not None}
    if not candidates:
        return messages, records
    pairs = sorted(candidates)
    keys = set(connection.execute("""
        SELECT s.external_local_id, s.identity_create_time
        FROM unnest(%s::bigint[], %s::bigint[]) AS candidate(local_id, create_time)
        JOIN public.wechat_auto_read_suppression s
          ON s.external_local_id=candidate.local_id
         AND s.identity_create_time=candidate.create_time
         AND s.owner_id=%s AND s.contact_id=%s
    """, ([key[0] for key in pairs], [key[1] for key in pairs], owner_id, contact_id)).fetchall())
    blocked_ids = {message.processing_record.record_id
                   for message, key in zip(messages, message_keys)
                   if key in keys and message.processing_record is not None}
    # 整份丢弃原始/规范化载荷，不将被删正文转存到处理收据。
    return (
        tuple(message for message, key in zip(messages, message_keys) if key not in keys),
        tuple(record for record, key in zip(records, record_keys)
              if record.record_id not in blocked_ids and key not in keys),
    )
