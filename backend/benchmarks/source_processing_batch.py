"""在指定提交上运行同一合成 PostgreSQL 负载，分别测计数、时间、Python 内存或阶段。

示例：PYTHONHASHSEED=0 python backend/benchmarks/source_processing_batch.py
--revision <完整提交> --mode count --output /tmp/import-count.json
仅连接本机维护库创建随机自有 _test 库；结束强制清理并核验。无模型、桌面或业务库访问。
"""

from __future__ import annotations

import argparse
from collections import Counter
from contextlib import ExitStack, contextmanager
import ctypes
import ctypes.util
from datetime import datetime, timezone
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import platform
import re
import statistics
import subprocess
import sys
import tarfile
import tempfile
import time
import tracemalloc
from unittest.mock import patch
from uuid import NAMESPACE_URL, uuid4, uuid5

import psycopg
from psycopg import pq, sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.types.json import Jsonb


class ProtocolTrace:
    """记录实际 libpq 消息；macOS binary 包未开放 trace 时使用同库的官方 C 接口。"""

    def __init__(self, connection, path):
        self.connection = connection
        self.path = path
        self.file = path.open("wb")
        self.native = None
        try:
            connection.pgconn.trace(self.file.fileno())
            connection.pgconn.set_trace_flags(pq.Trace.SUPPRESS_TIMESTAMPS)
        except psycopg.NotSupportedError:
            self.file.close()
            if pq.__impl__ != "binary":
                raise
            module = importlib.import_module("psycopg_binary.pq")
            library = ctypes.CDLL(module.__file__)
            libc = ctypes.CDLL(ctypes.util.find_library("c"))
            libc.fopen.argtypes, libc.fopen.restype = [ctypes.c_char_p, ctypes.c_char_p], ctypes.c_void_p
            libc.fclose.argtypes, libc.fclose.restype = [ctypes.c_void_p], ctypes.c_int
            library.PQtrace.argtypes, library.PQtrace.restype = [ctypes.c_void_p, ctypes.c_void_p], None
            library.PQsetTraceFlags.argtypes, library.PQsetTraceFlags.restype = [ctypes.c_void_p, ctypes.c_int], None
            library.PQuntrace.argtypes, library.PQuntrace.restype = [ctypes.c_void_p], None
            stream = libc.fopen(os.fsencode(path), b"w")
            if not stream:
                raise OSError("无法打开本轮协议计数文件。")
            library.PQtrace(connection.pgconn.pgconn_ptr, stream)
            library.PQsetTraceFlags(connection.pgconn.pgconn_ptr, int(pq.Trace.SUPPRESS_TIMESTAMPS))
            self.native = library, libc, stream

    def close(self):
        if self.native is not None:
            library, libc, stream = self.native
            library.PQuntrace(self.connection.pgconn.pgconn_ptr)
            libc.fclose(stream)
        else:
            self.connection.pgconn.untrace()
            self.file.close()


@contextmanager
def counted_connections(directory, counts):
    def record_sql(connection, query, executions):
        text = query.as_string(connection) if isinstance(query, sql.Composable) else query
        if "source_processing_capture_tombstone" in text or text.startswith("INSERT INTO public.source_processing_"):
            kind = "processing_business_sql"
        elif "pg_advisory" in text:
            kind = "scope_lock_sql"
        elif re.search(r"\b(?:source_document|message_source_ref|local_wechat_observation)\b", text):
            kind = "source_sql"
        else:
            kind = "other_sql"
        counts[kind] += executions
        counts["sql_statement_executions"] += executions

    def record_payloads(values):
        for value in values or ():
            if isinstance(value, Jsonb):
                encoded = (value.dumps or json.dumps)(value.obj)
                counts["json_parameter_bytes"] += len(encoded.encode("utf-8") if isinstance(encoded, str) else encoded)

    original_write_row = psycopg.Copy.write_row
    def write_row(copy, row):
        counts["copy_rows"] += 1
        record_payloads(row)
        return original_write_row(copy, row)

    class CountingCursor(psycopg.Cursor):
        def execute(self, query, params=None, **kwargs):
            record_sql(self.connection, query, 1)
            record_payloads(params)
            return super().execute(query, params, **kwargs)

        def copy(self, statement, params=None, **kwargs):
            record_sql(self.connection, statement, 1)
            counts["copy_statements"] += 1
            return super().copy(statement, params, **kwargs)

        def executemany(self, query, params_seq, *, returning=False):
            parameters = list(params_seq)
            for row in parameters:
                record_payloads(row)
            counts["python_executemany_calls"] += 1
            record_sql(self.connection, query, len(parameters))
            return super().executemany(query, parameters, returning=returning)

    class CountingConnection(psycopg.Connection):
        def execute(self, query, params=None, **kwargs):
            counts["python_execute_calls"] += 1
            return super().execute(query, params, **kwargs)

        def wait(self, generator, *args, **kwargs):
            counts["driver_wait_calls"] += 1
            return super().wait(generator, *args, **kwargs)

        def commit(self):
            counts["commit_calls"] += 1
            return super().commit()

        def close(self):
            if not self.closed:
                self.protocol_trace.close()
            super().close()

    traces = []
    def connect(*args, **kwargs):
        kwargs["cursor_factory"] = CountingCursor
        kwargs["options"] = "-c track_functions=pl"
        connection = CountingConnection.connect(*args, **kwargs)
        path = directory / f"connection-{len(traces)}.log"
        connection.protocol_trace = ProtocolTrace(connection, path)
        traces.append(path)
        return connection

    with patch("psycopg.connect", connect), patch.object(psycopg.Copy, "write_row", write_row):
        yield
    messages = Counter()
    for path in traces:
        with path.open("rb") as content:
            for line in content:
                fields = line.split(b"\t", 3)
                if len(fields) >= 3:
                    fields[2] = fields[2].rstrip(b"\r\n")
                if (len(fields) >= 3 and fields[0] in {b"F", b"B"} and fields[1].isdigit()
                        and fields[2] in {b"Parse", b"Bind", b"Describe", b"Execute", b"Sync",
                                          b"Query", b"Flush", b"ReadyForQuery", b"CommandComplete",
                                          b"CopyData", b"CopyDone", b"CopyInResponse"}):
                    messages[(fields[0] + b"." + fields[2]).decode("ascii")] += 1
    counts["protocol_messages"] = dict(messages)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--revision", required=True)
    parser.add_argument("--mode", choices=("count", "time", "memory", "phases"), required=True)
    parser.add_argument("--sizes", nargs="+", type=int, default=[100, 1000, 10000])
    parser.add_argument("--samples", type=int, default=7)
    parser.add_argument("--profiles", nargs="+", choices=("save", "import_file", "preview"), default=["save", "import_file"])
    parser.add_argument("--instance", default="host=/tmp dbname=postgres")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if os.environ.get("PYTHONHASHSEED") != "0" or min(args.sizes) < 1 or args.samples < 1:
        parser.error("要求 PYTHONHASHSEED=0、正数负载和样本数。")
    instance = conninfo_to_dict(args.instance)
    if (instance.get("host", "") not in {"/tmp", "localhost", "127.0.0.1", "::1"}
            or any(key in instance for key in ("hostaddr", "service"))
            or any(os.environ.get(key) for key in ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"))):
        parser.error("仅允许显式本机实例，禁止 hostaddr/service 及对应环境覆盖。")
    os.environ["NOTALONE_DISABLE_DOTENV"] = "1"
    revision = subprocess.check_output(["git", "-C", str(args.repo), "rev-parse", args.revision + "^{commit}"], text=True).strip()
    archive = subprocess.check_output(["git", "-C", str(args.repo), "archive", revision, "backend/src", "backend/database/migrations"])
    name = "notalone_import_benchmark_" + uuid4().hex + "_test"
    database_url = make_conninfo(args.instance, dbname=name)
    output = {"revision": revision, "mode": args.mode, "python": sys.version.split()[0],
              "hash_seed": 0, "machine": platform.machine(), "psycopg": psycopg.__version__,
              "libpq": pq.version(), "transport": "local", "results": [], "owned_database": name,
              "measurement_note": "协议消息与驱动等待分别实测；不等于 TCP 包数或网络往返。时间无计数/追踪，P95 为 nearest-rank；内存为独立 tracemalloc Python 峰值。import_file 从读取文件到事务提交，不含预览与后台提取。phases 含独立包装开销，仅供定位。"}
    with tempfile.TemporaryDirectory(prefix="notalone-import-benchmark-") as temporary:
        directory = Path(temporary)
        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
            source.extractall(directory, filter="data")
        sys.path.insert(0, str(directory / "backend/src"))
        from notalone.database_migrations import migrate
        from notalone.ingest.import_command import import_file
        from notalone.ingest.preview import build_preview
        import notalone.ingest.import_command as command_module
        from notalone.ingest.models import ExistingContactSelection, ImportConfirmationRequest
        from notalone.persistence.locks import lock_contact_scope
        from notalone.persistence.postgres_repository import PostgresIngestRepository
        from notalone.persistence.source_processing import PostgresSourceProcessingStore, save_processing_batch
        from notalone.scopes import ContactScope
        from notalone.source_processing.models import ProcessingRecord
        scope = ContactScope(uuid5(NAMESPACE_URL, "notalone-synthetic-benchmark-owner"),
                             uuid5(NAMESPACE_URL, "notalone-synthetic-benchmark-contact"))
        with psycopg.connect(args.instance, dbname="postgres", autocommit=True) as admin:
            admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(name)))
            try:
                migrate(database_url, directory / "backend/database/migrations")
                with psycopg.connect(database_url) as connection:
                    output["server_version"] = connection.info.server_version
                for size in args.sizes:
                    raw = [{"id": {"local_id": 101 + i, "server_id_str": f"synthetic-{101 + i}", "talker": "synthetic_contact"},
                            "create_time": 1786500000 + i, "is_from_me": bool(i % 2), "kind": "text",
                            "sender_wxid": "synthetic_owner" if i % 2 else "synthetic_contact",
                            "sender": "合成用户" if i % 2 else "合成联系人",
                            "time": datetime.fromtimestamp(1786500000 + i, timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                            "time_iso": datetime.fromtimestamp(1786500000 + i, timezone.utc).isoformat(),
                            "text": f"合成基准正文{i:05d}"}
                           for i in range(size)]
                    text = "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in raw)
                    path = directory / "synthetic.jsonl"
                    path.write_text(text, encoding="utf-8")
                    records = tuple(ProcessingRecord(uuid5(NAMESPACE_URL, f"notalone-synthetic-capture-{i}"),
                                    f"synthetic:{i}", json.dumps({"record_text": "合成基准正文", "outcome": "filtered"})) for i in range(size))
                    for profile in args.profiles:
                        measurements = []
                        repetitions = args.samples if args.mode == "time" else 1
                        # 一轮同负载预热不进入时间样本；计数和内存各自独立运行。
                        for sample in range(repetitions + (args.mode == "time")):
                            with psycopg.connect(database_url) as connection:
                                connection.execute("INSERT INTO public.owner(id,display_name) VALUES (%s,'合成基准用户')", (scope.owner_id,))
                                connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,'合成基准联系人')", (scope.owner_id, scope.contact_id))
                                connection.execute("INSERT INTO public.owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES (%s,'wechat','synthetic_owner','合成基准用户')", (scope.owner_id,))
                            def run():
                                if profile == "save":
                                    with psycopg.connect(database_url) as connection:
                                        lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
                                        save_processing_batch(connection, scope=scope, source_kind="source_document",
                                                              source_id=None, records=records, receipts={})
                                elif profile == "preview":
                                    return build_preview(path)
                                else:
                                    return import_file(path=path, owner_id=scope.owner_id,
                                        confirmation=ImportConfirmationRequest(ExistingContactSelection(scope.contact_id)),
                                        repository=PostgresIngestRepository(database_url))
                            if args.mode == "count":
                                counters = Counter()
                                def function_stats():
                                    with psycopg.connect(database_url) as connection:
                                        return {name: calls for name, calls in connection.execute(
                                            "SELECT funcname,calls FROM pg_stat_user_functions").fetchall()}
                                before = function_stats()
                                with counted_connections(directory, counters):
                                    run()
                                after = function_stats()
                                counters["pl_function_calls"] = {name: calls - before.get(name, 0)
                                    for name, calls in after.items() if calls != before.get(name, 0)}
                                measurements.append(dict(counters))
                            elif args.mode == "memory":
                                tracemalloc.start()
                                try:
                                    run()
                                    measurements.append(tracemalloc.get_traced_memory()[1])
                                finally:
                                    tracemalloc.stop()
                            elif args.mode == "phases":
                                phases = Counter()
                                def timed(name, function):
                                    def invoke(*args, **kwargs):
                                        started = time.perf_counter()
                                        try:
                                            return function(*args, **kwargs)
                                        finally:
                                            phases[name] += time.perf_counter() - started
                                    return invoke
                                with ExitStack() as stack:
                                    for target, attribute, phase_name in (
                                        (command_module, "read_jsonl", "read_parse"),
                                        (command_module, "normalize_document", "normalize"),
                                        (PostgresIngestRepository, "import_document", "repository_inclusive"),
                                        (PostgresIngestRepository, "_save_processing", "trace_inclusive"),
                                    ):
                                        stack.enter_context(patch.object(target, attribute, timed(phase_name, getattr(target, attribute))))
                                    started = time.perf_counter()
                                    run()
                                    phases["total"] = time.perf_counter() - started
                                phases["repository_excluding_trace"] = phases["repository_inclusive"] - phases["trace_inclusive"]
                                measurements.append(dict(phases))
                            else:
                                started = time.perf_counter()
                                run()
                                elapsed = time.perf_counter() - started
                                if sample:
                                    measurements.append(elapsed)
                            if profile == "preview":
                                preview = build_preview(path)
                                if preview.record_count != size or preview.content_sha256 != hashlib.sha256(path.read_bytes()).hexdigest():
                                    raise AssertionError("预览数量或文件字节摘要不符。")
                                with psycopg.connect(database_url) as connection:
                                    connection.execute("DELETE FROM public.owner WHERE id=%s", (scope.owner_id,))
                                continue
                            store = PostgresSourceProcessingStore(database_url)
                            batch = store.get_batch(scope, store.list_batches(scope)[0]["batch_id"])
                            if len(batch["records"]) != size or batch["records"][-1]["position"] != size - 1:
                                raise AssertionError("基准结果数量或顺序不符。")
                            for position, row in enumerate(batch["records"]):
                                payload = row["payload"]
                                if row["position"] != position:
                                    raise AssertionError("基准结果完整顺序不符。")
                                if profile == "save":
                                    if (payload["capture_record_id"] != str(records[position].record_id)
                                            or payload["record_text"] != "合成基准正文"):
                                        raise AssertionError("保存结果捕获身份或正文不符。")
                                elif (payload["parsed"]["text"] != raw[position]["text"]
                                      or payload["converted"]["text_content"] != raw[position]["text"]
                                      or payload["parsed"] != raw[position]
                                      or not row["message_id"] or not row["source_ref_id"]):
                                    raise AssertionError("导入结果原始及规范化正文不符。")
                            del batch
                            with psycopg.connect(database_url) as connection:
                                connection.execute("DELETE FROM public.owner WHERE id=%s", (scope.owner_id,))
                        input_bytes = text.encode() if profile in {"import_file", "preview"} else json.dumps([
                            [str(record.record_id), record.locator, record.payload_json] for record in records
                        ], ensure_ascii=False).encode()
                        result = {"profile": profile, "records": size, "input_sha256": hashlib.sha256(input_bytes).hexdigest(),
                                  "samples": measurements, "sample_count": len(measurements)}
                        if args.mode == "time":
                            result.update(median_seconds=statistics.median(measurements), min_seconds=min(measurements), max_seconds=max(measurements),
                                          p95_seconds=sorted(measurements)[max(0, (95 * len(measurements) + 99) // 100 - 1)])
                        if args.mode == "memory":
                            result["python_peak_bytes"] = measurements[0]
                        output["results"].append(result)
                        print(json.dumps({"mode": args.mode, "profile": profile, "records": size,
                                          "samples": len(measurements)}, ensure_ascii=False), flush=True)
            finally:
                admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
                output["owned_database_removed"] = not admin.execute("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)", (name,)).fetchone()[0]
                args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                print(json.dumps({"owned_database_removed": output["owned_database_removed"]}), flush=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"revision": revision, "mode": args.mode, "results": len(output["results"]),
                      "owned_database_removed": output["owned_database_removed"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
