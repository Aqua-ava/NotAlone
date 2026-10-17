"""仅为桌面公开操作验收创建、填充和清理本轮合成测试库。"""

from __future__ import annotations

import json
import os
import re
import stat
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

    def record_ownership(phase, *, planned=False):
        target = ownership_path if planned else ownership_path.with_name(
            f".{ownership_path.name}.{uuid4().hex}.tmp",
        )
        temporary_created = False
        original_error = None
        try:
            descriptor = os.open(target, os.O_WRONLY | os.O_NOFOLLOW | os.O_CREAT | os.O_EXCL, 0o600)
            temporary_created = not planned
            with os.fdopen(descriptor, "w", encoding="utf-8") as ownership:
                json.dump({"version": 1, "database_name": database_name,
                           "pid": os.getpid(), "phase": phase}, ownership)
                ownership.flush()
                os.fsync(ownership.fileno())
            if not planned:
                # created 完整落盘前不覆盖 planned，失败时仍能恢复精确计划身份。
                os.replace(target, ownership_path)
            directory = os.open(ownership_path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except BaseException as error:
            original_error = error
            raise
        finally:
            if temporary_created:
                try:
                    target.unlink(missing_ok=True)
                except OSError as cleanup_error:
                    if original_error is None:
                        raise
                    original_error.add_note(f"本轮临时归属文件清理未确认：{target}；{cleanup_error}")

    if ownership_path is not None:
        # 建库前持久化精确归属；即使调用方超时也不能丢失本轮库名。
        ownership_path = Path(ownership_path)
        directory = ownership_path.parent.lstat()
        if (not ownership_path.is_absolute() or not stat.S_ISDIR(directory.st_mode)
                or directory.st_uid != os.getuid() or directory.st_mode & 0o077):
            raise RuntimeError("本轮联系人库须使用自有私有归属目录。")
        record_ownership("planned", planned=True)
    with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(
            sql.Identifier(database_name),
        ))
    try:
        if ownership_path is not None:
            # CREATE 已明确成功，后续 marker 写入失败也须清理该精确库。
            record_ownership("created")
        database_url = f"host=/tmp dbname={database_name}"
        env = dict(os.environ, NOTALONE_DATABASE_URL=database_url,
                   NOTALONE_TEST_DATABASE_URL=database_url)
        with psycopg.connect(database_url) as connection:
            if connection.execute("SELECT current_database()").fetchone()[0] != database_name:
                raise RuntimeError("本轮联系人库身份不匹配。")
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
    except BaseException as original_error:
        original_error.add_note(f"本轮联系人库已确证创建（CREATE DATABASE 成功）：{database_name}")
        try:
            drop_database(database_name)
        except BaseException as cleanup_error:
            original_error.add_note("本轮已确证创建的联系人库未完成清理。")
            raise original_error from cleanup_error
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
