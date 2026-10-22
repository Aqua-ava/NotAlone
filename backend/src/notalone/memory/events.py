"""事件阶段与发生时段；来源判断分别取得，不由时钟补完成。"""

from copy import deepcopy
from dataclasses import dataclass, field, replace
from datetime import datetime
from enum import StrEnum
from uuid import UUID


class EventStage(StrEnum):
    PLANNED = "planned"
    AGREED = "agreed"
    RESCHEDULED = "rescheduled"
    CANCELLED = "cancelled"
    OCCURRED = "occurred"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class EventEvidence:
    message_id: UUID
    char_start: int
    char_end: int

    def __post_init__(self) -> None:
        if (not isinstance(self.message_id, UUID) or type(self.char_start) is not int
                or type(self.char_end) is not int
                or not 0 <= self.char_start < self.char_end <= 100000):
            raise ValueError("事件依据位置无效。")

    def to_payload(self) -> dict:
        return {"message_id": str(self.message_id), "char_start": self.char_start,
                "char_end": self.char_end}

    @classmethod
    def from_payload(cls, value: object) -> "EventEvidence":
        if not isinstance(value, dict) or set(value) != {"message_id", "char_start", "char_end"}:
            raise ValueError("事件依据字段无效。")
        if not isinstance(value["message_id"], str):
            raise ValueError("事件依据标识无效。")
        return cls(UUID(value["message_id"]), value["char_start"], value["char_end"])


@dataclass(frozen=True, slots=True)
class MemoryEvent:
    stage: EventStage
    stage_evidence: tuple[EventEvidence, ...] = ()
    occurrence_start: datetime | None = None
    occurrence_end: datetime | None = None
    occurrence_evidence: tuple[EventEvidence, ...] = ()
    stage_verified: bool = False
    occurrence_verified: bool = False
    version: int = 1
    occurrence_precision: str = "unknown"
    occurrence_expression: str | None = None
    anchor_message_id: UUID | None = None
    source_current: bool = field(default=True, init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        if type(self.version) is not int or self.version not in (1, 2):
            raise ValueError("事件版本无效。")
        if self.occurrence_precision not in {"year", "month", "day", "instant", "unknown"}:
            raise ValueError("事件日期精度无效。")
        if self.occurrence_expression is not None and (not isinstance(self.occurrence_expression, str)
                or not 0 < len(self.occurrence_expression.strip()) <= 256):
            raise ValueError("事件原始时间表达无效。")
        if self.anchor_message_id is not None and not isinstance(self.anchor_message_id, UUID):
            raise ValueError("事件时间锚点无效。")
        if self.version == 2 and self.occurrence_precision == "unknown" and self.occurrence_start is not None:
            raise ValueError("未知日期精度不能携带推测日期。")
        if not isinstance(self.stage, EventStage):
            raise ValueError("事件阶段无效。")
        for items in (self.stage_evidence, self.occurrence_evidence):
            if (not isinstance(items, tuple) or len(items) > 8
                    or any(not isinstance(item, EventEvidence) for item in items)):
                raise ValueError("事件依据超出有界范围。")
        for value in (self.occurrence_start, self.occurrence_end):
            if value is not None and (not isinstance(value, datetime)
                    or value.tzinfo is None or value.utcoffset() is None):
                raise ValueError("事件发生时间必须有明确时区。")
        if (self.occurrence_end is not None and (self.occurrence_start is None
                or self.occurrence_end <= self.occurrence_start)):
            raise ValueError("事件发生区间无效。")
        if type(self.stage_verified) is not bool or type(self.occurrence_verified) is not bool:
            raise ValueError("事件核验状态无效。")
        if self.stage_verified and (self.stage is EventStage.UNKNOWN or not self.stage_evidence):
            raise ValueError("阶段核验缺少独立来源。")
        if self.occurrence_verified and (self.occurrence_start is None or not self.occurrence_evidence):
            raise ValueError("发生时间核验缺少独立来源。")

    def to_payload(self, *, current: bool = False) -> dict:
        return {"version": self.version, "stage": self.stage.value,
                **({"occurrence_precision": self.occurrence_precision,
                    "occurrence_expression": self.occurrence_expression,
                    "anchor_message_id": str(self.anchor_message_id) if self.anchor_message_id else None} if self.version == 2 else {}),
                "stage_evidence": [item.to_payload() for item in self.stage_evidence],
                "stage_verified": self.stage_verified and (self.source_current or not current),
                "occurrence_start": self.occurrence_start.isoformat() if self.occurrence_start else None,
                "occurrence_end": self.occurrence_end.isoformat() if self.occurrence_end else None,
                "occurrence_evidence": [item.to_payload() for item in self.occurrence_evidence],
                "occurrence_verified": self.occurrence_verified and (self.source_current or not current)}

    @classmethod
    def from_payload(cls, value: object, *, proposal: bool = False) -> "MemoryEvent | None":
        if value is None:
            return None
        fields = {"version", "stage", "stage_evidence", "occurrence_start",
                  "occurrence_end", "occurrence_evidence"}
        if isinstance(value, dict) and value.get("version") == 2:
            fields |= {"occurrence_precision", "occurrence_expression", "anchor_message_id"}
        if not proposal:
            fields |= {"stage_verified", "occurrence_verified"}
        if (not isinstance(value, dict) or set(value) != fields
                or type(value["version"]) is not int or value["version"] not in (1, 2)):
            raise ValueError("事件字段不符合版本合同。")
        def when(key: str) -> datetime | None:
            raw = value[key]
            if raw is None:
                return None
            if not isinstance(raw, str):
                raise ValueError("事件发生时间无效。")
            return datetime.fromisoformat(raw)
        def positions(key: str) -> tuple[EventEvidence, ...]:
            if not isinstance(value[key], list):
                raise ValueError("事件依据必须是数组。")
            return tuple(EventEvidence.from_payload(item) for item in value[key])
        anchor = value.get("anchor_message_id")
        if anchor is not None and not isinstance(anchor, str):
            raise ValueError("事件时间锚点标识无效。")
        return cls(version=value["version"],
                   occurrence_precision=value.get("occurrence_precision", "unknown"),
                   occurrence_expression=value.get("occurrence_expression"),
                   anchor_message_id=UUID(anchor) if anchor is not None else None,
                   stage=EventStage(value["stage"]), stage_evidence=positions("stage_evidence"),
                   occurrence_start=when("occurrence_start"), occurrence_end=when("occurrence_end"),
                   occurrence_evidence=positions("occurrence_evidence"),
                   stage_verified=False if proposal else value["stage_verified"],
                   occurrence_verified=False if proposal else value["occurrence_verified"])

    def with_current_sources(self, current: bool) -> "MemoryEvent":
        result = replace(self)
        object.__setattr__(result, "source_current", current)
        return result


def _overlapping_positions(left: tuple[EventEvidence, ...], right: tuple[EventEvidence, ...]) -> bool:
    return any(a.message_id == b.message_id and max(a.char_start, b.char_start) < min(a.char_end, b.char_end)
               for a in left for b in right)


def same_verified_occurrence(left: MemoryEvent | None, right: MemoryEvent | None) -> bool:
    """同一当前来源片段支持同一发生时段；标签或来源编号本身不足以合并。"""
    return bool(left and right and left.source_current and right.source_current
                and left.occurrence_verified and right.occurrence_verified
                and left.occurrence_start == right.occurrence_start
                and left.occurrence_end == right.occurrence_end
                and left.occurrence_precision == right.occurrence_precision
                and _overlapping_positions(left.occurrence_evidence, right.occurrence_evidence))


def same_verified_event_claim(left: MemoryEvent | None, right: MemoryEvent | None) -> bool:
    if left is None and right is None:
        return True
    return bool(same_verified_occurrence(left, right) and left.stage_verified and right.stage_verified
                and left.stage == right.stage
                and _overlapping_positions(left.stage_evidence, right.stage_evidence))


EVENT_POSITION_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {"message_id": {"type": "string", "format": "uuid"},
                   "char_start": {"type": "integer", "minimum": 0},
                   "char_end": {"type": "integer", "minimum": 1}},
    "required": ["message_id", "char_start", "char_end"],
}
EVENT_PROPOSAL_SCHEMA = {
    "type": ["object", "null"], "additionalProperties": False,
    "properties": {"version": {"type": "integer", "const": 1},
        "stage": {"type": "string", "enum": [item.value for item in EventStage]},
        "stage_evidence": {"type": "array", "maxItems": 8, "items": EVENT_POSITION_SCHEMA},
        "occurrence_start": {"type": ["string", "null"]},
        "occurrence_end": {"type": ["string", "null"]},
        "occurrence_evidence": {"type": "array", "maxItems": 8, "items": EVENT_POSITION_SCHEMA}},
    "required": ["version", "stage", "stage_evidence", "occurrence_start",
                 "occurrence_end", "occurrence_evidence"],
}

# 新直接提取合同独立扩展；历史 grounded 协议继续使用版本一。
EVENT_PROPOSAL_V2_SCHEMA = deepcopy(EVENT_PROPOSAL_SCHEMA)
EVENT_PROPOSAL_V2_SCHEMA["properties"].update({
    "version": {"type": "integer", "const": 2},
    "occurrence_precision": {"type": "string", "enum": ["year", "month", "day", "instant", "unknown"]},
    "occurrence_expression": {"type": ["string", "null"], "maxLength": 256},
    "anchor_message_id": {"type": ["string", "null"], "format": "uuid"},
})
EVENT_PROPOSAL_V2_SCHEMA["required"] += ["occurrence_precision", "occurrence_expression", "anchor_message_id"]
