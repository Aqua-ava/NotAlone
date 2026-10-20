"""资料的适用限定；来源支持不等于条件在现实中仍然成立。"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from notalone.memory.events import EventEvidence, EVENT_POSITION_SCHEMA


@dataclass(frozen=True, slots=True)
class MemoryCondition:
    text: str
    evidence: tuple[EventEvidence, ...] = ()
    source_supported: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.text, str) or not self.text.strip() or len(self.text) > 1000:
            raise ValueError("适用条件正文无效。")
        if not isinstance(self.evidence, tuple) or len(self.evidence) > 8 or any(not isinstance(item, EventEvidence) for item in self.evidence):
            raise ValueError("条件来源位置无效。")
        if type(self.source_supported) is not bool or self.source_supported and not self.evidence:
            raise ValueError("条件支持缺少独立来源。")


@dataclass(frozen=True, slots=True)
class MemoryConditions:
    items: tuple[MemoryCondition, ...]
    source_current: bool = field(default=True, init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        if not isinstance(self.items, tuple) or not 1 <= len(self.items) <= 8 or any(not isinstance(item, MemoryCondition) for item in self.items):
            raise ValueError("适用条件须为一至八条。")

    def to_payload(self, *, current: bool = False) -> dict:
        return {"version": 1, "items": [{"text": item.text, "evidence": [ref.to_payload() for ref in item.evidence], "source_supported": item.source_supported and (self.source_current or not current)} for item in self.items]}

    @classmethod
    def from_payload(cls, raw: object, *, proposal: bool = False) -> MemoryConditions | None:
        if raw is None:
            return None
        if not isinstance(raw, dict) or set(raw) != {"version", "items"} or type(raw["version"]) is not int or raw["version"] != 1 or not isinstance(raw["items"], list):
            raise ValueError("适用条件不符合版本一合同。")
        items = []
        for item in raw["items"]:
            if not isinstance(item, dict) or set(item) != ({"text", "evidence"} if proposal else {"text", "evidence", "source_supported"}) or not isinstance(item["evidence"], list):
                raise ValueError("适用条件字段无效。")
            items.append(MemoryCondition(item["text"], tuple(EventEvidence.from_payload(ref) for ref in item["evidence"]), False if proposal else item["source_supported"]))
        return cls(tuple(items))

    def with_current_sources(self, current: bool) -> MemoryConditions:
        result = replace(self)
        object.__setattr__(result, "source_current", current)
        return result

    @property
    def supported(self) -> bool:
        return self.source_current and all(item.source_supported for item in self.items)


CONDITIONS_PROPOSAL_SCHEMA = {"type": ["object", "null"], "additionalProperties": False,
    "properties": {"version": {"type": "integer", "const": 1}, "items": {"type": "array", "minItems": 1, "maxItems": 8,
        "items": {"type": "object", "additionalProperties": False, "properties": {"text": {"type": "string", "minLength": 1, "maxLength": 1000}, "evidence": {"type": "array", "maxItems": 8, "items": EVENT_POSITION_SCHEMA}}, "required": ["text", "evidence"]}}}, "required": ["version", "items"]}
