"""运行原 PostgreSQL＋pgvector 的隔离 A/B 评测。

本入口只使用合成资料和实验专用 pg0；它不修改正式数据库或回复装配。
"""

from __future__ import annotations

from dataclasses import asdict
import argparse
from collections.abc import Sequence
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import shutil
import subprocess
from time import perf_counter
from typing import Any
from uuid import uuid4

from notalone.experiments.hindsight_baseline import build_fixture, evaluate_dataset
from notalone.experiments.hindsight_dataset import (
    SyntheticDataset,
    SyntheticQuery,
    build_dataset,
    dataset_documents,
)
from notalone.experiments.hindsight_metrics import grouped_summaries
from notalone.memory.models import ConfirmedMemoryStatus
from notalone.experiments.pgvector_adapter import (
    PgVectorCandidateRetrieval,
    VectorHit,
)

from .client import PgVectorCandidateClient
from .embedding import EmbeddingSpec, LocalChineseEmbedder, model_path_sha256
from .runtime import PgVectorRuntime
from .store import VectorMemoryRecord, VectorTable, content_hash

CANDIDATE_LIMIT = 20


class CachedVectorClient:
    """只缓存已经由真实 pgvector 查询得到的候选与分数。"""

    def __init__(self, hits: dict[tuple[str, str, str], tuple[VectorHit, ...]]) -> None:
        self.hits = hits

    def search(self, *, scope, query: str, limit: int) -> tuple[VectorHit, ...]:
        return self.hits.get((str(scope.owner_id), str(scope.contact_id), query), ())[:limit]


class FixedVectorClient:
    """生命周期检查用的固定候选，不重新生成向量。"""

    def __init__(self, hits: tuple[VectorHit, ...]) -> None:
        self.hits = hits

    def search(self, *, scope, query: str, limit: int) -> tuple[VectorHit, ...]:
        return self.hits[:limit]


def _dataset_hashes(dataset: SyntheticDataset) -> dict[str, str]:
    return {
        name: hashlib.sha256(content.encode("utf-8")).hexdigest()
        for name, content in dataset_documents(dataset).items()
    }


def _source_files() -> tuple[tuple[str, Path], ...]:
    """列出本轮参与评测的实验代码，不含产品模块的哈希副本。"""

    root = Path(__file__).resolve().parents[2]
    paths = [
        Path("experiments/pgvector/client.py"),
        Path("experiments/pgvector/embedding.py"),
        Path("experiments/pgvector/evaluate.py"),
        Path("experiments/pgvector/runtime.py"),
        Path("experiments/pgvector/store.py"),
        Path("backend/src/notalone/experiments/pgvector_adapter.py"),
        Path("backend/src/notalone/experiments/hindsight_baseline.py"),
        Path("backend/src/notalone/experiments/hindsight_dataset.py"),
        Path("backend/src/notalone/experiments/hindsight_metrics.py"),
    ]
    return tuple(
        (str(path), root / path) for path in paths if (root / path).is_file()
    )


def _git(*arguments: str) -> str | None:
    root = Path(__file__).resolve().parents[2]
    completed = subprocess.run(
        ["git", *arguments],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        return None
    return completed.stdout


def _provenance() -> dict[str, Any]:
    """记录实际运行代码的提交与文件摘要；git 不可用时如实标注。"""

    files = _source_files()
    diff = _git("diff", "HEAD", "--", *(name for name, _ in files))
    commit = _git("rev-parse", "HEAD")
    return {
        "code_commit_at_run": commit.strip() if commit else None,
        "participating_module_sha256": {
            name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in files
        },
        "participating_diff_sha256": (
            hashlib.sha256(diff.encode("utf-8")).hexdigest() if diff is not None else None
        ),
        "diff_base": "HEAD（包含已暂存改动）",
        "git_available": commit is not None,
        "baseline_arm": "A: InMemoryRetrieval + RetrievalReplyContext.build/validate_current",
        "vector_arm": "B: pgvector 候选身份 + 本地权威复验",
        "no_external_requests": True,
    }


def _insert_memories(
    *,
    connection,
    table: VectorTable,
    embedder: LocalChineseEmbedder,
    dataset: SyntheticDataset,
) -> int:
    contact_memories = [memory for memory in dataset.memories if memory.layer == "contact"]
    vectors = embedder.encode([memory.text for memory in contact_memories])
    records = (
        VectorMemoryRecord(
            memory_id=memory.memory_id,
            owner_id=memory.scope.owner_id,
            contact_id=memory.scope.contact_id,
            revision=str(memory.revision),
            content_hash=content_hash(memory.text),
            model_id=embedder.spec.model_id,
            model_revision=embedder.spec.model_revision,
            dimensions=embedder.spec.dimensions,
            embedding=vector,
        )
        for memory, vector in zip(contact_memories, vectors)
    )
    return table.insert(connection, records)


def _capture_hits(
    *,
    client: PgVectorCandidateClient,
    queries: Sequence[SyntheticQuery],
    candidate_limit: int,
) -> dict[tuple[str, str, str], tuple[VectorHit, ...]]:
    captured: dict[tuple[str, str, str], tuple[VectorHit, ...]] = {}
    for query in queries:
        hits = client.search(scope=query.scope, query=query.text, limit=candidate_limit)
        captured[(str(query.scope.owner_id), str(query.scope.contact_id), query.text)] = hits
    return captured


def _split_queries(
    dataset: SyntheticDataset,
    split: str,
) -> tuple[SyntheticQuery, ...]:
    return tuple(query for query in dataset.queries if query.split == split)


def _evaluate_with_client(
    dataset: SyntheticDataset,
    client: object,
    tau: float,
    candidate_limit: int = CANDIDATE_LIMIT,
) -> dict[str, Any]:
    results = evaluate_dataset(
        dataset,
        retrieval_factory=lambda local: PgVectorCandidateRetrieval(
            local=local,
            client=client,
            tau=tau,
            candidate_limit=candidate_limit,
        ),
    )
    return {
        "results": results,
        "summaries": grouped_summaries(results),
    }


def _calibrate(
    dev_dataset: SyntheticDataset,
    dev_captured: dict[tuple[str, str, str], tuple[VectorHit, ...]],
    candidate_limit: int = CANDIDATE_LIMIT,
) -> tuple[float, dict[str, object]]:
    """只在 dev 候选分值上选阈值；final 相似度不进入候选网格。"""

    thresholds = sorted(
        {
            1.0,
            *(
                hit.similarity
                for hits in dev_captured.values()
                for hit in hits
                if hit.similarity > 0
            ),
        }
    )
    baseline = grouped_summaries(evaluate_dataset(dev_dataset))
    baseline_injections = sum(
        int(summary["irrelevant_injection_queries"] or 0)
        for key, summary in baseline.items()
        if key.startswith("dev/")
    )
    rows: list[tuple[float, float, float, float, dict[str, object]]] = []
    threshold_rows: list[dict[str, object]] = []
    for tau in thresholds:
        result = _evaluate_with_client(
            dev_dataset,
            CachedVectorClient(dev_captured),
            tau,
            candidate_limit,
        )
        summaries = result["summaries"]
        injection = sum(
            int(summary["irrelevant_injection_queries"] or 0)
            for key, summary in summaries.items()
            if key.startswith("dev/")
        )
        paraphrase = summaries["dev/paraphrase"]
        threshold_rows.append(
            {
                "tau": tau,
                "dev_injection_queries": injection,
                "dev_paraphrase_recall_at_5": paraphrase["macro_recall_at_5"],
                "dev_paraphrase_precision_at_5": paraphrase["macro_precision_at_5"],
            }
        )
        if injection <= baseline_injections:
            rows.append(
                (
                    float(paraphrase["macro_recall_at_5"] or 0),
                    -float(injection),
                    float(paraphrase["macro_precision_at_5"] or 0),
                    tau,
                    {
                        "tau": tau,
                        "injection_queries": injection,
                        "summaries": summaries,
                    },
                )
            )
    if not rows:
        raise RuntimeError("dev 没有满足现有无关注入上限的向量阈值")
    chosen = max(rows, key=lambda row: row[:4])
    return chosen[3], {
        "threshold_source": "dev 候选分值；final 相似度不进入阈值网格",
        "candidate_limit": candidate_limit,
        "baseline_injection_queries": baseline_injections,
        "threshold_count": len(thresholds),
        "feasible_count": len(rows),
        "selection_order": [
            "dev 无关注入不高于词法基线",
            "dev 改写宏 Recall 最大",
            "dev 误注入 query 最少",
            "dev 有选入 query 宏 Precision 最大",
            "阈值最大",
        ],
        "selected": chosen[4],
        "threshold_rows": threshold_rows,
    }


def _lifecycle_checks(
    dataset: SyntheticDataset,
    captured: dict[tuple[str, str, str], tuple[VectorHit, ...]],
    tau: float,
) -> dict[str, Any]:
    """证明向量残留时当前权威状态仍决定最终是否可见。"""

    fixture = build_fixture(dataset)
    selected_pair = next(
        (
            (query, hit)
            for query in dataset.queries
            for hit in captured.get(
                (str(query.scope.owner_id), str(query.scope.contact_id), query.text),
                (),
            )
            if hit.similarity >= tau
        ),
        None,
    )
    if selected_pair is None:
        return {
            "status": "blocked",
            "reason": "dev 冻结阈值下没有可用于生命周期复验的向量候选",
            "cases": [],
        }
    query, target = selected_pair
    original = fixture.memory_store._memories.get(target.memory_id)  # type: ignore[attr-defined]
    if original is None:
        return {
            "status": "blocked",
            "reason": "向量候选未映射到合成权威记忆",
            "cases": [],
        }

    def run_case(name: str, memory: Any, expected_selected: bool) -> dict[str, Any]:
        fixture.memory_store._memories[target.memory_id] = memory  # type: ignore[attr-defined]
        adapter = PgVectorCandidateRetrieval(
            local=fixture.local_retrieval,
            client=FixedVectorClient((target,)),
            tau=tau,
            candidate_limit=20,
        )
        selected = adapter.search_confirmed_memories(
            scope=query.scope,
            query=query.text,
            limit=5,
        )
        selected_ids = tuple(str(item.memory_id) for item in selected)
        passed = (str(target.memory_id) in selected_ids) is expected_selected
        return {
            "case": name,
            "passed": passed,
            "selected_ids": selected_ids,
            "target_memory_id": str(target.memory_id),
            "diagnostics": asdict(adapter.last_attempt),
        }

    cases = [
        run_case("active", original, True),
        run_case("stale_revision", replace(original, revision=original.revision + 1), False),
        run_case("deleted", replace(original, status=ConfirmedMemoryStatus.DELETED), False),
        run_case("invalidated", replace(original, status=ConfirmedMemoryStatus.INVALIDATED), False),
        run_case(
            "expired",
            replace(
                original,
                invalid_at=datetime.now(timezone.utc) - timedelta(seconds=1),
            ),
            False,
        ),
    ]
    foreign_hit = replace(target, scope=replace(query.scope, owner_id=uuid4()))
    foreign_adapter = PgVectorCandidateRetrieval(
        local=fixture.local_retrieval,
        client=FixedVectorClient((foreign_hit,)),
        tau=tau,
        candidate_limit=20,
    )
    foreign_selected = foreign_adapter.search_confirmed_memories(
        scope=query.scope,
        query=query.text,
        limit=5,
    )
    cases.append(
        {
            "case": "foreign_scope",
            "passed": not foreign_selected,
            "selected_ids": tuple(str(item.memory_id) for item in foreign_selected),
            "target_memory_id": str(target.memory_id),
            "diagnostics": asdict(foreign_adapter.last_attempt),
        }
    )
    fixture.memory_store._memories[target.memory_id] = original  # type: ignore[attr-defined]
    return {
        "status": "passed" if all(case["passed"] for case in cases) else "failed",
        "cases": cases,
        "authority": "InMemoryMemoryStore current active/valid/source/revision re-read",
        "vector_rows_retained_during_check": True,
    }


def _environment_summary() -> dict[str, Any]:
    """记录运行环境的最小可复核信息，不含任何凭据。"""

    def package_version(name: str) -> str | None:
        try:
            return importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            return None

    return {
        "python_version": platform.python_version(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "pg0_version": package_version("pg0-embedded"),
        "psycopg_version": package_version("psycopg2-binary") or package_version("psycopg"),
        "sentence_transformers_version": package_version("sentence-transformers"),
    }


def _directory_size_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file():
        return path.stat().st_size
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def _cleanup_evidence(runtime: PgVectorRuntime, output: Path, elapsed_seconds: float) -> dict[str, Any]:
    """记录本轮临时资源清理结果与产物占用。"""

    error: str | None = None
    try:
        runtime.drop()
    except Exception as exc:  # noqa: BLE001 - 清理失败必须写进证据而不是静默
        error = f"{type(exc).__name__}: {exc}"
    if runtime.runtime_dir.exists():
        shutil.rmtree(runtime.runtime_dir, ignore_errors=True)
    return {
        "runtime_dir": str(runtime.runtime_dir),
        "runtime_dir_removed": not runtime.runtime_dir.exists(),
        "db_name": runtime.db_name,
        "db_port": runtime.db_port,
        "drop_error": error,
        "output_dir": str(output),
        "output_size_bytes": _directory_size_bytes(output),
        "model_path_size_bytes": None,
        "elapsed_seconds": round(elapsed_seconds, 3),
        "scope": "只清理本轮命名实例、runtime 目录和产物；不操作业务库或其他 pg0",
    }


def _evaluate(
    *,
    output: Path,
    model_path: Path,
    runtime: PgVectorRuntime,
    dataset: SyntheticDataset,
    dataset_hashes: dict[str, str],
    provenance: dict[str, Any],
) -> tuple[dict[str, object], Any, bool]:
    """执行一轮评测；调用方负责清理临时运行时。"""

    spec = EmbeddingSpec()
    embedder = LocalChineseEmbedder(spec=spec, model_path=model_path, device="cpu")
    started = False
    connection = None
    try:
        runtime.start()
        started = True
        table = VectorTable(dimensions=spec.dimensions, model_id=spec.model_id)
        table_info = runtime.initialize_vector_table(hnsw=True)
        runtime_evidence = runtime.probe(embedding=spec).as_dict()
        runtime_evidence["data_hash"] = hashlib.sha256(
            json.dumps(dataset_hashes, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()
        # 临时 runtime 目录随后会被删除，把已去凭据的 manifest 复制到产物目录，
        # 保证运行前提证据可以脱离临时目录复核。
        output.mkdir(parents=True, exist_ok=True)
        (output / "runtime-manifest.json").write_text(
            json.dumps(runtime_evidence, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        connection = runtime.connect()
        inserted = _insert_memories(
            connection=connection,
            table=table,
            embedder=embedder,
            dataset=dataset,
        )
        client = PgVectorCandidateClient(
            connection=connection,
            table=table,
            embedder=embedder,
        )
        captured_dev = _capture_hits(
            client=client,
            queries=_split_queries(dataset, "dev"),
            candidate_limit=CANDIDATE_LIMIT,
        )
        dev_dataset = replace(dataset, queries=_split_queries(dataset, "dev"))
        tau, calibration = _calibrate(dev_dataset, captured_dev, CANDIDATE_LIMIT)
        lifecycle = _lifecycle_checks(dataset, captured_dev, tau)
        # 最终组重新走实时向量查询，计时包含 embedding、SQL 和 Context。
        final_dataset = replace(
            dataset,
            queries=_split_queries(dataset, "final"),
        )
        baseline = grouped_summaries(evaluate_dataset(final_dataset))
        b_result = _evaluate_with_client(final_dataset, client, tau, CANDIDATE_LIMIT)
        vector_results = tuple(b_result["results"])
        baseline_results = tuple(evaluate_dataset(final_dataset))
        latency = _latency_summary(vector_results)
        baseline_quality = baseline["final/quality"]
        vector_quality = b_result["summaries"]["final/quality"]
        baseline_paraphrase = baseline["final/paraphrase"]
        vector_paraphrase = b_result["summaries"]["final/paraphrase"]
        baseline_direct = baseline["final/direct"]
        vector_direct = b_result["summaries"]["final/direct"]
        safety_zero = all(
            summary[key] == 0
            for summary in b_result["summaries"].values()
            if isinstance(summary, dict)
            for key in ("failed_queries", "over_budget_queries", "duplicate_ids", "scope_violations")
        )
        gates = {
            "rewrite_recall_gain_at_least_0_10": (
                float(vector_paraphrase["macro_recall_at_5"] or 0)
                - float(baseline_paraphrase["macro_recall_at_5"] or 0)
                >= 0.10
            ),
            "irrelevant_injection_not_increased": (
                vector_quality["irrelevant_injection_query_rate"]
                <= baseline_quality["irrelevant_injection_query_rate"]
            ),
            "direct_recall_not_lower": (
                float(vector_direct["macro_recall_at_5"] or 0)
                >= float(baseline_direct["macro_recall_at_5"] or 0)
            ),
            "scope_state_source_revision_and_budget_zero": safety_zero,
            "complete_retrieval_p95_at_most_1000_ms": latency["p95_ms"] <= 1000,
            "lifecycle_currentness_and_scope_passed": lifecycle["status"] == "passed",
        }
        report: dict[str, object] = {
            "dataset_id": dataset.dataset_id,
            "dataset_hashes": dataset_hashes,
            "provenance": provenance,
            "environment": _environment_summary(),
            "embedding": embedder.summary(),
            "runtime": runtime_evidence,
            "model_path_sha256": model_path_sha256(model_path),
            "vector_table": table_info,
            "candidate_limit": CANDIDATE_LIMIT,
            "inserted_records": inserted,
            "calibration": calibration,
            "tau": tau,
            "lifecycle": lifecycle,
            "baseline_summaries": baseline,
            "vector_summaries": b_result["summaries"],
            "vector_results": [asdict(result) for result in vector_results],
            "baseline_results": [asdict(result) for result in baseline_results],
            "latency": latency,
            "gates": gates,
            "verdict": "达到门槛" if all(gates.values()) else "未达到门槛",
            "calibration_is_dev_only": True,
            "scope": "synthetic confirmed contact memories only; Hindsight service unused",
        }
        return report, connection, started
    except BaseException:
        if connection is not None:
            connection.close()
        if started:
            runtime.cleanup(remove_runtime_dir=True)
        raise


def run(*, output: Path, model_path: Path, runtime_dir: Path) -> dict[str, object]:
    # 运行开始时采样源码与提交，保证记录的哈希对应当前已加载的代码。
    provenance = _provenance()
    dataset = build_dataset()
    dataset_hashes = _dataset_hashes(dataset)
    runtime = PgVectorRuntime(runtime_dir)
    started_at = perf_counter()
    report, connection, started = _evaluate(
        output=output,
        model_path=model_path,
        runtime=runtime,
        dataset=dataset,
        dataset_hashes=dataset_hashes,
        provenance=provenance,
    )
    if connection is not None:
        connection.close()
    if started:
        runtime.cleanup(remove_runtime_dir=True)
    cleanup = _cleanup_evidence(runtime, output, perf_counter() - started_at)
    cleanup["model_path_size_bytes"] = _directory_size_bytes(model_path)
    # 产物大小要包含本轮新写的 result.json，所以先写一次再回填测量值。
    cleanup["output_size_bytes"] = None
    report["cleanup"] = cleanup
    output.mkdir(parents=True, exist_ok=True)
    result_path = output / "result.json"
    result_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )
    cleanup["output_size_bytes"] = _directory_size_bytes(output)
    result_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )
    return report


def _latency_summary(results: tuple[Any, ...]) -> dict[str, Any]:
    """按最终 Context 调用耗时计算包含全部结果的 nearest-rank 分位数。"""

    values = sorted(float(result.elapsed_ms) for result in results)
    if not values:
        return {
            "count": 0,
            "p50_ms": None,
            "p95_ms": None,
            "max_ms": None,
            "failures": 0,
        }

    def nearest_rank(percentile: float) -> float:
        import math

        return values[max(0, math.ceil(percentile * len(values)) - 1)]

    return {
        "count": len(values),
        "p50_ms": nearest_rank(0.50),
        "p95_ms": nearest_rank(0.95),
        "max_ms": values[-1],
        "failures": sum(result.status == "failed" for result in results),
        "quantile_rule": "排序后第 ceil(p*N) 个值；包含失败结果",
        "scope": "embedding + pgvector SQL + candidate mapping + local authority revalidation + Context",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="原 PostgreSQL＋pgvector 隔离 A/B")
    parser.add_argument("--output", type=Path, default=Path("experiments/pgvector/runs/latest"))
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument("--runtime-dir", type=Path, default=Path("/tmp/notalone-pgvector-memory-recall"))
    args = parser.parse_args()
    report = run(output=args.output, model_path=args.model_path, runtime_dir=args.runtime_dir)
    print(json.dumps(report["vector_summaries"], ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
