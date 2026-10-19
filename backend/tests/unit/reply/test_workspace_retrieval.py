"""工作区想法与聊天分别召回，实际依据仍共用原有预算和来源复验。"""

from dataclasses import replace
import unittest
from uuid import uuid4

from notalone.memory import (AdoptionMethod, ConfirmedMemoryStatus, InMemoryMemoryStore,
                             MemoryCandidate, MemoryCategory, MemoryTopic, OwnerMemory)
from notalone.memory.overview import OverviewEntry, OverviewMemoryIdentity
from notalone.reply.context import RetrievalReplyContext
from notalone.reply.interface import GenerateReply, RewriteDraft
from notalone.retrieval import InMemoryRetrieval, RetrievedMessage, RetrievedOwnerMemory
from tests.unit.reply.test_overview_navigation import BINDING, OWNER, SOURCE, SCOPE, VERIFIED, OverviewFixture


class WorkspaceRetrievalTest(unittest.TestCase):
    def test_idea_and_chat_recall_independently_without_diluting_manual_or_pending_material(self):
        store = InMemoryMemoryStore()
        memories = []
        for text in ('对方明确偏好慢慢散步。', '近期合成课程考试还没有确定。', '喜欢烹饪烘焙。'):
            candidate = store.create_candidate(MemoryCandidate(uuid4(), SCOPE, text, MemoryCategory.PREFERENCE, (SOURCE,)))
            memories.append(store.confirm(scope=SCOPE, candidate_id=candidate.candidate_id,
                                          adoption_method=AdoptionMethod.MANUAL))
        pending = store.create_candidate(MemoryCandidate(uuid4(), SCOPE,
            '未确认参考：对方或许愿意一起散步。', MemoryCategory.PREFERENCE, (SOURCE,),
            interpretation_reason='合成待确认依据。'))
        owner = OwnerMemory(uuid4(), OWNER, '本人明确喜欢散步。', MemoryCategory.PREFERENCE,
                            MemoryTopic.OTHER, (SOURCE,), AdoptionMethod.MANUAL, ConfirmedMemoryStatus.ACTIVE)
        overview = OverviewFixture(tuple(OverviewEntry(memory,
            OverviewMemoryIdentity(memory.memory_id, memory.revision), 'manual_entry', ()) for memory in memories))
        overview.owner = replace(overview.owner, entries=(OverviewEntry(owner,
            OverviewMemoryIdentity(owner.memory_id, owner.revision), 'manual_entry', ()),))
        message = RetrievedMessage(uuid4(), SCOPE, '近期合成课程考试还没有确定，复习计划需要调整。', source_ids=(SOURCE,))
        retrieval = InMemoryRetrieval(memory_store=store, messages=(message,), owner_memories=(RetrievedOwnerMemory(
            owner.memory_id, OWNER, owner.text, owner.category.value, owner.topic.value, owner.source_ids,
            owner.adoption_method.value, owner.revision),))
        for navigation in (overview, None):
            with self.subTest(overview=navigation is not None):
                context = RetrievalReplyContext(retrieval=retrieval, skill_library_revision=0, overview=navigation).build(
                    command=GenerateReply(uuid4(), SCOPE, BINDING, RewriteDraft('想聊散步，先问安排。',
                        input_kind='workspace', workspace_action='express', include_relationship_context=True)),
                    verified_scope=VERIFIED)
                actual = {item.evidence_id for item in context.evidence}
                self.assertIn(memories[0].memory_id, actual)
                self.assertIn(memories[1].memory_id, actual)
                self.assertIn(owner.memory_id, actual)
                self.assertIn(pending.candidate_id, actual)
                self.assertNotIn(memories[2].memory_id, actual)
                if navigation:
                    self.assertEqual(context.retrieval.contact_memory.used_count, 2)
                    self.assertEqual(context.retrieval.owner_memory.used_count, 1)
                    self.assertEqual(context.retrieval.pending_candidate.used_count, 1)
                self.assertEqual(len(actual), len(context.evidence))

    def test_empty_suggest_uses_chat_and_exclusions_still_disable_derived_recall(self):
        store = InMemoryMemoryStore()
        candidate = store.create_candidate(MemoryCandidate(uuid4(), SCOPE,
            '喜欢散步', MemoryCategory.PREFERENCE, (SOURCE,)))
        memory = store.confirm(scope=SCOPE, candidate_id=candidate.candidate_id, adoption_method=AdoptionMethod.MANUAL)
        message = RetrievedMessage(uuid4(), SCOPE, '散步', source_ids=(SOURCE,))
        overview = OverviewFixture((OverviewEntry(memory,
            OverviewMemoryIdentity(memory.memory_id, memory.revision), 'manual_entry', ()),))
        retrieval = InMemoryRetrieval(memory_store=store, messages=(message,))
        for excluded in ((), (message.message_id,)):
            with self.subTest(excluded=bool(excluded)):
                context = RetrievalReplyContext(retrieval=retrieval, skill_library_revision=0, overview=overview).build(
                    command=GenerateReply(uuid4(), SCOPE, BINDING, RewriteDraft('', context_text='散步',
                        input_kind='workspace', workspace_action='suggest', include_relationship_context=True,
                        excluded_message_ids=excluded)), verified_scope=VERIFIED)
                actual = {item.evidence_id for item in context.evidence}
                self.assertEqual(memory.memory_id in actual, not excluded)
                self.assertEqual(message.message_id in actual, not excluded)
                self.assertEqual(context.current_text, '')
                self.assertFalse(any(item.kind == 'user_draft' for item in context.evidence))
                self.assertIsNone(context.direction)

    def test_two_routes_share_original_item_and_character_budgets(self):
        store = InMemoryMemoryStore()
        memories, owners = [], []
        for topic in ('散步', '课程'):
            for number in range(3):
                candidate = store.create_candidate(MemoryCandidate(uuid4(), SCOPE,
                    f'{topic}资料{number}', MemoryCategory.PREFERENCE, (SOURCE,)))
                memories.append(store.confirm(scope=SCOPE, candidate_id=candidate.candidate_id,
                                              adoption_method=AdoptionMethod.MANUAL))
            for number in range(2):
                owners.append(OwnerMemory(uuid4(), OWNER, f'{topic}本人资料{number}', MemoryCategory.PREFERENCE,
                    MemoryTopic.OTHER, (SOURCE,), AdoptionMethod.MANUAL, ConfirmedMemoryStatus.ACTIVE))
                store.create_candidate(MemoryCandidate(uuid4(), SCOPE, f'{topic}待确认{number}',
                    MemoryCategory.PREFERENCE, (SOURCE,), interpretation_reason='合成待确认依据。'))
        overview = OverviewFixture(tuple(OverviewEntry(memory,
            OverviewMemoryIdentity(memory.memory_id, memory.revision), 'manual_entry', ()) for memory in memories))
        overview.owner = replace(overview.owner, entries=tuple(OverviewEntry(owner,
            OverviewMemoryIdentity(owner.memory_id, owner.revision), 'manual_entry', ()) for owner in owners))
        retrieval = InMemoryRetrieval(memory_store=store, owner_memories=tuple(RetrievedOwnerMemory(
            owner.memory_id, OWNER, owner.text, owner.category.value, owner.topic.value, owner.source_ids,
            owner.adoption_method.value, owner.revision) for owner in owners))
        for navigation in (overview, None):
            with self.subTest(overview=navigation is not None):
                context = RetrievalReplyContext(retrieval=retrieval, skill_library_revision=0, overview=navigation).build(
                    command=GenerateReply(uuid4(), SCOPE, BINDING, RewriteDraft('散步', context_text='课程',
                        input_kind='workspace', workspace_action='express', include_relationship_context=True)),
                    verified_scope=VERIFIED)
                for kind, count, chars in (('confirmed_memory', 5, 600), ('owner_memory', 3, 240), ('pending_candidate', 3, 300)):
                    items = [item for item in context.evidence if item.kind == kind]
                    self.assertEqual(len(items), count)
                    self.assertLessEqual(sum(len(item.text) for item in items), chars)
                    self.assertEqual(len({item.evidence_id for item in items}), count)
                if navigation:
                    self.assertEqual(context.retrieval.contact_memory.used_count, 5)
                    self.assertEqual(context.retrieval.owner_memory.used_count, 3)
                    self.assertEqual(context.retrieval.pending_candidate.used_count, 3)
                    self.assertTrue(context.retrieval.contact_memory.exhausted)
