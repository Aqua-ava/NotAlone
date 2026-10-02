"""来源语义 guard 经公开提取与采纳端口的合成行为测试。"""

from __future__ import annotations

import unittest
from dataclasses import replace
from copy import deepcopy
from uuid import uuid4

from notalone.memory import InMemoryMemoryStore
from notalone.memory_extraction.adoption import MemoryAdoption
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.errors import ExtractionRuntimeError
from notalone.memory_extraction.models import ExtractionFailureKind
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.test_flow import RecordingRuntime, _payload
from tests.unit.memory_extraction.test_models import _window
from tests.unit.memory_extraction.verification_helpers import (
    FixedSourceVerifier,
    SyntheticSupportingVerifier,
    verification_result,
)


class SourceVerificationFlowTest(unittest.TestCase):
    """模型边界返回预置结果，记忆生命周期由实际领域端口执行。"""

    def test_unverified_negation_reversal_never_becomes_auto_memory(self) -> None:
        message_id = uuid4()
        original = _window((message_id,))
        window = replace(
            original,
            messages=(replace(original.messages[0], text="我不喝酒。"),),
        )
        outcome = ExtractionFlow(runtime=RecordingRuntime((
            _payload(message_id, text="联系人经常喝酒"),
        ))).run(window)
        store = InMemoryMemoryStore()
        scope = ContactScope(window.owner_id, window.contact_id)

        stats = MemoryAdoption(memory_port=store).adopt(scope, outcome)

        self.assertEqual(store.list_confirmed(scope), ())
        self.assertEqual(stats.pending, 1)
        pending = store.list_pending_candidates(scope)[0]
        self.assertEqual(pending.text, "联系人经常喝酒")
        self.assertIn("semantic:unverified", pending.risk_flags)

    def test_unsupported_negation_reversal_is_rejected_with_legal_source_id(self):
        message_id = uuid4()
        original = _window((message_id,))
        window = replace(
            original,
            messages=(replace(original.messages[0], text="我不喝酒。"),),
        )
        outcome = ExtractionFlow(
            runtime=RecordingRuntime((
                _payload(message_id, text="联系人经常喝酒"),
            )),
            verification_runtime=FixedSourceVerifier((verification_result(
                verdict="unsupported", issues=("negation",),
                evidence=((message_id, "不喝酒"),),
            ),)),
        ).run(window)
        store = InMemoryMemoryStore()
        scope = ContactScope(window.owner_id, window.contact_id)

        stats = MemoryAdoption(memory_port=store).adopt(scope, outcome)

        self.assertEqual(store.list_confirmed(scope), ())
        self.assertEqual(store.list_pending_candidates(scope), ())
        self.assertEqual(stats.rejected_by_contract, 1)
        self.assertTrue(outcome.extraction_completed)

    def test_uncertain_source_support_retains_original_claim_only_as_pending(self):
        message_id = uuid4()
        window = _window((message_id,))
        payload = _payload(
            message_id, text="联系人准备到杭州工作", risk_flags=["low"],
            speech_act="plan", valid_at="2026-10-01T00:00:00+00:00",
        )
        verifier = FixedSourceVerifier((verification_result(
            verdict="uncertain", issues=("subject", "time"),
        ),))
        outcome = ExtractionFlow(
            runtime=RecordingRuntime((payload,)),
            verification_runtime=verifier,
        ).run(window)
        store = InMemoryMemoryStore()
        scope = ContactScope(window.owner_id, window.contact_id)

        stats = MemoryAdoption(memory_port=store).adopt(scope, outcome)

        self.assertEqual(store.list_confirmed(scope), ())
        self.assertEqual(stats.pending, 1)
        pending = store.list_pending_candidates(scope)[0]
        self.assertEqual(pending.text, "联系人准备到杭州工作")
        self.assertEqual(pending.source_ids, (message_id,))
        self.assertEqual(pending.valid_at.isoformat(), "2026-10-01T00:00:00+00:00")
        self.assertIn("semantic:subject", pending.risk_flags)
        self.assertIn("semantic:time", pending.risk_flags)
        self.assertIn("pragmatic:plan", pending.risk_flags)
        reviewed_fact = verifier.calls[0][1][0]
        self.assertEqual(reviewed_fact.text, pending.text)
        self.assertEqual(reviewed_fact.risk_flags, ("low", "pragmatic:future_validity"))

    def test_invalid_verification_never_keeps_partial_batch_or_private_output(self):
        target, context, unused = uuid4(), uuid4(), uuid4()
        original = _window((target, context, unused))
        window = replace(
            original,
            messages=(
                replace(original.messages[0], text="我不喝酒。"),
                replace(original.messages[1], text="周末我打球。"),
                replace(original.messages[2], text="另一个话题。"),
            ),
            target_message_ids=(target,),
        )
        valid = verification_result(evidence=((target, "不喝酒"),))
        cases = {
            "missing": (),
            "duplicate": (valid, valid),
            "out_of_range": ({**valid, "candidate_index": 1},),
            "negative_index": ({**valid, "candidate_index": -1},),
            "bool_index": ({**valid, "candidate_index": True},),
            "unknown_verdict": ({**valid, "verdict": "confirmed"},),
            "unknown_issue": ({**valid, "issues": ["private unsupported issue"]},),
            "supported_with_issue": ({**valid, "issues": ["negation"]},),
            "uncertain_without_issue": ({**valid, "verdict": "uncertain"},),
            "unsupported_without_issue": ({**valid, "verdict": "unsupported"},),
            "missing_evidence": ({**valid, "evidence": []},),
            "made_up_quote": (verification_result(evidence=((target, "喝得很多"),)),),
            "empty_quote": (verification_result(evidence=((target, ""),)),),
            "outside_window": (verification_result(evidence=((uuid4(), "不喝酒"),)),),
            "outside_candidate_sources": (verification_result(evidence=((unused, "另一个"),)),),
            "context_only": (verification_result(evidence=((context, "打球"),)),),
            "candidate_rewrite": ({**valid, "text": "可识别的私人模型正文"},),
            "bad_evidence_field": ({**valid, "evidence": [{"message_id": str(target)}]},),
        }
        for label, results in cases.items():
            with self.subTest(label=label):
                outcome = ExtractionFlow(
                    runtime=RecordingRuntime((_payload(
                        target, source_message_ids=[str(target), str(context)],
                    ),)),
                    verification_runtime=FixedSourceVerifier(deepcopy(results)),
                ).run(window)
                store = InMemoryMemoryStore()
                scope = ContactScope(window.owner_id, window.contact_id)

                MemoryAdoption(memory_port=store).adopt(scope, outcome)

                self.assertEqual(outcome.accepted, ())
                self.assertEqual(outcome.failure_kind, ExtractionFailureKind.INVALID_OUTPUT)
                self.assertTrue(outcome.extraction_completed)
                self.assertEqual(store.list_confirmed(scope), ())
                self.assertEqual(store.list_pending_candidates(scope), ())
                self.assertNotIn("可识别", outcome.failure_reason)

    def test_over_budget_candidates_stop_whole_batch_without_review_or_truncation(self):
        message_id = uuid4()
        window = _window((message_id,))
        verifier = FixedSourceVerifier(())

        outcome = ExtractionFlow(
            runtime=RecordingRuntime(tuple(
                _payload(message_id, text=f"第{index}条合成候选")
                for index in range(61)
            )),
            verification_runtime=verifier,
        ).run(window)

        self.assertEqual(outcome.failure_kind, ExtractionFailureKind.INVALID_OUTPUT)
        self.assertEqual(outcome.accepted, ())
        self.assertTrue(outcome.extraction_completed)
        self.assertEqual(verifier.calls, [])

    def test_extraction_failure_does_not_report_private_provider_exception(self):
        class PrivateFailureRuntime:
            def extract(self, window):
                raise ExtractionRuntimeError("私人供应商错误中包含原始聊天正文")

        outcome = ExtractionFlow(runtime=PrivateFailureRuntime()).run(_window((uuid4(),)))

        self.assertEqual(outcome.failure_kind, ExtractionFailureKind.UNAVAILABLE)
        self.assertFalse(outcome.extraction_completed)
        self.assertNotIn("私人", outcome.failure_reason)

    def test_supported_claim_keeps_existing_pragmatic_confidence_and_risk_gates(self):
        message_id = uuid4()
        window = _window((message_id,))
        cases = (
            ({}, True),
            ({"confidence": 0.69}, False),
            ({"risk_flags": ["health"]}, False),
            ({"speech_act": "plan"}, False),
            ({"assertion_status": "hypothetical"}, False),
            ({"alternatives": ["无法判断指代主体"]}, False),
            ({"valid_at": "2026-10-01T00:00:00+00:00"}, False),
        )
        for overrides, expected_auto in cases:
            with self.subTest(overrides=overrides):
                outcome = ExtractionFlow(
                    runtime=RecordingRuntime((_payload(message_id, **overrides),)),
                    verification_runtime=SyntheticSupportingVerifier(),
                ).run(window)
                store = InMemoryMemoryStore()
                scope = ContactScope(window.owner_id, window.contact_id)

                stats = MemoryAdoption(memory_port=store).adopt(scope, outcome)

                self.assertEqual(stats.adopted, int(expected_auto))
                self.assertEqual(stats.pending, int(not expected_auto))
                self.assertEqual(len(store.list_confirmed(scope)), int(expected_auto))
                self.assertEqual(outcome.accepted[0].text, "他不爱发语音，有事爱直接打电话")
                self.assertEqual(outcome.accepted[0].source_message_ids, (message_id,))
                self.assertNotIn("semantic:unverified", outcome.accepted[0].risk_flags)

    def test_sixty_candidates_are_reviewed_once_without_truncation(self):
        message_id = uuid4()
        window = _window((message_id,))
        verifier = FixedSourceVerifier(tuple(verification_result(
            candidate_index=index, evidence=((message_id, "合成消息"),),
        ) for index in range(60)))
        outcome = ExtractionFlow(
            runtime=RecordingRuntime(tuple(
                _payload(message_id, text=f"第{index}条合成候选") for index in range(60)
            )),
            verification_runtime=verifier,
        ).run(window)

        self.assertIsNone(outcome.failure_reason)
        self.assertEqual(len(outcome.accepted), 60)
        self.assertEqual(outcome.accepted[-1].text, "第59条合成候选")
        self.assertEqual(len(verifier.calls), 1)

    def test_only_reviewable_candidates_use_indices_and_out_of_order_results_map_correctly(self):
        message_id = uuid4()
        window = _window((message_id,))
        verifier = FixedSourceVerifier((
            verification_result(candidate_index=1, verdict="uncertain", issues=("meaning",)),
            verification_result(candidate_index=0, evidence=((message_id, "合成消息"),)),
        ))
        outcome = ExtractionFlow(
            runtime=RecordingRuntime((
                _payload(uuid4(), text="非法来源候选"),
                _payload(message_id, text="纯玩笑", figurative_type="joke"),
                _payload(message_id, text="已标注支持的合成主张"),
                _payload(message_id, text="已标注不确定的合成主张"),
            )),
            verification_runtime=verifier,
        ).run(window)
        store = InMemoryMemoryStore()
        scope = ContactScope(window.owner_id, window.contact_id)

        stats = MemoryAdoption(memory_port=store).adopt(scope, outcome)

        self.assertEqual(stats.rejected_by_contract, 1)
        self.assertEqual(stats.skipped_non_memory, 1)
        self.assertEqual([memory.text for memory in store.list_confirmed(scope)], ["已标注支持的合成主张"])
        pending = store.list_pending_candidates(scope)
        self.assertEqual([candidate.text for candidate in pending], ["已标注不确定的合成主张"])
        self.assertIn("semantic:meaning", pending[0].risk_flags)
        self.assertEqual([fact.text for fact in verifier.calls[0][1]], [
            "已标注支持的合成主张", "已标注不确定的合成主张",
        ])

    def test_pure_non_memory_skips_source_verification(self):
        message_id = uuid4()
        window = _window((message_id,))
        verifier = FixedSourceVerifier(())
        outcome = ExtractionFlow(
            runtime=RecordingRuntime((_payload(message_id, speech_act="question"),)),
            verification_runtime=verifier,
        ).run(window)
        store = InMemoryMemoryStore()
        scope = ContactScope(window.owner_id, window.contact_id)

        stats = MemoryAdoption(memory_port=store).adopt(scope, outcome)

        self.assertEqual(stats.skipped_non_memory, 1)
        self.assertEqual(verifier.calls, [])
        self.assertTrue(outcome.extraction_completed)
        self.assertEqual(store.list_pending_candidates(scope), ())

    def test_verification_failure_preserves_extraction_stage_and_writes_nothing(self):
        class UnavailableVerifier:
            def verify(self, *, window, facts):
                raise ExtractionRuntimeError("供应商可能回显私人正文")

        message_id = uuid4()
        window = _window((message_id,))
        outcome = ExtractionFlow(
            runtime=RecordingRuntime((_payload(message_id),)),
            verification_runtime=UnavailableVerifier(),
        ).run(window)
        store = InMemoryMemoryStore()
        scope = ContactScope(window.owner_id, window.contact_id)

        MemoryAdoption(memory_port=store).adopt(scope, outcome)

        self.assertEqual(outcome.failure_kind, ExtractionFailureKind.UNAVAILABLE)
        self.assertTrue(outcome.extraction_completed)
        self.assertEqual(outcome.accepted, ())
        self.assertNotIn("私人", outcome.failure_reason)
        self.assertEqual(store.list_confirmed(scope), ())
        self.assertEqual(store.list_pending_candidates(scope), ())


if __name__ == "__main__":
    unittest.main()
