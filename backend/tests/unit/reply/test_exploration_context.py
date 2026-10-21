"""探索保留最小材料及实际删除依赖，重读不重新扩大模型窗口。"""

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from unittest import TestCase
from uuid import uuid4

from notalone.reply.exploration import ExplorationInput, ExplorationStale
from notalone.reply.exploration_context import ExplorationEvidence
from notalone.retrieval import InMemoryRetrieval, RetrievedMemory, RetrievedMessage
from notalone.scopes import ContactScope


class SyntheticRetrieval(InMemoryRetrieval):
    memories: tuple[RetrievedMemory, ...] = ()

    def search_confirmed_memories(self, *, memory_ids=None, **kwargs):
        return tuple(item for item in self.memories if memory_ids is None or item.memory_id in memory_ids)


class ExplorationEvidenceTest(TestCase):
    def test_message_author_survives_capture_restore_and_generation_dependencies(self):
        captured = self.evidence.capture(self.scope, self.content)
        self.assertTrue(all(item.model_payload.get('speaker_role') == 'contact' for item in captured))
        restored = self.evidence.restore(self.scope, [item.storage_payload for item in captured])
        dependencies = self.evidence.generation_dependencies(self.scope, restored)
        self.assertTrue(all(item.speaker_role == 'contact' for item in dependencies))

    def setUp(self) -> None:
        self.scope = ContactScope(uuid4(), uuid4())
        self.source_id = uuid4()
        now = datetime.now(timezone.utc)
        self.messages = tuple(RetrievedMessage(
            uuid4(), self.scope, f"合成第{index}条" + "文" * 2000,
            (self.source_id,), occurred_at=now + timedelta(seconds=index), role="contact",
        ) for index in range(10))
        self.retrieval = SyntheticRetrieval(messages=self.messages)
        self.evidence = ExplorationEvidence(self.retrieval)
        self.content = ExplorationInput(scene="reply_to_message", target_message_id=self.messages[4].message_id)

    def test_target_uses_two_neighbors_per_side_and_bounded_text(self) -> None:
        captured = self.evidence.capture(self.scope, self.content)
        self.assertEqual({item.evidence_id for item in captured}, {item.message_id for item in self.messages[2:7]})
        self.assertTrue(all(len(item.model_payload["text"]) == 1500 for item in captured))
        self.assertNotIn(self.messages[9].message_id, {item.evidence_id for item in captured})
        self.assertEqual(self.evidence.dependencies(captured),
                         {self.source_id, *(item.message_id for item in self.messages[2:7])})

    def test_proactive_purpose_with_no_history_does_not_create_a_target(self) -> None:
        self.retrieval.messages = ()
        content = ExplorationInput(scene="initiate_conversation", purpose_hint="想聊聊近况")
        self.assertEqual(self.evidence.capture(self.scope, content), ())

    def test_actual_source_body_role_and_time_changes_invalidate_snapshot(self) -> None:
        captured = self.evidence.capture(self.scope, self.content)
        original = self.messages[4]
        for change in ({"source_ids": (uuid4(),)}, {"text": original.text + "尾部改动"},
                       {"role": "owner"}, {"occurred_at": original.occurred_at + timedelta(seconds=1)}):
            with self.subTest(change=tuple(change)):
                self.retrieval.messages = tuple(replace(item, **change) if item.message_id == original.message_id else item
                                                for item in self.messages)
                with self.assertRaises(ExplorationStale):
                    self.evidence.validate(self.scope, captured)

    def test_foreign_material_is_rejected_even_if_adapter_leaks_it(self) -> None:
        foreign = replace(self.messages[5], scope=ContactScope(uuid4(), uuid4()))
        self.retrieval.query_messages = lambda **kwargs: (self.messages[4], foreign)
        with self.assertRaises(ExplorationStale):
            self.evidence.capture(self.scope, self.content)

    def test_manual_contact_fact_has_memory_dependency_without_identity_sentinel(self) -> None:
        memory = RetrievedMemory(uuid4(), self.scope, "合成手工关系资料", "preference",
                                 (self.scope.contact_id,), "manual", 2)
        self.retrieval.memories = (memory,)
        captured = self.evidence.capture(self.scope, self.content)
        dependencies = self.evidence.dependencies(captured)
        self.assertIn(memory.memory_id, dependencies)
        self.assertNotIn(self.scope.contact_id, dependencies)

    def test_saved_snapshot_keeps_old_dependencies_without_model_context_expansion(self) -> None:
        captured = self.evidence.capture(self.scope, self.content)
        restored = self.evidence.restore(self.scope, [item.storage_payload for item in captured])
        self.retrieval.messages += (replace(self.messages[9], message_id=uuid4(), text="合成新消息"),)
        self.evidence.validate(self.scope, restored)
        dependencies = self.evidence.generation_dependencies(self.scope, restored)
        self.assertEqual({item.evidence_id for item in dependencies}, {item.evidence_id for item in captured})
        self.assertTrue(all(not item.model_visible for item in dependencies))

    def test_foreign_snapshot_cannot_be_validated_or_reclassified_by_a_leaking_adapter(self) -> None:
        self.retrieval.memories = (RetrievedMemory(uuid4(), self.scope, "合成范围A资料", "preference",
                                                  (self.source_id,), "manual", 1),)
        captured = self.evidence.capture(self.scope, self.content)[-1:]
        other_scope = ContactScope(uuid4(), uuid4())
        for action in (self.evidence.validate, self.evidence.generation_dependencies):
            with self.subTest(action=action.__name__):
                with self.assertRaises(ExplorationStale):
                    action(other_scope, captured)
