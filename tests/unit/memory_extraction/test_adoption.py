"""关系记忆采纳的公开行为测试。"""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import UUID

from notalone.memory import (
    AdoptionMethod,
    InMemoryMemoryStore,
    MemoryCategory,
    MemoryTopic,
)
from notalone.memory_extraction.adoption import MemoryAdoption
from notalone.memory_extraction.adjudication import (
    AdjudicationAction,
    AdjudicationDecision,
)
from notalone.memory_extraction.dimensions import (
    DEFAULT_DIMENSION_RELEASE,
    RELEASE_ALL_DIMENSIONS,
    DimensionRelease,
)
from notalone.memory_extraction.flow import ExtractionOutcome
from notalone.memory_extraction.models import ExtractedFact, FactSubject
from notalone.memory_extraction.models import (
    AssertionStatus,
    FigurativeType,
    SpeechAct,
)
from notalone.scopes import ContactScope


OWNER_ID = UUID("aaaaaaaa-1111-1111-1111-111111111111")
CONTACT_ID = UUID("bbbbbbbb-2222-2222-2222-222222222222")
SOURCE_ID = UUID("cccccccc-3333-3333-3333-333333333333")


def _fact(**overrides: object) -> ExtractedFact:
    """通过语用与风险门槛的合成候选；默认落在 `subject` 维度。"""

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


class MemoryAdoptionTest(unittest.TestCase):
    """只通过 MemoryAdoption 和 MemoryPort 验证可观察生命周期。

    这些用例验证的是原有三道门槛，因此显式注入全量放行表；默认收紧的
    行为由 ``DimensionReleaseGateTest`` 单独覆盖。
    """

    def setUp(self) -> None:
        self.scope = ContactScope(OWNER_ID, CONTACT_ID)
        self.store = InMemoryMemoryStore()
        self.adoption = MemoryAdoption(
            memory_port=self.store,
            dimension_release=RELEASE_ALL_DIMENSIONS,
        )

    def _fact(self, **overrides: object) -> ExtractedFact:
        return _fact(**overrides)

    def test_sensitive_fact_keeps_provenance_in_pending_candidate(self) -> None:
        stats = self.adoption.adopt(
            self.scope,
            ExtractionOutcome(
                accepted=(self._fact(
                    risk_flags=("health",),
                    valid_at=datetime(2026, 9, 1, tzinfo=timezone.utc),
                    invalid_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
                ),)
            ),
        )

        self.assertEqual(stats.pending, 1)
        self.assertEqual(self.store.list_confirmed(self.scope), ())
        candidates = self.store.list_pending_candidates(self.scope)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].confidence, 0.92)
        self.assertEqual(candidates[0].risk_flags, ("health",))
        self.assertEqual(candidates[0].source_ids, (SOURCE_ID,))
        self.assertEqual(
            candidates[0].valid_at,
            datetime(2026, 9, 1, tzinfo=timezone.utc),
        )
        self.assertEqual(
            candidates[0].invalid_at,
            datetime(2026, 10, 1, tzinfo=timezone.utc),
        )

    def test_low_risk_fact_is_auto_adopted_with_provenance(self) -> None:
        stats = self.adoption.adopt(
            self.scope,
            ExtractionOutcome(accepted=(self._fact(),)),
        )

        self.assertEqual(stats.adopted, 1)
        memory = self.store.list_confirmed(self.scope)[0]
        self.assertEqual(memory.adoption_method, AdoptionMethod.AUTO)
        self.assertEqual(memory.confidence, 0.92)
        self.assertEqual(memory.risk_flags, ())
        self.assertEqual(memory.source_ids, (SOURCE_ID,))

    def test_auto_adopted_shared_fact_keeps_candidate_subject(self) -> None:
        stats = self.adoption.adopt(
            self.scope,
            ExtractionOutcome(
                accepted=(self._fact(
                    text="用户和联系人上周一起看了展览",
                    category=MemoryCategory.COMMON_FACT,
                    topic=MemoryTopic.OTHER,
                    subject=FactSubject.SHARED,
                ),),
            ),
        )

        self.assertEqual(stats.adopted, 1)
        memories = self.store.list_confirmed(self.scope)
        self.assertEqual(len(memories), 1)
        memory = memories[0]
        self.assertEqual(memory.adoption_method, AdoptionMethod.AUTO)
        self.assertEqual(memory.source_ids, (SOURCE_ID,))
        candidate_id = memory.source_candidate_id
        if candidate_id is None:
            self.fail("自动采纳记忆必须保留来源候选。")
        candidate = self.store.get_candidate(
            scope=self.scope,
            candidate_id=candidate_id,
        )
        self.assertEqual(candidate.subject, FactSubject.SHARED)
        self.assertEqual(candidate.source_ids, (SOURCE_ID,))

    def test_repeating_same_pending_fact_is_idempotent(self) -> None:
        fact = self._fact(confidence=0.3)
        first = self.adoption.adopt(
            self.scope, ExtractionOutcome(accepted=(fact,))
        )
        second = self.adoption.adopt(
            self.scope, ExtractionOutcome(accepted=(fact,))
        )

        self.assertEqual(first.pending, 1)
        self.assertEqual(second.skipped_duplicate, 1)
        self.assertEqual(len(self.store.list_pending_candidates(self.scope)), 1)

    def test_correction_creates_a_new_active_version(self) -> None:
        self.adoption.adopt(
            self.scope,
            ExtractionOutcome(accepted=(self._fact(),)),
        )
        old = self.store.list_confirmed(self.scope)[0]

        corrected = self.store.correct(
            scope=self.scope,
            memory_id=old.memory_id,
            text="对方最近开始游泳",
        )

        self.assertNotEqual(corrected.memory_id, old.memory_id)
        self.assertEqual(
            self.store.list_confirmed(self.scope),
            (corrected,),
        )
        self.assertEqual(corrected.revision, old.revision + 1)

    def test_plan_stays_pending_even_with_high_confidence(self) -> None:
        stats = self.adoption.adopt(
            self.scope,
            ExtractionOutcome(
                accepted=(
                    self._fact(
                        speech_act=SpeechAct.PLAN,
                        assertion_status=AssertionStatus.ASSERTED,
                    ),
                )
            ),
        )

        self.assertEqual(stats.pending, 1)
        self.assertEqual(self.store.list_confirmed(self.scope), ())
        candidate = self.store.list_pending_candidates(self.scope)[0]
        self.assertIn("pragmatic:plan", candidate.risk_flags)

    def test_joke_is_not_saved_as_a_candidate(self) -> None:
        stats = self.adoption.adopt(
            self.scope,
            ExtractionOutcome(
                accepted=(
                    self._fact(figurative_type=FigurativeType.JOKE),
                )
            ),
        )

        self.assertEqual(stats.pending, 0)
        self.assertEqual(stats.skipped_non_memory, 1)
        self.assertEqual(self.store.list_pending_candidates(self.scope), ())

    def test_update_without_replaced_memory_stays_pending(self) -> None:
        # 裁决判定"新事实取代旧记忆"但缺少有效被取代 id（结构化输出
        # 丢字段或指向范围外）：不能静默按 ADD 落库，否则被取代的旧
        # 记忆保持 active，与新事实并存。降级为待定候选，由用户确认。
        stats = self.adoption.adopt(
            self.scope,
            ExtractionOutcome(accepted=(self._fact(confidence=0.3),)),
        )
        self.assertEqual(stats.pending, 1)
        candidate_id = self.store.list_pending_candidates(self.scope)[0].candidate_id
        self.store.confirm(scope=self.scope, candidate_id=candidate_id)
        old = self.store.list_confirmed(self.scope)[0]

        adoption = MemoryAdoption(
            memory_port=self.store,
            adjudication_runtime=UpdateWithoutReplacedIdRuntime(),
            dimension_release=RELEASE_ALL_DIMENSIONS,
        )
        result = adoption.adopt(
            self.scope,
            ExtractionOutcome(
                accepted=(self._fact(text="对方最近开始跑步锻炼"),)
            ),
        )

        self.assertEqual(result.pending, 1)
        self.assertEqual(result.adopted, 0)
        self.assertEqual(result.updated, 0)
        self.assertEqual(self.store.list_confirmed(self.scope), (old,))
        pending = self.store.list_pending_candidates(self.scope)
        self.assertEqual(
            [candidate.text for candidate in pending],
            ["对方最近开始跑步锻炼"],
        )


class DimensionReleaseGateTest(unittest.TestCase):
    """第四道合取项：维度未放行时安静待确认，不写 confirmed_memory。"""

    def setUp(self) -> None:
        self.scope = ContactScope(OWNER_ID, CONTACT_ID)
        self.store = InMemoryMemoryStore()

    def _adoption(
        self, release: DimensionRelease | None = None
    ) -> MemoryAdoption:
        values: dict[str, object] = {"memory_port": self.store}
        if release is not None:
            values["dimension_release"] = release
        return MemoryAdoption(**values)

    def _time_fact(self) -> ExtractedFact:
        """仍未过期的临时状态；只带失效时间，避免未来生效时间被语用拦下。"""

        return _fact(
            invalid_at=datetime.now(timezone.utc) + timedelta(days=7)
        )

    def _truth_intent_fact(self) -> ExtractedFact:
        return _fact(
            text="用户和联系人上周一起看了展览",
            category=MemoryCategory.COMMON_FACT,
            topic=MemoryTopic.OTHER,
            subject=FactSubject.SHARED,
        )

    def test_default_release_table_keeps_low_risk_candidate_pending(self) -> None:
        stats = self._adoption(DEFAULT_DIMENSION_RELEASE).adopt(
            self.scope,
            ExtractionOutcome(accepted=(_fact(),)),
        )

        self.assertEqual(stats.adopted, 0)
        self.assertEqual(stats.pending, 1)
        self.assertEqual(self.store.list_confirmed(self.scope), ())
        candidates = self.store.list_pending_candidates(self.scope)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].confidence, 0.92)

    def test_environment_unset_defaults_to_the_strict_gate(self) -> None:
        """未显式配置时按维度放行门就是开启的，保持默认收紧。"""

        with patch.dict(os.environ, {}, clear=True):
            stats = self._adoption().adopt(
                self.scope,
                ExtractionOutcome(accepted=(_fact(),)),
            )

        self.assertEqual(stats.adopted, 0)
        self.assertEqual(stats.pending, 1)
        self.assertEqual(self.store.list_confirmed(self.scope), ())

    def test_released_dimension_is_auto_adopted(self) -> None:
        stats = self._adoption(DimensionRelease(("subject",))).adopt(
            self.scope,
            ExtractionOutcome(accepted=(_fact(),)),
        )

        self.assertEqual(stats.adopted, 1)
        memories = self.store.list_confirmed(self.scope)
        self.assertEqual(len(memories), 1)
        self.assertEqual(memories[0].adoption_method, AdoptionMethod.AUTO)

    def test_releasing_one_dimension_does_not_release_another(self) -> None:
        adoption = self._adoption(DimensionRelease(("time",)))

        subject_stats = adoption.adopt(
            self.scope, ExtractionOutcome(accepted=(_fact(),))
        )

        self.assertEqual(subject_stats.adopted, 0)
        self.assertEqual(subject_stats.pending, 1)
        self.assertEqual(self.store.list_confirmed(self.scope), ())

    def test_time_dimension_is_auto_adopted_when_released(self) -> None:
        stats = self._adoption(DimensionRelease(("time",))).adopt(
            self.scope,
            ExtractionOutcome(accepted=(self._time_fact(),)),
        )

        self.assertEqual(stats.adopted, 1)
        self.assertEqual(len(self.store.list_confirmed(self.scope)), 1)

    def test_truth_intent_dimension_is_auto_adopted_when_released(self) -> None:
        stats = self._adoption(DimensionRelease(("truth_intent",))).adopt(
            self.scope,
            ExtractionOutcome(accepted=(self._truth_intent_fact(),)),
        )

        self.assertEqual(stats.adopted, 1)
        self.assertEqual(len(self.store.list_confirmed(self.scope)), 1)

    def test_undecidable_dimension_is_never_auto_adopted(self) -> None:
        for overrides in (
            {"speech_act": SpeechAct.UNKNOWN},
            {"assertion_status": AssertionStatus.UNKNOWN},
            {
                "speech_act": SpeechAct.REPORT,
                "assertion_status": AssertionStatus.REPORTED,
            },
        ):
            with self.subTest(overrides=overrides):
                store = InMemoryMemoryStore()
                adoption = MemoryAdoption(
                    memory_port=store,
                    dimension_release=RELEASE_ALL_DIMENSIONS,
                )

                stats = adoption.adopt(
                    self.scope,
                    ExtractionOutcome(accepted=(_fact(**overrides),)),
                )

                self.assertEqual(stats.adopted, 0)
                self.assertEqual(store.list_confirmed(self.scope), ())

    def test_release_all_dimensions_restores_todays_adoption(self) -> None:
        stats = self._adoption(RELEASE_ALL_DIMENSIONS).adopt(
            self.scope,
            ExtractionOutcome(accepted=(_fact(),)),
        )

        self.assertEqual(stats.adopted, 1)

    def test_environment_rollback_switch_restores_todays_adoption(self) -> None:
        with patch.dict(
            os.environ, {"NOTALONE_MEMORY_DIMENSION_GATE": "0"}, clear=False
        ):
            stats = self._adoption().adopt(
                self.scope,
                ExtractionOutcome(accepted=(_fact(),)),
            )

        self.assertEqual(stats.adopted, 1)
        self.assertEqual(len(self.store.list_confirmed(self.scope)), 1)

    def test_environment_gate_keeps_candidates_pending(self) -> None:
        with patch.dict(
            os.environ, {"NOTALONE_MEMORY_DIMENSION_GATE": "1"}, clear=False
        ):
            stats = self._adoption().adopt(
                self.scope,
                ExtractionOutcome(accepted=(_fact(),)),
            )

        self.assertEqual(stats.adopted, 0)
        self.assertEqual(stats.pending, 1)
        self.assertEqual(self.store.list_confirmed(self.scope), ())


class UpdateWithoutReplacedIdRuntime:
    """模拟结构化输出丢失 replaced_memory_id 字段的裁决。"""

    def adjudicate(self, *, candidate_text: str, similar: tuple) -> AdjudicationDecision:
        del candidate_text, similar
        return AdjudicationDecision(
            action=AdjudicationAction.UPDATE,
            replaced_memory_id=None,
        )


if __name__ == "__main__":
    unittest.main()
