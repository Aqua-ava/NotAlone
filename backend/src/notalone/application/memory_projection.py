"""资料API的有限依据投影；只表达当前依据，不赋予自动采纳资格。"""

from notalone.memory.models import (
    ConfirmedMemory, MemoryCandidate, OwnerMemory, SourceDependencyMode,
)
from notalone.memory.pragmatics import AssertionStatus, FigurativeType, SpeechAct
from notalone.memory_extraction.dimensions import required_dimensions, valid_evidence_dimensions
from notalone.memory_extraction.models import ExtractedFact


DIMENSION_NAMES = ("subject", "time", "truth_intent", "paraphrase", "reference", "media", "reported")


def source_dependency_fields(
    memory: MemoryCandidate | ConfirmedMemory | OwnerMemory,
) -> dict[str, str]:
    """只有新ALL资料增加字段，旧ANY响应保持原形状。"""
    return {"source_dependency_mode": "all"} if memory.source_dependency_mode is SourceDependencyMode.ALL else {}


def bounded_dimension_states(candidate: MemoryCandidate) -> dict[str, dict[str, object]]:
    """从既有相关集合和逐项依据派生受控三键，不使用自由理由。"""
    if candidate.source_dependency_mode is not SourceDependencyMode.ALL:
        raise ValueError("逐维度投影仅用于有限运行资料。")
    evidence = candidate.dimension_evidence
    if evidence is None:
        return {name: {"required": True, "state": "unknown", "reason": "not_proven"}
                for name in DIMENSION_NAMES}
    pragmatics = evidence.pragmatics
    fact = ExtractedFact(
        text=candidate.text, category=candidate.category, topic=candidate.topic,
        subject=candidate.subject, source_message_ids=candidate.source_ids,
        confidence=candidate.confidence, risk_flags=candidate.risk_flags,
        valid_at=candidate.valid_at, invalid_at=candidate.invalid_at,
        alternatives=candidate.alternatives, interpretation_reason=candidate.interpretation_reason,
        speech_act=pragmatics.speech_act if pragmatics is not None else SpeechAct.UNKNOWN,
        assertion_status=pragmatics.assertion_status if pragmatics is not None else AssertionStatus.UNKNOWN,
        figurative_type=pragmatics.figurative_type if pragmatics is not None else FigurativeType.UNKNOWN,
        dimension_evidence=evidence, source_dependency_mode=candidate.source_dependency_mode,
    )
    required = required_dimensions(fact)
    valid = valid_evidence_dimensions(fact)
    states = {}
    for name in DIMENSION_NAMES:
        if not evidence.source_bound:
            state, reason = "stale", "source_changed_or_candidate_changed"
        elif name in valid:
            state, reason = "valid", None
        else:
            state, reason = "unknown", "not_proven"
        states[name] = {"required": name in required, "state": state, "reason": reason}
    return states
