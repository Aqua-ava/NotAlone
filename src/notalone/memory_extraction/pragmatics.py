"""关系记忆提取的语用解释与确定性记忆分流。"""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import StrEnum

from notalone.memory_extraction.models import (
    AssertionStatus,
    ExtractedFact,
    FigurativeType,
    SpeechAct,
)

__all__ = [
    "MemoryDisposition",
    "PragmaticDecision",
    "PragmaticInterpreter",
]


class MemoryDisposition(StrEnum):
    """语用结果对关系记忆候选的确定性分流。"""

    CONFIRMABLE = "confirmable"
    PENDING = "pending"
    NONE = "none"


@dataclass(frozen=True, slots=True)
class PragmaticDecision:
    """语用解释之后的记忆分流决定；不代表现实世界真伪。"""

    disposition: MemoryDisposition
    reasons: tuple[str, ...] = ()
    risk_flags: tuple[str, ...] = ()


class PragmaticInterpreter:
    """将模型给出的语用标签转换为确定性的记忆分流。"""

    __slots__ = ()

    def interpret(self, fact: ExtractedFact) -> PragmaticDecision:
        """只依据结构化标签分流，不用关键词猜测，也不调用外部系统。"""

        if not isinstance(fact, ExtractedFact):
            raise TypeError("语用解释输入必须是 ExtractedFact。")

        if fact.figurative_type in {
            FigurativeType.JOKE,
            FigurativeType.SARCASM,
            FigurativeType.HYPERBOLE,
        }:
            return PragmaticDecision(
                disposition=MemoryDisposition.NONE,
                reasons=(fact.figurative_type.value,),
            )

        if fact.speech_act is SpeechAct.QUESTION:
            return PragmaticDecision(
                disposition=MemoryDisposition.NONE,
                reasons=(SpeechAct.QUESTION.value,),
            )

        reasons: list[str] = []
        if fact.alternatives:
            reasons.append("ambiguous")
        if fact.speech_act is not SpeechAct.ASSERTION:
            reasons.append(fact.speech_act.value)
        if fact.assertion_status is not AssertionStatus.ASSERTED:
            reasons.append(fact.assertion_status.value)
        if fact.figurative_type is FigurativeType.UNKNOWN:
            reasons.append("figurative_unknown")

        if reasons:
            unique_reasons = tuple(dict.fromkeys(reasons))
            return PragmaticDecision(
                disposition=MemoryDisposition.PENDING,
                reasons=unique_reasons,
                risk_flags=tuple(
                    f"pragmatic:{reason}" for reason in unique_reasons
                ),
            )

        return PragmaticDecision(
            disposition=MemoryDisposition.CONFIRMABLE,
        )

    def prepare_for_adoption(
        self,
        fact: ExtractedFact,
        *,
        decision: PragmaticDecision | None = None,
    ) -> ExtractedFact:
        """为 pending 结果保留语用阻塞原因，供现有候选生命周期审计。"""

        decision = decision or self.interpret(fact)
        if decision.disposition is not MemoryDisposition.PENDING:
            return fact
        flags = tuple(dict.fromkeys((*fact.risk_flags, *decision.risk_flags)))
        return replace(fact, risk_flags=flags)
