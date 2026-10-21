"""维度判定键与放行表的公开行为测试。"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone
from unittest import mock

from notalone.memory_extraction import dimensions
from notalone.memory_extraction.dimensions import (
    DEFAULT_DIMENSION_RELEASE,
    RELEASE_ALL_DIMENSIONS,
    DimensionRelease,
    MemoryDimension,
    dimension_key,
)
from notalone.memory_extraction.evaluation_cases import CASES
from notalone.memory_extraction.semantic_evaluation_cases import SEMANTIC_CASES
from notalone.memory_extraction.models import (
    AssertionStatus,
    FactSubject,
    FigurativeType,
    SpeechAct,
)
from tests.unit.memory_extraction.dimension_helpers import synthetic_fact


class DimensionKeyTest(unittest.TestCase):
    """规则表驱动：每条规则一个用例，无法明确判定时必须返回 None。"""

    def test_rule_one_validity_window_selects_time_dimension(self) -> None:
        for overrides in (
            {"valid_at": datetime(2026, 9, 1, tzinfo=timezone.utc)},
            {"invalid_at": datetime(2026, 10, 1, tzinfo=timezone.utc)},
        ):
            with self.subTest(overrides=overrides):
                self.assertIs(
                    dimension_key(synthetic_fact(**overrides)),
                    MemoryDimension.TIME,
                )

    def test_time_dimension_wins_over_subject_dimension(self) -> None:
        fact = synthetic_fact(
            valid_at=datetime(2026, 9, 1, tzinfo=timezone.utc),
            invalid_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
        )

        self.assertIs(dimension_key(fact), MemoryDimension.TIME)

    def test_rule_two_contact_assertion_selects_subject_dimension(self) -> None:
        fact = synthetic_fact(
            speech_act=SpeechAct.ASSERTION,
            assertion_status=AssertionStatus.ASSERTED,
        )

        self.assertIs(dimension_key(fact), MemoryDimension.SUBJECT)

    def test_rule_two_covers_self_contact_and_shared_subjects(self) -> None:
        for subject, expected in (
            (FactSubject.SELF, MemoryDimension.SUBJECT),
            (FactSubject.CONTACT, MemoryDimension.SUBJECT),
            (FactSubject.SHARED, MemoryDimension.TRUTH_INTENT),
        ):
            with self.subTest(subject=subject):
                self.assertIs(
                    dimension_key(synthetic_fact(subject=subject)),
                    expected,
                )

    def test_rule_three_shared_assertion_selects_truth_intent_dimension(
        self,
    ) -> None:
        fact = synthetic_fact(subject=FactSubject.SHARED)

        self.assertIs(dimension_key(fact), MemoryDimension.TRUTH_INTENT)

    def test_rule_four_unknown_pragmatic_labels_cannot_be_judged(self) -> None:
        for overrides in (
            {"speech_act": SpeechAct.UNKNOWN},
            {"assertion_status": AssertionStatus.UNKNOWN},
        ):
            with self.subTest(overrides=overrides):
                self.assertIsNone(dimension_key(synthetic_fact(**overrides)))

    def test_rule_four_non_assertion_speech_acts_cannot_be_judged(self) -> None:
        for speech_act in (
            SpeechAct.PLAN,
            SpeechAct.QUESTION,
            SpeechAct.REQUEST,
            SpeechAct.REPORT,
            SpeechAct.CORRECTION,
        ):
            with self.subTest(speech_act=speech_act):
                self.assertIsNone(
                    dimension_key(synthetic_fact(speech_act=speech_act))
                )

    def test_rule_four_uncommitted_assertion_states_cannot_be_judged(
        self,
    ) -> None:
        for assertion_status in (
            AssertionStatus.HYPOTHETICAL,
            AssertionStatus.CONDITIONAL,
            AssertionStatus.REPORTED,
        ):
            with self.subTest(assertion_status=assertion_status):
                self.assertIsNone(
                    dimension_key(
                        synthetic_fact(assertion_status=assertion_status)
                    )
                )

    def test_rule_table_covers_every_speech_act_and_assertion_status(self) -> None:
        for speech_act in SpeechAct:
            for assertion_status in AssertionStatus:
                with self.subTest(
                    speech_act=speech_act, assertion_status=assertion_status
                ):
                    key = dimension_key(synthetic_fact(
                        speech_act=speech_act,
                        assertion_status=assertion_status,
                    ))
                    if (
                        speech_act is SpeechAct.ASSERTION
                        and assertion_status is AssertionStatus.ASSERTED
                    ):
                        self.assertIs(key, MemoryDimension.SUBJECT)
                    else:
                        self.assertIsNone(key)

    def test_time_rule_covers_every_pragmatic_label_combination(self) -> None:
        time_bound = datetime(2026, 9, 1, tzinfo=timezone.utc)
        for speech_act in SpeechAct:
            for assertion_status in AssertionStatus:
                with self.subTest(
                    speech_act=speech_act, assertion_status=assertion_status
                ):
                    self.assertIs(
                        dimension_key(synthetic_fact(
                            speech_act=speech_act,
                            assertion_status=assertion_status,
                            valid_at=time_bound,
                        )),
                        MemoryDimension.TIME,
                    )

    def test_figurative_type_does_not_change_the_key(self) -> None:
        for figurative_type in FigurativeType:
            with self.subTest(figurative_type=figurative_type):
                self.assertIs(
                    dimension_key(
                        synthetic_fact(figurative_type=figurative_type)
                    ),
                    MemoryDimension.SUBJECT,
                )

    def test_non_fact_input_is_rejected(self) -> None:
        with self.assertRaises(TypeError):
            dimension_key("不是候选")


class DimensionReleaseTest(unittest.TestCase):
    """默认空表、显式放行与运维回退开关。"""

    def test_runtime_keys_cover_every_evaluatable_dimension(self) -> None:
        """运行时键与评测维度串必须对齐；例外只能显式登记。"""

        evaluation_dimensions = {
            case.dimension for case in (*CASES, *SEMANTIC_CASES)
        }
        runtime_keys = {item.value for item in MemoryDimension}

        # 只允许评测专用、运行时不可推导的两个维度作为例外。
        self.assertEqual(
            evaluation_dimensions - runtime_keys,
            {"condition", "quantity"},
        )
        self.assertEqual(runtime_keys - evaluation_dimensions, set())

    def test_default_release_table_is_empty_and_gate_is_on(self) -> None:
        for release in (DEFAULT_DIMENSION_RELEASE, DimensionRelease()):
            with self.subTest(release=release):
                self.assertEqual(release.allowed, frozenset())
                self.assertEqual(release.released, frozenset())
                self.assertTrue(release.gate_enabled)

    def test_release_all_covers_the_evaluation_dimensions(self) -> None:
        self.assertEqual(
            RELEASE_ALL_DIMENSIONS.released,
            frozenset(dimension.value for dimension in MemoryDimension),
        )
        self.assertFalse(RELEASE_ALL_DIMENSIONS.gate_enabled)

    def test_release_table_rejects_unknown_dimension_names(self) -> None:
        for names in (("paraphrase_typo",), ("subject", "媒体")):
            with self.subTest(names=names):
                with self.assertRaises(ValueError):
                    DimensionRelease(names)

    def test_one_release_does_not_replace_other_proofs(self) -> None:
        release = DimensionRelease(("subject",))

        self.assertEqual(release.released, frozenset({"subject"}))
        self.assertFalse(release.allows(synthetic_fact()))
        self.assertFalse(release.allows(synthetic_fact(
            valid_at=datetime(2026, 9, 1, tzinfo=timezone.utc),
        )))

    def test_allows_returns_false_for_undecidable_facts(self) -> None:
        release = DimensionRelease(
            frozenset(dimension.value for dimension in MemoryDimension)
        )

        self.assertFalse(release.allows(synthetic_fact()))
        self.assertFalse(
            release.allows(synthetic_fact(speech_act=SpeechAct.UNKNOWN))
        )

    def test_environment_switch_disables_the_gate_only_for_explicit_zero(
        self,
    ) -> None:
        for value, enabled in (
            ("0", False),
            ("1", True),
            ("", True),
            ("true", True),
            (None, True),
        ):
            with self.subTest(value=value):
                environ = {} if value is None else {
                    "NOTALONE_MEMORY_DIMENSION_GATE": value
                }
                self.assertEqual(
                    DimensionRelease.from_environment(environ).gate_enabled,
                    enabled,
                )

    def test_unset_environment_keeps_the_strict_gate(self) -> None:
        release = DimensionRelease.from_environment({})

        self.assertTrue(release.gate_enabled)
        self.assertEqual(release.released, frozenset())
        self.assertFalse(release.allows(synthetic_fact()))

    def test_explicit_zero_only_disables_dimension_whitelist(self) -> None:
        release = DimensionRelease.from_environment(
            {"NOTALONE_MEMORY_DIMENSION_GATE": "0"}
        )

        self.assertFalse(release.gate_enabled)
        self.assertEqual(
            release.released,
            frozenset(dimension.value for dimension in MemoryDimension),
        )
        # 回退只关闭逐维白名单；默认 verified_sources 仍要求同次来源核验回执。
        self.assertFalse(release.allows(synthetic_fact(
            valid_at=datetime(2026, 9, 1, tzinfo=timezone.utc),
        )))
        # 显式历史协议（verified_sources=False）保留原有回退语义，供旧评测注入。
        legacy = DimensionRelease(gate_enabled=False, verified_sources=False)
        self.assertTrue(legacy.allows(synthetic_fact(
            valid_at=datetime(2026, 9, 1, tzinfo=timezone.utc),
        )))

    def test_ops_rollback_keeps_evidence_binding(self) -> None:
        with_rollback = DimensionRelease.from_environment(
            {"NOTALONE_MEMORY_DIMENSION_GATE": "0"}
        )
        self.assertTrue(with_rollback.requires_evidence_binding)

        legacy = DimensionRelease(gate_enabled=False, verified_sources=False)
        self.assertFalse(legacy.requires_evidence_binding)
        gate_on = DimensionRelease(verified_sources=False)
        self.assertTrue(gate_on.requires_evidence_binding)

    def test_explicit_single_release_keeps_the_full_gate_enabled(self) -> None:
        release = DimensionRelease(("subject",))

        self.assertEqual(release.allowed, frozenset({"subject"}))
        self.assertTrue(release.gate_enabled)
        self.assertFalse(release.allows(synthetic_fact()))
        self.assertFalse(release.allows(synthetic_fact(
            valid_at=datetime(2026, 9, 1, tzinfo=timezone.utc),
        )))

    def test_from_environment_starts_from_the_compiled_release_table(self) -> None:
        """放行台账改的正是这个默认值：改完必须真的生效。"""

        with mock.patch.object(
            dimensions,
            "DEFAULT_DIMENSION_RELEASE",
            DimensionRelease(("subject",)),
        ):
            release = DimensionRelease.from_environment({})

        self.assertEqual(release.released, frozenset({"subject"}))
        self.assertTrue(release.gate_enabled)
        self.assertFalse(release.allows(synthetic_fact()))
        self.assertFalse(release.allows(synthetic_fact(
            valid_at=datetime(2026, 9, 1, tzinfo=timezone.utc),
        )))

    def test_gate_switch_still_overrides_the_compiled_release_table(self) -> None:
        with mock.patch.object(
            dimensions,
            "DEFAULT_DIMENSION_RELEASE",
            DimensionRelease(("subject",)),
        ):
            release = DimensionRelease.from_environment(
                {"NOTALONE_MEMORY_DIMENSION_GATE": "0"}
            )

        self.assertFalse(release.gate_enabled)
        self.assertEqual(
            release.released,
            frozenset(dimension.value for dimension in MemoryDimension),
        )

    def test_environment_default_must_be_a_release_table(self) -> None:
        with self.assertRaises(TypeError):
            DimensionRelease.from_environment({}, default="subject")


if __name__ == "__main__":
    unittest.main()
