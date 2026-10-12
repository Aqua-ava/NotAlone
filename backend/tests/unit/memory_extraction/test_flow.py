"""提取外壳的逐条解析、证据契约校验与整体失败语义测试。"""

from __future__ import annotations

import unittest
from dataclasses import replace
from datetime import datetime, timezone
from uuid import uuid4

from notalone.memory_extraction.adoption import can_auto_adopt
from notalone.memory import InMemoryMemoryStore
from notalone.memory_extraction.adoption import MemoryAdoption
from notalone.memory_extraction.dimensions import (
    DEFAULT_DIMENSION_RELEASE,
    RELEASE_ALL_DIMENSIONS,
    MemoryDimension,
    dimension_key,
)
from notalone.scopes import ContactScope
from notalone.memory_extraction.errors import (
    ExtractionInvalidOutputError,
    ExtractionRuntimeError,
)
from notalone.memory_extraction.flow import ExtractionFlow, ExtractionOutcome
from notalone.memory_extraction.models import (
    AssertionStatus,
    ExtractionFailureKind,
    ExtractionWindow,
    FactSubject,
    FigurativeType,
    SpeechAct,
)
from notalone.memory_extraction.pragmatics import (
    MemoryDisposition,
    PragmaticInterpreter,
)
from notalone.memory_extraction.runtime import ExtractionPayload
from tests.unit.memory_extraction.test_models import _window
from tests.unit.memory_extraction.verification_helpers import SyntheticSupportingVerifier


def _payload(message_id: object, **overrides: object) -> dict:
    fields: dict[str, object] = {
        "text": "他不爱发语音，有事爱直接打电话",
        "category": "preference",
        "subject": "contact",
        "topic": "other",
        "source_message_ids": [str(message_id)],
        "confidence": 0.9,
        "risk_flags": [],
        "valid_at": None,
        "invalid_at": None,
        "speech_act": "assertion",
        "assertion_status": "asserted",
        "figurative_type": "literal",
        "alternatives": [],
        "interpretation_reason": "消息以确定语气表达一个关系主张。",
    }
    fields.update(overrides)
    return fields


class RecordingRuntime:
    """返回预置原始候选的确定性运行时。"""

    def __init__(self, payloads: ExtractionPayload) -> None:
        self.payloads = payloads

    def extract(self, window: object) -> ExtractionPayload:  # noqa: ARG002
        return self.payloads


class CrashingRuntime:
    def extract(self, window: object) -> ExtractionPayload:  # noqa: ARG002
        raise ExtractionRuntimeError("模型调用失败，未生成记忆。")


class InvalidOutputRuntime:
    def extract(self, window: object) -> ExtractionPayload:  # noqa: ARG002
        raise ExtractionInvalidOutputError("模型未返回可解析的结构化事实。")


class ExtractionFlowTest(unittest.TestCase):
    """外壳只做确定性解析与契约校验，不调用真实模型。"""

    def _run_flow(
        self, runtime: object, message_id: object = None
    ) -> ExtractionOutcome:
        resolved_id = message_id if message_id is not None else uuid4()
        return ExtractionFlow(
            runtime=runtime, verification_runtime=SyntheticSupportingVerifier(),
        ).run(_window((resolved_id,)))

    def test_valid_payload_passes_with_counts(self) -> None:
        message_id = uuid4()

        outcome = self._run_flow(
            RecordingRuntime((_payload(message_id),)), message_id
        )

        self.assertEqual(len(outcome.accepted), 1)
        fact = outcome.accepted[0]
        self.assertEqual(fact.text, "他不爱发语音，有事爱直接打电话")
        self.assertEqual(fact.source_message_ids, (message_id,))
        self.assertEqual(outcome.rejected_count, 0)
        self.assertIsNone(outcome.failure_reason)

    def test_historical_memory_keeps_only_referenced_dates_after_adoption(self):
        first, second, context = uuid4(), uuid4(), uuid4()
        original = _window((first, second, context))
        window = replace(original, messages=(
            replace(original.messages[0], occurred_at=datetime(2024, 2, 1, tzinfo=timezone.utc)),
            replace(original.messages[1], occurred_at=datetime(2024, 2, 3, tzinfo=timezone.utc)),
            replace(original.messages[2], occurred_at=datetime(2026, 9, 15, tzinfo=timezone.utc)),
        ), target_message_ids=(first, second))
        outcome = ExtractionFlow(
            verification_runtime=SyntheticSupportingVerifier(),
            runtime=RecordingRuntime((
                _payload(first, source_message_ids=[str(first), str(second)]),
            )),
        ).run(window)
        store = InMemoryMemoryStore()
        scope = ContactScope(window.owner_id, window.contact_id)
        MemoryAdoption(
            memory_port=store,
            dimension_release=RELEASE_ALL_DIMENSIONS,
        ).adopt(scope, outcome)
        memory = store.list_confirmed(scope)[0]

        self.assertEqual(memory.timing.source_started_at, datetime(2024, 2, 1, tzinfo=timezone.utc))
        self.assertEqual(memory.timing.source_ended_at, datetime(2024, 2, 3, tzinfo=timezone.utc))
        self.assertTrue(memory.timing.source_time_complete)
        self.assertIsNotNone(memory.timing.recorded_at)
        self.assertIsNone(memory.valid_at)

    def test_future_validity_blocks_auto_adoption_despite_assertion_labels(
        self,
    ) -> None:
        source_id, context_id = uuid4(), uuid4()
        original = _window((source_id, context_id))
        window = replace(
            original,
            messages=(
                replace(
                    original.messages[0],
                    text="原本下周去北京，改到下个月。",
                    occurred_at=datetime(2026, 9, 15, tzinfo=timezone.utc),
                ),
                replace(
                    original.messages[1],
                    text="今天聊的是另一件事。",
                    occurred_at=datetime(2026, 10, 2, tzinfo=timezone.utc),
                ),
            ),
            target_message_ids=(source_id,),
        )
        outcome = ExtractionFlow(
            verification_runtime=SyntheticSupportingVerifier(),
            runtime=RecordingRuntime((
                _payload(
                    source_id,
                    text="联系人改在下个月去北京",
                    valid_at="2026-10-01T00:00:00+00:00",
                    risk_flags=["low"],
                ),
            )),
        ).run(window)

        self.assertEqual(outcome.rejected_count, 0)
        self.assertEqual(len(outcome.accepted), 1)
        fact = outcome.accepted[0]
        decision = PragmaticInterpreter().interpret(fact)
        self.assertFalse(can_auto_adopt(fact, decision))
        self.assertEqual(fact.risk_flags, ("low", "pragmatic:future_validity"))
        self.assertEqual(fact.text, "联系人改在下个月去北京")
        self.assertEqual(fact.subject, FactSubject.CONTACT)
        self.assertEqual(fact.speech_act, SpeechAct.ASSERTION)
        self.assertEqual(fact.assertion_status, AssertionStatus.ASSERTED)
        self.assertEqual(fact.figurative_type, FigurativeType.LITERAL)
        self.assertEqual(fact.source_message_ids, (source_id,))
        self.assertEqual(
            fact.valid_at,
            datetime(2026, 10, 1, tzinfo=timezone.utc),
        )

    def test_post_effective_evidence_does_not_block_auto_adoption(
        self,
    ) -> None:
        planning_id, confirmation_id = uuid4(), uuid4()
        original = _window((planning_id, confirmation_id))
        window = replace(
            original,
            messages=(
                replace(
                    original.messages[0],
                    text="原本下周去北京，改到下个月。",
                    occurred_at=datetime(2026, 9, 15, tzinfo=timezone.utc),
                ),
                replace(
                    original.messages[1],
                    text="已经按改期安排到北京了。",
                    occurred_at=datetime(2026, 10, 2, tzinfo=timezone.utc),
                ),
            ),
            target_message_ids=(confirmation_id,),
        )
        outcome = ExtractionFlow(
            verification_runtime=SyntheticSupportingVerifier(),
            runtime=RecordingRuntime((
                _payload(
                    confirmation_id,
                    text="联系人已按改期安排到北京",
                    source_message_ids=[str(planning_id), str(confirmation_id)],
                    valid_at="2026-10-01T00:00:00+00:00",
                    risk_flags=["low"],
                ),
            )),
        ).run(window)

        self.assertEqual(outcome.rejected_count, 0)
        self.assertEqual(len(outcome.accepted), 1)
        fact = outcome.accepted[0]
        decision = PragmaticInterpreter().interpret(fact)
        self.assertTrue(can_auto_adopt(fact, decision))
        self.assertEqual(fact.risk_flags, ("low",))
        self.assertEqual(
            fact.source_message_ids,
            (planning_id, confirmation_id),
        )

    def test_missing_source_time_blocks_only_facts_with_validity(self) -> None:
        source_id = uuid4()
        original = _window((source_id,))
        window = replace(
            original,
            messages=(replace(original.messages[0], occurred_at=None),),
        )
        for valid_at, expected_auto, expected_flags in (
            (None, True, ("low",)),
            (
                "2026-10-01T00:00:00+00:00",
                False,
                ("low", "pragmatic:unknown_source_time"),
            ),
        ):
            with self.subTest(valid_at=valid_at):
                outcome = ExtractionFlow(
                    verification_runtime=SyntheticSupportingVerifier(),
                    runtime=RecordingRuntime((
                        _payload(source_id, valid_at=valid_at, risk_flags=["low"]),
                    )),
                ).run(window)
                self.assertEqual(outcome.rejected_count, 0)
                self.assertEqual(len(outcome.accepted), 1)
                fact = outcome.accepted[0]
                decision = PragmaticInterpreter().interpret(fact)
                self.assertEqual(can_auto_adopt(fact, decision), expected_auto)
                self.assertEqual(fact.risk_flags, expected_flags)
                self.assertEqual(fact.source_message_ids, (source_id,))
                self.assertIsNone(window.messages[0].occurred_at)

    def test_facts_referencing_outside_window_are_rejected(self) -> None:
        valid_id = uuid4()
        window = _window((valid_id,))
        payloads = (
            _payload(valid_id),
            _payload(uuid4()),
            _payload(valid_id, source_message_ids=[str(valid_id), str(uuid4())]),
        )

        outcome = ExtractionFlow(
            runtime=RecordingRuntime(payloads)
        ).run(window)

        self.assertEqual(len(outcome.accepted), 1)
        self.assertEqual(outcome.rejected_count, 2)

    def test_invalid_fields_are_rejected_one_by_one(self) -> None:
        message_id = uuid4()
        payloads = (
            _payload(uuid4(), subject="somebody_else"),
            _payload(uuid4(), category="hobby"),
            {"text": "缺字段的事实"},
        )

        outcome = self._run_flow(RecordingRuntime(payloads), message_id)

        self.assertEqual(outcome.accepted, ())
        self.assertEqual(outcome.rejected_count, 3)
        self.assertIsNone(outcome.failure_reason)

    def test_mixed_batch_keeps_valid_and_counts_invalid(self) -> None:
        message_id = uuid4()
        payloads = (
            _payload(message_id),
            _payload(uuid4()),
            _payload(uuid4(), confidence=2.0),
        )

        outcome = self._run_flow(RecordingRuntime(payloads), message_id)

        self.assertEqual(len(outcome.accepted), 1)
        self.assertEqual(outcome.rejected_count, 2)

    def test_runtime_failure_is_reported_not_raised(self) -> None:
        outcome = self._run_flow(CrashingRuntime())

        self.assertEqual(outcome.accepted, ())
        self.assertEqual(
            outcome.failure_reason, "模型调用失败，未生成记忆。"
        )
        self.assertEqual(
            outcome.failure_kind, ExtractionFailureKind.UNAVAILABLE
        )

    def test_invalid_output_is_tagged_for_skip_counting(self) -> None:
        outcome = self._run_flow(InvalidOutputRuntime())

        self.assertEqual(
            outcome.failure_kind, ExtractionFailureKind.INVALID_OUTPUT
        )

    def test_fact_must_reference_at_least_one_target_message(self) -> None:
        target_id = uuid4()
        context_id = uuid4()
        window = _window((target_id, context_id))
        window = ExtractionWindow(
            owner_id=window.owner_id,
            contact_id=window.contact_id,
            messages=window.messages,
            target_message_ids=(target_id,),
        )

        outcome = ExtractionFlow(
            runtime=RecordingRuntime((_payload(context_id),))
        ).run(window)

        self.assertEqual(outcome.accepted, ())
        self.assertEqual(outcome.rejected_count, 1)

    def test_missing_or_empty_interpretation_fields_are_rejected(self) -> None:
        message_id = uuid4()
        missing = _payload(message_id)
        del missing["speech_act"]
        empty_reason = _payload(message_id, interpretation_reason="  ")
        null_alternatives = _payload(message_id, alternatives=None)

        outcome = self._run_flow(
            RecordingRuntime((missing, empty_reason, null_alternatives)),
            message_id,
        )

        self.assertEqual(outcome.accepted, ())
        self.assertEqual(outcome.rejected_count, 3)

    def test_missing_required_validity_fields_are_structure_rejected(self) -> None:
        message_id = uuid4()
        for missing in (
            ("valid_at",),
            ("invalid_at",),
            ("valid_at", "invalid_at"),
        ):
            with self.subTest(missing=missing):
                payload = _payload(message_id)
                for field in missing:
                    del payload[field]

                outcome = self._run_flow(
                    RecordingRuntime((payload,)), message_id
                )

                self.assertEqual(outcome.accepted, ())
                self.assertEqual(outcome.rejected_count, 1)
                self.assertTrue(outcome.extraction_completed)

    def test_explicit_validity_slots_preserve_labels_and_closed_default(
        self,
    ) -> None:
        message_id = uuid4()
        cases = (
            ({}, MemoryDimension.SUBJECT, MemoryDisposition.CONFIRMABLE),
            (
                {"speech_act": "correction", "alternatives": ["合成歧义"]},
                None,
                MemoryDisposition.PENDING,
            ),
            (
                {
                    "valid_at": "2026-01-01T00:00:00+08:00",
                    "speech_act": "report",
                    "assertion_status": "reported",
                },
                MemoryDimension.TIME,
                MemoryDisposition.PENDING,
            ),
        )
        for overrides, expected_dimension, expected_disposition in cases:
            with self.subTest(overrides=overrides):
                outcome = self._run_flow(
                    RecordingRuntime((_payload(message_id, **overrides),)),
                    message_id,
                )

                self.assertEqual(len(outcome.accepted), 1)
                self.assertEqual(outcome.rejected_count, 0)
                fact = outcome.accepted[0]
                self.assertIs(dimension_key(fact), expected_dimension)
                self.assertIs(
                    PragmaticInterpreter().interpret(fact).disposition,
                    expected_disposition,
                )
                self.assertTrue(DEFAULT_DIMENSION_RELEASE.gate_enabled)
                self.assertFalse(DEFAULT_DIMENSION_RELEASE.allows(fact))


if __name__ == "__main__":
    unittest.main()
