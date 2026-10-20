"""完整合并正文必须重新核验，不继承新候选的旧核验结论。"""
from dataclasses import replace
from types import SimpleNamespace
from uuid import uuid4
import unittest

from notalone.memory.models import AdoptionMethod
from notalone.memory_extraction.merge import MemoryMergeVerifier
from notalone.memory_extraction.flow import _to_fact
from tests.unit.memory_extraction.test_flow import _payload
from tests.unit.memory_extraction.test_models import _window
from tests.unit.memory_extraction.verification_helpers import SyntheticSupportingVerifier, FixedSourceVerifier, verification_result
from notalone.scopes import ContactScope

class MergeTests(unittest.TestCase):
    def setup_data(self):
        ids = (uuid4(), uuid4(), uuid4())
        self.window = _window(ids)
        self.scope = ContactScope(self.window.owner_id, self.window.contact_id)
        self.fact = _to_fact(_payload(ids[2]))
        self.parents = tuple(SimpleNamespace(memory_id=uuid4(), adoption_method=AdoptionMethod.AUTO,
            category=self.fact.category, topic=self.fact.topic, event=None, conditions=None, valid_at=None, invalid_at=None,
            source_ids=(identifier,)) for identifier in ids[:2])

    def test_merged_text_is_reverified_with_all_source_messages(self):
        self.setup_data()
        verifier = MemoryMergeVerifier(messages=self.window.messages, verification_runtime=SyntheticSupportingVerifier())
        result = verifier.verify(scope=self.scope, fact=self.fact, parents=self.parents, text='联系人偏好文字说明，也接受电话沟通。')
        self.assertEqual(result.text, '联系人偏好文字说明，也接受电话沟通。')
        self.assertEqual(set(result.source_message_ids), self.window.message_id_set)
        self.assertIsNotNone(result.dimension_evidence)

    def test_unsupported_merged_text_does_not_reuse_original_candidate(self):
        self.setup_data()
        verifier = MemoryMergeVerifier(messages=self.window.messages, verification_runtime=FixedSourceVerifier((
            verification_result(verdict='unsupported', issues=('meaning',)),)))
        with self.assertRaises(ValueError):
            verifier.verify(scope=self.scope, fact=self.fact, parents=self.parents, text='凭空增加的内容')

    def test_missing_source_and_manual_parent_are_rejected_before_verification(self):
        self.setup_data()
        verifier = MemoryMergeVerifier(messages=self.window.messages[1:], verification_runtime=SyntheticSupportingVerifier())
        with self.assertRaises(ValueError):
            verifier.verify(scope=self.scope, fact=self.fact, parents=self.parents, text='合并正文')
        self.parents[0].adoption_method = AdoptionMethod.MANUAL
        verifier = MemoryMergeVerifier(messages=self.window.messages, verification_runtime=SyntheticSupportingVerifier())
        with self.assertRaises(ValueError):
            verifier.verify(scope=self.scope, fact=self.fact, parents=self.parents, text='合并正文')

    def test_legacy_merge_without_relation_proof_never_reaches_atomic_port(self):
        from notalone.memory import InMemoryMemoryStore
        from notalone.memory_extraction.adoption import MemoryAdoption, _candidate_from_fact
        from notalone.memory_extraction.adjudication import AdjudicationDecision, AdjudicationAction
        from notalone.memory_extraction.flow import ExtractionOutcome
        from notalone.memory_extraction.dimensions import DimensionRelease
        self.setup_data()

        class Store(InMemoryMemoryStore):
            merged = None
            def confirm_merge(inner, **kwargs):
                inner.merged = kwargs
                return inner.confirm(scope=kwargs['scope'], candidate_id=kwargs['candidate_id'])
        store = Store()
        parents = []
        for index, message in enumerate(self.window.messages[:2]):
            candidate = store.create_candidate(_candidate_from_fact(self.scope, replace(self.fact,
                text=f'联系人偏好文字沟通，特别是第{index + 1}类事情。', source_message_ids=(message.message_id,))))
            parents.append(store.confirm(scope=self.scope, candidate_id=candidate.candidate_id))
        merged_text = '联系人偏好文字沟通，特别是第一类、第二类和第三类事情。'
        class Adjudicator:
            def adjudicate(inner, **kwargs):
                return AdjudicationDecision(action=AdjudicationAction.MERGE,
                    merged_memory_ids=tuple(item.memory_id for item in parents), merged_text=merged_text)
        fact = replace(self.fact, text='联系人偏好文字沟通，特别是第三类事情。')
        stats = MemoryAdoption(memory_port=store, adjudication_runtime=Adjudicator(),
            dimension_release=DimensionRelease(gate_enabled=False),
            merge_verifier=MemoryMergeVerifier(messages=self.window.messages,
                verification_runtime=SyntheticSupportingVerifier())).adopt(self.scope, ExtractionOutcome(accepted=(fact,)))
        self.assertEqual((stats.updated, stats.pending), (0, 1))
        self.assertIsNone(store.merged)
        self.assertEqual(store.list_confirmed(self.scope), tuple(parents))

    def test_all_source_merged_memory_remains_recallable_for_later_updates(self):
        from notalone.memory import InMemoryMemoryStore, SourceDependencyMode
        from notalone.memory_extraction.adoption import MemoryAdoption, _candidate_from_fact
        from notalone.memory_extraction.adjudication import AdjudicationDecision, AdjudicationAction
        from notalone.memory_extraction.flow import ExtractionOutcome
        from notalone.memory_extraction.dimensions import DimensionRelease
        self.setup_data()
        class Store(InMemoryMemoryStore):
            def list_confirmed(inner, *args, **kwargs):
                return tuple(replace(item, source_dependency_mode=SourceDependencyMode.ALL)
                    for item in super().list_confirmed(*args, **kwargs))
        store = Store()
        previous = store.create_candidate(_candidate_from_fact(self.scope, replace(self.fact, text='联系人喜欢文字沟通。')))
        store.confirm(scope=self.scope, candidate_id=previous.candidate_id)
        class Adjudicator:
            seen = ()
            def adjudicate(inner, **kwargs):
                inner.seen = kwargs['similar']
                return AdjudicationDecision(AdjudicationAction.KEEP)
        adjudicator = Adjudicator()
        stats = MemoryAdoption(memory_port=store, adjudication_runtime=adjudicator,
            merge_verifier=object(), dimension_release=DimensionRelease(gate_enabled=False),
            similarity_threshold=0).adopt(self.scope, ExtractionOutcome((replace(self.fact, text='联系人现在喜欢文字沟通和电话说明。'),)))
        self.assertEqual((stats.adopted, stats.pending), (0, 1))
        self.assertEqual(len(adjudicator.seen), 1)

    def test_invalid_first_adjudication_does_not_block_next_candidate(self):
        from notalone.memory import InMemoryMemoryStore
        from notalone.memory_extraction.adoption import MemoryAdoption, _candidate_from_fact
        from notalone.memory_extraction.adjudication import AdjudicationDecision, AdjudicationAction
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError
        from notalone.memory_extraction.flow import ExtractionOutcome
        from notalone.memory_extraction.dimensions import DimensionRelease
        self.setup_data()
        store = InMemoryMemoryStore()
        previous = store.create_candidate(_candidate_from_fact(self.scope, replace(self.fact, text='联系人喜欢文字沟通。')))
        store.confirm(scope=self.scope, candidate_id=previous.candidate_id)
        class Adjudicator:
            count = 0
            def adjudicate(inner, **kwargs):
                inner.count += 1
                if inner.count == 1:
                    raise ExtractionInvalidOutputError('非法合并父版本')
                return AdjudicationDecision(AdjudicationAction.KEEP)
        adjudicator = Adjudicator()
        stats = MemoryAdoption(memory_port=store, adjudication_runtime=adjudicator,
            dimension_release=DimensionRelease(gate_enabled=False), similarity_threshold=0).adopt(self.scope,
            ExtractionOutcome((replace(self.fact, text='联系人喜欢第一类说明。'), replace(self.fact, text='联系人喜欢第二类说明。'))))
        self.assertEqual(adjudicator.count, 2)
        self.assertEqual((stats.pending, stats.adopted), (2, 0))


class MergeDecisionTests(unittest.TestCase):
    def test_model_merge_requires_known_parents_and_complete_text(self):
        from langchain_core.messages import AIMessage
        from notalone.memory_extraction.adjudication import SimilarMemory, AdjudicationAction
        from notalone.memory_extraction.adjudication_adapters import LangChainAdjudicationRuntime
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError
        from tests.unit.reply.test_langchain_vertical_slice import ToolCallingFakeModel
        parents = tuple(SimilarMemory(uuid4(), text, 'other') for text in ('偏好文字', '复杂事情可电话'))
        args = {'action': 'merge', 'replaced_memory_id': None,
            'merged_memory_ids': [str(item.memory_id) for item in parents],
            'merged_text': '偏好文字，复杂事情可电话沟通。'}
        for bad in (False, True):
            payload = {**args, **({'merged_memory_ids': [str(uuid4()), str(uuid4())]} if bad else {})}
            model = ToolCallingFakeModel(responses=[AIMessage(content='', tool_calls=[{
                'name': 'MemoryAdjudicationOutput', 'args': payload, 'id': 'merge'}])])
            runtime = LangChainAdjudicationRuntime(model=model)
            if bad:
                with self.assertRaises(ExtractionInvalidOutputError):
                    runtime.adjudicate(candidate_text='复杂事情也可以电话', similar=parents)
            else:
                decision = runtime.adjudicate(candidate_text='复杂事情也可以电话', similar=parents)
                self.assertEqual(decision.action, AdjudicationAction.MERGE)
                self.assertEqual(decision.merged_memory_ids, tuple(item.memory_id for item in parents))
                self.assertEqual(decision.merged_text, args['merged_text'])


class BatchAdjudicationTests(unittest.TestCase):
    def test_bad_batch_item_does_not_discard_valid_decision(self):
        from langchain_core.messages import AIMessage
        from notalone.memory_extraction.adjudication import SimilarMemory, AdjudicationAction
        from notalone.memory_extraction.adjudication_adapters import LangChainAdjudicationRuntime
        from tests.unit.reply.test_langchain_vertical_slice import ToolCallingFakeModel
        parents = (SimilarMemory(uuid4(), "偏好文字", "other"),)
        model = ToolCallingFakeModel(responses=[AIMessage(content="", tool_calls=[{
            "name": "BatchMemoryAdjudicationOutput", "id": "batch", "args": {"decisions": [
                {"candidate_index": 0, "action": "nonsense", "replaced_memory_id": None},
                {"candidate_index": 1, "action": "noop", "replaced_memory_id": None}
            ]}}])])
        decisions = LangChainAdjudicationRuntime(model=model).adjudicate_batch(
            candidates=(("偏好文字说明", parents), ("喜欢文字", parents)))
        self.assertIsNone(decisions[0])
        self.assertEqual(decisions[1].action, AdjudicationAction.NOOP)
