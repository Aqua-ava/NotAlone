"""本轮页面的固定合成时间状态，不读取业务资料或改变质量放行。"""

from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import psycopg
from psycopg.types.json import Jsonb

from notalone.memory import AdoptionMethod, MemoryCandidate, MemoryCategory
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.scopes import ContactScope


def prepare_memory_current_status(fixture, contact_id: str) -> dict[str, str]:
    scope = ContactScope(fixture.owner_id, UUID(contact_id))
    current = datetime.now(timezone(timedelta(hours=8)))
    start = current.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end = (start.replace(year=start.year + 1, month=1) if start.month == 12
           else start.replace(month=start.month + 1))
    source_id = uuid4()
    rows = (
        ("unverified", "合成旧近况：最近在加班。", datetime(2024, 1, 1, tzinfo=timezone.utc), None, None),
        ("verified", "合成当期近况：这个月在加班。", start, start, end),
        ("historical", "合成历史近况：这个月在加班。", datetime(2025, 1, 1, tzinfo=timezone.utc),
         datetime(2025, 1, 1, tzinfo=timezone.utc), datetime(2025, 2, 1, tzinfo=timezone.utc)),
        ("dynamic", "合成职业近况：对方是建筑师。", datetime(2024, 1, 1, tzinfo=timezone.utc), None, None),
        ("narrow", "合成窄时段：这个月仅晚上在加班。", start, start, end),
    )
    store = PostgresMemoryStore(fixture.database_url)
    result = {"source_id": str(source_id)}
    with psycopg.connect(fixture.database_url) as connection:
        connection.execute("""INSERT INTO public.source_document
            (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
            VALUES (%s,%s,%s,'wechat_jsonl','memory-current-status.jsonl',%s,%s)""",
            (source_id, scope.owner_id, scope.contact_id, uuid4().hex * 2, len(rows)))
    for name, text, occurred_at, valid_at, invalid_at in rows:
        message_id = uuid4()
        with psycopg.connect(fixture.database_url) as connection:
            connection.execute("""INSERT INTO public.message
                (id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
                VALUES (%s,%s,%s,'contact','text',%s,%s)""",
                (message_id, scope.owner_id, scope.contact_id, text, occurred_at))
            connection.execute("""INSERT INTO public.message_source_ref
                (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
                VALUES (%s,%s,%s,'source_document',%s,%s,%s)""",
                (message_id, scope.owner_id, scope.contact_id, source_id, name,
                 Jsonb({"time_iso": occurred_at.isoformat()})))
        candidate = store.create_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=scope, text=text,
            category=MemoryCategory.COMMON_FACT if name == "dynamic" else MemoryCategory.RECENT_STATE,
            source_ids=(message_id,), valid_at=valid_at, invalid_at=invalid_at,
        ))
        memory = store.confirm(scope=scope, candidate_id=candidate.candidate_id, adoption_method=AdoptionMethod.MANUAL)
        result[f"{name}_memory_id"] = str(memory.memory_id)
    for level, text in (("contact", "合成稳定偏好：一直喜欢咖啡。"), ("owner", "合成本人偏好：不喜欢甜食。")):
        body = {"text": text, "category": "preference"}
        if level == "contact":
            body["contact_id"] = contact_id
        endpoint = (f"/api/contacts/{contact_id}/owner-memories" if level == "owner"
                    else f"/api/memories/manual-{level}")
        status, saved = fixture.backend.request(endpoint, body)
        if status != 200:
            raise RuntimeError("合成稳定资料准备失败。")
        result[f"{level}_stable_memory_id"] = saved["memory"]["memory_id"]
    return result
