"""历史候选页面的固定合成资料，仅通过测试进程 stdin 控制。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb

from notalone.memory import MemoryCandidate, MemoryCategory
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.scopes import ContactScope


def prepare_historical_reply_basis(fixture, contact_id: str, kind: str) -> dict:
    if kind not in {"contact", "owner", "source_contact"}:
        raise ValueError("历史依据夹具范围无效。")
    text = "我喜欢散步，希望表达轻松自然。"
    source_id = None
    if kind == "source_contact":
        source_id, message_id = uuid4(), uuid4()
        scope = ContactScope(fixture.owner_id, UUID(contact_id))
        occurred_at = datetime.now(timezone.utc)
        with psycopg.connect(fixture.database_url) as connection:
            connection.execute(
                "INSERT INTO public.source_document "
                "(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) "
                "VALUES (%s,%s,%s,'wechat_jsonl','historical-basis-synthetic.jsonl',%s,1)",
                (source_id, scope.owner_id, scope.contact_id, uuid4().hex * 2),
            )
            connection.execute(
                "INSERT INTO public.message "
                "(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) "
                "VALUES (%s,%s,%s,'contact','text',%s,%s)",
                (message_id, scope.owner_id, scope.contact_id, text, occurred_at),
            )
            connection.execute(
                "INSERT INTO public.message_source_ref "
                "(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) "
                "VALUES (%s,%s,%s,'source_document',%s,'synthetic:historical-basis',%s)",
                (message_id, scope.owner_id, scope.contact_id, source_id,
                 Jsonb({"time_iso": occurred_at.isoformat()})),
            )
        store = PostgresMemoryStore(fixture.database_url)
        candidate = store.create_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=scope, text=text,
            category=MemoryCategory.PREFERENCE, source_ids=(message_id,),
        ))
        status, result = fixture.backend.request(
            f"/api/contacts/{contact_id}/memory-candidates/{candidate.candidate_id}/confirm", {},
        )
        fixture.assertEqual(status, 200, result)
        memory_id = result["memory"]["memory_id"]
    else:
        payload = {"text": text, "category": "preference"}
        if kind == "contact":
            payload["contact_id"] = contact_id
        status, result = fixture.backend.request(f"/api/memories/manual-{kind}", payload)
        fixture.assertEqual(status, 200, result)
        memory_id = result["memory"]["memory_id"]
    return {"kind": "owner" if kind == "owner" else "contact", "memoryId": memory_id,
            "sourceId": str(source_id) if source_id else None, "text": text}


def expire_historical_reply_basis(fixture, prepared: dict) -> dict:
    table = "owner_memory" if prepared["kind"] == "owner" else "confirmed_memory"
    current = datetime.now(timezone.utc)
    with psycopg.connect(fixture.database_url) as connection:
        # 可控时效事件只改本夹具精确资料；不修改旧候选、快照或原始来源。
        connection.execute(sql.SQL(
            "UPDATE public.{} SET valid_at=%s, invalid_at=%s WHERE owner_id=%s AND id=%s"
        ).format(sql.Identifier(table)),
            (current - timedelta(days=2), current - timedelta(days=1),
             fixture.owner_id, UUID(prepared["memoryId"])))
    return {"memoryId": prepared["memoryId"]}
