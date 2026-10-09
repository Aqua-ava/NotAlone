"""仅安排本轮来源删除的随机合成库，建库前保存精确归属。"""

import runpy
import sys
from pathlib import Path
from uuid import UUID, uuid4

import psycopg


def prepare_reply(data: dict) -> None:
    from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
    from notalone.persistence.memory_store import PostgresMemoryStore
    from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
    from notalone.memory.models import FactSubject, MemoryCandidate, MemoryCategory
    from notalone.scopes import ContactScope

    owner_id = UUID(data["owner_id"])
    bindings = PostgresConversationBindingRepository(data["database_url"])
    for contact_id in map(UUID, data["contact_ids"]):
        bindings.create_binding(owner_id=owner_id, contact_id=contact_id, channel="wechat",
                                account_scope="source-deletion-synthetic-account",
                                conversation_locator=f"source-deletion-{contact_id}")
    contact_id = UUID(data["contact_ids"][0])
    with psycopg.connect(data["database_url"]) as connection:
        message_id = connection.execute(
            "SELECT id FROM public.message WHERE owner_id=%s AND contact_id=%s ORDER BY id LIMIT 1",
            (owner_id, contact_id),
        ).fetchone()[0]
    candidate = PostgresMemoryStore(data["database_url"]).create_candidate(MemoryCandidate(
        candidate_id=uuid4(), scope=ContactScope(owner_id, contact_id), text="本人喜欢合成绿茶。",
        category=MemoryCategory.PREFERENCE, subject=FactSubject.SELF, source_ids=(message_id,),
    ))
    PostgresOwnerMemoryStore(data["database_url"]).confirm_candidate(candidate=candidate)


def prepare_multi_source(data: dict) -> None:
    from notalone.persistence.memory_store import PostgresMemoryStore
    from notalone.memory.models import MemoryCandidate, MemoryCategory
    from notalone.scopes import ContactScope

    owner_id, contact_id = UUID(data["owner_id"]), UUID(data["contact_ids"][0])
    second_source_id = uuid4()
    with psycopg.connect(data["database_url"]) as connection:
        message_id = connection.execute(
            "SELECT id FROM public.message WHERE owner_id=%s AND contact_id=%s ORDER BY id LIMIT 1",
            (owner_id, contact_id),
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO public.source_document (
                id, owner_id, contact_id, source_type, file_name, content_sha256, record_count
            ) VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic-second.jsonl', %s, 1)""",
            (second_source_id, owner_id, contact_id, uuid4().hex * 2),
        )
        # 与既有跨来源去重契约一致：同一规范消息由两个有效来源支持。
        connection.execute(
            """INSERT INTO public.message_source_ref (
                message_id, owner_id, contact_id, source_kind, source_document_id, source_locator, raw_payload
            ) VALUES (%s, %s, %s, 'source_document', %s, 'synthetic-second:1', '{}'::jsonb)""",
            (message_id, owner_id, contact_id, second_source_id),
        )
    store = PostgresMemoryStore(data["database_url"])
    scope = ContactScope(owner_id, contact_id)
    candidate = store.create_candidate(MemoryCandidate(
        candidate_id=uuid4(), scope=scope, text="两个合成来源共同支持的记忆。",
        category=MemoryCategory.COMMON_FACT, source_ids=(message_id,),
    ))
    store.confirm(scope=scope, candidate_id=candidate.candidate_id)


if __name__ == "__main__":
    fixture = runpy.run_path(str(Path(__file__).with_name("contact-database.py")))
    if len(sys.argv) == 4 and sys.argv[1] == "create" and sys.argv[3] in ("basic", "reply", "multi-source"):
        import json

        data = fixture["create_database"]("ready", sys.argv[2])
        if sys.argv[3] == "reply":
            prepare_reply(data)
        elif sys.argv[3] == "multi-source":
            prepare_multi_source(data)
        print(json.dumps(data))
    elif len(sys.argv) == 3 and sys.argv[1] == "drop":
        fixture["drop_database"](sys.argv[2])
    else:
        raise ValueError("只允许本轮来源删除库的具名准备和精确清理。")
