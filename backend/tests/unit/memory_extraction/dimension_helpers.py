"""维度放行的共享测试夹具；只构造合成事实，不接触存储或模型。"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID
from uuid import uuid4
from dataclasses import replace

from notalone.memory.dimension_evidence import (
    DimensionEvidence, EvidenceMessage, MediaOrigin, MessageSpan,
    ReferenceAnchor, ReportedAttribution, TextAlignment, TextSpan,
)
from notalone.memory.evidence_binding import (
    bind_dimension_evidence, candidate_digest, content_digest, fact_pragmatics,
    window_digest,
)
from notalone.scopes import ContactScope

from notalone.memory import MemoryCategory, MemoryTopic
from notalone.memory_extraction.models import (
    AssertionStatus,
    ExtractedFact,
    FactSubject,
    FigurativeType,
    SpeechAct,
)

OWNER_ID = UUID("aaaaaaaa-1111-1111-1111-111111111111")
CONTACT_ID = UUID("bbbbbbbb-2222-2222-2222-222222222222")
SOURCE_ID = UUID("cccccccc-3333-3333-3333-333333333333")


def synthetic_fact(**overrides: object) -> ExtractedFact:
    """与评测维度对齐的合成事实；默认落在 `subject` 维度。"""

    values: dict[str, object] = {
        "text": "对方最近开始跑步",
        "category": MemoryCategory.RECENT_STATE,
        "subject": FactSubject.CONTACT,
        "topic": MemoryTopic.HEALTH,
        "source_message_ids": (SOURCE_ID,),
        "confidence": 0.92,
        "risk_flags": (),
        "valid_at": None,
        "invalid_at": None,
        "speech_act": SpeechAct.ASSERTION,
        "assertion_status": AssertionStatus.ASSERTED,
        "figurative_type": FigurativeType.LITERAL,
        "interpretation_reason": "消息以确定语气表达一个关系主张。",
    }
    values.update(overrides)
    return ExtractedFact(**values)


def synthetic_time_fact(**overrides: object) -> ExtractedFact:
    """带明确有效期的合成事实；用于 `time` 维度用例。"""

    values: dict[str, object] = {
        "valid_at": datetime(2026, 9, 1, tzinfo=timezone.utc),
        "invalid_at": datetime(2026, 10, 1, tzinfo=timezone.utc),
    }
    values.update(overrides)
    return synthetic_fact(**values)


def synthetic_complete_evidence(
    fact: ExtractedFact, *, scope: ContactScope | None = None,
    sender: str | None = None,
) -> ExtractedFact:
    """显式注入已约定正确的合成定位，仅测门逻辑，不签生产模型能力。"""

    scope = scope or ContactScope(OWNER_ID, CONTACT_ID)
    source = fact.source_message_ids[0]
    whole = TextSpan(0, len(fact.text), content_digest(fact.text))
    first = TextSpan(0, 1, content_digest(fact.text[:1]))
    anchor = MessageSpan(source, first)
    metadata = EvidenceMessage(
        source, content_digest(fact.text), len(fact.text),
        sender or ("self" if fact.subject is FactSubject.SELF else "contact"),
        "text", datetime.now(timezone.utc), ((uuid4(), uuid4()),),
        "text",
        content_digest("固定合成来源指纹"),
    )
    evidence = DimensionEvidence(
        scope, candidate_digest(fact), window_digest(scope, (metadata,)),
        (metadata,),
        pragmatics=fact_pragmatics(fact),
        paraphrase=(TextAlignment(whole, MessageSpan(source, whole)),),
        reference=(ReferenceAnchor(anchor, anchor, fact.subject.value),),
        media=(MediaOrigin(source, "text", "text"),),
        reported=(ReportedAttribution(anchor, anchor, "direct"),),
    )
    return replace(fact, dimension_evidence=bind_dimension_evidence(
        evidence, scope=scope, candidate=fact, messages=(metadata,),
        texts={source: fact.text},
    ))


__all__ = [
    "CONTACT_ID",
    "OWNER_ID",
    "SOURCE_ID",
    "synthetic_fact",
    "synthetic_time_fact",
]
