"""确定性记忆召回评测：装配真实评分器与真实回复上下文组装。

不连接数据库、不调用模型、不需要凭据；结果可直接作为 CI 门槛断言。
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID, uuid5

from notalone.memory import (
    AdoptionMethod,
    InMemoryMemoryStore,
    MemoryCandidate,
    MemoryCategory,
)
from notalone.reply.context import (
    CONTACT_MEMORY_CHAR_BUDGET,
    CONTACT_MEMORY_LIMIT,
    OWNER_MEMORY_CHAR_BUDGET,
    OWNER_MEMORY_LIMIT,
    RetrievalReplyContext,
)
from notalone.reply.interface import (
    ConfirmedDirection,
    DirectionSource,
    GenerateReply,
    ReplyToMessage,
)
from notalone.retrieval.adapters import InMemoryRetrieval
from notalone.retrieval.models import RetrievedMessage, RetrievedOwnerMemory
from notalone.retrieval.recall_cases import (
    DIMENSION_BUDGET,
    DIMENSION_DIRECT,
    DIMENSION_INVALID,
    DIMENSION_IRRELEVANT,
    DIMENSION_ISOLATION,
    DIMENSION_ORDERING,
    DIMENSION_PARAPHRASE,
    DIMENSIONS,
    MIN_CASES_PER_DIMENSION,
    RecallCase,
)
from notalone.scopes import ContactScope, VerifiedConversationScope


GATE_DIRECT_HIT_RATE = 0.9
GATE_PARAPHRASE_HIT_RATE = 0.6
GATE_ORDER_RATE = 0.9
GATE_BUDGET_HIT_RATE = 0.9
GATE_SAFETY_VIOLATIONS = 0

_NAMESPACE = UUID("f0f0f0f0-0000-4000-8000-000000000000")
_DIRECTION = "自然回复"


@dataclass(frozen=True, slots=True)
class RecallCaseResult:
    """一条用例的观测结果与违规项。"""

    name: str
    dimension: str
    recalled: tuple[str, ...]
    missing: tuple[str, ...]
    unexpected: tuple[str, ...]
    over_budget: bool
    order_ok: bool

    @property
    def passed(self) -> bool:
        return (
            not self.missing
            and not self.unexpected
            and not self.over_budget
            and self.order_ok
        )

    @property
    def failure_reason(self) -> str:
        reasons = []
        if self.missing:
            reasons.append(f"缺少预期记忆：{'、'.join(self.missing)}")
        if self.unexpected:
            reasons.append(f"出现不应召回的记忆：{'、'.join(self.unexpected)}")
        if self.over_budget:
            reasons.append("超出记忆预算")
        if not self.order_ok:
            reasons.append(
                f"顺序不符：实际 {'、'.join(self.recalled) or '空'}"
            )
        return "；".join(reasons)


@dataclass(frozen=True, slots=True)
class RecallDimensionSummary:
    """一个维度的门槛统计。"""

    dimension: str
    cases: int
    passed: int
    hit_rate: float
    order_rate: float
    unexpected: int
    over_budget: int
    meets_gate: bool


def evaluate_case(case: RecallCase) -> RecallCaseResult:
    """用真实评分器与真实上下文组装执行一条用例。"""

    owner_id = uuid5(_NAMESPACE, f"{case.name}:owner")
    contact_id = uuid5(_NAMESPACE, f"{case.name}:contact")
    other_contact_id = uuid5(_NAMESPACE, f"{case.name}:other-contact")
    binding_id = uuid5(_NAMESPACE, f"{case.name}:binding")
    target_message_id = uuid5(_NAMESPACE, f"{case.name}:target")
    source_id = uuid5(_NAMESPACE, f"{case.name}:source")
    scope = ContactScope(owner_id, contact_id)
    other_scope = ContactScope(owner_id, other_contact_id)

    store = InMemoryMemoryStore()
    for index, spec in enumerate(case.memories):
        candidate_id = uuid5(_NAMESPACE, f"{case.name}:candidate:{index}")
        memory_scope = other_scope if spec.contact == "other" else scope
        store.create_candidate(
            MemoryCandidate(
                candidate_id=candidate_id,
                scope=memory_scope,
                text=spec.text,
                category=MemoryCategory(spec.category),
                source_ids=(source_id,),
                confidence=spec.confidence,
                valid_at=spec.valid_at,
                invalid_at=spec.invalid_at,
            )
        )
        memory = store.confirm(
            scope=memory_scope,
            candidate_id=candidate_id,
            adoption_method=AdoptionMethod(spec.adoption_method),
        )
        if spec.state == "invalidated":
            store.invalidate(scope=memory_scope, memory_id=memory.memory_id)
        elif spec.state == "deleted":
            store.delete(scope=memory_scope, memory_id=memory.memory_id)

    owner_memories = tuple(
        RetrievedOwnerMemory(
            memory_id=uuid5(_NAMESPACE, f"{case.name}:owner-memory:{index}"),
            owner_id=owner_id,
            text=spec.text,
            category=spec.category,
            topic=spec.topic,
            source_ids=(source_id,),
            adoption_method=spec.adoption_method,
            revision=1,
            status={
                "invalidated": "invalidated",
                "deleted": "deleted",
            }.get(spec.state, "active"),
            valid_at=spec.valid_at,
            invalid_at=spec.invalid_at,
            confidence=spec.confidence,
        )
        for index, spec in enumerate(case.owner_memories)
    )
    retrieval = InMemoryRetrieval(
        messages=(
            RetrievedMessage(
                message_id=target_message_id,
                scope=scope,
                text=case.query,
                source_ids=(source_id,),
            ),
        ),
        memory_store=store,
        owner_memories=owner_memories,
    )

    command = GenerateReply(
        idempotency_key=uuid5(_NAMESPACE, f"{case.name}:request"),
        scope=scope,
        conversation_binding_id=binding_id,
        content=ReplyToMessage(
            target_message_id,
            ConfirmedDirection(_DIRECTION, DirectionSource.DIRECT_INPUT),
        ),
    )
    evidence_counter = 0

    def _next_evidence_id() -> UUID:
        nonlocal evidence_counter
        evidence_counter += 1
        return uuid5(
            _NAMESPACE,
            f"{case.name}:evidence:{evidence_counter}",
        )

    context = RetrievalReplyContext(
        retrieval=retrieval,
        skill_library_revision=0,
        id_factory=_next_evidence_id,
    ).build(
        command=command,
        verified_scope=VerifiedConversationScope(
            owner_id,
            contact_id,
            binding_id,
        ),
    )
    contact_texts = tuple(
        item.text for item in context.evidence if item.kind == "confirmed_memory"
    )
    owner_texts = tuple(
        item.text for item in context.evidence if item.kind == "owner_memory"
    )
    recalled = (*contact_texts, *owner_texts)
    expected = case.expect_recalled or case.expect_order
    missing = tuple(text for text in expected if text not in recalled)
    unexpected = tuple(text for text in recalled if text not in expected)
    over_budget = (
        len(contact_texts) > CONTACT_MEMORY_LIMIT
        or sum(len(text) for text in contact_texts)
        > CONTACT_MEMORY_CHAR_BUDGET
        or len(owner_texts) > OWNER_MEMORY_LIMIT
        or sum(len(text) for text in owner_texts) > OWNER_MEMORY_CHAR_BUDGET
    )
    order_ok = not case.expect_order or case.expect_order == recalled
    return RecallCaseResult(
        name=case.name,
        dimension=case.dimension,
        recalled=recalled,
        missing=missing,
        unexpected=unexpected,
        over_budget=over_budget,
        order_ok=order_ok,
    )


def summarize(
    results: tuple[RecallCaseResult, ...],
) -> tuple[RecallDimensionSummary, ...]:
    """按维度汇总命中、顺序、越界与安全违规。"""

    summaries = []
    for dimension in DIMENSIONS:
        cases = tuple(
            result for result in results if result.dimension == dimension
        )
        passed = sum(1 for result in cases if result.passed)
        unexpected = sum(len(result.unexpected) for result in cases)
        over_budget = sum(1 for result in cases if result.over_budget)
        order_ok = sum(1 for result in cases if result.order_ok)
        hit_rate = passed / len(cases) if cases else 0.0
        order_rate = order_ok / len(cases) if cases else 0.0
        meets_gate = (
            len(cases) >= MIN_CASES_PER_DIMENSION
            and _dimension_gate(
                dimension=dimension,
                hit_rate=hit_rate,
                order_rate=order_rate,
                unexpected=unexpected,
                over_budget=over_budget,
            )
        )
        summaries.append(
            RecallDimensionSummary(
                dimension=dimension,
                cases=len(cases),
                passed=passed,
                hit_rate=hit_rate,
                order_rate=order_rate,
                unexpected=unexpected,
                over_budget=over_budget,
                meets_gate=meets_gate,
            )
        )
    return tuple(summaries)


def _dimension_gate(
    *,
    dimension: str,
    hit_rate: float,
    order_rate: float,
    unexpected: int,
    over_budget: int,
) -> bool:
    if dimension == DIMENSION_DIRECT:
        return hit_rate >= GATE_DIRECT_HIT_RATE
    if dimension == DIMENSION_PARAPHRASE:
        return hit_rate >= GATE_PARAPHRASE_HIT_RATE
    if dimension == DIMENSION_BUDGET:
        return over_budget == 0 and hit_rate >= GATE_BUDGET_HIT_RATE
    if dimension == DIMENSION_ORDERING:
        return order_rate >= GATE_ORDER_RATE
    if dimension in (
        DIMENSION_IRRELEVANT,
        DIMENSION_ISOLATION,
        DIMENSION_INVALID,
    ):
        return unexpected <= GATE_SAFETY_VIOLATIONS
    return False
