"""记忆提取的确定性外壳：逐条解析、来源语义核验与整体失败语义。"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from uuid import UUID

from notalone.memory.models import MemoryCategory
from notalone.memory.timing import MemoryTiming
from notalone.memory_extraction.errors import ExtractionRuntimeError
from notalone.memory_extraction.models import (
    AssertionStatus,
    ExtractedFact,
    ExtractionFailureKind,
    ExtractionWindow,
    FactSubject,
    FigurativeType,
    MemoryTopic,
    SpeechAct,
)
from notalone.memory_extraction.pragmatics import (
    MemoryDisposition,
    PragmaticInterpreter,
)
from notalone.memory_extraction.runtime import MemoryExtractionRuntime
from notalone.memory_extraction.verification import (
    MAX_SOURCE_VERIFICATION_CANDIDATES,
    SourceVerificationRuntime,
    SourceVerificationVerdict,
    validate_source_verification,
)


@dataclass(frozen=True, slots=True)
class ExtractionOutcome:
    """一次提取的结果：通过的候选、拒绝计数与整体失败原因。"""

    accepted: tuple[ExtractedFact, ...]
    rejected_count: int = 0
    failure_reason: str | None = None
    failure_kind: ExtractionFailureKind | None = None
    # 初始提取成功与后续来源核验成功分开，供各次调用独立记账。
    extraction_completed: bool = False

    def __post_init__(self) -> None:
        if (self.failure_reason is None) != (self.failure_kind is None):
            raise ValueError("失败原因与失败分类必须同时出现或同时为空。")


class ExtractionFlow:
    """逐条解析并校验证据契约；非法候选拒绝，运行时失败转为明确结果。"""

    __slots__ = ("_runtime", "_verification_runtime")

    def __init__(
        self,
        *,
        runtime: MemoryExtractionRuntime,
        verification_runtime: SourceVerificationRuntime | None = None,
    ) -> None:
        if runtime is None:
            raise TypeError("ExtractionFlow 必须显式注入运行时。")
        self._runtime = runtime
        self._verification_runtime = verification_runtime

    def run(self, window: ExtractionWindow) -> ExtractionOutcome:
        try:
            payloads = self._runtime.extract(window)
        except ExtractionRuntimeError as error:
            return ExtractionOutcome(
                accepted=(),
                rejected_count=0,
                failure_reason=(
                    "模型未返回可解析的结构化事实。"
                    if error.failure_kind is ExtractionFailureKind.INVALID_OUTPUT
                    else "模型调用失败，未生成记忆。"
                ),
                failure_kind=error.failure_kind,
            )

        window_ids = window.message_id_set
        target_ids = window.target_message_id_set
        accepted: list[ExtractedFact] = []
        rejected = 0
        for payload in payloads:
            try:
                fact = _to_fact(payload)
            except Exception:
                rejected += 1
                continue
            source_ids = set(fact.source_message_ids)
            if not source_ids <= window_ids or not source_ids & target_ids:
                rejected += 1
                continue
            source_times = tuple(
                message.occurred_at
                for message in window.messages
                if message.message_id in source_ids
            )
            fact = replace(
                fact, timing=MemoryTiming.from_source_times(source_times),
            )
            valid_at = fact.valid_at
            if valid_at is not None:
                temporal_risk: str | None = None
                if any(occurred_at is None for occurred_at in source_times):
                    temporal_risk = "pragmatic:unknown_source_time"
                elif valid_at > max(
                    value for value in source_times if value is not None
                ):
                    temporal_risk = "pragmatic:future_validity"
                if temporal_risk is not None:
                    fact = replace(
                        fact,
                        risk_flags=tuple(dict.fromkeys((
                            *fact.risk_flags, temporal_risk,
                        ))),
                    )
            accepted.append(fact)
        interpreter = PragmaticInterpreter()
        reviewable = tuple(
            fact for fact in accepted
            if interpreter.interpret(fact).disposition
            is not MemoryDisposition.NONE
        )
        if len(reviewable) > MAX_SOURCE_VERIFICATION_CANDIDATES:
            return ExtractionOutcome(
                accepted=(), rejected_count=rejected,
                failure_reason="来源核验候选超出单批预算，本批未写入记忆。",
                failure_kind=ExtractionFailureKind.INVALID_OUTPUT,
                extraction_completed=True,
            )
        if self._verification_runtime is None:
            accepted = [
                fact if interpreter.interpret(fact).disposition
                is MemoryDisposition.NONE else replace(
                    fact,
                    risk_flags=tuple(dict.fromkeys((
                        *fact.risk_flags, "semantic:unverified",
                    ))),
                )
                for fact in accepted
            ]
        elif reviewable:
            try:
                payloads = self._verification_runtime.verify(
                    window=window, facts=reviewable,
                )
                results = validate_source_verification(
                    payloads, window=window, facts=reviewable,
                )
            except ExtractionRuntimeError as error:
                return ExtractionOutcome(
                    accepted=(), rejected_count=rejected,
                    failure_reason="来源核验失败，本批未写入记忆。",
                    failure_kind=error.failure_kind,
                    extraction_completed=True,
                )
            unsupported_ids = {
                id(reviewable[result.candidate_index])
                for result in results
                if result.verdict is SourceVerificationVerdict.UNSUPPORTED
            }
            uncertain_facts = {
                id(reviewable[result.candidate_index]): replace(
                    reviewable[result.candidate_index],
                    risk_flags=tuple(dict.fromkeys((
                        *reviewable[result.candidate_index].risk_flags,
                        *(f"semantic:{issue.value}" for issue in result.issues),
                    ))),
                )
                for result in results
                if result.verdict is SourceVerificationVerdict.UNCERTAIN
            }
            accepted = [
                uncertain_facts.get(id(fact), fact)
                for fact in accepted if id(fact) not in unsupported_ids
            ]
            rejected += len(unsupported_ids)
        return ExtractionOutcome(
            accepted=tuple(accepted), rejected_count=rejected,
            extraction_completed=True,
        )


def _to_fact(payload: dict) -> ExtractedFact:
    risk_flags = payload["risk_flags"]
    alternatives = payload["alternatives"]
    interpretation_reason = payload["interpretation_reason"]
    if not isinstance(risk_flags, list):
        raise TypeError("风险标记必须是数组。")
    if not isinstance(alternatives, list):
        raise TypeError("备选解释必须是数组。")
    if (
        not isinstance(interpretation_reason, str)
        or not interpretation_reason.strip()
    ):
        raise ValueError("语用判断依据不能为空。")
    return ExtractedFact(
        text=payload["text"],
        category=MemoryCategory(payload["category"]),
        subject=FactSubject(payload["subject"]),
        topic=MemoryTopic(payload["topic"]),
        source_message_ids=tuple(
            _as_uuid(value) for value in payload["source_message_ids"]
        ),
        confidence=float(payload["confidence"]),
        risk_flags=tuple(risk_flags),
        valid_at=_as_datetime(payload.get("valid_at")),
        invalid_at=_as_datetime(payload.get("invalid_at")),
        speech_act=SpeechAct(payload["speech_act"]),
        assertion_status=AssertionStatus(payload["assertion_status"]),
        figurative_type=FigurativeType(payload["figurative_type"]),
        alternatives=tuple(alternatives),
        interpretation_reason=interpretation_reason,
    )


def _as_uuid(value: object) -> UUID:
    if isinstance(value, UUID):
        return value
    return UUID(str(value))


def _as_datetime(value: object) -> datetime | None:
    if value is None:
        return None
    return datetime.fromisoformat(str(value))
