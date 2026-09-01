"""联系人范围 SQL/全文检索的合成评测工具。

评测只接收 ``RetrievalPort``，不会读取真实聊天，也不会写入生产数据库。
回复候选的引用纠错和拒绝率通过显式的匿名运行观察值补充；没有提供时以
``N/A`` 表示，避免把“未测量”伪装成零风险。
"""

from __future__ import annotations

import json
import time
from collections import Counter
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import UUID

from notalone.retrieval.feature_flags import RetrievalFeatureFlags
from notalone.retrieval.models import RetrievedMessage
from notalone.retrieval.ports import RetrievalPort
from notalone.scopes import ContactScope


EvaluationCategory = Literal[
    "synonym_expression",
    "exact_phrase",
    "time_window",
    "no_result",
    "conflict",
    "cross_contact",
]
EvaluationStatus = Literal["hit", "empty", "miss", "failed", "fallback"]

_EVALUATION_CATEGORIES = frozenset(
    {
        "synonym_expression",
        "exact_phrase",
        "time_window",
        "no_result",
        "conflict",
        "cross_contact",
    }
)


def _validate_case_id(case_id: str) -> None:
    if (
        not isinstance(case_id, str)
        or not case_id.strip()
        or len(case_id) > 64
    ):
        raise ValueError("评测 case_id 无效。")


def _validate_unique_ids(values: tuple[UUID, ...], *, name: str) -> None:
    if not isinstance(values, tuple) or len(values) != len(set(values)):
        raise ValueError(f"{name} 必须是无重复 UUID 元组。")
    if any(not isinstance(value, UUID) for value in values):
        raise TypeError(f"{name} 必须只包含 UUID。")


def _validate_nonnegative_int(value: int | None, *, name: str) -> None:
    if value is not None and (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < 0
    ):
        raise ValueError(f"{name} 必须是非负整数或 None。")


@dataclass(frozen=True, slots=True)
class RetrievalEvaluationCase:
    """一条不包含聊天正文输出的检索评测用例。"""

    case_id: str
    category: str
    scope: ContactScope
    query: str | None
    expected_message_ids: tuple[UUID, ...]
    top_k: int = 5
    occurred_after: datetime | None = None
    occurred_before: datetime | None = None

    def __post_init__(self) -> None:
        _validate_case_id(self.case_id)
        if self.category not in _EVALUATION_CATEGORIES:
            raise ValueError("评测分类无效。")
        if not isinstance(self.scope, ContactScope):
            raise TypeError("评测用例必须带联系人范围。")
        if self.query is not None and not isinstance(self.query, str):
            raise TypeError("评测 query 必须是字符串或 None。")
        _validate_unique_ids(
            self.expected_message_ids,
            name="expected_message_ids",
        )
        if (
            not isinstance(self.top_k, int)
            or isinstance(self.top_k, bool)
            or not 1 <= self.top_k <= 50
        ):
            raise ValueError("评测 top_k 超出检索预算。")
        for name in ("occurred_after", "occurred_before"):
            value = getattr(self, name)
            if value is not None and not isinstance(value, datetime):
                raise TypeError(f"{name} 结构无效。")
        if (
            self.occurred_after is not None
            and self.occurred_before is not None
            and self.occurred_before < self.occurred_after
        ):
            raise ValueError("评测时间范围无效。")


@dataclass(frozen=True, slots=True)
class ReplyEvaluationObservation:
    """候选回复层提供的最小匿名指标观察值。"""

    case_id: str
    citation_corrected: bool
    candidate_rejected: bool
    latency_ms: int | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    tool_calls: int = 0

    def __post_init__(self) -> None:
        _validate_case_id(self.case_id)
        for name in ("citation_corrected", "candidate_rejected"):
            if not isinstance(getattr(self, name), bool):
                raise TypeError(f"{name} 必须是 bool。")
        _validate_nonnegative_int(self.latency_ms, name="latency_ms")
        _validate_nonnegative_int(self.input_tokens, name="input_tokens")
        _validate_nonnegative_int(self.output_tokens, name="output_tokens")
        if (
            not isinstance(self.tool_calls, int)
            or isinstance(self.tool_calls, bool)
            or self.tool_calls < 0
        ):
            raise ValueError("tool_calls 必须是非负整数。")


@dataclass(frozen=True, slots=True)
class RetrievalEvaluationObservation:
    """一条检索结果的无正文观察。"""

    case_id: str
    category: str
    status: EvaluationStatus
    returned_message_ids: tuple[UUID, ...]
    expected_message_ids: tuple[UUID, ...]
    top_k_hit: bool
    foreign_message_ids: tuple[UUID, ...]
    fallback_used: bool
    latency_ms: int
    estimated_query_tokens: int
    failure_kind: str | None = None

    def __post_init__(self) -> None:
        _validate_case_id(self.case_id)
        if self.category not in _EVALUATION_CATEGORIES:
            raise ValueError("评测分类无效。")
        if self.status not in {"hit", "empty", "miss", "failed", "fallback"}:
            raise ValueError("评测结果状态无效。")
        _validate_unique_ids(
            self.returned_message_ids,
            name="returned_message_ids",
        )
        _validate_unique_ids(
            self.expected_message_ids,
            name="expected_message_ids",
        )
        _validate_unique_ids(
            self.foreign_message_ids,
            name="foreign_message_ids",
        )
        if not isinstance(self.top_k_hit, bool) or not isinstance(
            self.fallback_used,
            bool,
        ):
            raise TypeError("评测布尔结果结构无效。")
        _validate_nonnegative_int(self.latency_ms, name="latency_ms")
        _validate_nonnegative_int(
            self.estimated_query_tokens,
            name="estimated_query_tokens",
        )
        if self.failure_kind is not None:
            _validate_case_id(self.failure_kind)


@dataclass(frozen=True, slots=True)
class EvaluationRate:
    """带分母的比例；分母为零时 value 为 None。"""

    numerator: int
    denominator: int

    def __post_init__(self) -> None:
        for name in ("numerator", "denominator"):
            value = getattr(self, name)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise ValueError(f"{name} 必须是非负整数。")
        if self.numerator > self.denominator:
            raise ValueError("比例分子不能大于分母。")

    @property
    def value(self) -> float | None:
        if self.denominator == 0:
            return None
        return self.numerator / self.denominator

    def as_dict(self) -> dict[str, Any]:
        return {
            "numerator": self.numerator,
            "denominator": self.denominator,
            "value": self.value,
        }


@dataclass(frozen=True, slots=True)
class LatencySummary:
    """延迟的可重复摘要，不保留请求正文或参数。"""

    sample_count: int
    average_ms: float | None
    p50_ms: float | None
    p95_ms: float | None

    def __post_init__(self) -> None:
        if not isinstance(self.sample_count, int) or self.sample_count < 0:
            raise ValueError("延迟样本数无效。")
        for name in ("average_ms", "p50_ms", "p95_ms"):
            value = getattr(self, name)
            if value is not None and (
                not isinstance(value, (int, float)) or value < 0
            ):
                raise ValueError(f"{name} 无效。")
        if self.sample_count == 0 and any(
            getattr(self, name) is not None
            for name in ("average_ms", "p50_ms", "p95_ms")
        ):
            raise ValueError("没有延迟样本时摘要必须为空。")

    def as_dict(self) -> dict[str, Any]:
        return {
            "sample_count": self.sample_count,
            "average_ms": self.average_ms,
            "p50_ms": self.p50_ms,
            "p95_ms": self.p95_ms,
        }


@dataclass(frozen=True, slots=True)
class RetrievalEvaluationMetrics:
    """评测报告中的检索、候选、用量和 Tool 指标。"""

    case_count: int
    empty_result_rate: EvaluationRate
    fallback_rate: EvaluationRate
    top_k_hit_rate: EvaluationRate
    citation_correction_rate: EvaluationRate
    candidate_rejection_rate: EvaluationRate
    retrieval_latency_ms: LatencySummary
    reply_latency_ms: LatencySummary
    retrieval_query_tokens: int
    reply_input_tokens: int | None
    reply_output_tokens: int | None
    tool_calls: int

    def __post_init__(self) -> None:
        if not isinstance(self.case_count, int) or self.case_count < 1:
            raise ValueError("评测 case 数量必须为正整数。")
        _validate_nonnegative_int(
            self.retrieval_query_tokens,
            name="retrieval_query_tokens",
        )
        _validate_nonnegative_int(
            self.reply_input_tokens,
            name="reply_input_tokens",
        )
        _validate_nonnegative_int(
            self.reply_output_tokens,
            name="reply_output_tokens",
        )
        _validate_nonnegative_int(self.tool_calls, name="tool_calls")

    def as_dict(self) -> dict[str, Any]:
        return {
            "case_count": self.case_count,
            "empty_result_rate": self.empty_result_rate.as_dict(),
            "fallback_rate": self.fallback_rate.as_dict(),
            "top_k_hit_rate": self.top_k_hit_rate.as_dict(),
            "citation_correction_rate": self.citation_correction_rate.as_dict(),
            "candidate_rejection_rate": self.candidate_rejection_rate.as_dict(),
            "latency_ms": {
                "retrieval": self.retrieval_latency_ms.as_dict(),
                "reply": self.reply_latency_ms.as_dict(),
            },
            "tokens": {
                "retrieval_query_estimated": self.retrieval_query_tokens,
                "reply_input": self.reply_input_tokens,
                "reply_output": self.reply_output_tokens,
            },
            "tool_calls": self.tool_calls,
        }


@dataclass(frozen=True, slots=True)
class RetrievalEvaluationReport:
    """可写入 Markdown/JSON 的无正文评测报告。"""

    adapter_name: str
    dataset_name: str
    observations: tuple[RetrievalEvaluationObservation, ...]
    metrics: RetrievalEvaluationMetrics
    reply_observations: tuple[ReplyEvaluationObservation, ...]
    vector_recommendation: Literal[
        "retain_current_path",
        "re_evaluate_before_vector",
    ]
    vector_reason: str
    vector_enabled: bool

    def __post_init__(self) -> None:
        if (
            not isinstance(self.adapter_name, str)
            or not self.adapter_name.strip()
        ):
            raise ValueError("评测 adapter 名称不能为空。")
        if (
            not isinstance(self.dataset_name, str)
            or not self.dataset_name.strip()
        ):
            raise ValueError("评测数据集名称不能为空。")
        if not isinstance(self.observations, tuple) or not self.observations:
            raise ValueError("评测报告不能没有检索观察值。")
        if any(
            not isinstance(item, RetrievalEvaluationObservation)
            for item in self.observations
        ):
            raise TypeError("评测检索观察值结构无效。")
        if any(
            not isinstance(item, ReplyEvaluationObservation)
            for item in self.reply_observations
        ):
            raise TypeError("评测回复观察值结构无效。")
        if self.vector_recommendation not in {
            "retain_current_path",
            "re_evaluate_before_vector",
        }:
            raise ValueError("向量评估建议无效。")
        if not isinstance(self.vector_reason, str) or not self.vector_reason.strip():
            raise ValueError("向量评估理由不能为空。")
        if not isinstance(self.vector_enabled, bool):
            raise TypeError("vector_enabled 必须是 bool。")

    def as_dict(self) -> dict[str, Any]:
        by_category = Counter(item.category for item in self.observations)
        status_counts = Counter(item.status for item in self.observations)
        return {
            "adapter": self.adapter_name,
            "dataset": self.dataset_name,
            "coverage": {
                "categories": dict(sorted(by_category.items())),
                "statuses": dict(sorted(status_counts.items())),
            },
            "metrics": self.metrics.as_dict(),
            "vector": {
                "enabled": self.vector_enabled,
                "recommendation": self.vector_recommendation,
                "reason": self.vector_reason,
            },
            "observations": [
                {
                    "case_id": item.case_id,
                    "category": item.category,
                    "status": item.status,
                    "top_k_hit": item.top_k_hit,
                    "foreign_hit_count": len(item.foreign_message_ids),
                    "fallback_used": item.fallback_used,
                    "failure_kind": item.failure_kind,
                }
                for item in self.observations
            ],
            "reply_observation_count": len(self.reply_observations),
        }

    def to_json(self) -> str:
        return json.dumps(
            self.as_dict(),
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )

    def to_markdown(self) -> str:
        metrics = self.metrics
        lines = [
            "# 检索评测报告",
            "",
            f"- Adapter：`{self.adapter_name}`",
            f"- 数据集：`{self.dataset_name}`",
            f"- 用例数：{metrics.case_count}",
            "",
            "## 向量决策",
            "",
            f"- 建议：`{self.vector_recommendation}`",
            f"- 当前是否启用向量：`{self.vector_enabled}`",
            f"- 理由：{self.vector_reason}",
            "",
            "## 指标",
            "",
            "| 指标 | 结果 |",
            "| --- | --- |",
            f"| 空结果率 | {_format_rate(metrics.empty_result_rate)} |",
            f"| 降级率 | {_format_rate(metrics.fallback_rate)} |",
            f"| Top-K 命中率 | {_format_rate(metrics.top_k_hit_rate)} |",
            f"| 引用纠错率 | {_format_rate(metrics.citation_correction_rate)} |",
            f"| 候选拒绝率 | {_format_rate(metrics.candidate_rejection_rate)} |",
            f"| 检索延迟 | {_format_latency(metrics.retrieval_latency_ms)} |",
            f"| 回复延迟 | {_format_latency(metrics.reply_latency_ms)} |",
            f"| 估算检索 query Token | {metrics.retrieval_query_tokens} |",
            "| 回复 input/output Token | "
            f"{metrics.reply_input_tokens} / {metrics.reply_output_tokens} |",
            f"| Tool 次数 | {metrics.tool_calls} |",
            "",
            "## 用例覆盖",
            "",
            "| Case | 分类 | 状态 | Top-K | 跨联系人命中 | 降级 |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
        for item in self.observations:
            lines.append(
                (
                    "| {case} | {category} | {status} | {hit} | "
                    "{foreign} | {fallback} |"
                ).format(
                    case=item.case_id,
                    category=item.category,
                    status=item.status,
                    hit="是" if item.top_k_hit else "否",
                    foreign=len(item.foreign_message_ids),
                    fallback="是" if item.fallback_used else "否",
                )
            )
        lines.extend(
            [
                "",
                "> 报告只保存 case、分类、状态，不保存合成正文、"
                "Prompt 或真实聊天内容。",
            ]
        )
        return "\n".join(lines) + "\n"


@dataclass(frozen=True, slots=True)
class SyntheticRetrievalFixture:
    """覆盖 issue 07 六类场景的合成消息和用例。"""

    scope: ContactScope
    other_scope: ContactScope
    messages: tuple[RetrievedMessage, ...]
    cases: tuple[RetrievalEvaluationCase, ...]


def _synthetic_uuid(value: str) -> UUID:
    return UUID(f"00000000-0000-0000-0000-{value:0>12}")


def build_synthetic_retrieval_fixture(
    *,
    owner_id: UUID | None = None,
    contact_id: UUID | None = None,
    other_contact_id: UUID | None = None,
) -> SyntheticRetrievalFixture:
    """创建不含真实资料的确定性评测夹具。"""

    owner = owner_id or UUID("10000000-0000-0000-0000-000000000001")
    contact = contact_id or UUID("20000000-0000-0000-0000-000000000001")
    other_contact = other_contact_id or UUID(
        "20000000-0000-0000-0000-000000000002"
    )
    if not all(
        isinstance(value, UUID) for value in (owner, contact, other_contact)
    ):
        raise TypeError("合成评测范围必须使用 UUID。")
    scope = ContactScope(owner, contact)
    other_scope = ContactScope(owner, other_contact)
    source_id = _synthetic_uuid("1")
    other_source_id = _synthetic_uuid("2")
    synonym_id = _synthetic_uuid("101")
    exact_id = _synthetic_uuid("102")
    time_out_id = _synthetic_uuid("103")
    time_in_id = _synthetic_uuid("104")
    conflict_yes_id = _synthetic_uuid("105")
    conflict_no_id = _synthetic_uuid("106")
    foreign_id = _synthetic_uuid("107")
    messages = (
        RetrievedMessage(
            synonym_id,
            scope,
            "周末一起吃饭",
            source_ids=(source_id,),
            occurred_at=datetime(2026, 8, 29, 10, tzinfo=timezone.utc),
        ),
        RetrievedMessage(
            exact_id,
            scope,
            "明天下午三点见面",
            source_ids=(source_id,),
            occurred_at=datetime(2026, 8, 30, 10, tzinfo=timezone.utc),
        ),
        RetrievedMessage(
            time_out_id,
            scope,
            "下周一开会",
            source_ids=(source_id,),
            occurred_at=datetime(2026, 8, 31, 10, tzinfo=timezone.utc),
        ),
        RetrievedMessage(
            time_in_id,
            scope,
            "下周一开会",
            source_ids=(source_id,),
            occurred_at=datetime(2026, 9, 1, 10, tzinfo=timezone.utc),
        ),
        RetrievedMessage(
            conflict_yes_id,
            scope,
            "周六有空",
            source_ids=(source_id,),
            occurred_at=datetime(2026, 9, 1, 11, tzinfo=timezone.utc),
        ),
        RetrievedMessage(
            conflict_no_id,
            scope,
            "周六没空",
            source_ids=(source_id,),
            occurred_at=datetime(2026, 9, 1, 12, tzinfo=timezone.utc),
        ),
        RetrievedMessage(
            foreign_id,
            other_scope,
            "周末一起吃饭",
            source_ids=(other_source_id,),
            occurred_at=datetime(2026, 9, 1, 13, tzinfo=timezone.utc),
        ),
    )
    cases = (
        RetrievalEvaluationCase(
            case_id="synonym-expression",
            category="synonym_expression",
            scope=scope,
            query="周末 聚餐",
            expected_message_ids=(synonym_id,),
        ),
        RetrievalEvaluationCase(
            case_id="exact-phrase",
            category="exact_phrase",
            scope=scope,
            query="明天下午三点见面",
            expected_message_ids=(exact_id,),
        ),
        RetrievalEvaluationCase(
            case_id="time-window",
            category="time_window",
            scope=scope,
            query="下周一",
            expected_message_ids=(time_in_id,),
            occurred_after=datetime(2026, 9, 1, tzinfo=timezone.utc),
            occurred_before=datetime(2026, 9, 1, 23, 59, tzinfo=timezone.utc),
        ),
        RetrievalEvaluationCase(
            case_id="no-result",
            category="no_result",
            scope=scope,
            query="不存在的合成主题",
            expected_message_ids=(),
        ),
        RetrievalEvaluationCase(
            case_id="conflict",
            category="conflict",
            scope=scope,
            query="周六",
            expected_message_ids=(conflict_yes_id, conflict_no_id),
            top_k=3,
        ),
        RetrievalEvaluationCase(
            case_id="cross-contact",
            category="cross_contact",
            scope=scope,
            query="周末一起吃饭",
            expected_message_ids=(synonym_id,),
        ),
    )
    return SyntheticRetrievalFixture(
        scope=scope,
        other_scope=other_scope,
        messages=messages,
        cases=cases,
    )


RetrievalFallback = Callable[
    [RetrievalEvaluationCase],
    tuple[RetrievedMessage, ...],
]


def _estimated_query_tokens(query: str | None) -> int:
    if query is None or not query.strip():
        return 0
    return max(1, (len(query) + 3) // 4)


def _top_k_hit(
    expected_message_ids: tuple[UUID, ...],
    returned_message_ids: tuple[UUID, ...],
) -> bool:
    if not expected_message_ids:
        return not returned_message_ids
    return set(expected_message_ids).issubset(returned_message_ids)


def _safe_failure_kind(error: BaseException) -> str:
    """只暴露稳定的异常类别，不暴露连接、SQL 或正文。"""

    return type(error).__name__[:64] or "unknown_error"


def _validate_messages(
    messages: object,
    *,
    scope: ContactScope,
) -> tuple[tuple[RetrievedMessage, ...], tuple[UUID, ...]]:
    if not isinstance(messages, tuple) or any(
        not isinstance(message, RetrievedMessage) for message in messages
    ):
        raise TypeError("invalid_retrieval_result")
    message_ids = tuple(message.message_id for message in messages)
    if len(message_ids) != len(set(message_ids)):
        raise TypeError("duplicate_retrieval_result")
    foreign_ids = tuple(
        message.message_id for message in messages if message.scope != scope
    )
    if foreign_ids:
        return messages, foreign_ids
    return messages, ()


def _evaluate_case(
    retrieval: RetrievalPort,
    case: RetrievalEvaluationCase,
    *,
    fallback: RetrievalFallback | None,
) -> RetrievalEvaluationObservation:
    started = time.perf_counter()
    fallback_used = False
    failure_kind: str | None = None
    messages: tuple[RetrievedMessage, ...] = ()
    try:
        messages, foreign_ids = _validate_messages(
            retrieval.search_messages(
                scope=case.scope,
                query=case.query,
                limit=case.top_k,
                occurred_after=case.occurred_after,
                occurred_before=case.occurred_before,
            ),
            scope=case.scope,
        )
        if foreign_ids:
            failure_kind = "cross_contact_result"
    except Exception as error:
        failure_kind = _safe_failure_kind(error)
        foreign_ids = ()
        if fallback is not None:
            try:
                messages, foreign_ids = _validate_messages(
                    fallback(case),
                    scope=case.scope,
                )
                fallback_used = True
                if foreign_ids:
                    failure_kind = "cross_contact_fallback_result"
                else:
                    failure_kind = None
            except Exception as fallback_error:
                failure_kind = _safe_failure_kind(fallback_error)
                messages = ()
                foreign_ids = ()
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    returned_ids = tuple(message.message_id for message in messages)
    top_k_hit = _top_k_hit(case.expected_message_ids, returned_ids)
    if failure_kind is not None:
        status: EvaluationStatus = "failed"
    elif fallback_used:
        status = "fallback"
    elif not returned_ids:
        status = "empty"
    elif top_k_hit:
        status = "hit"
    else:
        status = "miss"
    return RetrievalEvaluationObservation(
        case_id=case.case_id,
        category=case.category,
        status=status,
        returned_message_ids=returned_ids,
        expected_message_ids=case.expected_message_ids,
        top_k_hit=top_k_hit and failure_kind is None,
        foreign_message_ids=foreign_ids,
        fallback_used=fallback_used,
        latency_ms=elapsed_ms,
        estimated_query_tokens=_estimated_query_tokens(case.query),
        failure_kind=failure_kind,
    )


def _percentile(values: list[int], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def _latency_summary(values: Iterable[int]) -> LatencySummary:
    samples = list(values)
    if not samples:
        return LatencySummary(0, None, None, None)
    return LatencySummary(
        sample_count=len(samples),
        average_ms=sum(samples) / len(samples),
        p50_ms=_percentile(samples, 0.50),
        p95_ms=_percentile(samples, 0.95),
    )


def _format_rate(rate: EvaluationRate) -> str:
    if rate.value is None:
        return "N/A (0/0)"
    return f"{rate.numerator}/{rate.denominator} ({rate.value:.1%})"


def _format_latency(summary: LatencySummary) -> str:
    if summary.sample_count == 0:
        return "N/A"
    return (
        f"avg {summary.average_ms:.1f} ms; "
        f"p50 {summary.p50_ms:.1f} ms; p95 {summary.p95_ms:.1f} ms"
    )


def _build_metrics(
    observations: tuple[RetrievalEvaluationObservation, ...],
    reply_observations: tuple[ReplyEvaluationObservation, ...],
) -> RetrievalEvaluationMetrics:
    case_count = len(observations)
    return RetrievalEvaluationMetrics(
        case_count=case_count,
        empty_result_rate=EvaluationRate(
            sum(item.status == "empty" for item in observations),
            case_count,
        ),
        fallback_rate=EvaluationRate(
            sum(item.fallback_used for item in observations),
            case_count,
        ),
        top_k_hit_rate=EvaluationRate(
            sum(item.top_k_hit for item in observations),
            case_count,
        ),
        citation_correction_rate=EvaluationRate(
            sum(item.citation_corrected for item in reply_observations),
            len(reply_observations),
        ),
        candidate_rejection_rate=EvaluationRate(
            sum(item.candidate_rejected for item in reply_observations),
            len(reply_observations),
        ),
        retrieval_latency_ms=_latency_summary(
            item.latency_ms for item in observations
        ),
        reply_latency_ms=_latency_summary(
            item.latency_ms
            for item in reply_observations
            if item.latency_ms is not None
        ),
        retrieval_query_tokens=sum(
            item.estimated_query_tokens for item in observations
        ),
        reply_input_tokens=(
            sum(
                item.input_tokens
                for item in reply_observations
                if item.input_tokens is not None
            )
            if any(item.input_tokens is not None for item in reply_observations)
            else None
        ),
        reply_output_tokens=(
            sum(
                item.output_tokens
                for item in reply_observations
                if item.output_tokens is not None
            )
            if any(item.output_tokens is not None for item in reply_observations)
            else None
        ),
        tool_calls=sum(item.tool_calls for item in reply_observations),
    )


def _vector_decision(
    observations: tuple[RetrievalEvaluationObservation, ...],
) -> tuple[
    Literal["retain_current_path", "re_evaluate_before_vector"],
    str,
]:
    synonym_misses = sum(
        item.category == "synonym_expression" and not item.top_k_hit
        for item in observations
    )
    cross_contact_failures = sum(
        bool(item.foreign_message_ids) or item.failure_kind == "cross_contact_result"
        for item in observations
        if item.category == "cross_contact"
    )
    if synonym_misses or cross_contact_failures:
        return (
            "re_evaluate_before_vector",
        "合成集发现同义表达漏检或范围异常信号；按 ADR-005，仍需持续指标和"
        "真实反馈后才可评审向量，当前不启用。",
        )
    return (
        "retain_current_path",
        "本轮合成集未发现需要语义补充的稳定信号；保留 PostgreSQL SQL/全文路径，"
        "并在真实匿名反馈达到阈值后复评。",
    )


def evaluate_retrieval(
    retrieval: RetrievalPort,
    cases: Iterable[RetrievalEvaluationCase],
    *,
    adapter_name: str | None = None,
    dataset_name: str = "synthetic-contact-retrieval-v1",
    fallback: RetrievalFallback | None = None,
    reply_observations: Iterable[ReplyEvaluationObservation] = (),
    feature_flags: RetrievalFeatureFlags | None = None,
) -> RetrievalEvaluationReport:
    """对一个检索适配器执行有界、联系人隔离的评测。"""

    if retrieval is None:
        raise TypeError("评测必须注入 RetrievalPort。")
    case_items = tuple(cases)
    if not case_items or any(
        not isinstance(case, RetrievalEvaluationCase) for case in case_items
    ):
        raise ValueError("评测必须提供至少一条合法用例。")
    case_ids = tuple(case.case_id for case in case_items)
    if len(case_ids) != len(set(case_ids)):
        raise ValueError("评测 case_id 不能重复。")
    reply_items = tuple(reply_observations)
    if any(
        observation.case_id not in case_ids for observation in reply_items
    ):
        raise ValueError("回复评测观察值引用了未知 case。")
    if len(reply_items) != len({item.case_id for item in reply_items}):
        raise ValueError("每个 case 最多记录一条回复评测观察值。")
    flags = feature_flags or RetrievalFeatureFlags()
    if not isinstance(flags, RetrievalFeatureFlags):
        raise TypeError("feature_flags 结构无效。")
    if flags.vector_candidates_enabled:
        raise ValueError(
            "向量候选尚未完成实现与隐私评审，不能启用。"
        )

    observations = tuple(
        _evaluate_case(retrieval, case, fallback=fallback)
        for case in case_items
    )
    recommendation, reason = _vector_decision(observations)
    return RetrievalEvaluationReport(
        adapter_name=adapter_name or type(retrieval).__name__,
        dataset_name=dataset_name,
        observations=observations,
        metrics=_build_metrics(observations, reply_items),
        reply_observations=reply_items,
        vector_recommendation=recommendation,
        vector_reason=reason,
        vector_enabled=False,
    )


def main(argv: list[str] | None = None) -> int:
    """运行默认合成评测；生产路径不会被命令写入或修改。"""

    import argparse

    parser = argparse.ArgumentParser(
        description="评估 NotAlone 联系人范围检索"
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="以 JSON 输出最小化指标",
    )
    args = parser.parse_args(argv)
    fixture = build_synthetic_retrieval_fixture()
    from notalone.retrieval.adapters import InMemoryRetrieval

    report = evaluate_retrieval(
        InMemoryRetrieval(messages=fixture.messages),
        fixture.cases,
        adapter_name="in-memory-contract",
    )
    print(report.to_json() if args.json else report.to_markdown(), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
