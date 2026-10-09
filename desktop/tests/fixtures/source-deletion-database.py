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


if __name__ == "__main__":
    fixture = runpy.run_path(str(Path(__file__).with_name("contact-database.py")))
    if len(sys.argv) == 4 and sys.argv[1] == "create" and sys.argv[3] in ("basic", "reply"):
        import json

        data = fixture["create_database"]("ready", sys.argv[2])
        if sys.argv[3] == "reply":
            prepare_reply(data)
        print(json.dumps(data))
    elif len(sys.argv) == 3 and sys.argv[1] == "drop":
        fixture["drop_database"](sys.argv[2])
    else:
        raise ValueError("只允许本轮来源删除库的具名准备和精确清理。")
