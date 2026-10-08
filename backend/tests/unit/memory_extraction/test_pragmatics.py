"""语用解释的确定性记忆分流测试。"""

from __future__ import annotations

import unittest
from uuid import uuid4

from notalone.memory.models import MemoryCategory
from notalone.memory_extraction.models import (
    AssertionStatus,
    ExtractedFact,
    FactSubject,
    FigurativeType,
    MemoryTopic,
    SpeechAct,
)
from notalone.memory_extraction.pragmatics import (
    MemoryDisposition,
    PragmaticInterpreter,
)


def _fact(**overrides: object) -> ExtractedFact:
    fields: dict[str, object] = {
        "text": "对方最近开始跑步",
        "category": MemoryCategory.RECENT_STATE,
        "subject": FactSubject.CONTACT,
        "topic": MemoryTopic.HEALTH,
        "source_message_ids": (uuid4(),),
        "confidence": 0.92,
        "speech_act": SpeechAct.ASSERTION,
        "assertion_status": AssertionStatus.ASSERTED,
        "figurative_type": FigurativeType.LITERAL,
        "alternatives": (),
        "interpretation_reason": "消息以确定语气描述近期状态。",
    }
    fields.update(overrides)
    return ExtractedFact(**fields)


class PragmaticInterpreterTest(unittest.TestCase):
    """规则只决定记忆分流，不判断现实世界真假。"""

    def setUp(self) -> None:
        self.interpreter = PragmaticInterpreter()

    def test_asserted_literal_statement_can_enter_adoption_gate(self) -> None:
        decision = self.interpreter.interpret(_fact())

        self.assertEqual(decision.disposition, MemoryDisposition.CONFIRMABLE)
        self.assertEqual(decision.reasons, ())

    def test_plan_is_pending_even_when_confidence_is_high(self) -> None:
        decision = self.interpreter.interpret(
            _fact(speech_act=SpeechAct.PLAN)
        )

        self.assertEqual(decision.disposition, MemoryDisposition.PENDING)
        self.assertIn("plan", decision.reasons)
        self.assertIn("pragmatic:plan", decision.risk_flags)

    def test_ambiguous_interpretation_is_pending(self) -> None:
        decision = self.interpreter.interpret(
            _fact(alternatives=("可能是在开玩笑",))
        )

        self.assertEqual(decision.disposition, MemoryDisposition.PENDING)
        self.assertIn("ambiguous", decision.reasons)

    def test_joke_sarcasm_and_hyperbole_do_not_create_memory(self) -> None:
        for figurative_type in (
            FigurativeType.JOKE,
            FigurativeType.SARCASM,
            FigurativeType.HYPERBOLE,
        ):
            with self.subTest(figurative_type=figurative_type):
                decision = self.interpreter.interpret(
                    _fact(figurative_type=figurative_type)
                )
                self.assertEqual(
                    decision.disposition,
                    MemoryDisposition.NONE,
                )

    def test_question_does_not_create_long_term_memory(self) -> None:
        decision = self.interpreter.interpret(
            _fact(speech_act=SpeechAct.QUESTION)
        )

        self.assertEqual(decision.disposition, MemoryDisposition.NONE)

    def test_non_literal_statuses_are_pending(self) -> None:
        for assertion_status in (
            AssertionStatus.HYPOTHETICAL,
            AssertionStatus.CONDITIONAL,
            AssertionStatus.REPORTED,
            AssertionStatus.UNKNOWN,
        ):
            with self.subTest(assertion_status=assertion_status):
                decision = self.interpreter.interpret(
                    _fact(assertion_status=assertion_status)
                )
                self.assertEqual(
                    decision.disposition,
                    MemoryDisposition.PENDING,
                )


if __name__ == "__main__":
    unittest.main()
