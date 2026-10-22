"""记忆方向保真：金额收支方向反转的确定性检测、提示词契约与采纳门。"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone
from uuid import UUID

from notalone.memory import InMemoryMemoryStore, MemoryCategory, MemoryTopic
from notalone.memory_extraction.adoption import MemoryAdoption
from notalone.memory_extraction.dimensions import DimensionRelease
from notalone.memory_extraction.direction_fidelity import (
    EXPENSE,
    INCOME,
    amount_directions,
    direction_conflicts,
)
from notalone.memory_extraction.direct_adapter import DIRECT_EXTRACTION_PROMPT
from notalone.memory_extraction.flow import ExtractionOutcome
from notalone.memory_extraction.models import (
    AssertionStatus,
    ExtractedFact,
    FactSubject,
    FigurativeType,
    MessageRef,
    MessageSender,
    SpeechAct,
)
from notalone.memory_extraction.verification_adapters import (
    SOURCE_VERIFICATION_SYSTEM_PROMPT,
)
from notalone.scopes import ContactScope

OWNER_ID = UUID("aaaaaaaa-1111-1111-1111-111111111111")
CONTACT_ID = UUID("bbbbbbbb-2222-2222-2222-222222222222")
SOURCE_ID = UUID("cccccccc-3333-3333-3333-333333333333")
OCCURRED_AT = datetime(2026, 7, 6, 10, 0, tzinfo=timezone.utc)


def _fact(**overrides: object) -> ExtractedFact:
    values: dict[str, object] = {
        "text": "对方说带课一个假期要花3万元",
        "category": MemoryCategory.COMMON_FACT,
        "subject": FactSubject.CONTACT,
        "topic": MemoryTopic.FINANCE,
        "source_message_ids": (SOURCE_ID,),
        "confidence": 0.9,
        "risk_flags": (),
        "valid_at": None,
        "invalid_at": None,
        "speech_act": SpeechAct.ASSERTION,
        "assertion_status": AssertionStatus.ASSERTED,
        "figurative_type": FigurativeType.LITERAL,
        "interpretation_reason": "合成对照候选，方向须由确定性检查与来源文本核对。",
    }
    values.update(overrides)
    return ExtractedFact(**values)


def _source_message(text: str) -> MessageRef:
    return MessageRef(
        message_id=SOURCE_ID,
        text=text,
        sender=MessageSender.CONTACT,
        occurred_at=OCCURRED_AT,
    )


class AmountDirectionTest(unittest.TestCase):
    def test_income_and_expense_directions_are_extracted(self):
        self.assertEqual(
            amount_directions("对方说带课一个假期能得3万"),
            (("3万", INCOME),),
        )
        self.assertEqual(
            amount_directions("对方说带课一个假期要花3万元"),
            (("3万", EXPENSE),),
        )

    def test_must_spend_phrase_is_expense(self):
        self.assertEqual(amount_directions("报名费得花3万"), (("3万", EXPENSE),))

    def test_decimal_amount_keeps_decimal_point(self):
        self.assertEqual(amount_directions("一共花了1.5万"), (("1.5万", EXPENSE),))

    def test_ambiguous_range_amount_is_normalized(self):
        self.assertEqual(
            amount_directions("一个假期带课得1、2万"),
            (("1-2万", INCOME),),
        )
        self.assertEqual(
            direction_conflicts(
                "一个假期带课要花1、2万元",
                ("一个假期带课得1、2万",),
            ),
            (("1-2万", EXPENSE, INCOME),),
        )

    def test_hyphen_range_amount_matches_range_source(self):
        self.assertEqual(
            direction_conflicts(
                "一个假期带课要花1-2万元",
                ("一个假期带课得1、2万",),
            ),
            (("1-2万", EXPENSE, INCOME),),
        )


class DirectionConflictTest(unittest.TestCase):
    def test_income_written_as_expense_is_conflict(self):
        self.assertEqual(
            direction_conflicts(
                "对方说带课一个假期要花3万元",
                ("对方说带课一个假期能得3万",),
            ),
            (("3万", EXPENSE, INCOME),),
        )

    def test_expense_written_as_income_is_conflict(self):
        self.assertEqual(
            direction_conflicts(
                "对方说带课一个假期能得3万元",
                ("对方说带课一个假期要花3万",),
            ),
            (("3万", INCOME, EXPENSE),),
        )

    def test_same_direction_is_not_conflict(self):
        self.assertFalse(
            direction_conflicts(
                "对方说带课一个假期能得3万元",
                ("对方说带课一个假期能得3万",),
            )
        )

    def test_missing_amount_is_not_conflict(self):
        self.assertFalse(direction_conflicts("对方觉得带课不错", ("对方觉得带课不错",)))

    def test_different_amounts_are_not_conflict(self):
        self.assertFalse(
            direction_conflicts(
                "对方说带课一个假期要花3万元",
                ("对方说带课一个假期能得5万",),
            )
        )

    def test_decimal_and_integer_amounts_are_not_conflict(self):
        self.assertFalse(
            direction_conflicts(
                "一共花了1.5万",
                ("一共赚了15万",),
            )
        )

    def test_source_with_two_directions_is_not_conflict(self):
        self.assertFalse(
            direction_conflicts(
                "补课要花3万",
                ("不是赚3万，是花3万",),
            )
        )
        self.assertFalse(
            direction_conflicts(
                "他赚了3万",
                ("他赚了3万，又花了3万",),
            )
        )

    def test_action_after_amount_defines_direction(self):
        self.assertFalse(
            direction_conflicts(
                "他花了3万元",
                ("他拿3万去花",),
            )
        )


class DirectionPromptContractTest(unittest.TestCase):
    def test_extraction_prompt_requires_source_direction_fidelity(self):
        self.assertIn("收支、给予", DIRECT_EXTRACTION_PROMPT)
        self.assertIn("方向", DIRECT_EXTRACTION_PROMPT)
        self.assertIn("必须与来源一致", DIRECT_EXTRACTION_PROMPT)

    def test_verification_prompt_checks_direction_reversal(self):
        self.assertIn("方向或施受主体反转", SOURCE_VERIFICATION_SYSTEM_PROMPT)
        self.assertIn("unsupported/meaning", SOURCE_VERIFICATION_SYSTEM_PROMPT)


class DirectionAdoptionGateTest(unittest.TestCase):
    def test_automatic_flow_does_not_adopt_direction_conflict(self):
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        store = InMemoryMemoryStore()
        stats = MemoryAdoption(
            memory_port=store,
            automatic=True,
            source_messages=(_source_message("对方说带课一个假期能得3万"),),
            dimension_release=DimensionRelease(gate_enabled=False),
        ).adopt(scope, ExtractionOutcome(accepted=(_fact(),)))

        self.assertEqual((stats.adopted, stats.pending), (0, 0))
        self.assertEqual(store.list_confirmed(scope), ())
        self.assertEqual(store.list_pending_candidates(scope), ())

    def test_manual_flow_keeps_direction_conflict_as_pending(self):
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        store = InMemoryMemoryStore()
        stats = MemoryAdoption(
            memory_port=store,
            automatic=False,
            source_messages=(_source_message("对方说带课一个假期能得3万"),),
            dimension_release=DimensionRelease(gate_enabled=False),
        ).adopt(scope, ExtractionOutcome(accepted=(_fact(),)))

        self.assertEqual((stats.adopted, stats.pending), (0, 1))
        self.assertEqual(store.list_confirmed(scope), ())
        self.assertEqual(len(store.list_pending_candidates(scope)), 1)

    def test_matching_direction_still_adopts(self):
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        store = InMemoryMemoryStore()
        stats = MemoryAdoption(
            memory_port=store,
            automatic=True,
            source_messages=(_source_message("对方说带课一个假期能得3万"),),
            dimension_release=DimensionRelease(gate_enabled=False),
        ).adopt(
            scope,
            ExtractionOutcome(accepted=(_fact(text="对方说带课一个假期能得3万元"),)),
        )

        self.assertEqual(stats.adopted, 1)
        self.assertEqual(len(store.list_confirmed(scope)), 1)

    def test_missing_source_text_does_not_downgrade(self):
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        store = InMemoryMemoryStore()
        stats = MemoryAdoption(
            memory_port=store,
            automatic=True,
            dimension_release=DimensionRelease(gate_enabled=False),
        ).adopt(scope, ExtractionOutcome(accepted=(_fact(),)))

        self.assertEqual(stats.adopted, 1)
        self.assertEqual(len(store.list_confirmed(scope)), 1)


if __name__ == "__main__":
    unittest.main()
