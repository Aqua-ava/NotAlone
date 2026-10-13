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
    bind_dimension_evidence, candidate_digest, content_digest, window_digest,
)
from notalone.memory_extraction.models import (
    AssertionStatus, FactSubject, FigurativeType, SpeechAct,
)
from tests.unit.memory_extraction.test_flow import RecordingRuntime, _payload
from tests.unit.memory_extraction.test_models import _window
from tests.unit.memory_extraction.verification_helpers import (
    FixedSourceVerifier, SyntheticSupportingVerifier, verification_result,
)


def _arrival_fixture():
    """公开合成实际来源和位置提案，不直接签运行校验状态。"""
    message_id = uuid4()
    original = _window((message_id,))
    text = "我刚到家。"
    window = replace(original, messages=(replace(
        original.messages[0], text=text, message_type="text",
        text_representation="text", source_snapshots=({
            "source_ref_id": str(uuid4()), "source_id": str(uuid4()),
            "source_kind": "source_document", "locator": "messages/0",
            "raw_payload": {"text": text},
            "source_content_sha256": content_digest(text),
        },),
    ),))
    payload = _payload(message_id, text="联系人刚到家。", category="common_fact")
    source = {"message_id": str(message_id), "start": 0, "end": len(text)}
    author = {"message_id": str(message_id), "start": 0, "end": 1}
    candidate = {"start": 0, "end": len(payload["text"])}
    proof = {
        "version": 1,
        "atom_links": [{"rule_id": "AUTHOR_ARRIVAL_H1", "variant_id": "direct_h",
                        "source": source, "candidate": candidate}],
        "reference": [{"rule_id": "AUTHOR_ARRIVAL_H1", "mention": author,
                       "target": author, "binding": None}],
        "reported": [{"rule_id": "AUTHOR_ARRIVAL_H1", "frame": "direct",
                      "source": source, "candidate": candidate}],
    }
    return window, payload, proof


def _relation_fixture(source, candidate, rule, variant, frame, **fields):
    """独立合成窗口与I/O位置提案；期望关系由测试案例另行明确。"""
    window, payload, _ = _arrival_fixture()
    message = window.messages[0]
    snapshots = (dict(message.source_snapshots[0], raw_payload={"text": source},
                      source_content_sha256=content_digest(source)),)
    window = replace(window, messages=(replace(
        message, text=source, source_snapshots=snapshots,
        sender=(type(message.sender).SELF if fields.get("subject") == "self"
                else message.sender),
    ),))
    payload = {**payload, "text": candidate, **fields}
    main = source.split("。", 1)[0]
    author_start = main.rindex("我")

    def span(start, end):
        return {"message_id": str(message.message_id), "start": start, "end": end}

    author = span(author_start, author_start + 1)
    references = [{"rule_id": rule, "mention": author, "target": author,
                   "binding": None}]
    if "这里的“" in source:
        start = source.index("这里的“")
        pronoun = source[start + 4]
        mention = main.index(pronoun)
        target = source.index("指", start) + 1
        end = len(source.rstrip("。"))
        references.append({
            "rule_id": "SOURCE_IDENTITY_H1", "mention": span(mention, mention + 1),
            "target": span(target, end), "binding": span(start, end),
        })
    whole = span(0, len(source))
    candidate_span = {"start": 0, "end": len(candidate)}
    proof = {
        "version": 1, "reference": references,
        "atom_links": [{"rule_id": rule, "variant_id": variant,
                        "source": whole, "candidate": candidate_span}],
        "reported": [{"rule_id": rule, "frame": frame,
                      "source": whole, "candidate": candidate_span}],
    }
    return window, payload, proof


class DimensionEvidenceFlowTest(unittest.TestCase):
    def test_known_additions_and_dropped_qualifiers_are_rejected_by_actual_flow(self):
        request = "我同事让我周末帮他顶个班。这里的“他”指我同事。"
        plan = "如果天晴，我计划后天只跑约7.5公里。"
        cases = (
            (request, "用户已答应周末替用户的同事顶班", "self"),
            (request, "用户有义务周末替用户的同事顶班", "self"),
            (request, "用户已经顶班了", "self"),
            (request, "用户周末已收到用户的同事请托；所请内容为用户替该同事顶班，未说明接受", "self"),
            (plan, "联系人计划后天只跑约7500米", "contact"),
            (plan, "如果天晴，联系人计划后天跑约7500米", "contact"),
            (plan, "如果天晴，联系人计划后天只跑7500米", "contact"),
            (plan, "如果天晴，联系人已经后天只跑约7500米了", "contact"),
        )
        for source, candidate, subject in cases:
            with self.subTest(candidate=candidate):
                window, payload, _ = _relation_fixture(
                    source, candidate, "REQUEST_ROLE_H1", "received_request_h",
                    "received_request_h", subject=subject,
                )
                raw = {**verification_result(
                    evidence=((window.messages[0].message_id, source),),
                ), "proof": None}
                verifier = FixedSourceVerifier((raw,))
                verifier.verification_mode = "nullable-proof-v1"
                outcome = ExtractionFlow(
                    runtime=RecordingRuntime((payload,)), verification_runtime=verifier,
                ).run(window)
                self.assertIsNone(outcome.failure_kind)
                self.assertEqual(outcome.accepted, ())
                self.assertEqual(outcome.rejected_count, 1)
                self.assertEqual(raw["verdict"], "supported")

    def test_parameterized_relations_run_through_actual_producer_and_binding(self):
        cases = (
            ("我哥前天没有把他的书借给我。这里的“他”指我哥。",
             "联系人的哥哥前天没有把自己的书借给联系人", "KIN_LEND_BA_H1",
             "negative_h", "direct", {}, {"lend"}, {"polarity", "time"}),
            ("我同事让我周末帮他顶个班。这里的“他”指我同事。",
             "用户的同事已提出请托，内容是希望用户周末替该同事顶班，未说明接受",
             "REQUEST_ROLE_H1", "quoted_request_h", "quoted_request_h",
             {"subject": "self", "category": "relationship_note", "speech_act": "report",
              "assertion_status": "reported"}, {"request", "cover_shift"}, {"time"}),
            ("我同事让我周末帮他顶个班。这里的“他”指我同事。",
             "用户已收到用户的同事请托；所请内容为用户周末替该同事顶班，未说明接受",
             "REQUEST_ROLE_H1", "received_request_h", "received_request_h",
             {"subject": "self", "category": "relationship_note"},
             {"receive_request", "cover_shift"}, {"time"}),
            ("如果天晴，我计划后天只跑约7.5公里。",
             "如果天晴，联系人计划后天只跑约7500米。", "COND_PLAN_RUN_V1",
             "conditional_plan", "direct", {"speech_act": "plan", "assertion_status": "conditional"},
             {"clear_weather", "run"}, {"quantity", "degree", "condition", "time"}),
        )
        for source, candidate, rule, variant, frame, fields, predicates, qualifiers in cases:
            with self.subTest(rule=rule, variant=variant):
                window, payload, proof = _relation_fixture(
                    source, candidate, rule, variant, frame, **fields,
                )
                verifier = FixedSourceVerifier(({**verification_result(
                    evidence=((window.messages[0].message_id, source),),
                ), "proof": proof},))
                verifier.verification_mode = "nullable-proof-v1"
                outcome = ExtractionFlow(
                    runtime=RecordingRuntime((payload,)), verification_runtime=verifier,
                ).run(window)
                self.assertIsNone(outcome.failure_kind)
                self.assertEqual(outcome.rejected_count, 0)
                fact = outcome.accepted[0]
                self.assertEqual(fact.text, candidate)
                self.assertIsNone(fact.valid_at)
                self.assertIsNone(fact.invalid_at)
                self.assertTrue(fact.dimension_evidence.source_bound)
                basis = fact.dimension_evidence.semantic_basis.to_payload()
                self.assertEqual(basis["frame"], frame)
                self.assertEqual({row["predicate"] for row in basis["atoms"]}, predicates)
                self.assertEqual({row["kind"] for row in basis["qualifiers"]}, qualifiers)
                self.assertEqual(basis["unresolved"], [])
                self.assertTrue({"paraphrase", "reference", "subject", "reported", "time"}
                                <= valid_evidence_dimensions(fact))
                self.assertFalse(DimensionRelease().allows(fact))

    def test_unresolved_original_pronouns_cannot_sign_owner_or_beneficiary(self):
        for source, candidate, labels in (
            ("我姐把她的车借给我了", "联系人的姐姐把自己的车借给了联系人", {}),
            ("我同事让我周末帮他顶个班", "用户已收到用户的同事请托；所请内容为用户周末替该同事顶班，未说明接受",
             {"subject": "self", "category": "relationship_note"}),
        ):
            with self.subTest(source=source):
                window, payload, _ = _arrival_fixture()
                message = window.messages[0]
                snapshots = (dict(message.source_snapshots[0],
                                  raw_payload={"text": source},
                                  source_content_sha256=content_digest(source)),)
                window = replace(window, messages=(replace(
                    message, text=source, source_snapshots=snapshots,
                    sender=(type(message.sender).SELF if labels else message.sender),
                ),))
                payload = {**payload, "text": candidate, **labels}
                verifier = FixedSourceVerifier(({**verification_result(
                    evidence=((message.message_id, source),),
                ), "proof": None},))
                verifier.verification_mode = "nullable-proof-v1"
                outcome = ExtractionFlow(
                    runtime=RecordingRuntime((payload,)), verification_runtime=verifier,
                ).run(window)
                self.assertIsNone(outcome.failure_kind)
                self.assertEqual(outcome.rejected_count, 0)
                fact = outcome.accepted[0]
                self.assertEqual(fact.text, candidate)
                self.assertIsNone(fact.dimension_evidence.semantic_basis)
                self.assertTrue({"reference", "paraphrase", "reported"}
                                .isdisjoint(valid_evidence_dimensions(fact)))
                self.assertFalse(DimensionRelease(tuple(MemoryDimension)).allows(fact))

    def test_v2_cannot_reuse_v1_anchor_counts_as_semantic_qualification(self):
        fact = synthetic_complete_evidence(synthetic_fact(text="我喜欢咖啡"))
        evidence = fact.dimension_evidence
        proposed_v2 = replace(evidence, version=2, semantic_basis=None)
        rebound = bind_dimension_evidence(
            proposed_v2, scope=proposed_v2.scope, candidate=fact,
            messages=proposed_v2.messages,
            texts={fact.source_message_ids[0]: fact.text},
        )
        changed = replace(fact, dimension_evidence=rebound)
        self.assertTrue(rebound.source_bound)
        self.assertEqual(valid_evidence_dimensions(changed),
                         frozenset({"truth_intent", "paraphrase", "media"}))
        self.assertFalse(DimensionRelease(tuple(MemoryDimension)).allows(changed))

    def test_actual_flow_builds_nonliteral_basis_from_complete_source_and_proof(self):
        window, payload, proof = _arrival_fixture()
        message_id = window.messages[0].message_id
        verifier = FixedSourceVerifier(({**verification_result(
            evidence=((message_id, window.messages[0].text),),
        ), "proof": proof},))
        verifier.verification_mode = "nullable-proof-v1"

        outcome = ExtractionFlow(
            runtime=RecordingRuntime((payload,)), verification_runtime=verifier,
        ).run(window)

        self.assertIsNone(outcome.failure_kind)
        self.assertEqual(len(verifier.calls), 1)
        self.assertEqual(len(outcome.accepted), 1)
        fact = outcome.accepted[0]
        evidence = fact.dimension_evidence
        self.assertEqual(evidence.version, 2)
        self.assertIsNotNone(evidence.semantic_basis)
        self.assertTrue(evidence.source_bound)
        self.assertTrue({"paraphrase", "reference", "subject", "reported"}
                        <= valid_evidence_dimensions(fact))
        self.assertFalse(DimensionRelease().allows(fact))
        self.assertNotIn(window.messages[0].text, str(evidence.to_payload()))
        self.assertNotIn(fact.text, str(evidence.to_payload()))

    def test_v2_historical_null_dates_cannot_remove_temporal_dependency(self):
        window, payload, proof = _arrival_fixture()
        message_id = window.messages[0].message_id
        verifier = FixedSourceVerifier(({**verification_result(
            evidence=((message_id, window.messages[0].text),),
        ), "proof": proof},))
        verifier.verification_mode = "nullable-proof-v1"
        fact = ExtractionFlow(
            runtime=RecordingRuntime((payload,)), verification_runtime=verifier,
        ).run(window).accepted[0]

        self.assertIsNone(fact.valid_at)
        self.assertIsNone(fact.invalid_at)
        self.assertIn("time", required_dimensions(fact))
        self.assertIn("time", valid_evidence_dimensions(fact))
        self.assertFalse(DimensionRelease(tuple(
            item for item in MemoryDimension if item.value != "time"
        )).allows(fact))

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
