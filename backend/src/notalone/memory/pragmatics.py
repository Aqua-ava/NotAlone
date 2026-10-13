"""提取与持久依据共享的语用标签；快照不代表语义已被验证。"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class SpeechAct(StrEnum):
    """消息在对话中执行的说话行为。"""

    ASSERTION = "assertion"
    PLAN = "plan"
    QUESTION = "question"
    REQUEST = "request"
    REPORT = "report"
    CORRECTION = "correction"
    UNKNOWN = "unknown"


class AssertionStatus(StrEnum):
    """消息对其主张的承诺程度。"""

    ASSERTED = "asserted"
    HYPOTHETICAL = "hypothetical"
    CONDITIONAL = "conditional"
    REPORTED = "reported"
    UNKNOWN = "unknown"


class FigurativeType(StrEnum):
    """消息是否使用玩笑、讽刺或夸张等非字面表达。"""

    LITERAL = "literal"
    JOKE = "joke"
    SARCASM = "sarcasm"
    HYPERBOLE = "hyperbole"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class PragmaticSnapshot:
    """绑定 Fact 当时的三个标签，不从无标签的旧候选重建。"""

    speech_act: SpeechAct
    assertion_status: AssertionStatus
    figurative_type: FigurativeType

    def __post_init__(self) -> None:
        if (
            not isinstance(self.speech_act, SpeechAct)
            or not isinstance(self.assertion_status, AssertionStatus)
            or not isinstance(self.figurative_type, FigurativeType)
        ):
            raise TypeError("语用依据快照必须使用受控枚举。")

    def to_payload(self) -> dict[str, str]:
        return {
            "speech_act": self.speech_act.value,
            "assertion_status": self.assertion_status.value,
            "figurative_type": self.figurative_type.value,
        }

    @classmethod
    def from_payload(cls, value: object) -> PragmaticSnapshot:
        names = {"speech_act", "assertion_status", "figurative_type"}
        if (
            not isinstance(value, dict) or set(value) != names
            or any(type(item) is not str for item in value.values())
        ):
            raise ValueError("语用依据快照字段不符合契约。")
        return cls(
            SpeechAct(value["speech_act"]),
            AssertionStatus(value["assertion_status"]),
            FigurativeType(value["figurative_type"]),
        )
