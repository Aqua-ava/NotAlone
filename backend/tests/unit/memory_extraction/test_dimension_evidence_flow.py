"""来源核验后的实际窗口依据；合成端口不代表真实模型质量。"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
import unittest
from uuid import uuid4

from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.dimensions import (
    DimensionRelease, MemoryDimension, required_dimensions,
    valid_evidence_dimensions,
)
from tests.unit.memory_extraction.dimension_helpers import (
    synthetic_complete_evidence, synthetic_fact,
)
from notalone.memory import MemoryCategory
from notalone.memory.dimension_evidence import MediaOrigin
from notalone.memory.evidence_binding import (
    bind_dimension_evidence, candidate_digest, window_digest,
)
from notalone.memory_extraction.models import (
    AssertionStatus, FactSubject, FigurativeType, SpeechAct,
)
from tests.unit.memory_extraction.test_flow import RecordingRuntime, _payload
from tests.unit.memory_extraction.test_models import _window
from tests.unit.memory_extraction.verification_helpers import (
    SyntheticSupportingVerifier,
)


class DimensionEvidenceFlowTest(unittest.TestCase):
    def test_missing_media_details_cannot_hide_unknown_representation(self) -> None:
        fact = synthetic_complete_evidence(synthetic_fact(
            text="我喜欢咖啡", category=MemoryCategory.PREFERENCE,
        ))
        evidence = fact.dimension_evidence
        metadata = (replace(
            evidence.messages[0], text_representation="unknown",
        ),)
        evidence = bind_dimension_evidence(
            replace(
                evidence, messages=metadata, media=None,
                window_sha256=window_digest(evidence.scope, metadata),
            ),
            scope=evidence.scope, candidate=fact, messages=metadata,
            texts={fact.source_message_ids[0]: fact.text},
        )
        changed = replace(fact, dimension_evidence=evidence)
        self.assertIn("media", required_dimensions(changed))
        self.assertFalse(DimensionRelease(tuple(MemoryDimension)).allows(changed))

    def test_label_only_changes_invalidate_the_previous_evidence(self) -> None:
        fact = synthetic_complete_evidence(synthetic_fact(
            text="我喜欢咖啡", category=MemoryCategory.PREFERENCE,
        ))
        self.assertTrue(DimensionRelease(tuple(MemoryDimension)).allows(fact))
        for name, value in (
            ("speech_act", SpeechAct.PLAN),
            ("assertion_status", AssertionStatus.REPORTED),
            ("figurative_type", FigurativeType.JOKE),
        ):
            with self.subTest(label=name):
                changed = replace(fact, **{name: value})
                self.assertEqual(candidate_digest(changed), candidate_digest(fact))
                self.assertIs(changed.dimension_evidence, fact.dimension_evidence)
                self.assertEqual(valid_evidence_dimensions(changed), frozenset())
                rebound = bind_dimension_evidence(
                    changed.dimension_evidence,
                    scope=changed.dimension_evidence.scope,
                    candidate=changed,
                    messages=changed.dimension_evidence.messages,
                    texts={changed.source_message_ids[0]: changed.text},
                )
                self.assertFalse(rebound.source_bound)

    def test_media_label_does_not_prove_a_controlled_text_adapter(self) -> None:
        fact = synthetic_complete_evidence(synthetic_fact(
            text="我喜欢咖啡", category=MemoryCategory.PREFERENCE,
        ))
        evidence = fact.dimension_evidence
        message = replace(
            evidence.messages[0], message_type="audio",
            text_representation="unknown",
        )
        metadata = (message,)
        declared = replace(
            evidence, messages=metadata,
            window_sha256=window_digest(evidence.scope, metadata),
            media=(MediaOrigin(message.message_id, "audio", "processed_text"),),
        )
        bound = bind_dimension_evidence(
            declared, scope=evidence.scope, candidate=fact,
            messages=metadata, texts={message.message_id: fact.text},
        )

        self.assertFalse(DimensionRelease(tuple(MemoryDimension)).allows(
            replace(fact, dimension_evidence=bound)
        ))

    def test_every_related_dimension_is_required_and_sender_cannot_be_forged(
        self,
    ) -> None:
        fact = synthetic_complete_evidence(synthetic_fact(
            text="我喜欢咖啡", category=MemoryCategory.PREFERENCE,
        ))
        all_dimensions = tuple(MemoryDimension)
        self.assertTrue(DimensionRelease(all_dimensions).allows(fact))
        for dimension in required_dimensions(fact):
            with self.subTest(dimension=dimension):
                self.assertFalse(DimensionRelease(tuple(
                    item for item in all_dimensions if item.value != dimension
                )).allows(fact))
        forged = synthetic_complete_evidence(synthetic_fact(
            text="我喜欢咖啡", category=MemoryCategory.PREFERENCE,
            subject=FactSubject.SELF,
        ), sender="contact")
        self.assertFalse(DimensionRelease(all_dimensions).allows(forged))

    def test_priority_release_cannot_hide_subject_or_missing_evidence(self) -> None:
        fact = synthetic_fact(
            valid_at=datetime(2026, 9, 1, tzinfo=timezone.utc),
            invalid_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
        )
        self.assertFalse(DimensionRelease(("time",)).allows(fact))
        self.assertFalse(DimensionRelease(tuple(MemoryDimension)).allows(
            synthetic_fact(),
        ))

    def test_generic_supported_saves_unknown_attribution_and_full_window(self) -> None:
        message_id, context_id = uuid4(), uuid4()
        window = _window((message_id, context_id))
        outcome = ExtractionFlow(
            runtime=RecordingRuntime((_payload(message_id),)),
            verification_runtime=SyntheticSupportingVerifier(),
        ).run(window)
        fact = outcome.accepted[0]
        evidence = fact.dimension_evidence
        self.assertIsNotNone(evidence)
        self.assertEqual(
            {item.message_id for item in evidence.messages},
            {message_id, context_id},
        )
        self.assertIsNone(evidence.paraphrase)
        self.assertIsNone(evidence.reference)
        self.assertIsNone(evidence.reported)
        self.assertFalse(evidence.source_bound)


if __name__ == "__main__":
    unittest.main()
