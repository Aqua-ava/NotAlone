"""独立合成 PostgreSQL 的分页、进度及完整导入对照；不连接业务库。

python backend/benchmarks/database_queries.py --output /tmp/query-results.json
所有计时持有跨聊天文件锁；临时实例、数据库及输入在退出时清除。
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import tempfile
import time
import types
from unittest.mock import patch
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from notalone.database_migrations import migrate
from notalone.ingest.import_command import import_file
from notalone.ingest.models import ImportConfirmationRequest, NewContactSelection
from notalone.persistence.memory_processing import PostgresMemoryProcessingStore
from notalone.persistence.message_stream import PostgresMessageStream
from notalone.persistence.postgres_repository import PostgresIngestRepository
from notalone.scopes import ContactScope


ROOT = Path(__file__).resolve().parents[2]
BASELINE = "681fcc38eab77c8fe149b76705419971f3750a86"
OWNER = UUID(int=1)
CONTACT = UUID(int=20)
INDEXES = (
    "message_contact_page_idx",
    "wechat_message_metadata_scope_server_idx",
)
DDL = (
    "CREATE INDEX message_contact_page_idx ON public.message "
    "(owner_id, contact_id, occurred_at DESC NULLS LAST, id DESC)",
    "CREATE INDEX wechat_message_metadata_scope_server_idx "
    "ON public.wechat_message_metadata (owner_id, contact_id, external_server_id)",
)


@contextmanager
def isolated_postgres(directory: Path):
    data = directory / "pgdata"
    initdb = shutil.which("initdb") or "/opt/homebrew/bin/initdb"
    pg_ctl = shutil.which("pg_ctl") or "/opt/homebrew/bin/pg_ctl"
    with (directory / "initdb.log").open("w") as log:
        subprocess.run([initdb, "-D", str(data), "--auth=trust", "--no-locale",
                        "-E", "UTF8"], stdout=log, stderr=log, check=True)
    subprocess.run([pg_ctl, "-D", str(data), "-l", str(directory / "pg.log"),
                    "-o", f"-h '' -k {directory} -p 55464 -c jit=off -c autovacuum=off",
                    "-w", "start"], check=True, stdout=subprocess.DEVNULL)
    try:
        dsn = f"host={directory} port=55464 dbname=postgres"
        with psycopg.connect(dsn, autocommit=True) as connection:
            connection.execute("CREATE DATABASE query_benchmark_test")
        yield f"host={directory} port=55464 dbname=query_benchmark_test"
    finally:
        subprocess.run([pg_ctl, "-D", str(data), "-m", "fast", "-w", "stop"],
                       check=True, stdout=subprocess.DEVNULL)


def summary(samples):
    ordered = sorted(samples)
    return dict(samples=samples, p50=statistics.median(samples),
                p95=ordered[min(len(ordered) - 1, round((len(ordered) - 1) * .95))])


def elapsed(call):
    start = time.perf_counter()
    result = call()
    return (time.perf_counter() - start) * 1000, result


def indexes(connection, enabled):
    for name in INDEXES:
        connection.execute(f"DROP INDEX IF EXISTS public.{name}")
    if enabled:
        for statement in DDL:
            connection.execute(statement)


def seed(connection):
    connection.execute("INSERT INTO owner(id,display_name) VALUES (%s,'合成本人')", (OWNER,))
    contacts = [UUID(int=i) for i in range(20, 25)]
    for contact in contacts:
        connection.execute("INSERT INTO contact(owner_id,id,display_name) VALUES (%s,%s,'合成联系人')",
                           (OWNER, contact))
    for i, contact in enumerate(contacts):
        connection.execute("""INSERT INTO source_document
            (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
            VALUES (%s,%s,%s,'wechat_jsonl','synthetic.jsonl',%s,24000)""",
            (contact, OWNER, contact, hashlib.sha256(str(i).encode()).hexdigest()))
        connection.execute("""INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
            SELECT md5(%s||i)::uuid,%s,%s,'contact','text','合成消息'||i,
                CASE WHEN i%%100=0 THEN NULL ELSE '2026-01-01'::timestamptz+(i/2)*interval '1 second' END
            FROM generate_series(1,24000) i""", (str(contact), OWNER, contact))
        connection.execute("""INSERT INTO wechat_message_metadata
            (message_id,owner_id,contact_id,external_local_id,external_server_id,external_talker,source_create_time)
            SELECT md5(%s||i)::uuid,%s,%s,i,i::text,'synthetic',i
            FROM generate_series(1,24000) i""", (str(contact), OWNER, contact))
        connection.execute("""INSERT INTO message_source_ref
            (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
            SELECT md5(%s||i)::uuid,%s,%s,'source_document',%s,i::text,
              CASE WHEN i=23999 THEN '{"quote":{"text":"合成引用","id":{"server_id_str":"100"}}}'::jsonb ELSE '{}'::jsonb END
            FROM generate_series(1,24000) i""", (str(contact), OWNER, contact, contact))
    for i in range(101):
        contact = contacts[i % len(contacts)]
        source = UUID(int=1000 + i)
        connection.execute("""INSERT INTO source_document
            (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count,status)
            VALUES (%s,%s,%s,'wechat_jsonl','synthetic-task.jsonl',%s,0,%s)""",
            (source, OWNER, contact, hashlib.sha256(f"task{i}".encode()).hexdigest(),
             "active" if i % 3 else "delete_requested"))
        connection.execute("""INSERT INTO background_task
            (owner_id,contact_id,source_document_id,task_type,current_step,message_count)
            VALUES (%s,%s,%s,'import','extract_memory',0)""", (OWNER, contact, source))
    connection.execute("ANALYZE")


def capture_page(scope, limit, cursor=None):
    class Capture:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def execute(self, query, params=None):
            self.query, self.params = query, params
            return self

        def fetchall(self):
            return []

        def fetchone(self):
            return {"occurred_at": None}

    capture = Capture()
    with patch.object(PostgresMessageStream, "_connect", return_value=capture):
        PostgresMessageStream("synthetic").page_messages(
            scope=scope, limit=limit, before_message_id=cursor)
    return capture.query, capture.params


def import_measurement(connection, path):
    # 正式 import_file 包含解析、规范化、来源追踪、COPY、约束与触发器。
    # 只替换连接所有权，使每轮两次正式调用均在同一可回滚事务内。
    class BorrowedConnection:
        def __enter__(self):
            return connection

        def __exit__(self, *args):
            pass

    connection.execute("BEGIN")
    try:
        wal_start = connection.execute("SELECT pg_current_wal_insert_lsn()").fetchone()[0]
        with patch("psycopg.connect", return_value=BorrowedConnection()):
            first_ms, first = elapsed(lambda: import_file(
                path=path, owner_id=None, initialize_owner=True,
                initialize_first_owner_identity=True,
                confirmation=ImportConfirmationRequest(NewContactSelection("合成联系人")),
                repository=PostgresIngestRepository("synthetic")))
            new_wal = connection.execute("SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),%s)", (wal_start,)).fetchone()[0]
            repeat_start = connection.execute("SELECT pg_current_wal_insert_lsn()").fetchone()[0]
            repeat_ms, repeat = elapsed(lambda: import_file(
                path=path, owner_id=first.owner_id,
                confirmation=ImportConfirmationRequest(NewContactSelection("合成联系人")),
                repository=PostgresIngestRepository("synthetic")))
            repeat_wal = connection.execute("SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),%s)", (repeat_start,)).fetchone()[0]
        assert first.outcome == "imported" and repeat.outcome == "already_imported"
        assert first.message_count == repeat.message_count == 1000
        shape = connection.execute("""SELECT count(*),md5(string_agg(jsonb_build_array(
            m.speaker,m.text_content,m.occurred_at,w.external_local_id)::text,'' ORDER BY w.external_local_id))
            FROM message m JOIN wechat_message_metadata w ON w.message_id=m.id
            WHERE m.owner_id=%s""", (first.owner_id,)).fetchone()
        return dict(new_ms=first_ms, repeat_ms=repeat_ms, new_wal_bytes=int(new_wal),
                    repeat_wal_bytes=int(repeat_wal), shape=shape)
    finally:
        connection.execute("ROLLBACK")


def run(dsn, directory, samples):
    migrate(dsn, ROOT / "backend/database/migrations")
    baseline_source = subprocess.check_output(["git", "-C", str(ROOT), "show",
        BASELINE + ":backend/src/notalone/persistence/memory_processing.py"], text=True)
    baseline = types.ModuleType("baseline_memory_processing")
    exec(compile(baseline_source, "baseline_memory_processing.py", "exec"), baseline.__dict__)
    stores = dict(baseline=baseline.PostgresMemoryProcessingStore(dsn),
                  candidate=PostgresMemoryProcessingStore(dsn))
    page = capture_page(ContactScope(OWNER, CONTACT), 50)
    result = dict(baseline_revision=BASELINE, samples=samples,
                  benchmark_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  input=dict(messages=120000, contacts=5, tasks=101, null_every=100,
                             timestamp_tie_every=2, import_records=1000),
                  baseline_progress_sha256=hashlib.sha256(baseline_source.encode()).hexdigest(),
                  candidate_progress_sha256=hashlib.sha256((ROOT / "backend/src/notalone/persistence/memory_processing.py").read_bytes()).hexdigest(),
                  page_sql_sha256=hashlib.sha256(page[0].encode()).hexdigest())
    raw = [dict(mode=mode, new_ms=[], repeat_ms=[], new_wal_bytes=[], repeat_wal_bytes=[],
                page_ms=[], progress_ms=[], asc_ms=[]) for mode in ("baseline", "candidate")]
    path = directory / "synthetic.jsonl"
    path.write_text("".join(json.dumps(dict(id=dict(local_id=i,server_id_str=str(i),talker="synthetic_contact"),
        create_time=1786500000+i,is_from_me=bool(i%2),kind="text",
        time=datetime.fromtimestamp(1786500000+i, timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        time_iso=datetime.fromtimestamp(1786500000+i, timezone.utc).isoformat(),
        sender_wxid="synthetic_owner" if i%2 else "synthetic_contact",
        sender="合成用户" if i%2 else "合成联系人",text=f"合成导入{i}"),ensure_ascii=False)+"\n"
        for i in range(1,1001)))
    result["input_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    with psycopg.connect(dsn, autocommit=True) as connection:
        result["postgres_version"] = connection.info.server_version
        seed(connection)
        expected_page = connection.execute(*page).fetchall()
        expected_progress = stores["baseline"].read(owner_id=OWNER)
        result["progress_data_queries"] = {}
        for mode, store in stores.items():
            statements = []
            class CountConnection(psycopg.Connection):
                def execute(self, query, params=None, **kwargs):
                    statements.append(query)
                    return super().execute(query, params, **kwargs)
            with patch("psycopg.connect", CountConnection.connect):
                store.read(owner_id=OWNER)
            result["progress_data_queries"][mode] = sum(
                statement.lstrip().upper().startswith("SELECT") for statement in statements)
        stream = PostgresMessageStream(dsn)
        scope = ContactScope(OWNER, CONTACT)
        cursors = [None, UUID(hashlib.md5((str(CONTACT) + "23997").encode()).hexdigest()),
                   UUID(hashlib.md5((str(CONTACT) + "24000").encode()).hexdigest())]
        indexes(connection, False)
        before = [stream.page_messages(scope=scope, limit=50, before_message_id=cursor)
                  for cursor in cursors]
        indexes(connection, True)
        after = [stream.page_messages(scope=scope, limit=50, before_message_id=cursor)
                 for cursor in cursors]
        assert before == after
        result["first_tied_timestamp_null_cursor_pages_equal"] = True
        for round_number in range(samples + 1):
            for index in ((0, 1) if round_number % 2 == 0 else (1, 0)):
                entry = raw[index]
                indexes(connection, index == 1)
                # DDL 不在计时内；每次先预热，再采集相同 SQL 及相同结果。
                connection.execute(*page).fetchall()
                duration, rows = elapsed(lambda: connection.execute(*page).fetchall())
                assert rows == expected_page
                asc_ms, asc_rows = elapsed(lambda: connection.execute(
                    "SELECT id FROM message WHERE owner_id=%s AND contact_id=%s "
                    "ORDER BY occurred_at ASC NULLS LAST,id ASC LIMIT 51", (OWNER, CONTACT)).fetchall())
                if "asc_rows" in result:
                    assert result["asc_rows"] == [str(row[0]) for row in asc_rows]
                result["asc_rows"] = [str(row[0]) for row in asc_rows]
                progress_ms, progress = elapsed(lambda: stores[entry["mode"]].read(owner_id=OWNER))
                assert progress == expected_progress
                imported = import_measurement(connection, path)
                if round_number:
                    entry["page_ms"].append(duration)
                    entry["progress_ms"].append(progress_ms)
                    entry["asc_ms"].append(asc_ms)
                    for key in ("new_ms", "repeat_ms", "new_wal_bytes", "repeat_wal_bytes"):
                        entry[key].append(imported[key])
                if "import_shape" in result:
                    assert result["import_shape"] == imported["shape"]
                result["import_shape"] = imported["shape"]
        indexes(connection, True)
        result["index_bytes"] = dict(connection.execute(
            "SELECT relname,pg_relation_size(oid) FROM pg_class WHERE relname=ANY(%s)", (list(INDEXES),)).fetchall())
        result["old_index_retained"] = connection.execute("SELECT to_regclass('message_contact_time_idx') IS NOT NULL").fetchone()[0]
        result["same_page_and_progress"] = True
        for mode in ("baseline", "candidate"):
            indexes(connection, mode == "candidate")
            plan = connection.execute("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + page[0], page[1]).fetchone()[0]
            result[mode + "_page_plan"] = plan
        indexes(connection, True)
    result["measurements"] = [{"mode": entry["mode"], **{key: summary(value)
        for key, value in entry.items() if key != "mode"}} for entry in raw]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=13)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    if args.samples < 1:
        parser.error("samples 必须为正整数。")
    with open("/tmp/notalone-optimization-benchmark.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with tempfile.TemporaryDirectory(prefix="na-query-") as name:
            directory = Path(name)
            with isolated_postgres(directory) as dsn:
                result = run(dsn, directory, args.samples)
                if args.verify:
                    with psycopg.connect(dsn, dbname="postgres", autocommit=True) as connection:
                        connection.execute("CREATE DATABASE query_behavior_test")
                    behavior_dsn = dsn.replace("dbname=query_benchmark_test", "dbname=query_behavior_test")
                    migrate(behavior_dsn, ROOT / "backend/database/migrations")
                    verification = subprocess.run([os.sys.executable, "-m", "unittest",
                        "tests.integration.server.test_message_api",
                        "tests.integration.persistence.test_memory_processing_read", "-v"],
                        cwd=ROOT / "backend", env={**os.environ, "NOTALONE_TEST_DATABASE_URL": behavior_dsn,
                                                  "PYTHONPATH": str(ROOT / "backend/src")})
                    result["verification_exit_code"] = verification.returncode
        result["temporary_instance_stopped_and_removed"] = not directory.exists()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({"output": str(args.output), "cleaned": result["temporary_instance_stopped_and_removed"]}))
    raise SystemExit(result.get("verification_exit_code", 0))


if __name__ == "__main__":
    main()
