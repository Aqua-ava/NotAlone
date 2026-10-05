"""维度放行的共享测试夹具；只构造合成事实，不接触存储或模型。"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

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


__all__ = [
    "CONTACT_ID",
    "OWNER_ID",
    "SOURCE_ID",
    "synthetic_fact",
    "synthetic_time_fact",
]
