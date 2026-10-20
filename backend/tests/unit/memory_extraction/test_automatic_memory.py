"""新消息默认经独立来源核验后自动采纳和更新；不补认证历史候选。"""
from dataclasses import replace
import unittest
from uuid import uuid4

from langchain_core.messages import AIMessage

from notalone.memory import AdoptionMethod, InMemoryMemoryStore
from notalone.memory_extraction.adoption import MemoryAdoption
from notalone.memory_extraction.adjudication import AdjudicationAction, AdjudicationDecision
from notalone.memory_extraction.direct_adapter import DirectExtractionRuntime
from notalone.memory_extraction.flow import ExtractionFlow, ExtractionOutcome
from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.test_flow import _payload
from tests.unit.memory_extraction.test_models import _window
from tests.unit.memory_extraction.verification_helpers import verification_result
from tests.unit.reply.test_langchain_vertical_slice import ToolCallingFakeModel


class AutomaticMemoryTest(unittest.TestCase):
    def setUp(self):
        self.window = _window((uuid4(),))
        self.scope = ContactScope(self.window.owner_id, self.window.contact_id)
        self.store = InMemoryMemoryStore()
        self.messages = []

    def extract(self, text, *, sources=True, verdict='supported', **fields):
        message = replace(self.window.messages[0], message_id=uuid4(), text=text,
            source_snapshots=({'source_ref_id': str(uuid4()), 'source_id': str(uuid4()),
                'source_kind': 'source_document', 'locator': 'synthetic:1',
                'raw_payload': {}, 'source_content_sha256': 'a' * 64},) if sources else ())
        self.messages.append(message)
        window = replace(self.window, messages=(message,))
        model = ToolCallingFakeModel(responses=[
            AIMessage(content='', tool_calls=[{'name': 'DirectMemoryExtractionOutput', 'id': 'e',
                'args': {'scenes': [{'scene_name': '沟通', 'memories': [_payload(
                    message.message_id, text=text, **fields)]}]}}]),
            AIMessage(content='', tool_calls=[{'name': 'SourceVerificationOutput', 'id': 'v',
                'args': {'results': [verification_result(verdict=verdict,
                    issues=('meaning',) if verdict != 'supported' else (),
                    evidence=((message.message_id, message.text),))]}}]),
        ])
        return ExtractionFlow(runtime=DirectExtractionRuntime(model=model),
            verification_runtime=LangChainSourceVerificationRuntime(model=model)).run(window)

    def test_legacy_update_without_relation_proof_preserves_prior_auto_version(self):
        first = MemoryAdoption(memory_port=self.store).adopt(self.scope, self.extract('联系人喜欢文字沟通。'))
        self.assertEqual(first.adopted, 1)
        previous, = self.store.list_confirmed(self.scope)
        class Update:
            def adjudicate(inner, **kwargs):
                return AdjudicationDecision(AdjudicationAction.UPDATE, replaced_memory_id=previous.memory_id)
        result = MemoryAdoption(memory_port=self.store, adjudication_runtime=Update(),
            similarity_threshold=0).adopt(self.scope, self.extract('联系人现在喜欢电话沟通。'))
        self.assertEqual((result.updated, result.pending), (0, 1))
        self.assertEqual(self.store.list_confirmed(self.scope), (previous,))

    def test_missing_sources_uncertain_or_sensitive_remain_unconfirmed(self):
        for options in ({'sources': False}, {'verdict': 'uncertain'}, {'risk_flags': ['sensitive']}, {'confidence': 0.2}):
            with self.subTest(options=options):
                store = InMemoryMemoryStore()
                result = MemoryAdoption(memory_port=store).adopt(self.scope,
                    self.extract('联系人喜欢文字沟通。', **options))
                self.assertEqual(result.adopted, 0)
                self.assertEqual(store.list_confirmed(self.scope), ())

    def test_verified_correction_without_relation_proof_remains_pending(self):
        MemoryAdoption(memory_port=self.store).adopt(self.scope, self.extract('联系人平时最喜欢喝乌龙茶，日常一直选乌龙茶。'))
        previous, = self.store.list_confirmed(self.scope)
        class Update:
            def adjudicate(inner, **kwargs):
                return AdjudicationDecision(AdjudicationAction.UPDATE, replaced_memory_id=previous.memory_id)
        result = MemoryAdoption(memory_port=self.store, adjudication_runtime=Update()).adopt(self.scope,
            self.extract('联系人此前的日常口味是乌龙茶；现更正为已不喝乌龙茶，改为每天喝红茶，以后都选红茶。', speech_act='correction'))
        self.assertEqual((result.updated, result.pending), (0, 1))
        self.assertEqual(self.store.list_confirmed(self.scope), (previous,))

    def test_unverified_or_uncertain_correction_stays_pending(self):
        for options in ({'sources': False}, {'verdict': 'uncertain'}):
            with self.subTest(options=options):
                outcome = self.extract('联系人更正为喜欢红茶。', speech_act='correction', **options)
                result = MemoryAdoption(memory_port=InMemoryMemoryStore()).adopt(self.scope, outcome)
                self.assertEqual(result.adopted, 0)

    def test_correction_exception_preserves_explicit_policy_and_receipt_binding(self):
        from notalone.memory_extraction.dimensions import RELEASE_ALL_DIMENSIONS
        outcome = self.extract('联系人更正为喜欢红茶。', speech_act='correction')
        fact, = outcome.accepted
        for changed in (replace(fact, verified_source_receipt=None),
                replace(fact, alternatives=('可能是另一位联系人。',))):
            result = MemoryAdoption(memory_port=InMemoryMemoryStore()).adopt(self.scope, ExtractionOutcome((changed,)))
            self.assertEqual((result.adopted, result.pending), (0, 1))
        result = MemoryAdoption(memory_port=InMemoryMemoryStore(), dimension_release=RELEASE_ALL_DIMENSIONS).adopt(self.scope, outcome)
        self.assertEqual((result.adopted, result.pending), (0, 1))

    def test_changed_candidate_or_lost_source_binding_cannot_reuse_verification(self):
        fact, = self.extract('联系人喜欢文字沟通。').accepted
        for changed in (replace(fact, text='联系人讨厌文字沟通。'),
                replace(fact, dimension_evidence=None), replace(fact, verified_source_receipt=None),
                replace(fact, requires_all_sources=False)):
            store = InMemoryMemoryStore()
            result = MemoryAdoption(memory_port=store).adopt(self.scope, ExtractionOutcome((changed,)))
            self.assertEqual(result.adopted, 0)
            self.assertEqual(store.list_confirmed(self.scope), ())

    def test_manual_memory_is_never_automatically_replaced(self):
        MemoryAdoption(memory_port=self.store).adopt(self.scope, self.extract('联系人喜欢文字沟通。'))
        original, = self.store.list_confirmed(self.scope)
        manual = self.store.correct(scope=self.scope, memory_id=original.memory_id, text='用户确认联系人喜欢文字。')
        class Update:
            def adjudicate(inner, **kwargs):
                return AdjudicationDecision(AdjudicationAction.UPDATE, replaced_memory_id=manual.memory_id)
        result = MemoryAdoption(memory_port=self.store, adjudication_runtime=Update(),
            similarity_threshold=0).adopt(self.scope, self.extract('联系人现在喜欢电话沟通。'))
        self.assertEqual(result.updated, 0)
        self.assertIn(manual, self.store.list_confirmed(self.scope))
        correction = MemoryAdoption(memory_port=self.store, adjudication_runtime=Update(),
            similarity_threshold=0).adopt(self.scope, self.extract('联系人更正为喜欢电话沟通。', speech_act='correction'))
        self.assertEqual(correction.updated, 0)
        self.assertIn(manual, self.store.list_confirmed(self.scope))

    def test_source_changes_during_candidate_save_block_automatic_confirmation(self):
        from tests.unit.memory_extraction.test_adoption import SourceChangedStore
        store = SourceChangedStore()
        result = MemoryAdoption(memory_port=store).adopt(self.scope,
            self.extract('联系人喜欢文字沟通。'))
        self.assertEqual((result.adopted, result.pending), (0, 1))
        self.assertEqual(store.list_confirmed(self.scope), ())

    def test_legacy_merge_cannot_publish_without_relation_proof(self):
        from notalone.memory_extraction.merge import MemoryMergeVerifier
        class Store(InMemoryMemoryStore):
            def confirm_merge(inner, **kwargs):
                inner.parents = kwargs['expected_parents']
                return inner.confirm(scope=kwargs['scope'], candidate_id=kwargs['candidate_id'],
                    expected_dimension_evidence=kwargs['expected_dimension_evidence'])
        store = Store()
        for text in ('联系人喜欢文字沟通。', '联系人也接受电话沟通。'):
            self.assertEqual(MemoryAdoption(memory_port=store).adopt(self.scope, self.extract(text)).adopted, 1)
        parents = store.list_confirmed(self.scope)
        outcome = self.extract('联系人复杂事情喜欢文字说明。')
        merged_text = '联系人沟通时喜欢文字，也接受电话；复杂事情喜欢文字说明。'
        class Merge:
            def adjudicate(inner, **kwargs):
                return AdjudicationDecision(AdjudicationAction.MERGE,
                    merged_memory_ids=tuple(item.memory_id for item in parents), merged_text=merged_text)
        model = ToolCallingFakeModel(responses=[AIMessage(content='', tool_calls=[{
            'name': 'SourceVerificationOutput', 'id': 'merge-v', 'args': {'results': [verification_result(
                evidence=tuple((message.message_id, message.text) for message in self.messages))]}}])])
        result = MemoryAdoption(memory_port=store, adjudication_runtime=Merge(), similarity_threshold=0,
            merge_verifier=MemoryMergeVerifier(messages=self.messages,
                verification_runtime=LangChainSourceVerificationRuntime(model=model))).adopt(self.scope, outcome)
        self.assertEqual((result.updated, result.pending), (0, 1))
        self.assertFalse(hasattr(store, 'parents'))
        self.assertEqual(store.list_confirmed(self.scope), parents)

    def test_verified_self_memory_uses_owner_scope_without_contact_memory(self):
        from tests.integration.server.test_memory_api import FakeOwnerMemory
        owner = FakeOwnerMemory()
        result = MemoryAdoption(memory_port=self.store, owner_memory_port=owner).adopt(
            self.scope, self.extract('用户本人喜欢文字沟通。', subject='self'))
        self.assertEqual(result.adopted, 1)
        memory, = owner.list_active(self.scope.owner_id)
        self.assertEqual(memory.adoption_method, AdoptionMethod.AUTO)
        self.assertEqual(self.store.list_confirmed(self.scope), ())
