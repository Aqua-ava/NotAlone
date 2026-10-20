"""在独立合成 PG 复验 76 个同号引用目标；只输出布尔结果与摘要，不计时。"""

from __future__ import annotations

import argparse
from dataclasses import asdict
import fcntl
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types


ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "backend/src"), str(ROOT / "backend/benchmarks")]

import database_queries as benchmark
import psycopg

from notalone.persistence.message_stream import PostgresMessageStream
from notalone.scopes import ContactScope


LIMITS = (1, 2, 3, 10, 50)
STREAM_PATH = "backend/src/notalone/persistence/message_stream.py"


def digest(value: object) -> str:
    encoded = json.dumps(value, default=str, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(encoded.encode()).hexdigest()


def snapshot(connection, database_url: str, store_class) -> dict:
    scope = ContactScope(benchmark.OWNER, benchmark.CONTACT)
    stream = store_class(database_url)
    result = {}
    for limit in LIMITS:
        statement, parameters = benchmark.capture_page(
            scope, limit, store_class=store_class,
        )
        rows = connection.execute(statement, parameters).fetchall()
        page = stream.page_messages(scope=scope, limit=limit)
        result[limit] = dict(
            sql_rows=rows, page=page,
            targets=tuple(message.quoted.target_message_id for message in page.messages
                          if message.quoted is not None),
        )
    return result


def compare(before: dict, after: dict) -> dict:
    return {
        str(limit): dict(
            full_sql_order_equal=before[limit]["sql_rows"] == after[limit]["sql_rows"],
            api_page_equal=before[limit]["page"] == after[limit]["page"],
            api_target_order_equal=before[limit]["targets"] == after[limit]["targets"],
            api_target_set_equal=set(before[limit]["targets"]) == set(after[limit]["targets"]),
            sql_row_counts=[len(before[limit]["sql_rows"]), len(after[limit]["sql_rows"])],
            api_target_counts=[len(before[limit]["targets"]), len(after[limit]["targets"])],
            full_sql_result_sha256=[digest(before[limit]["sql_rows"]), digest(after[limit]["sql_rows"])],
            api_page_sha256=[digest(asdict(before[limit]["page"])),
                             digest(asdict(after[limit]["page"]))],
        ) for limit in LIMITS
    }


def run(database_url: str, baseline_source: str) -> dict:
    applied = benchmark.migrate(database_url, ROOT / "backend/database/migrations")
    legacy = types.ModuleType("legacy_message_stream")
    exec(compile(baseline_source, "legacy_message_stream.py", "exec"), legacy.__dict__)
    with psycopg.connect(database_url, autocommit=True) as connection:
        benchmark.seed(connection)
        # seed 自带三重号；先还原唯一标识，再精确构造 100..175 共 76 个目标。
        connection.execute(
            "UPDATE wechat_message_metadata SET external_server_id=external_local_id::text "
            "WHERE owner_id=%s AND contact_id=%s", (benchmark.OWNER, benchmark.CONTACT),
        )
        connection.execute(
            "UPDATE wechat_message_metadata SET external_server_id='100' "
            "WHERE owner_id=%s AND contact_id=%s AND external_local_id BETWEEN 100 AND 175",
            (benchmark.OWNER, benchmark.CONTACT),
        )
        connection.execute("ANALYZE")
        targets = tuple(row[0] for row in connection.execute(
            "SELECT message_id FROM wechat_message_metadata WHERE owner_id=%s "
            "AND contact_id=%s AND external_server_id='100' ORDER BY message_id",
            (benchmark.OWNER, benchmark.CONTACT),
        ).fetchall())
        assert len(targets) == 76
        definitions = tuple(row[0] for row in connection.execute(
            "SELECT indexdef FROM pg_indexes WHERE schemaname='public' "
            "AND indexname=ANY(%s) ORDER BY indexname", (list(benchmark.INDEXES),),
        ).fetchall())
        assert len(definitions) == 2
        variants = {}
        for enabled in (False, True):
            benchmark.indexes(connection, enabled, definitions)
            variants[enabled] = {
                "candidate": snapshot(connection, database_url, PostgresMessageStream),
                "legacy": snapshot(connection, database_url, legacy.PostgresMessageStream),
            }
        candidate = compare(variants[False]["candidate"], variants[True]["candidate"])
        for limit in LIMITS:
            row = candidate[str(limit)]
            row["stable_ascending_target_prefix"] = (
                variants[False]["candidate"][limit]["targets"] == targets[:limit]
            )
            assert all(row[key] for key in (
                "full_sql_order_equal", "api_page_equal", "api_target_order_equal",
                "api_target_set_equal", "stable_ascending_target_prefix",
            )), (limit, row)
        return dict(
            postgres_version=connection.info.server_version,
            applied_migration_count=len(applied),
            input=dict(messages=120000, contacts=5, tasks=101, duplicate_quote_targets=76),
            input_shape_sha256=digest([120000, 5, 101, targets]),
            candidate=candidate,
            legacy=compare(variants[False]["legacy"], variants[True]["legacy"]),
            candidate_all_checks_passed=True,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).with_suffix(".json"))
    args = parser.parse_args()
    baseline_source = subprocess.check_output(
        ["git", "-C", str(ROOT), "show", f"{benchmark.BASELINE}:{STREAM_PATH}"], text=True,
    )
    candidate_source = (ROOT / STREAM_PATH).read_text()
    with open("/tmp/notalone-optimization-benchmark.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with tempfile.TemporaryDirectory(prefix="na-duplicate-validation-") as name:
            directory = Path(name)
            with benchmark.isolated_postgres(directory) as database_url:
                result = run(database_url, baseline_source)
        result["temporary_instance_stopped_and_removed"] = not directory.exists()
    assert (ROOT / STREAM_PATH).read_text() == candidate_source
    result.update(
        baseline_revision=benchmark.BASELINE,
        candidate_stream_sha256=hashlib.sha256(candidate_source.encode()).hexdigest(),
        baseline_stream_sha256=hashlib.sha256(baseline_source.encode()).hexdigest(),
        validation_script_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        benchmark_script_sha256=hashlib.sha256((ROOT / "backend/benchmarks/database_queries.py").read_bytes()).hexdigest(),
        comparison="候选及旧主线分别执行相同完整 SQL，只切换 099 新增索引；不计时。",
        legacy_note="旧主线未约定同号目标次序；保留其索引前后差异，不宣称候选保留任意旧次序。",
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({
        "candidate_all_checks_passed": result["candidate_all_checks_passed"],
        "legacy_target_set_changes": [limit for limit, row in result["legacy"].items()
                                      if not row["api_target_set_equal"]],
        "temporary_instance_stopped_and_removed": result["temporary_instance_stopped_and_removed"],
    }))


if __name__ == "__main__":
    main()
