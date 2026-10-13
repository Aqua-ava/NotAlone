"""维度依据的严格输入、范围和候选变更契约。"""

from __future__ import annotations

import unittest
from dataclasses import replace
import hashlib
from uuid import uuid4

from notalone.memory import InMemoryMemoryStore, MemoryCandidate, MemoryCategory
from notalone.memory.dimension_evidence import DimensionEvidence
from notalone.memory.pragmatics import (
    AssertionStatus, FigurativeType, PragmaticSnapshot, SpeechAct,
)
from notalone.memory.evidence_binding import (
    bind_dimension_evidence, candidate_digest, window_digest,
)
from notalone.scopes import ContactScope


class CandidateDimensionEvidenceTest(unittest.TestCase):
    def test_legacy_candidate_is_unknown_and_model_true_is_not_evidence(self) -> None:
        scope = ContactScope(uuid4(), uuid4())
        candidate = MemoryCandidate(
            candidate_id=uuid4(), scope=scope, text="合成原文",
            category=MemoryCategory.COMMON_FACT, source_ids=(uuid4(),),
        )
        store = InMemoryMemoryStore()
        saved = store.create_candidate(candidate)
        self.assertIsNone(saved.dimension_evidence)
        with self.assertRaises((TypeError, ValueError)):
            replace(candidate, dimension_evidence={"paraphrase": True})
        for version in (True, 1.0, 2):
            with self.subTest(version=version):
                with self.assertRaises((TypeError, ValueError)):
                    DimensionEvidence.from_payload({"version": version})

    def test_complete_payload_rejects_boolean_and_foreign_window_anchors(self) -> None:
        scope = ContactScope(uuid4(), uuid4())
        message_id = uuid4()
        digest = hashlib.sha256("合成原文".encode()).hexdigest()
        payload = {
            "version": 1,
            "scope": {
                "owner_id": str(scope.owner_id), "contact_id": str(scope.contact_id),
            },
            "candidate_sha256": digest, "window_sha256": digest,
            "pragmatics": None,
            "messages": [{
                "message_id": str(message_id), "text_sha256": digest,
                "text_length": 4, "sender": "contact", "message_type": "text",
                "text_representation": "text",
                "source_state_sha256": None,
                "occurred_at": None, "source_refs": [],
            }],
            "paraphrase": None, "reference": None, "media": None, "reported": None,
        }
        self.assertEqual(DimensionEvidence.from_payload(payload).to_payload(), payload)
        pragmatics = PragmaticSnapshot(
            SpeechAct.ASSERTION, AssertionStatus.ASSERTED, FigurativeType.LITERAL,
        ).to_payload()
        complete = {**payload, "pragmatics": pragmatics}
        self.assertEqual(
            DimensionEvidence.from_payload(complete).to_payload(), complete,
        )
        for invalid in (
            True, {**pragmatics, "speech_act": True},
            {**pragmatics, "speech_act": "unknown_custom_label"},
            {**pragmatics, "is_correct": True},
        ):
            with self.subTest(pragmatics=invalid):
                with self.assertRaises((TypeError, ValueError)):
                    DimensionEvidence.from_payload({
                        **payload, "pragmatics": invalid,
                    })
        for version in (True, 1.0, 2):
            with self.subTest(version=version):
                with self.assertRaises((TypeError, ValueError)):
                    DimensionEvidence.from_payload({**payload, "version": version})
        with self.assertRaises(ValueError):
            DimensionEvidence.from_payload({**payload, "source_bound": True})
        with self.assertRaises((TypeError, ValueError)):
            DimensionEvidence.from_payload({**payload, "paraphrase": True})
        span = {"start": 0, "end": 4, "sha256": digest}
        with self.assertRaises(ValueError):
            DimensionEvidence.from_payload({
                **payload,
                "reference": [{
                    "mention": {"message_id": str(message_id), "span": span},
                    "target": {"message_id": str(uuid4()), "span": span},
                    "subject": "contact",
                }],
            })

    def test_binding_refuses_candidate_source_and_scope_changes(self) -> None:
        from notalone.memory.dimension_evidence import EvidenceMessage

        scope = ContactScope(uuid4(), uuid4())
        message_id = uuid4()
        text = "合成原文"
        candidate = MemoryCandidate(
            candidate_id=uuid4(), scope=scope, text=text,
            category=MemoryCategory.COMMON_FACT, source_ids=(message_id,),
        )
        message = EvidenceMessage(
            message_id, hashlib.sha256(text.encode()).hexdigest(), len(text),
            "contact", "text", None, ((uuid4(), uuid4()),),
            source_state_sha256=hashlib.sha256(b"synthetic source").hexdigest(),
        )
        evidence = DimensionEvidence(
            scope, candidate_digest(candidate), window_digest(scope, (message,)),
            (message,),
        )
        bind = lambda **changes: bind_dimension_evidence(evidence, **{
            "scope": scope, "candidate": candidate,
            "messages": (message,), "texts": {message_id: text}, **changes,
        })
        self.assertTrue(bind().source_bound)
        self.assertFalse(DimensionEvidence.from_payload(
            evidence.to_payload(),
        ).source_bound)
        self.assertFalse(bind(candidate=replace(
            candidate, text="变更后的合成正文",
        )).source_bound)
        self.assertFalse(bind(texts={message_id: "变更后的来源正文"}).source_bound)
        self.assertFalse(bind(messages=(replace(
            message, source_refs=(),
        ),)).source_bound)
        self.assertFalse(bind(scope=ContactScope(scope.owner_id, uuid4())).source_bound)


if __name__ == "__main__":
    unittest.main()
