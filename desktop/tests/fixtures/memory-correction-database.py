"""人工纠错页面的独立合成证据；不读取已有业务资料。"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from uuid import UUID, uuid4

import psycopg

from notalone.memory.models import AdoptionMethod, MemoryCandidate, MemoryCategory
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.scopes import ContactScope

spec = importlib.util.spec_from_file_location(
    "correction_contact_fixture", Path(__file__).with_name("contact-database.py"),
)
assert spec is not None and spec.loader is not None
contact_fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contact_fixture)


def create_database(ownership_path=None):
    data = contact_fixture.create_database("ready", ownership_path)
    try:
        owner, contact = UUID(data["owner_id"]), UUID(data["contact_ids"][0])
        scope = ContactScope(owner, contact)
        store = PostgresMemoryStore(data["database_url"])
        with psycopg.connect(data["database_url"]) as connection:
            message, source = connection.execute(
                "SELECT message.id, ref.source_document_id FROM public.message AS message "
                "JOIN public.message_source_ref AS ref ON ref.message_id=message.id "
                "WHERE message.owner_id=%s AND message.contact_id=%s ORDER BY message.id LIMIT 1",
                (owner, contact),
            ).fetchone()
            fresh_message, fresh_source = uuid4(), uuid4()
            connection.execute(
                "INSERT INTO public.source_document (id, owner_id, contact_id, source_type, "
                "file_name, content_sha256, record_count) VALUES (%s,%s,%s,'wechat_jsonl','new-synthetic.jsonl',%s,1)",
                (fresh_source, owner, contact, uuid4().hex * 2),
            )
            connection.execute(
                "INSERT INTO public.message (id, owner_id, contact_id, speaker, message_type, text_content) "
                "VALUES (%s,%s,%s,'contact','text','现在我开始喜欢合成咖啡了。')",
                (fresh_message, owner, contact),
            )
            connection.execute(
                "INSERT INTO public.message_source_ref (message_id, owner_id, contact_id, source_kind, "
                "source_document_id, source_locator, raw_payload) "
                "VALUES (%s,%s,%s,'source_document',%s,'synthetic:new','{}'::jsonb)",
                (fresh_message, owner, contact, fresh_source),
            )

        def candidate(text, message_id):
            return store.create_candidate(MemoryCandidate(
                candidate_id=uuid4(), scope=scope, text=text,
                category=MemoryCategory.PREFERENCE, source_ids=(message_id,),
            ))

        wrong = candidate("甲喜欢合成咖啡。", message)
        memory = store.confirm(scope=scope, candidate_id=wrong.candidate_id, adoption_method=AdoptionMethod.MANUAL)
        late = candidate("甲偏爱合成咖啡。", message)
        fresh = candidate("甲喜欢合成咖啡。", fresh_message)
        return {**data, "old_source_id": str(source), "fresh_source_id": str(fresh_source),
                "wrong_memory_id": str(memory.memory_id), "late_candidate_id": str(late.candidate_id),
                "fresh_candidate_id": str(fresh.candidate_id)}
    except BaseException:
        contact_fixture.drop_database(data["database_name"])
        raise


if __name__ == "__main__":
    if sys.argv[1] == "create":
        if len(sys.argv) not in (2, 3):
            raise ValueError("未知本轮纠错夹具参数。")
        print(json.dumps(create_database(sys.argv[2] if len(sys.argv) == 3 else None)))
    elif sys.argv[1] == "drop":
        contact_fixture.drop_database(sys.argv[2])
    else:
        raise ValueError("未知本轮纠错夹具操作。")
