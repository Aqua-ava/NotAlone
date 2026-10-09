"""仅为桌面公开操作验收创建、填充和清理本轮合成测试库。"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg import sql


ROOT = Path(__file__).resolve().parents[3]
DATABASE_PATTERN = re.compile(r"notalone_contact_session_[0-9a-f]{32}_test")


def seed_contact(connection, owner_id, name, message_count):
    contact_id, source_id = uuid4(), uuid4()
    connection.execute(
        "INSERT INTO public.contact (owner_id, id, display_name, created_at) VALUES (%s, %s, %s, clock_timestamp())",
        (owner_id, contact_id, name),
    )
    connection.execute(
        """INSERT INTO public.source_document (
            id, owner_id, contact_id, source_type, file_name, content_sha256, record_count
        ) VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic.jsonl', %s, %s)""",
        (source_id, owner_id, contact_id, uuid4().hex * 2, message_count),
    )
    for number in range(message_count):
        message_id = uuid4()
        connection.execute(
            """INSERT INTO public.message (
                id, owner_id, contact_id, speaker, message_type, text_content, occurred_at
            ) VALUES (%s, %s, %s, 'contact', 'text', %s, now())""",
            (message_id, owner_id, contact_id, f"桌面验收合成文字 {number + 1}"),
        )
        connection.execute(
            """INSERT INTO public.message_source_ref (
                message_id, owner_id, contact_id, source_kind,
                source_document_id, source_locator, raw_payload
            ) VALUES (%s, %s, %s, 'source_document', %s, %s, '{}'::jsonb)""",
            (message_id, owner_id, contact_id, source_id, f"synthetic:{number + 1}"),
        )
    return str(contact_id)


def create_database(mode, ownership_path=None):
    database_name = f"notalone_contact_session_{uuid4().hex}_test"
    if ownership_path is not None:
        # 建库前持久化精确归属；即使调用方超时也不能丢失本轮库名。
        descriptor = os.open(ownership_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as ownership:
            json.dump({"version": 1, "database_name": database_name, "pid": os.getpid()}, ownership)
            ownership.flush()
            os.fsync(ownership.fileno())
    with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(
            sql.Identifier(database_name),
        ))
    try:
        database_url = f"host=/tmp dbname={database_name}"
        env = dict(os.environ, NOTALONE_DATABASE_URL=database_url)
        migration = subprocess.run(
            [sys.executable, "-m", "notalone.database_migrations", "--migrations",
             str(ROOT / "backend/database/migrations")],
            cwd=ROOT, env=env, capture_output=True, timeout=60,
        )
        if migration.returncode:
            raise RuntimeError("本轮联系人测试库迁移失败。")
        owner_id, other_owner_id = uuid4(), uuid4()
        contacts = []
        with psycopg.connect(database_url) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, '另一合成用户')",
                (other_owner_id,),
            )
            if mode != "invalid-owner":
                connection.execute(
                    "INSERT INTO public.owner (id, display_name) VALUES (%s, '桌面合成用户')",
                    (owner_id,),
                )
            if mode not in ("empty", "invalid-owner"):
                contacts = [
                    seed_contact(connection, owner_id, "合成联系人甲", 2),
                    seed_contact(connection, owner_id, "合成联系人乙", 1),
                ]
            other_contact = seed_contact(connection, other_owner_id, "另一用户的联系人", 1)
        return {
            "database_name": database_name, "database_url": database_url,
            "owner_id": str(owner_id), "other_owner_id": str(other_owner_id),
            "contact_ids": contacts, "other_contact_id": other_contact,
        }
    except BaseException:
        drop_database(database_name)
        raise


def drop_database(database_name):
    if not DATABASE_PATTERN.fullmatch(database_name):
        raise ValueError("只允许清理本轮联系人测试库。")
    with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
        admin.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(
            sql.Identifier(database_name),
        ))


if __name__ == "__main__":
    operation = sys.argv[1]
    if operation == "create":
        print(json.dumps(create_database(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)))
    elif operation == "drop":
        drop_database(sys.argv[2])
    else:
        raise ValueError("未知合成库操作。")
