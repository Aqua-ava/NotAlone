"""冻结 tau 后运行真实 A/B；只管理本任务明确拥有的合成 bank。"""

from __future__ import annotations

import argparse
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
from time import perf_counter
from typing import Any

from notalone.experiments.hindsight_baseline import build_fixture
from notalone.experiments.hindsight_calibration import (
    ExperimentAttempt,
    calibrate,
    evaluate_arm,
    latency_summary,
)
from notalone.experiments.hindsight_client import (
    HindsightFailure,
    HindsightHttpClient,
    bank_id_for,
)
from notalone.experiments.hindsight_comparison_io import (
    ResourceObservation,
    hardware,
    provenance,
    verify_frozen_dataset,
    write_json,
)
from notalone.experiments.hindsight_dataset import build_dataset
from notalone.experiments.hindsight_lifecycle import memory_item
from notalone.experiments.hindsight_lifecycle_db import LifecycleDatabase
from notalone.experiments.hindsight_metrics import grouped_summaries
from notalone.experiments.hindsight_runtime import (
    DEFAULT_RUNTIME,
    SOURCE_SHA,
    run_external,
)


def _client(runtime: Path, banks: frozenset[str]) -> HindsightHttpClient:
    return HindsightHttpClient(
        base_url="http://127.0.0.1:18888",
        log_path=runtime / "service.log",
        allowed_bank_ids=banks,
    )


def _runtime_evidence(runtime: Path) -> dict[str, Any]:
    manifest = json.loads((runtime / "manifest.json").read_text())
    if manifest["source_sha"] != SOURCE_SHA:
        raise ValueError("服务源码 SHA 与已经验证的配置不一致。")
    config = json.loads((runtime / "service-config.json").read_text())
    fixed = {
        "HINDSIGHT_API_LLM_PROVIDER": "none",
        "HINDSIGHT_API_EMBEDDINGS_PROVIDER": "local",
        "HINDSIGHT_API_RERANKER_PROVIDER": "local",
        "HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION": "false",
        "HINDSIGHT_API_RETAIN_EXTRACTION_MODE": "chunks",
        "HF_HUB_OFFLINE": "1",
        "PYTHON_DOTENV_DISABLED": "1",
        "OMP_NUM_THREADS": "2",
    }
    if any(config.get(key) != value for key, value in fixed.items()):
        raise ValueError("服务实际启动配置与本机离线方案不一致。")
    versions = json.loads(
        run_external(
            runtime,
            "import importlib.metadata as m,json; packages=['hindsight-api-slim','sentence-transformers','transformers','torch','pg0-embedded','toktok-rs']; print(json.dumps({p:m.version(p) for p in packages}))",
        )
    )
    if versions != manifest["versions"]:
        raise ValueError("运行依赖版本不同，必须先重新验证 smoke/lifecycle。")
    return {
        "manifest": manifest,
        "actual_versions": versions,
        "inference_config": {
            **fixed,
            **{
                key: config[key]
                for key in (
                    "HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL",
                    "HINDSIGHT_API_RERANKER_LOCAL_MODEL",
                    "HINDSIGHT_API_EMBEDDINGS_LOCAL_FORCE_CPU",
                    "HINDSIGHT_API_RERANKER_LOCAL_FORCE_CPU",
                    "HINDSIGHT_API_WORKER_ENABLED",
                    "HINDSIGHT_API_OTEL_TRACES_ENABLED",
                )
            },
        },
        "service_pid_at_run": int((runtime / "service.pid").read_text()),
    }


def _stage_summary(attempts: tuple[ExperimentAttempt, ...]) -> dict[str, Any]:
    stages: dict[str, list[float]] = {
        "external_mapped_candidate_recall": [],
        "after_tau_and_local_hydration_recall": [],
        "final_context_recall": [],
    }
    for attempt in attempts:
        result = attempt.result
        if result.group != "paraphrase" or not result.contact_gold:
            continue
        gold = {str(identity.memory_id) for identity in result.contact_gold}
        # 外部阶段只计 scope/layer/document 可映射身份；不声称已过当前性。
        external = {
            hit.metadata.get("local_memory_id", "")
            for frame in attempt.frames
            for hit in frame.batch.hits
            if hit.metadata.get("owner_id") == str(result.contact_gold[0].owner_id)
            and hit.metadata.get("contact_id") == str(result.contact_gold[0].contact_id)
            and hit.metadata.get("layer") == "confirmed_memory"
            and hit.document_id == "memory-" + hit.metadata.get("local_memory_id", "")
        }
        hydrated = {
            str(mid) for mid in (attempt.diagnostics or {}).get("selected_ids", ())
        }
        final = {str(item.identity.memory_id) for item in result.contact_selected}
        for name, selected in zip(stages, (external, hydrated, final)):
            stages[name].append(len(gold & selected) / len(gold))
    return {
        name: sum(values) / len(values) if values else None
        for name, values in stages.items()
    }


def _safety(attempts: tuple[ExperimentAttempt, ...]) -> dict[str, int]:
    return {
        "scope_violations": sum(a.result.scope_violations for a in attempts),
        "over_budget_queries": sum(a.result.over_budget for a in attempts),
        "duplicate_ids": sum(a.result.duplicate_ids for a in attempts),
        "state_or_source_violations": sum(
            "state_or_source" in record["violations"]
            or "missing_local_authority" in record["violations"]
            for a in attempts
            for record in a.authority_audit
        ),
        "authority_field_violations": sum(
            len(record["violations"]) for a in attempts for record in a.authority_audit
        ),
        "audited_final_records": sum(len(a.authority_audit) for a in attempts),
    }


def run(
    *, output: Path, runtime: Path, cost_evidence: Path, preflight: Path
) -> dict[str, Any]:
    if output.exists():
        raise ValueError("产物目录已存在；不得覆盖已运行结果。清理后请另建运行目录。")
    root = Path(__file__).resolve().parents[3]
    repository_root = root.parent
    dataset = build_dataset()
    hashes = verify_frozen_dataset(dataset, repository_root / "experiments/hindsight/v2")
    fixture = build_fixture(dataset)
    scopes = sorted(
        {m.scope for m in dataset.memories if m.layer == "contact"},
        key=lambda s: (str(s.owner_id), str(s.contact_id)),
    )
    banks = frozenset(bank_id_for(scope) for scope in scopes)
    client, database = _client(runtime, banks), LifecycleDatabase(banks)
    health = client.request("GET", "/health")
    runtime_evidence = _runtime_evidence(runtime)
    smoke = json.loads((preflight / "smoke-result.json").read_text())
    lifecycle = json.loads((preflight / "lifecycle-result.json").read_text())
    if (
        smoke["pass"] is not True
        or lifecycle["status"] != "passed"
        or not all(case["passed"] for case in lifecycle["cases"])
    ):
        raise HindsightFailure("已验证配置的smoke/lifecycle前提未满足。")
    preflight_hashes = {
        name: hashlib.sha256((preflight / name).read_bytes()).hexdigest()
        for name in (
            "smoke-result.json",
            "lifecycle-result.json",
            "code-provenance.json",
        )
    }
    checked_code = json.loads((preflight / "code-provenance.json").read_text())
    current_code = provenance(root)["participating_file_sha256"]
    required_modules = (
        "hindsight_client",
        "hindsight_adapter",
        "hindsight_lifecycle",
        "hindsight_lifecycle_db",
        "hindsight_runtime",
    )
    if any(
        checked_code["participating_file_sha256"][f"src/notalone/experiments/{name}.py"]
        != current_code[f"src/notalone/experiments/{name}.py"]
        for name in required_modules
    ):
        raise HindsightFailure("smoke/lifecycle之后接缝代码有变化，须重新复验。")
    initial = {bank: database.bank(bank) for bank in sorted(banks)}
    if any(any(snapshot["counts"].values()) for snapshot in initial.values()):
        raise HindsightFailure("冻结 dataset 的 bank 已被占用；禁止自动清除或复用。")
    final_queries = tuple(q for q in dataset.queries if q.split == "final")
    warmups = tuple(
        next(q for q in final_queries if q.group == group)
        for group in sorted({q.group for q in final_queries})
    )
    stable_ids = ("final-coffee-paraphrase-1", "final-meeting-direct", "final-topic-2")
    plan = {
        "recorded_before_calibration_at": datetime.now(timezone.utc).isoformat(),
        "dataset_id": dataset.dataset_id,
        "dataset_hashes": hashes,
        "formal_attempts_per_arm": len(final_queries),
        "formal_order": [
            {
                "query_id": q.query_id,
                "arms": ["A", "B"] if index % 2 == 0 else ["B", "A"],
            }
            for index, q in enumerate(final_queries)
        ],
        "warmup_query_ids": [q.query_id for q in warmups],
        "warmup_repetitions_per_arm": 1,
        "stability_query_ids": stable_ids,
        "stability_repetitions_per_arm": 3,
        "latency_boundary": "evaluate_query: 从 Port 装配/Context.build 至 validate_current 完成，含真实HTTP；逐ID额外审计另报，不含模型加载/建索引/生成。",
        "source_rule": "仅本机、新建公开合成数据；不读取业务.env/数据库/真实聊天。",
        "initial_banks": initial,
        "preflight_evidence_directory": str(preflight),
        "preflight_evidence_hashes": preflight_hashes,
    }
    write_json(output / "run-plan.json", plan)
    owned: dict[str, Any] = {
        "dataset_id": dataset.dataset_id,
        "bank_ids": sorted(banks),
        "created": {},
    }
    write_json(output / "owned-banks.json", owned)
    observer = ResourceObservation(runtime)
    observer.start()
    index_events: list[dict[str, Any]] = []
    try:
        for scope in scopes:
            bank = bank_id_for(scope)
            config: dict[str, Any] = client.create_bank(bank)
            snapshot = database.bank(bank)
            owned["created"][bank] = {
                "scope": asdict(scope),
                "internal_id": snapshot["internal_id"],
                "config": config,
            }
            write_json(output / "owned-banks.json", owned)
            if (
                config["config"]["retain_extraction_mode"] != "chunks"
                or config["config"]["enable_auto_consolidation"] is not False
                or any(
                    snapshot["counts"][name]
                    for name in (
                        "memory_units",
                        "chunks",
                        "mental_models",
                        "observation_history",
                    )
                )
            ):
                raise HindsightFailure("新 bank 配置/空索引检查失败。")

        def index_scope(scope) -> None:
            memories = fixture.memory_store.list_confirmed(scope)
            started = perf_counter()
            batches: list[dict[str, Any]] = []
            for offset in range(0, len(memories), 25):
                batch_started = perf_counter()
                response = client.retain(
                    bank_id=bank_id_for(scope),
                    items=[
                        memory_item(memory) for memory in memories[offset : offset + 25]
                    ],
                )
                if (
                    response.get("success") is not True
                    or response.get("async") is not False
                ):
                    raise HindsightFailure("正式建索引没有同步完成。")
                batches.append(
                    {
                        "offset": offset,
                        "count": len(memories[offset : offset + 25]),
                        "elapsed_ms": (perf_counter() - batch_started) * 1000,
                        "response": response,
                    }
                )
            after = database.bank(bank_id_for(scope))
            if (
                after["counts"]["documents"] != len(memories)
                or after["counts"]["memory_units"] < len(memories)
                or after["counts"]["mental_models"] != 0
            ):
                raise HindsightFailure("建索引数量或没有mental model前提未获验证。")
            index_events.append(
                {
                    "bank_id": bank_id_for(scope),
                    "scope": asdict(scope),
                    "local_total_records": sum(
                        m.layer == "contact" and m.scope == scope
                        for m in dataset.memories
                    ),
                    "local_current_eligible_records": len(memories),
                    "indexed_documents": after["counts"]["documents"],
                    "indexed_units": after["counts"]["memory_units"],
                    "elapsed_ms": (perf_counter() - started) * 1000,
                    "batches": batches,
                    "database_after": after,
                }
            )
            write_json(output / "index-events.json", index_events)
            print(f"已索引 {bank_id_for(scope)}：{len(memories)} 条", flush=True)

        dev_scope = next(q.scope for q in dataset.queries if q.split == "dev")
        index_scope(dev_scope)
        calibration = calibrate(fixture, client)
        write_json(output / "calibration.json", calibration)
        if not calibration["prerequisites_met"] or calibration["tau_B"] is None:
            blocked_result = {
                "verdict": (
                    "运行前提未满足"
                    if not calibration["prerequisites_met"]
                    else "未达到门槛"
                ),
                "reason": "独立 dev 未产生可接受 tau_B",
                "calibration": calibration,
            }
            write_json(output / "result.json", blocked_result)
            return blocked_result
        tau = float(calibration["tau_B"])
        frozen: dict[str, Any] = {
            "frozen_before_final_at": datetime.now(timezone.utc).isoformat(),
            "tau_B": tau,
            "score_field": "scores.reranker (HTTP normalized, higher is better)",
            "chunk_rule": "最佳当前revision chunk reranker>=tau_B过门；过门chunk最佳final排序，再以local UUID稳定排序；local候选limit20。",
            "budget": "low",
            "http_max_tokens": 4096,
            "http_timeout_seconds": 30,
            "types": ["world"],
            "query_timestamp": "2026-10-04T00:00:00Z",
            "query_rule": "既有NFKC/casefold、200字符头尾采样与token空跳过规则",
            "contact_budget": {"count": 5, "chars": 600},
            "owner_budget": {"count": 3, "chars": 240},
            "dataset_hashes": hashes,
            "runtime": runtime_evidence,
            "provenance": provenance(root),
            "run_plan_sha256": hashlib.sha256(
                (output / "run-plan.json").read_bytes()
            ).hexdigest(),
            "calibration_sha256": hashlib.sha256(
                (output / "calibration.json").read_bytes()
            ).hexdigest(),
        }
        write_json(output / "frozen-config.json", frozen)
        frozen_hash = hashlib.sha256(
            (output / "frozen-config.json").read_bytes()
        ).hexdigest()
        print(
            f"dev 已冻结 tau_B={tau:.9g}，阈值候选 {len(calibration['threshold_rows'])} 个",
            flush=True,
        )
        for scope in scopes:
            if scope != dev_scope:
                index_scope(scope)
        warmup_attempts = tuple(
            evaluate_arm(fixture, q, client=None if arm == "A" else client, tau=tau)
            for q in warmups
            for arm in ("A", "B")
        )
        write_json(
            output / "warmup-attempts.json", [asdict(a) for a in warmup_attempts]
        )
        formal: list[ExperimentAttempt] = []
        for index, query in enumerate(final_queries):
            for arm in ("A", "B") if index % 2 == 0 else ("B", "A"):
                formal.append(
                    evaluate_arm(
                        fixture, query, client=None if arm == "A" else client, tau=tau
                    )
                )
            if (index + 1) % 10 == 0:
                write_json(output / "formal-attempts.json", [asdict(a) for a in formal])
                print(
                    f"正式对照 {index + 1}/{len(final_queries)} query 完成", flush=True
                )
        write_json(output / "formal-attempts.json", [asdict(a) for a in formal])
        stability = tuple(
            evaluate_arm(
                fixture,
                next(q for q in final_queries if q.query_id == query_id),
                client=None if arm == "A" else client,
                tau=tau,
            )
            for query_id in stable_ids
            for _ in range(3)
            for arm in ("A", "B")
        )
        write_json(output / "stability-attempts.json", [asdict(a) for a in stability])
        stable = all(
            len(
                {
                    tuple(str(m.identity.memory_id) for m in a.result.contact_selected)
                    for a in stability
                    if a.arm == arm and a.result.query_id == query_id
                }
            )
            == 1
            and all(
                a.result.status == "succeeded"
                for a in stability
                if a.arm == arm and a.result.query_id == query_id
            )
            for arm in ("A", "B")
            for query_id in stable_ids
        )
        arms = {arm: tuple(a for a in formal if a.arm == arm) for arm in ("A", "B")}
        summaries: dict[str, Any] = {
            arm: grouped_summaries(tuple(a.result for a in attempts))
            for arm, attempts in arms.items()
        }
        latency = {arm: latency_summary(attempts) for arm, attempts in arms.items()}
        safety = {arm: _safety(attempts) for arm, attempts in arms.items()}
        gain = (
            summaries["B"]["final/paraphrase"]["macro_recall_at_5"]
            - summaries["A"]["final/paraphrase"]["macro_recall_at_5"]
        )
        owner_matches = all(
            a.result.owner_selected == b.result.owner_selected
            for a, b in zip(arms["A"], arms["B"])
        )
        unchanged = (
            provenance(root)["participating_file_sha256"]
            == frozen["provenance"]["participating_file_sha256"]
            and verify_frozen_dataset(dataset, repository_root / "experiments/hindsight/v2")
            == hashes
            and hashlib.sha256((output / "frozen-config.json").read_bytes()).hexdigest()
            == frozen_hash
        )
        gates = {
            "recall_gain_at_least_0_10": gain >= 0.10,
            "irrelevant_injection_not_increased": summaries["B"]["final/quality"][
                "irrelevant_injection_query_rate"
            ]
            <= summaries["A"]["final/quality"]["irrelevant_injection_query_rate"],
            "scope_state_source_budget_duplicate_and_authority_zero": all(
                all(
                    value == 0
                    for key, value in counts.items()
                    if key != "audited_final_records"
                )
                for counts in safety.values()
            ),
            "full_B_p95_at_most_1000_ms": latency["B"]["all_attempts"]["p95_ms"]
            <= 1000,
            "each_arm_at_least_100_attempts": all(len(a) >= 100 for a in arms.values()),
            "owner_local_path_identical": owner_matches,
            "source_model_dataset_rules_unchanged_after_freeze": unchanged,
            "repeated_query_id_order_stable": stable,
            "lifecycle_preconditions_passed": lifecycle["status"] == "passed",
        }
        result = {
            "verdict": "达到门槛" if all(gates.values()) else "未达到门槛",
            "recorded_at": datetime.now(timezone.utc).isoformat(),
            "gates": gates,
            "recall_gain": gain,
            "tau_B": tau,
            "summaries": summaries,
            "latency": latency,
            "safety": safety,
            "B_candidate_stage_summaries": _stage_summary(arms["B"]),
            "unexpected_final_ids": {
                arm: [
                    {
                        "query_id": a.result.query_id,
                        "memory_id": str(m.identity.memory_id),
                        "text": m.text,
                    }
                    for a in attempts
                    if a.result.group in ("paraphrase", "direct", "empty", "topic")
                    for m in a.result.contact_selected
                    if m.identity not in a.result.contact_gold
                ]
                for arm, attempts in arms.items()
            },
            "hardware": hardware(),
            "health_before_run": health,
            "models_cached_restart_to_health_ms_from_lifecycle": next(
                check["evidence"]["restart_to_health_ms"]
                for check in lifecycle["cases"]
                if "restart_to_health_ms" in check.get("evidence", {})
            ),
            "frozen_config_sha256": frozen_hash,
            "final_provenance": provenance(root),
            "download_cost_evidence": (
                "download-cost-evidence.json" if cost_evidence.exists() else "未记录"
            ),
        }
        if cost_evidence.exists():
            shutil.copyfile(cost_evidence, output / "download-cost-evidence.json")
        write_json(output / "result.json", result)
        return result
    finally:
        write_json(output / "resources.json", observer.finish())


def cleanup(*, output: Path, runtime: Path) -> dict[str, Any]:
    owned = json.loads((output / "owned-banks.json").read_text())
    expected = frozenset(
        bank_id_for(m.scope) for m in build_dataset().memories if m.layer == "contact"
    )
    if (
        owned["dataset_id"] != build_dataset().dataset_id
        or frozenset(owned["bank_ids"]) != expected
        or not set(owned["created"]).issubset(expected)
    ):
        raise ValueError("owned manifest 与冻结实验范围不一致。")
    client, database = _client(runtime, expected), LifecycleDatabase(expected)
    evidence: dict[str, Any] = {}
    for bank, entry in owned["created"].items():
        before = database.bank(bank)
        if before["internal_id"] not in (None, entry["internal_id"]):
            raise HindsightFailure("bank 已被其他运行重建，拒绝清理。")
        response = client.delete_bank(bank_id=bank)
        after = database.bank(bank, previous_internal_id=entry["internal_id"])
        if any(after["counts"].values()) or after["indexes"]:
            raise HindsightFailure("bank 清理后仍有活动行或作用域索引。")
        evidence[bank] = {"response": response, "before": before, "after": after}
    write_json(output / "cleanup.json", evidence)
    return evidence


def main() -> int:
    parser = argparse.ArgumentParser(
        description="本机合成记忆的独立校准和冻结真实A/B，不启用生产检索。"
    )
    parser.add_argument("operation", choices=("run", "cleanup"))
    parser.add_argument(
        "--output", type=Path, default=Path("experiments/hindsight/comparison-v2")
    )
    parser.add_argument("--runtime-dir", type=Path, default=DEFAULT_RUNTIME)
    parser.add_argument(
        "--cost-evidence",
        type=Path,
        default=Path("/tmp/notalone-hindsight-cost-evidence.json"),
    )
    parser.add_argument(
        "--preflight",
        type=Path,
        default=Path("experiments/hindsight/comparison-v2-r2-preflight"),
    )
    args = parser.parse_args()
    if args.operation == "cleanup":
        evidence = cleanup(output=args.output, runtime=args.runtime_dir)
        print(f"已按 owned manifest 清理 {len(evidence)} 个合成 bank。")
        return 0
    try:
        result = run(
            output=args.output,
            runtime=args.runtime_dir,
            cost_evidence=args.cost_evidence,
            preflight=args.preflight,
        )
    except Exception as exc:
        if args.output.exists():
            write_json(
                args.output / "failure.json",
                {
                    "status": "运行前提未满足",
                    "error_type": type(exc).__name__,
                    "reason": str(exc),
                    "recorded_at": datetime.now(timezone.utc).isoformat(),
                },
            )
        raise
    print(
        json.dumps(
            {
                "verdict": result["verdict"],
                "tau_B": result.get("tau_B"),
                "recall_gain": result.get("recall_gain"),
                "output": str(args.output),
            },
            ensure_ascii=False,
        )
    )
    return 0 if result["verdict"] != "运行前提未满足" else 2


if __name__ == "__main__":
    raise SystemExit(main())
