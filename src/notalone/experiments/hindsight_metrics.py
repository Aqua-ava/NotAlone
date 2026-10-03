"""按范围和本地记忆 ID 计算最终上下文指标，不复用旧 hit_rate。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import UUID


@dataclass(frozen=True, slots=True)
class MemoryIdentity:
    layer: Literal["contact", "owner"]
    owner_id: UUID
    contact_id: UUID | None
    memory_id: UUID


@dataclass(frozen=True, slots=True)
class SelectedMemory:
    identity: MemoryIdentity
    text: str
    source_ids: tuple[UUID, ...]
    revision: int
    selection_reason: str


@dataclass(frozen=True, slots=True)
class QueryResult:
    query_id: str
    split: str
    group: str
    status: Literal["succeeded", "failed"]
    error: str | None
    elapsed_ms: float
    local_started_at: str
    local_finished_at: str
    contact_gold: tuple[MemoryIdentity, ...]
    owner_gold: tuple[MemoryIdentity, ...]
    contact_selected: tuple[SelectedMemory, ...]
    owner_selected: tuple[SelectedMemory, ...]
    over_budget: bool = False
    duplicate_ids: int = 0
    scope_violations: int = 0


def summarize_results(
    results: tuple[QueryResult, ...],
    *,
    layer: Literal["contact", "owner"] = "contact",
) -> dict[str, object]:
    """Recall 对正例宏平均；Precision 对有选入的 query 宏平均。"""

    recalls: list[float] = []
    precisions: list[float] = []
    injection_queries = 0
    unexpected_ids = 0
    positive_empty = 0
    for result in results:
        gold = set(result.contact_gold if layer == "contact" else result.owner_gold)
        selected = (
            result.contact_selected if layer == "contact" else result.owner_selected
        )
        identities = {item.identity for item in selected}
        if gold:
            recalls.append(len(identities & gold) / len(gold))
            positive_empty += int(not identities)
        if identities:
            precisions.append(len(identities & gold) / len(identities))
        unexpected = len(identities - gold)
        injection_queries += int(unexpected > 0)
        unexpected_ids += unexpected
    return {
        "queries": len(results),
        "positive_queries": len(recalls),
        "macro_recall_at_5" if layer == "contact" else "macro_recall_at_3": (
            sum(recalls) / len(recalls) if recalls else None
        ),
        "macro_precision_at_5" if layer == "contact" else "macro_precision_at_3": (
            sum(precisions) / len(precisions) if precisions else None
        ),
        "precision_query_denominator": len(precisions),
        "irrelevant_injection_query_rate": (
            injection_queries / len(results) if results else None
        ),
        "irrelevant_injection_queries": injection_queries,
        "unexpected_id_count": unexpected_ids,
        "positive_empty_rate": positive_empty / len(recalls) if recalls else None,
        "failed_queries": sum(r.status == "failed" for r in results),
        "over_budget_queries": sum(r.over_budget for r in results),
        "duplicate_ids": sum(r.duplicate_ids for r in results),
        "scope_violations": sum(r.scope_violations for r in results),
    }


def grouped_summaries(results: tuple[QueryResult, ...]) -> dict[str, object]:
    """分层保持各自分母，不把本人、预算压力和主收益合成一个数。"""

    summaries: dict[str, object] = {}
    for split, group in sorted({(r.split, r.group) for r in results}):
        selected = tuple(r for r in results if (r.split, r.group) == (split, group))
        layer: Literal["contact", "owner"] = (
            "owner" if group.startswith("owner") else "contact"
        )
        summaries[f"{split}/{group}"] = summarize_results(selected, layer=layer)
    quality = tuple(
        r
        for r in results
        if r.split == "final" and r.group in ("paraphrase", "direct", "empty", "topic")
    )
    summaries["final/quality"] = summarize_results(quality)
    return summaries
