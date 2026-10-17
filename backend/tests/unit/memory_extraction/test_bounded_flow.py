"""有限任务实际E2输出经过Flow的依赖合同；不代签正式导入或模型质量。"""

from dataclasses import replace
import unittest
from uuid import uuid4

from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory.adapters import InMemoryMemoryStore
from notalone.memory.evidence_binding import candidate_digest
from notalone.memory_extraction.adoption import MemoryAdoption
from notalone.memory_extraction.grounded import compile_labels, source_units
from notalone.memory_extraction.models import ExtractionFailureKind
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.test_flow import RecordingRuntime
from tests.unit.memory_extraction.test_source_proof import window_for as _legacy_window


def window_for(text):
    window = _legacy_window(text)
    return replace(window, target_message_ids=(window.messages[0].message_id,))


class _NullableVerifier:
    verification_mode = "nullable-proof-v3"

    def __init__(self, proof=None):
        self.proof = proof
        self.calls = []

    def verify(self, *, window, facts):
        self.calls.append(facts)
        return tuple({
            "candidate_index": index, "verdict": "supported", "issues": [],
            "evidence": [{"message_id": str(fact.source_message_ids[0]),
                          "quote": next(item.text for item in window.messages
                                        if item.message_id == fact.source_message_ids[0])}],
            "proof": self.proof,
        } for index, fact in enumerate(facts))


def _compiled(window):
    return compile_labels(window, {"units": {
        unit.id: {"kind": "event", "subject": "contact", "topic": "other",
                  "dependency": None, "unresolved": False,
                  "confidence": .92, "sensitivity": "none"}
        for unit in source_units(window) if unit.target
    }})


class BoundedFlowTest(unittest.TestCase):
    def test_pending_pragmatic_flags_are_normalized_before_signing_candidate_digest(self):
        cases = (
            ("如果天晴，我计划明天只跑约3公里。", ("condition", "plan"), None,
             {"pragmatic:plan", "pragmatic:conditional"}),
            ("我姐昨天让我明天帮她顶个班。这里的“她”指我同事。", ("reported_event", "not_memory"), "0:1",
             {"pragmatic:report", "pragmatic:reported"}),
        )
        for text, kinds, dependency, flags in cases:
            with self.subTest(text=text):
                window = window_for(text)
                payloads = compile_labels(window, {"units": {
                    unit.id: {"kind": kinds[index], "subject": "contact", "topic": "other",
                              "dependency": dependency if index == 0 else None,
                              "unresolved": False, "confidence": .92, "sensitivity": "none"}
                    for index, unit in enumerate(source_units(window))
                }})
                outcome = ExtractionFlow(
                    runtime=RecordingRuntime(payloads), verification_runtime=_NullableVerifier(),
                ).run(window)
                self.assertIsNone(outcome.failure_reason)
                fact, = outcome.accepted
                store = InMemoryMemoryStore()
                scope = ContactScope(window.owner_id, window.contact_id)
                stats = MemoryAdoption(memory_port=store).adopt(scope, outcome)
                self.assertEqual(stats.pending, 1)
                candidate, = store.list_pending_candidates(scope)
                self.assertTrue(flags <= set(candidate.risk_flags))
                self.assertEqual(candidate.risk_flags, fact.risk_flags)
                self.assertEqual(candidate_digest(candidate, version=4), candidate.dimension_evidence.candidate_sha256)

    def test_explicit_mode_sets_persistent_all_even_when_proof_is_null(self):
        window = window_for("我刚到家。")
        verifier = _NullableVerifier()
        outcome = ExtractionFlow(
            runtime=RecordingRuntime(_compiled(window)), verification_runtime=verifier,
        ).run(window)
        self.assertIsNone(outcome.failure_reason)
        self.assertEqual(len(outcome.accepted), 1)
        fact, = outcome.accepted
        self.assertEqual(fact.source_dependency_mode.value, "all")
        self.assertEqual(fact.dimension_evidence.version, 4)
        self.assertIsNone(fact.dimension_evidence.semantic_basis)
        self.assertEqual(len(verifier.calls), 1)
        self.assertEqual(verifier.calls[0][0].source_dependency_mode.value, "all")

    def test_first_oversized_window_keeps_body_and_all_without_old_snapshot(self):
        base = window_for("我刚到家。")
        messages = (base.messages[0],) + tuple(
            replace(base.messages[0], message_id=uuid4(), text=f"合成背景{index}。")
            for index in range(4)
        )
        window = replace(base, messages=messages, target_message_ids=(messages[0].message_id,))
        payload, = _compiled(window)
        verifier = _NullableVerifier()
        outcome = ExtractionFlow(runtime=RecordingRuntime((payload,)), verification_runtime=verifier).run(window)
        self.assertIsNone(outcome.failure_reason)
        fact, = outcome.accepted
        self.assertEqual(fact.text, payload["text"])
        self.assertEqual(fact.source_message_ids, (messages[0].message_id,))
        self.assertEqual(fact.source_dependency_mode.value, "all")
        self.assertIsNone(fact.dimension_evidence)
        self.assertEqual(len(verifier.calls), 1)
        self.assertEqual(len(window.messages), 5)

    def test_invalid_proposal_is_not_swallowed_by_oversized_unknown_branch(self):
        base = window_for("我刚到家。")
        messages = (base.messages[0],) + tuple(
            replace(base.messages[0], message_id=uuid4(), text=f"合成背景{index}。")
            for index in range(4)
        )
        window = replace(base, messages=messages, target_message_ids=(messages[0].message_id,))
        verifier = _NullableVerifier({"version": True, "atom_links": None, "reference": None, "reported": None})
        outcome = ExtractionFlow(runtime=RecordingRuntime(_compiled(window)), verification_runtime=verifier).run(window)
        self.assertEqual(outcome.failure_kind, ExtractionFailureKind.INVALID_OUTPUT)
        self.assertEqual(outcome.accepted, ())
        self.assertEqual(len(verifier.calls), 1)

    def test_wrong_wrapper_or_free_interpretation_is_rejected_before_v(self):
        window = window_for("我刚到家。")
        payload, = _compiled(window)
        for change in (
            {"text": payload["text"].replace("联系人", "用户")},
            {"interpretation_reason": "根据另一个未列来源的聊天推测。"},
            {"alternatives": ["未列来源的额外事实。"]},
        ):
            with self.subTest(change=change):
                verifier = _NullableVerifier()
                outcome = ExtractionFlow(runtime=RecordingRuntime(({**payload, **change},)), verification_runtime=verifier).run(window)
                self.assertEqual(outcome.accepted, ())
                self.assertEqual(outcome.rejected_count, 1)
                self.assertIsNone(outcome.failure_reason)
                self.assertEqual(verifier.calls, [])

    def test_no_reviewable_candidate_still_uses_explicit_v4_producer_contract(self):
        window = window_for("我刚到家。")
        payload, = _compiled(window)
        verifier = _NullableVerifier()
        outcome = ExtractionFlow(
            runtime=RecordingRuntime(({**payload, "speech_act": "question"},)),
            verification_runtime=verifier,
        ).run(window)
        self.assertIsNone(outcome.failure_reason)
        fact, = outcome.accepted
        self.assertEqual(fact.source_dependency_mode.value, "all")
        self.assertEqual(fact.dimension_evidence.version, 4)
        self.assertIsNone(fact.dimension_evidence.semantic_basis)
        self.assertEqual(verifier.calls, [])


if __name__ == "__main__":
    unittest.main()
