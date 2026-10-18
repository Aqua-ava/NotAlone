"""完整记忆提取通过公共Flow逐条处理，不依赖分句编译。"""
import unittest
from langchain_core.messages import AIMessage
from notalone.memory_extraction.direct_adapter import DirectExtractionRuntime
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.errors import ExtractionInvalidOutputError
from tests.unit.memory_extraction.test_models import _window
from tests.unit.memory_extraction.test_flow import _payload
from tests.unit.memory_extraction.verification_helpers import SyntheticSupportingVerifier
from tests.unit.reply.test_langchain_vertical_slice import ToolCallingFakeModel
from uuid import uuid4


class DirectExtractionTests(unittest.TestCase):
    def runtime(self, scenes):
        model = ToolCallingFakeModel(responses=[AIMessage(content='', tool_calls=[{
            'name': 'DirectMemoryExtractionOutput', 'args': {'scenes': scenes}, 'id': 'synthetic',
        }])])
        return DirectExtractionRuntime(model=model)

    def test_invalid_item_does_not_drop_complete_memory(self):
        identifier = uuid4()
        good = _payload(identifier, text='联系人明确表示更喜欢文字沟通。')
        runtime = self.runtime([{'scene_name': '沟通习惯', 'memories': ['bad', good]}])
        outcome = ExtractionFlow(runtime=runtime, verification_runtime=SyntheticSupportingVerifier()).run(_window((identifier,)))
        self.assertEqual([x.text for x in outcome.accepted], [good['text']])
        self.assertEqual(outcome.rejected_count, 1)

    def test_whole_response_without_scene_array_fails(self):
        with self.assertRaises(ExtractionInvalidOutputError):
            self.runtime('bad').extract(_window((uuid4(),)))

    def test_bad_scene_and_foreign_source_only_reject_their_items(self):
        identifier = uuid4()
        good = _payload(identifier, text='联系人偏好明确的文字说明。')
        foreign = _payload(uuid4(), text='范围外事实')
        runtime = self.runtime([None, {'scene_name': '沟通', 'memories': [foreign, good]}])
        outcome = ExtractionFlow(runtime=runtime, verification_runtime=SyntheticSupportingVerifier()).run(_window((identifier,)))
        self.assertEqual([x.text for x in outcome.accepted], [good['text']])
        self.assertEqual(outcome.rejected_count, 2)

    def test_complete_cross_message_memory_keeps_all_references(self):
        identifiers = (uuid4(), uuid4())
        payload = _payload(identifiers[0], text='联系人表示，在沟通复杂事情时更喜欢文字说明。',
                           source_message_ids=[str(x) for x in identifiers])
        raw = self.runtime([{'scene_name': '沟通', 'memories': [payload]}]).extract(_window(identifiers))
        self.assertEqual(raw[0]['text'], payload['text'])
        self.assertEqual(raw[0]['source_message_ids'], payload['source_message_ids'])

    def test_explicit_bounded_history_still_selects_historical_protocol(self):
        from notalone.tasks.extraction_runtime import extraction_runtime_for_config, runtime_config_for_mode
        from notalone.tasks.models import ExtractionRuntimeMode
        from notalone.memory_extraction.grounded_adapter import GroundedExtractionRuntime
        runtime = self.runtime([])
        self.assertIs(extraction_runtime_for_config(runtime, None), runtime)
        selected = extraction_runtime_for_config(runtime, runtime_config_for_mode(ExtractionRuntimeMode.BOUNDED_RUNTIME_V1))
        self.assertIsInstance(selected, GroundedExtractionRuntime)

    def test_one_invalid_verification_does_not_drop_other_complete_memory(self):
        from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime, SOURCE_VERIFICATION_SCHEMA
        identifier = uuid4()
        window = _window((identifier,))
        first = _payload(identifier, text='联系人更喜欢文字说明。')
        second = _payload(identifier, text='另一条待核验的记忆。')
        model = ToolCallingFakeModel(responses=[AIMessage(content='', tool_calls=[{
            'name': SOURCE_VERIFICATION_SCHEMA['title'], 'id': 'v', 'args': {'results': [
                {'candidate_index': 0, 'verdict': 'supported', 'issues': [],
                 'evidence': [{'message_id': str(identifier), 'quote': window.messages[0].text}]},
                'invalid item',
            ]}}])])
        outcome = ExtractionFlow(runtime=self.runtime([{'scene_name': '沟通', 'memories': [first, second]}]),
            verification_runtime=LangChainSourceVerificationRuntime(model=model, isolate_items=True)).run(window)
        self.assertIsNone(outcome.failure_reason)
        self.assertEqual([x.text for x in outcome.accepted], [first['text']])
        self.assertEqual(outcome.rejected_count, 1)
