"""用独立 dev 的真实候选校准门，所有选入仍经过真实 Context。"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import math
from time import perf_counter
from typing import Any
from uuid import UUID

from notalone.experiments.hindsight_adapter import HindsightRetrieval
from notalone.experiments.hindsight_baseline import FixtureHandles, evaluate_query
from notalone.experiments.hindsight_client import (
    HindsightFailure,
    RecallBatch,
    RecallClient,
)
from notalone.experiments.hindsight_dataset import SyntheticQuery
from notalone.experiments.hindsight_metrics import QueryResult, summarize_results
from notalone.reply.context import ReplyContext
from notalone.retrieval.models import RetrievedMemory
from notalone.scopes import ContactScope


@dataclass(frozen=True)
class RecallFrame:
    bank_id: str
    query: str
    batch: RecallBatch


class RecordingClient:
    """在外部边界保留实际响应，不改写分数或候选身份。"""

    def __init__(self, delegate: RecallClient) -> None:
        self.delegate = delegate
        self.frames: list[RecallFrame] = []
        self.attempts = 0

    def recall(self, *, bank_id: str, query: str) -> RecallBatch:
        self.attempts += 1
        batch = self.delegate.recall(bank_id=bank_id, query=query)
        self.frames.append(RecallFrame(bank_id, query, batch))
        return batch


class ReplayClient:
    """仅用于 dev 参数搜索；其耗时不作为真实服务耗时。"""

    def __init__(self, frames: tuple[RecallFrame, ...]) -> None:
        self.batches = {(frame.bank_id, frame.query): frame.batch for frame in frames}

    def recall(self, *, bank_id: str, query: str) -> RecallBatch:
        try:
            return self.batches[bank_id, query]
        except KeyError as exc:
            raise HindsightFailure("dev 没有对应真实候选，禁止补造响应。") from exc


class _CapturedRetrieval(HindsightRetrieval):
    """保留 Port 返回的本地字段，以核对 Context 不保存的采纳信息。"""

    returned: tuple[RetrievedMemory, ...] = ()

    def search_confirmed_memories(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
        limit: int = 20,
        memory_ids: tuple[UUID, ...] | None = None,
        include_historical: bool = False,
    ) -> tuple[RetrievedMemory, ...]:
        result = super().search_confirmed_memories(
            scope=scope, query=query, limit=limit, memory_ids=memory_ids,
            **({"include_historical": True} if include_historical else {}),
        )
        if query is not None and memory_ids is None:
            self.returned = result
        return result


@dataclass(frozen=True)
class ExperimentAttempt:
    arm: str
    result: QueryResult
    http_attempts: int
    frames: tuple[RecallFrame, ...]
    diagnostics: dict[str, Any] | None
    authority_audit: tuple[dict[str, Any], ...]
    audit_elapsed_ms: float


def evaluate_arm(
    fixture: FixtureHandles,
    query: SyntheticQuery,
    *,
    client: RecallClient | None = None,
    tau: float = 1.0,
) -> ExperimentAttempt:
    """计时使用既有完整 runner；逐 ID 审计在计时后另报。"""

    recorder = None if client is None else RecordingClient(client)
    adapter = (
        None
        if recorder is None
        else _CapturedRetrieval(local=fixture.local_retrieval, client=recorder, tau=tau)
    )
    contexts: list[ReplyContext] = []
    result = evaluate_query(
        fixture,
        query,
        retrieval_factory=None if adapter is None else lambda local: adapter,
        before_validate=lambda handles, context: contexts.append(context),
    )
    audit_started = perf_counter()
    audits: list[dict[str, Any]] = []
    now = datetime.now(timezone.utc)
    if result.status == "succeeded" and contexts:
        context = contexts[0]
        fields = (
            "text",
            "source_ids",
            "status",
            "valid_at",
            "invalid_at",
            "revision",
            "timing",
        )
        for selected in (*result.contact_selected, *result.owner_selected):
            identity = selected.identity
            evidence = next(
                e for e in context.evidence if e.evidence_id == identity.memory_id
            )
            records = (
                fixture.local_retrieval.search_confirmed_memories(
                    scope=query.scope, query=None, memory_ids=(identity.memory_id,)
                )
                if identity.layer == "contact"
                else fixture.local_retrieval.search_owner_memories(
                    owner_id=query.scope.owner_id,
                    query=None,
                    memory_ids=(identity.memory_id,),
                )
            )
            violations: list[str] = []
            record = records[0] if len(records) == 1 else None
            if record is None:
                violations.append("missing_local_authority")
            else:
                violations.extend(
                    field
                    for field in fields
                    if getattr(evidence, field) != getattr(record, field)
                )
                if (
                    record.status != "active"
                    or not record.source_ids
                    or record.valid_at is not None
                    and record.valid_at > now
                    or record.invalid_at is not None
                    and now >= record.invalid_at
                ):
                    violations.append("state_or_source")
                if identity.layer == "contact" and adapter is not None:
                    returned = next(
                        (
                            m
                            for m in adapter.returned
                            if m.memory_id == identity.memory_id
                        ),
                        None,
                    )
                    if returned is None:
                        violations.append("missing_port_record")
                    else:
                        violations.extend(
                            "port_" + field
                            for field in (
                                *fields,
                                "adoption_method",
                                "confidence",
                                "scope",
                            )
                            if getattr(returned, field) != getattr(record, field)
                        )
            audits.append(
                {
                    "identity": asdict(identity),
                    "audited_at": now.isoformat(),
                    "local_record": None if record is None else asdict(record),
                    "context_record": asdict(evidence),
                    "violations": violations,
                }
            )
    return ExperimentAttempt(
        "A" if client is None else "B",
        result,
        0 if recorder is None else recorder.attempts,
        () if recorder is None else tuple(recorder.frames),
        None if adapter is None else asdict(adapter.last_attempt),
        tuple(audits),
        (perf_counter() - audit_started) * 1000,
    )


def calibrate(fixture: FixtureHandles, client: RecallClient) -> dict[str, Any]:
    """固定选择顺序；最终 split 从不进入候选阈值或选择分母。"""

    queries = tuple(q for q in fixture.dataset.queries if q.split == "dev")
    if not queries:
        raise ValueError("必须有独立 dev 查询。")
    baseline = tuple(evaluate_arm(fixture, q) for q in queries)
    captured = tuple(evaluate_arm(fixture, q, client=client, tau=1.0) for q in queries)
    if any(a.result.status != "succeeded" for a in (*baseline, *captured)):
        return {
            "tau_B": None,
            "prerequisites_met": False,
            "error": "dev 有真实服务失败，不能以空集合选择门。",
            "captured_http_attempts": [asdict(a) for a in captured],
            "baseline_attempts": [asdict(a) for a in baseline],
        }
    replay = ReplayClient(
        tuple(frame for attempt in captured for frame in attempt.frames)
    )
    thresholds = sorted(
        {
            1.0,
            *(
                hit.reranker
                for attempt in captured
                for frame in attempt.frames
                for hit in frame.batch.hits
                if hit.reranker > 0
            ),
        }
    )
    baseline_summary: dict[str, Any] = summarize_results(
        tuple(a.result for a in baseline)
    )
    maximum_injections = int(baseline_summary["irrelevant_injection_queries"] or 0)
    rows: list[dict[str, Any]] = []
    best: (
        tuple[tuple[float, float, float, float], float, tuple[ExperimentAttempt, ...]]
        | None
    ) = None
    for tau in thresholds:
        attempts = tuple(
            evaluate_arm(fixture, q, client=replay, tau=tau) for q in queries
        )
        summary: dict[str, Any] = summarize_results(tuple(a.result for a in attempts))
        paraphrases: dict[str, Any] = summarize_results(
            tuple(a.result for a in attempts if a.result.group == "paraphrase")
        )
        feasible = (
            summary["irrelevant_injection_queries"] <= maximum_injections
            and summary["failed_queries"] == 0
            and summary["scope_violations"] == 0
            and summary["over_budget_queries"] == 0
            and summary["duplicate_ids"] == 0
            and not any(
                record["violations"] for a in attempts for record in a.authority_audit
            )
        )
        row = {
            "tau_B": tau,
            "feasible": feasible,
            "summary": summary,
            "paraphrase_summary": paraphrases,
        }
        rows.append(row)
        rank = (
            float(paraphrases["macro_recall_at_5"] or 0),
            -float(summary["irrelevant_injection_queries"]),
            float(summary["macro_precision_at_5"] or 0),
            tau,
        )
        if feasible and (best is None or rank > best[0]):
            best = (rank, tau, attempts)
    return {
        "prerequisites_met": True,
        "tau_B": None if best is None else best[1],
        "selection_order": [
            "dev 无关注入不高于 A 且安全/失败为零",
            "改写宏 Recall 最大",
            "误注入 query 最少",
            "有选入 query 的宏 Precision 最大",
            "tau 最大",
        ],
        "threshold_rule": "所有 dev 实际 HTTP 正 reranker 分值及 1.0；>= tau 过门，1.0 仍会接受恰好 1 分。",
        "baseline_summary": baseline_summary,
        "selected_summary": (
            None
            if best is None
            else summarize_results(tuple(a.result for a in best[2]))
        ),
        "selected_attempts": [] if best is None else [asdict(a) for a in best[2]],
        "captured_http_attempts": [asdict(a) for a in captured],
        "baseline_attempts": [asdict(a) for a in baseline],
        "threshold_rows": rows,
        "replay_is_dev_only_and_not_latency_evidence": True,
    }


def latency_summary(attempts: tuple[ExperimentAttempt, ...]) -> dict[str, Any]:
    """nearest rank 包含全部失败等待时间；成功分布独立列出。"""

    def distribution(values: list[float]) -> dict[str, float | int | None]:
        ordered = sorted(values)
        return {
            "count": len(ordered),
            "p50_ms": (
                None if not ordered else ordered[math.ceil(0.5 * len(ordered)) - 1]
            ),
            "p95_ms": (
                None if not ordered else ordered[math.ceil(0.95 * len(ordered)) - 1]
            ),
            "max_ms": None if not ordered else ordered[-1],
        }

    failed = tuple(a for a in attempts if a.result.status == "failed")
    return {
        "all_attempts": distribution([a.result.elapsed_ms for a in attempts]),
        "successful_attempts": distribution(
            [a.result.elapsed_ms for a in attempts if a.result.status == "succeeded"]
        ),
        "failures": len(failed),
        "timeout_failures": sum(
            "timeout" in (a.result.error or "").casefold()
            or "timeout" in str(a.diagnostics).casefold()
            for a in failed
        ),
        "failure_rate": len(failed) / len(attempts) if attempts else None,
        "http_attempts": sum(a.http_attempts for a in attempts),
        "no_http_attempts": sum(a.http_attempts == 0 for a in attempts),
        "quantile_rule": "排序后第 ceil(p*N) 个值，包含失败。",
    }
