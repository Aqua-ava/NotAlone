"""合并批量性能路径与时间语义：合成证据仅验证调度和确定性门。"""
from dataclasses import replace
from datetime import datetime, timezone
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4
from notalone.memory import AdoptionMethod, InMemoryMemoryStore
from notalone.memory.conditions import MemoryCondition, MemoryConditions
from notalone.memory.evidence_binding import content_digest, source_state_digest
from notalone.memory.events import EventEvidence
from notalone.memory.models import MemoryCategory, MemoryTopic
from notalone.memory_extraction.adjudication import AdjudicationAction, AdjudicationDecision
from notalone.memory_extraction.adoption import MemoryAdoption, _candidate_from_fact
from notalone.memory_extraction.dimensions import DimensionRelease
from notalone.memory_extraction.flow import ExtractionOutcome
from notalone.memory_extraction.models import AssertionStatus, ExtractedFact, FactSubject, FigurativeType, MessageRef, MessageSender, SpeechAct
from notalone.scopes import ContactScope


class FrozenSourceStore(InMemoryMemoryStore):
    """冻结合成来源，不连接数据库或认证模型关系质量。"""
    def __init__(self, messages):
        super().__init__()
        self.messages = {item.message_id: item for item in messages}
        self.freeze = True

    def capture_adjudication_sources(self, scope, identifiers):
        if not self.freeze:
            return None
        selected = {str(identifier): self.messages[identifier] for identifier in identifiers}
        return {"message_ids": list(selected),
            "message_digests": {key: content_digest(message.text) for key, message in selected.items()},
            "message_snapshots": {key: {
                "source_state_sha256": source_state_digest(message.source_snapshots),
                "occurred_at": message.occurred_at.isoformat(),
            } for key, message in selected.items()}}


class EvidenceBatchRuntime:
    supports_evidence = True
    def __init__(self, decision):
        self.decision, self.calls = decision, []

    def adjudicate_batch(self, *, candidates):
        self.calls.append(candidates)
        return tuple(self.decision for _ in candidates)

    def adjudicate(self, **kwargs):
        raise AssertionError("批量缓存不得触发逐项模型重发。")


class MergeBatchTimelineTest(TestCase):
    def setUp(self):
        self.scope = ContactScope(uuid4(), uuid4())
        self.old_source, self.new_source = uuid4(), uuid4()
        self.old_fact = self.fact(self.old_source, "联系人此前偏好文字沟通。")
        self.new_fact = self.fact(self.new_source, "联系人现在改为偏好电话沟通。")
        self.messages = tuple(MessageRef(identifier, text, MessageSender.CONTACT,
            datetime(2026, 1, day, tzinfo=timezone.utc),
            ({"source_ref_id": str(uuid4()), "source_id": str(uuid4()),
              "source_kind": "source_document", "source_content_sha256": "a" * 64,
              "locator": "synthetic:1", "raw_payload": {}},))
            for identifier, text, day in ((self.old_source, self.old_fact.text, 1),
                                          (self.new_source, self.new_fact.text, 2)))
        self.store = FrozenSourceStore(self.messages)
        candidate = self.store.create_candidate(_candidate_from_fact(self.scope, self.old_fact))
        self.previous = self.store.confirm(scope=self.scope, candidate_id=candidate.candidate_id,
                                           adoption_method=AdoptionMethod.AUTO)
        # 显式合成策略隔离正文来源质量门，测试真实批量关系与时间门。
        self.policy = DimensionRelease(gate_enabled=False, verified_sources=True)

    @staticmethod
    def fact(source, text):
        return ExtractedFact(text=text, category=MemoryCategory.PREFERENCE,
            subject=FactSubject.CONTACT, topic=MemoryTopic.OTHER,
            source_message_ids=(source,), confidence=.95, risk_flags=(),
            valid_at=None, invalid_at=None, speech_act=SpeechAct.ASSERTION,
            assertion_status=AssertionStatus.ASSERTED, figurative_type=FigurativeType.LITERAL)

    def decision(self, *, kind="state_change", supported=True, action=AdjudicationAction.UPDATE,
                 claim_changed=True, condition_changed=False):
        return AdjudicationDecision(action,
            replaced_memory_id=self.previous.memory_id if action is AdjudicationAction.UPDATE else None,
            relation={"kind": kind, "explanation": "合成原话支持的新旧变化提案。",
                "related_memory_ids": [str(self.previous.memory_id)],
                "evidence": [{"message_id": str(message.message_id), "quote": message.text}
                             for message in self.messages],
                "claim_changed": claim_changed, "condition_changed": condition_changed},
            relation_supported=supported)

    def run_batch(self, decision, *, fact=None, runtime=None):
        runtime = runtime or EvidenceBatchRuntime(decision)
        adoption = MemoryAdoption(memory_port=self.store, adjudication_runtime=runtime,
            dimension_release=self.policy, automatic=True, source_messages=self.messages)
        with patch("notalone.memory_extraction.recall.hybrid_candidates",
                   side_effect=lambda texts, pool: [list(pool) for _ in texts]):
            result = adoption.adopt(self.scope, ExtractionOutcome((fact or self.new_fact,)))
        if isinstance(runtime, EvidenceBatchRuntime):
            self.assertEqual(len(runtime.calls), 1)
        return result, runtime

    def assert_pending(self, decision, *, fact=None, reason="timeline:relation_unknown"):
        result, runtime = self.run_batch(decision, fact=fact)
        self.assertEqual((result.adopted, result.updated, result.pending), (0, 0, 1))
        candidate, = self.store.list_pending_candidates(self.scope)
        self.assertEqual(candidate.failure_reason, reason)
        self.assertEqual(self.store.list_confirmed(self.scope), (self.previous,))
        return candidate, runtime

    def test_cached_add_without_relation_is_unknown_pending(self):
        self.assert_pending(AdjudicationDecision(AdjudicationAction.ADD))

    def test_cached_unverified_relation_cannot_replace(self):
        self.assert_pending(self.decision(supported=False))

    def test_cached_supported_relation_without_frozen_sources_is_unknown(self):
        self.store.freeze = False
        candidate, _ = self.assert_pending(self.decision())
        self.assertIsNone(candidate.evolution)

    def test_cached_condition_change_must_be_independently_supported(self):
        conditions = MemoryConditions((MemoryCondition("结束出差之后",
            (EventEvidence(self.new_source, 0, len(self.new_fact.text)),), True),))
        candidate, runtime = self.assert_pending(self.decision(), fact=replace(self.new_fact, conditions=conditions))
        self.assertEqual(candidate.conditions, conditions)
        projected, _ = runtime.calls[0][0]
        self.assertEqual(projected["conditions"], conditions.to_payload())
        self.assertFalse(candidate.evolution.source_supported)

    def test_cached_older_statement_cannot_replace_later_memory(self):
        newer_old = replace(self.messages[0], occurred_at=datetime(2026, 1, 3, tzinfo=timezone.utc))
        self.messages = (newer_old, self.messages[1])
        self.store.messages[newer_old.message_id] = newer_old
        self.assert_pending(self.decision())

    def test_cached_unresolved_conflict_remains_visible_pending(self):
        candidate, _ = self.assert_pending(self.decision(kind="unresolved_conflict"),
                                          reason="timeline:unresolved_conflict")
        self.assertEqual(candidate.evolution.kind, "unresolved_conflict")

    def test_cached_supported_new_statement_can_update_and_preserve_evolution(self):
        result, _ = self.run_batch(self.decision())
        self.assertEqual((result.adopted, result.updated, result.pending), (0, 1, 0))
        current, = self.store.list_confirmed(self.scope)
        self.assertEqual(current.supersedes_memory_id, self.previous.memory_id)
        self.assertEqual(current.evolution.kind, "state_change")
        self.assertTrue(current.evolution.source_supported)
        self.assertIsNotNone(current.evolution.proof)

    def test_empty_pool_invalid_batch_result_does_not_silently_add(self):
        self.store = FrozenSourceStore(self.messages)
        result, _ = self.run_batch(None)
        self.assertEqual((result.adopted, result.updated), (0, 0))
        self.assertEqual(self.store.list_confirmed(self.scope), ())

    def test_bulk_read_preserves_management_flags_and_scope(self):
        self.store.invalidate(scope=self.scope, memory_id=self.previous.memory_id)
        self.assertEqual(self.store.list_confirmed(self.scope), ())
        selected = self.store.list_confirmed(self.scope, include_invalidated=True,
            include_expired=True, memory_ids=(self.previous.memory_id,))
        self.assertEqual(tuple(item.memory_id for item in selected), (self.previous.memory_id,))
        self.assertEqual(self.store.list_confirmed(ContactScope(uuid4(), self.scope.contact_id),
            include_invalidated=True, include_expired=True), ())
        with self.assertRaises(ValueError):
            self.store.list_confirmed(self.scope, include_historical=True)

    def test_real_batch_adapter_independent_verdict_controls_cached_updates(self):
        from langchain_core.messages import AIMessage
        from notalone.memory_extraction.adjudication_adapters import LangChainAdjudicationRuntime
        from tests.unit.reply.test_langchain_vertical_slice import ToolCallingFakeModel
        for verdict in ("unknown", "unsupported", "supported"):
            with self.subTest(verdict=verdict):
                self.setUp()
                relation = self.decision().relation
                model = ToolCallingFakeModel(responses=[
                    AIMessage(content="", tool_calls=[{"name": "BatchMemoryAdjudicationOutput",
                        "id": "synthetic-batch", "args": {"decisions": [{
                            "candidate_index": 0, "action": "update",
                            "replaced_memory_id": str(self.previous.memory_id),
                            "merged_memory_ids": [], "merged_text": None,
                            "duplicate_memory_id": None, "relation": relation}]}}]),
                    AIMessage(content="", tool_calls=[{"name": "MemoryRelationVerificationOutput",
                        "id": "synthetic-independent", "args": {"results": [{
                            "candidate_index": 0, "verdict": verdict,
                            "same_subject_and_matter": True, "claim_changed": True,
                            "condition_changed": False, "evidence": relation["evidence"]}]}}]),
                ])
                result, _ = self.run_batch(None, runtime=LangChainAdjudicationRuntime(model=model))
                self.assertEqual(len(model.seen_calls), 2)
                if verdict == "supported":
                    self.assertEqual((result.updated, result.pending), (1, 0))
                else:
                    self.assertEqual((result.updated, result.pending), (0, 1))
                    self.assertEqual(self.store.list_confirmed(self.scope), (self.previous,))
