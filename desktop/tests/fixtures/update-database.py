"""更新验收自有的随机旧版库；正式 SQL 与合成资料，不读取本机配置。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from uuid import uuid4

import psycopg
from psycopg import sql

from notalone.database_migrations import migrate
from notalone.database_adoption import adopt_legacy_database


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("create", "drop", "drift", "restore-drift"))
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--database", default="")
    parser.add_argument("--managed-directory", type=Path)
    parser.add_argument("--baseline", action="store_true")
    args = parser.parse_args()
    name = f"notalone_update_{uuid4().hex}_test" if args.action == "create" else args.database
    managed = args.managed_directory
    if managed is None and not re.fullmatch(r"notalone_update_[0-9a-f]{32}_test", name):
        raise ValueError("只允许本轮随机更新测试库。")
    url = os.environ.get("NOTALONE_TEST_MANAGED_URL", "") if managed else f"host=/tmp dbname={name}"
    if managed:
        from psycopg.conninfo import make_conninfo
        if (args.action != "create" or not managed.name.startswith("notalone-app-")
                or (managed / "managed-update-fixture.json").read_text() != '{"fixture":"preserving-data-update"}'):
            raise ValueError("只允许本夹具自建的私有资料目录。")
        name = "notalone"
        admin_url = make_conninfo(url, dbname="postgres")
        with psycopg.connect(admin_url) as admin:
            actual = Path(admin.execute("SHOW data_directory").fetchone()[0]).resolve()
            if actual != (managed / "managed/postgres").resolve():
                raise ValueError("资料服务不是本次夹具创建的集群。")
    else:
        admin_url = "host=/tmp dbname=postgres"
    if args.action in {"drift", "restore-drift"}:
        checksum = ("synthetic-drift" if args.action == "drift" else hashlib.sha256(
            (args.project / "backend/database/migrations/055_assistant_candidate_carry_input.sql").read_bytes()).hexdigest())
        with psycopg.connect(url) as connection:
            connection.execute("UPDATE public.notalone_schema_migration SET checksum=%s WHERE name='055_assistant_candidate_carry_input.sql'", (checksum,))
        return
    with psycopg.connect(admin_url, autocommit=True) as connection:
        command = "CREATE DATABASE {} TEMPLATE template0" if args.action == "create" else "DROP DATABASE {} WITH (FORCE)"
        connection.execute(sql.SQL(command).format(sql.Identifier(name)))
    if args.action == "drop":
        return
    with tempfile.TemporaryDirectory() as directory:
        prefix = Path(directory)
        migrations = sorted((args.project / "backend/database/migrations").glob("*.sql"))
        for migration in migrations[:35 if args.baseline else 55]:
            shutil.copy2(migration, prefix / migration.name)
        migrate(url, prefix)
        if args.baseline:
            with psycopg.connect(url) as connection:
                connection.execute("DROP TABLE public.notalone_schema_migration")
            adopt_legacy_database(url, args.project / "backend/database/migrations", prefix / "baseline-backup")
            for migration in migrations[35:55]:
                shutil.copy2(migration, prefix / migration.name)
            migrate(url, prefix)
    owner, contact, binding, document, message, candidate, memory = [str(uuid4()) for _ in range(7)]
    with psycopg.connect(url) as connection:
        connection.execute("INSERT INTO public.owner (id, display_name) VALUES (%s, '合成更新使用者')", (owner,))
        connection.execute("INSERT INTO public.contact (owner_id, id, display_name) VALUES (%s, %s, '合成保留联系人')", (owner, contact))
        connection.execute("""INSERT INTO public.conversation_binding
            (id, owner_id, contact_id, channel, account_scope, conversation_locator)
            VALUES (%s,%s,%s,'wechat','synthetic_update','synthetic_confirmed')""", (binding, owner, contact))
        connection.execute("""INSERT INTO public.source_document
            (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
            VALUES (%s,%s,%s,'wechat_jsonl','synthetic.jsonl',%s,1)""", (document, owner, contact, "a" * 64))
        connection.execute("""INSERT INTO public.message (id,owner_id,contact_id,speaker,message_type,text_content)
            VALUES (%s,%s,%s,'contact','text','这是只用于兼容更新验收的合成资料')""", (message, owner, contact))
        connection.execute("""INSERT INTO public.message_source_ref
            (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
            VALUES (%s,%s,%s,'source_document',%s,'line:1','{"synthetic":true}')""", (message, owner, contact, document))
        connection.execute("""INSERT INTO public.memory_candidate
            (id,owner_id,contact_id,text_content,category,source_ids)
            VALUES (%s,%s,%s,'合成关系资料','common_fact',%s)""", (candidate, owner, contact, [message]))
        connection.execute("""INSERT INTO public.confirmed_memory
            (id,owner_id,contact_id,text_content,category,source_ids,adoption_method)
            VALUES (%s,%s,%s,'合成保留关系资料','common_fact',%s,'manual')""", (memory, owner, contact, [message]))
        connection.execute("""INSERT INTO public.cli_backfill_state
            (owner_id,contact_id,binding_id,phase,trigger_at) VALUES (%s,%s,%s,'paused',now())""", (owner, contact, binding))
        connection.execute("INSERT INTO public.front_sync_state (owner_id,enabled) VALUES (%s,false)", (owner,))
    print(json.dumps({"database": name, **({"database_url": url} if managed is None else {}), "owner": owner, "contact": contact}))


if __name__ == "__main__":
    main()
