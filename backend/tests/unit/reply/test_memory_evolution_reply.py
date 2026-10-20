"""变化关系贯穿公开准备、模型输入与探索恢复边界。"""
import json
import unittest
from dataclasses import replace
from uuid import uuid4

from notalone.memory.evolution import MemoryEvolution
from notalone.reply.prepared_context_codec import decode_context, encode_context
from tests.unit.reply.test_input_budget_runtime import prepared_context


class MemoryEvolutionReplyTest(unittest.TestCase):
    def test_prepared_context_roundtrip_preserves_conflict_without_private_proof(self):
        original = prepared_context()
        evolution = MemoryEvolution("unresolved_conflict", "后续来源存在矛盾，现状仍未知。",
            ((uuid4(), 2),), (uuid4(),), source_supported=True, condition_changed=True,
            proof={"private": "内部复验信息"})
        original = replace(original, evidence=(replace(original.evidence[0], evolution=evolution),))
        payload = encode_context(original)
        self.assertNotIn("内部复验信息", json.dumps(payload, ensure_ascii=False))
        restored = decode_context(payload, original.command)
        self.assertEqual(restored.evidence[0].evolution.to_payload(), evolution.to_payload())
        self.assertIsNone(restored.evidence[0].evolution.proof)

    def test_formal_runtime_keeps_evolution_in_model_input_without_parent_body(self):
        from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
        from tests.unit.reply.test_input_budget_runtime import ControlledBudgetModel, ConfiguredRuntimeCounter, make_profile, EmptySkillPort, SCOPE, reply_output
        original = prepared_context()
        evolution = MemoryEvolution("historical_supplement", "晚导入的旧资料只补充历史。",
            ((uuid4(), 2),), (uuid4(),), source_supported=True)
        original = replace(original, evidence=(replace(original.evidence[0], evolution=evolution),))
        model = ControlledBudgetModel(responses=[reply_output()])
        runtime = LangChainReplyRuntime(model=model, skill_port=EmptySkillPort(SCOPE, 0),
            input_budget_profile=make_profile(), input_token_counter=ConfiguredRuntimeCounter(model))
        runtime.generate(original)
        payload = json.loads(model.seen_calls[0]["messages"][1]["content"])
        self.assertEqual(payload["evidence"][0]["evolution"], evolution.to_payload(current=True))
        self.assertEqual(set(payload["evidence"][0]["evolution"]["related_versions"][0]), {"memory_id", "revision"})

    def test_retrieval_context_preserves_and_revalidates_changed_evolution(self):
        from notalone.reply.context import RetrievalReplyContext, ReplyContextInvariantError
        from notalone.reply.interface import RewriteDraft
        from notalone.retrieval import RetrievedMemory, RetrievedOwnerMemory
        from notalone.scopes import VerifiedConversationScope
        from tests.unit.reply.test_context_retrieval import RecordingRetrieval
        original = prepared_context()
        scope = original.scope
        evolution = MemoryEvolution("unresolved_conflict", "后来来源与原状态矛盾，尚未确认。", ((uuid4(), 1),), (uuid4(),), source_supported=True)
        retrieval = RecordingRetrieval(memories=(RetrievedMemory(uuid4(), scope, "合成通话偏好", "preference", (uuid4(),), "auto", 1, evolution=evolution),),
            owner_memories=(RetrievedOwnerMemory(uuid4(), scope.owner_id, "合成通话偏好", "preference", "other", (uuid4(),), "auto", 1, evolution=evolution),))
        context = RetrievalReplyContext(retrieval=retrieval, skill_library_revision=0)
        command = replace(original.command, content=RewriteDraft(draft_text="合成通话偏好", include_relationship_context=True))
        result = context.build(command=command, verified_scope=VerifiedConversationScope(scope.owner_id, scope.contact_id, command.conversation_binding_id))
        memories = [item for item in result.evidence if item.kind in ("confirmed_memory", "owner_memory")]
        self.assertEqual(len(memories), 2)
        for memory in memories:
            self.assertEqual(memory.evolution.to_payload(), evolution.to_payload())
        context.validate_current(result)
        retrieval.memories = (replace(retrieval.memories[0], evolution=replace(evolution, explanation="新来源已改变矛盾说明。")),)
        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(result)

    def test_exploration_restores_evolution_and_tracks_counterevidence_without_using_parent_fact(self):
        from notalone.reply.exploration import ExplorationInput, ExplorationStale
        from notalone.reply.exploration_context import ExplorationEvidence
        from notalone.retrieval import RetrievedMemory
        from tests.unit.reply.test_exploration_context import SyntheticRetrieval
        scope = prepared_context().scope
        parent, counterevidence, source = uuid4(), uuid4(), uuid4()
        evolution = MemoryEvolution("unresolved_conflict", "后续来源存在矛盾。", ((parent, 2),), (counterevidence,), source_supported=True)
        retrieval = SyntheticRetrieval()
        retrieval.memories = (RetrievedMemory(uuid4(), scope, "合成通话偏好", "preference", (source,), "auto", 1, evolution=evolution),)
        evidence = ExplorationEvidence(retrieval)
        snapshots = evidence.capture(scope, ExplorationInput(scene="initiate_conversation", purpose_hint="合成通话偏好"))
        self.assertEqual(snapshots[0].model_payload["evolution"], evolution.to_payload(current=True))
        self.assertTrue({counterevidence, source} <= evidence.dependencies(snapshots))
        self.assertNotIn(parent, evidence.dependencies(snapshots))
        self.assertEqual(snapshots[0].storage_payload["evolution"]["related_versions"], [{"memory_id": str(parent), "revision": 2}])
        restored = evidence.restore(scope, [item.storage_payload for item in snapshots])
        self.assertEqual(restored[0].evolution.to_payload(), evolution.to_payload())
        self.assertEqual(evidence.generation_dependencies(scope, restored)[0].evolution.to_payload(), evolution.to_payload())
        legacy = snapshots[0].storage_payload
        legacy.pop("evolution")
        self.assertIsNone(evidence.restore(scope, [legacy])[0].evolution)
        retrieval.memories = (replace(retrieval.memories[0], evolution=None),)
        with self.assertRaises(ExplorationStale):
            evidence.validate(scope, restored)
