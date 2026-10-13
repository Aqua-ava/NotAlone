"""候选读取时复核整个依据窗口，不借另一有效来源恢复旧证明。"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import psycopg

from notalone.memory.dimension_evidence import DimensionEvidence, EvidenceMessage
from notalone.memory.evidence_binding import (
    bind_dimension_evidence, content_digest, source_state_digest,
)
from notalone.memory.models import MemoryCandidate
from notalone.persistence.message_sources import (
    active_source_ref_sql, source_ref_content_sha_sql, valid_source_ref_exists_sql,
)


def has_dimension_evidence(connection: psycopg.Connection[Any]) -> bool:
    """旧业务结构只读保持未知；此查询不会执行迁移。"""

    row = connection.execute("""
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='memory_candidate'
              AND column_name='dimension_evidence'
        ) AS present
    """).fetchone()
    if row is None:
        raise ValueError("无法核对维度依据字段结构。")
    return bool(row["present"] if isinstance(row, dict) else row[0])


def residual_source_evidence_sql(source_alias: str) -> str:
    """删除复核包含所有状态候选的上下文依据；旧列缺席时为空。"""

    return f"""
    EXISTS (
        SELECT 1 FROM public.memory_candidate AS candidate
        WHERE candidate.owner_id={source_alias}.owner_id
          AND candidate.contact_id={source_alias}.contact_id
          AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(COALESCE(
                  to_jsonb(candidate)->'dimension_evidence'->'messages',
                  '[]'::jsonb
              )) AS message
              WHERE EXISTS (
                  SELECT 1 FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(message->'source_refs')='array'
                           THEN message->'source_refs' ELSE '[]'::jsonb END
                  ) AS ref
                  WHERE ref->>'source_id'={source_alias}.id::text
              )
          )
    )
    """


def erase_dimension_evidence(
    connection: psycopg.Connection[Any], *, owner_id: UUID,
    contact_id: UUID, removed_ids: set[UUID],
) -> None:
    """上下文来源也进入删除依赖；候选仍有其他直接来源时只清除证明。"""

    if not has_dimension_evidence(connection):
        return
    connection.execute("""
        UPDATE public.memory_candidate
        SET dimension_evidence=NULL, updated_at=now()
        WHERE owner_id=%s AND contact_id=%s AND dimension_evidence IS NOT NULL
          AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(dimension_evidence->'messages') AS message
              WHERE message->>'message_id'=ANY(%s)
                 OR EXISTS (
                     SELECT 1 FROM jsonb_array_elements(
                         CASE WHEN jsonb_typeof(message->'source_refs')='array'
                              THEN message->'source_refs' ELSE '[]'::jsonb END
                     ) AS ref
                     WHERE ref->>'source_id'=ANY(%s)
                 )
          )
    """, (owner_id, contact_id, [str(item) for item in removed_ids],
             [str(item) for item in removed_ids]))


def bind_stored_dimension_evidence(
    connection: psycopg.Connection[Any], candidate: MemoryCandidate,
    *, lock_sources: bool = False,
) -> DimensionEvidence | None:
    evidence = candidate.dimension_evidence
    if evidence is None:
        return None
    rows = connection.execute(
        f"""
        SELECT message.id AS message_id, message.speaker, message.message_type,
               message.text_content, message.media_placeholder, message.occurred_at,
               COALESCE((
                   SELECT jsonb_agg(jsonb_build_object(
                       'source_ref_id', ref.id,
                       'source_id', COALESCE(ref.source_document_id, ref.observation_id),
                       'source_kind', ref.source_kind, 'locator', ref.source_locator,
                       'raw_payload', ref.raw_payload,
                       'source_content_sha256', ({source_ref_content_sha_sql()})
                   ) ORDER BY ref.id)
                   FROM public.message_source_ref AS ref
                   WHERE ref.owner_id=message.owner_id
                     AND ref.contact_id=message.contact_id
                     AND ref.message_id=message.id AND {active_source_ref_sql()}
               ), '[]'::jsonb) AS source_refs
        FROM public.message AS message
        WHERE message.owner_id=%s AND message.contact_id=%s AND message.id=ANY(%s)
          AND {valid_source_ref_exists_sql('message')}
        {"FOR SHARE OF message" if lock_sources else ""}
        """,
        (candidate.scope.owner_id, candidate.scope.contact_id,
         [item.message_id for item in evidence.messages]),
    ).fetchall()
    by_id = {row["message_id"]: row for row in rows}
    messages = []
    texts = {}
    for original in evidence.messages:
        row = by_id.get(original.message_id)
        if row is None:
            continue
        text = row["text_content"] or row["media_placeholder"] or ""
        texts[original.message_id] = text
        messages.append(EvidenceMessage(
            original.message_id, content_digest(text), len(text),
            "self" if row["speaker"] == "user" else row["speaker"],
            row["message_type"], row["occurred_at"],
            tuple(
                (UUID(ref["source_ref_id"]), UUID(ref["source_id"]))
                for ref in row["source_refs"]
            ),
            (
                "placeholder" if not row["text_content"]
                else "text" if row["message_type"] == "text"
                else "unknown"
            ),
            source_state_digest(row["source_refs"]),
        ))
    return bind_dimension_evidence(
        evidence, scope=candidate.scope, candidate=candidate,
        messages=tuple(messages), texts=texts,
    )
