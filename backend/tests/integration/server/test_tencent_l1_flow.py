"""聊天导入到当前记忆的生产入口回归；仅替换外部模型。"""
import json
import re
import unittest
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from unittest.mock import patch
import psycopg
from langchain_core.outputs import ChatGeneration, ChatResult
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture, ScriptedCoreModel, tool_response
from tests.integration.server.memory_skill_evolution_support import EvolutionHttpSupport
from tests.integration.server import test_skill_learning as learning_fixture


class BatchMemoryModel(ScriptedCoreModel):
    facts: dict = {}
    action: str = 'update'
    final_text: str = ''
    target_texts: dict = {}
    invalid_targets: bool = False
    actions: dict = {}
    timings: dict = {}
    batch_inputs: list = []

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        name = kwargs['tools'][0]['function']['name']
        content = str(messages[-1].content)
        if name == 'DirectMemoryExtractionOutput':
            facts = []
            for identifier, sender, raw in re.findall(r'\[target\] \[message_id=([0-9a-f-]+)\] occurred_at=\S+ sender=(contact|self): (.*)', content):
                if raw not in self.facts:
                    continue
                category, topic = self.facts[raw]
                facts.append(dict(text=raw, category=category, topic=topic, subject=sender,
                    source_message_ids=[identifier], confidence=.95, risk_flags=[], valid_at=None,
                    invalid_at=None, speech_act='assertion', assertion_status='asserted',
                    figurative_type='literal', alternatives=[], interpretation_reason='合成直接陈述。', event=None))
                facts[-1].update(self.timings.get(raw, {}))
            result = {'scenes': [{'scene_name': '合成资料', 'memories': facts}]}
        elif name == 'SourceVerificationOutput':
            payload = json.loads(content)
            result = {'results': [dict(candidate_index=c['candidate_index'], verdict='supported', issues=[],
                evidence=[dict(message_id=m['message_id'], quote=m['text']) for m in payload['messages']
                          if m['message_id'] in c['source_message_ids']]) for c in payload['candidates']]}
        elif name == 'BatchMemoryAdjudicationOutput':
            payload = json.loads(content)
            self.batch_inputs.append(payload)
            decisions = []
            for c in payload['memories']:
                ids = c['candidate_ids']
                if c['text'] in self.target_texts:
                    ids = [p['memory_id'] for p in payload['candidate_pool'] if p['text'] in self.target_texts[c['text']]]
                if self.invalid_targets:
                    ids = [str(uuid4())]
                action = self.actions.get(c['text'], self.action if payload['candidate_pool'] else 'store')
                decisions.append(dict(candidate_id=c['candidate_id'], action=action,
                    target_ids=ids if action in {'merge', 'update'} else [],
                    merged_text=(self.final_text or c['text']) if action in {'merge', 'update'} else None))
            result = {'decisions': decisions}
        elif name == 'MemoryAdjudicationOutput':
            ids = re.findall(r'\[memory_id=([0-9a-f-]+)\]', content)
            result = dict(action='update', replaced_memory_id=ids[0], merged_memory_ids=[], merged_text=None)
        else:
            raise AssertionError(name)
        return ChatResult(generations=[ChatGeneration(message=tool_response(name, result))])


class TencentL1HttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    production_model_wiring = True
    dimension_release = None
    extraction_model_factory = BatchMemoryModel
    _delete_source = learning_fixture.SkillLearningHttpTest._delete_source
    _ok = EvolutionHttpSupport._ok
    _import_evolution_source = EvolutionHttpSupport._import_evolution_source

    def setUp(self):
        self.addCleanup(patch.stopall)
        self.embedding_patch = patch("notalone.memory_extraction.recall.embed_texts", side_effect=lambda texts: [(1.0, 0.0) for _ in texts])
        self.embedding_patch.start()
        super().setUp()
        self.contact_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute('INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,%s)',
                               (self.contact_id, self.owner_id, '合成跨类更新'))
        self.when = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def memories(self):
        return self._ok(f'/api/contacts/{self.contact_id}/memories')['memories']

    def test_missing_embedding_keeps_candidate_with_public_preparation_diagnostic(self):
        from tempfile import TemporaryDirectory
        from notalone.memory_extraction import recall
        first, new = '周末喜欢游泳。', '周末喜欢读书。'
        self.extraction_model.facts = {t: ('preference', 'health') for t in (first, new)}
        self.extraction_model.actions = {first: 'store', new: 'store'}
        self._import_evolution_source([(False, first)], when=self.when)
        self.embedding_patch.stop()
        with TemporaryDirectory() as empty, patch.dict('os.environ', {'NOTALONE_MEMORY_EMBEDDING_CACHE': empty}), patch.object(recall, '_MODEL', None):
            self._import_evolution_source([(False, new)], when=self.when + timedelta(days=1))
        self.assertEqual([m['text'] for m in self.memories()], [first])
        candidates = self._ok(f'/api/contacts/{self.contact_id}/memory-candidates')['candidates']
        pending = next(c for c in candidates if c['text'] == new)
        self.assertEqual(pending['status'], 'pending')
        self.assertIn('embedding_unavailable', pending['failure_reason'] or '')
        self.assertIn('scripts/prepare_memory_embedding.py', pending['failure_reason'])

    def test_first_batch_semantic_duplicates_keep_one_fact(self):
        first, second = '周末喜欢游泳。', '喜欢在周末游泳锻炼。'
        self.extraction_model.facts = {text: ('preference', 'health') for text in (first, second)}
        self.extraction_model.actions = {first: 'store', second: 'skip'}
        self._import_evolution_source([(False, first), (False, second), (True, '收到合成安排。')], when=self.when)
        self.assertEqual([m['text'] for m in self.memories()], [first])
        self.assertEqual(len(self.extraction_model.batch_inputs[0]['memories']), 2)

    def test_first_batch_all_skip_stays_pending_without_carrier(self):
        text = '周末喜欢游泳。'
        self.extraction_model.facts = {text: ('preference', 'health')}
        self.extraction_model.actions = {text: 'skip'}
        self._import_evolution_source([(False, text)], when=self.when)
        self.assertEqual(self.memories(), [])
        candidates = self._ok(f'/api/contacts/{self.contact_id}/memory-candidates')['candidates']
        self.assertTrue(any(c['text'] == text and c['status'] == 'pending' for c in candidates))

    def test_skip_different_time_interval_stays_pending(self):
        old, new = '从一月开始周末喜欢游泳。', '从二月开始周末喜欢游泳。'
        self.extraction_model.facts = {text: ('preference', 'health') for text in (old, new)}
        self.extraction_model.timings = {
            old: {'valid_at': '2026-01-01T00:00:00+00:00'},
            new: {'valid_at': '2026-02-01T00:00:00+00:00'},
        }
        self._import_evolution_source([(False, old)], when=self.when)
        self.extraction_model.action = 'skip'
        self._import_evolution_source([(False, new)], when=self.when + timedelta(days=32))
        self.assertEqual([m['text'] for m in self.memories()], [old])
        candidates = self._ok(f'/api/contacts/{self.contact_id}/memory-candidates')['candidates']
        self.assertTrue(any(c['text'] == new and c['status'] == 'pending' for c in candidates))
        payload = self.extraction_model.batch_inputs[-1]
        self.assertNotEqual(payload['memories'][0]['valid_at'], payload['candidate_pool'][0]['valid_at'])
        for item in payload['memories'] + payload['candidate_pool']:
            self.assertTrue(item['source_message_ids'])
            self.assertIn('event', item)
            self.assertIn('invalid_at', item)

    def test_new_chat_updates_old_memory_across_category_and_topic(self):
        old, new = '长期固定参加周末跑步。', '锻炼习惯变更为周末游泳，不再跑步。'
        self.extraction_model.facts = {old: ('common_fact', 'other'), new: ('preference', 'health')}
        self._import_evolution_source([(False, old)], when=self.when)
        previous = self.memories()[0]
        self._import_evolution_source([(False, new)], when=self.when + timedelta(days=1))
        current = self.memories()
        self.assertEqual([m['text'] for m in current], [new])
        self.assertEqual(current[0]['supersedes_memory_id'], previous['memory_id'])
        self.assertEqual(current[0]['adoption_method'], 'auto')

    def test_chat_merges_multiple_cross_category_memories_with_all_sources(self):
        first, second = '周末固定参加跑步锻炼。', '平日训练项目是游泳。'
        new = '现在锻炼安排统一为周末游泳，平日休息。'
        self.extraction_model.facts = {first: ('common_fact', 'other'), second: ('preference', 'health'),
                                       new: ('preference', 'health')}
        self._import_evolution_source([(False, first), (False, second), (True, '收到合成安排。')], when=self.when)
        parents = self.memories()
        self.assertEqual(len(parents), 2)
        self.extraction_model.action = 'merge'
        self._import_evolution_source([(False, new)], when=self.when + timedelta(days=1))
        current = self.memories()
        self.assertEqual([m['text'] for m in current], [new])
        self.assertTrue(set(source for m in parents for source in m['source_ids']) <= set(current[0]['source_ids']))

    def test_single_old_memory_can_merge_new_details_without_losing_source(self):
        old, new = '周末长期参加游泳。', '周末游泳固定在社区泳馆。'
        self.extraction_model.facts = {old: ('preference', 'health'), new: ('common_fact', 'other')}
        self._import_evolution_source([(False, old)], when=self.when)
        previous = self.memories()[0]
        self.extraction_model.action = 'merge'
        self.extraction_model.final_text = '周末长期在社区泳馆游泳。'
        self._import_evolution_source([(False, new)], when=self.when + timedelta(days=1))
        current = self.memories()
        self.assertEqual([m['text'] for m in current], ['周末长期在社区泳馆游泳。'])
        self.assertTrue(set(previous['source_ids']) < set(current[0]['source_ids']))

    def test_two_new_memories_update_separate_old_facts_in_one_import(self):
        old = ['长期喝茶。', '周末跑步。']
        new = ['日常改喝咖啡。', '周末改为游泳。']
        self.extraction_model.facts = {text: ('preference', 'other') for text in old + new}
        self._import_evolution_source([(False, text) for text in old] + [(True, '收到。')], when=self.when)
        self.extraction_model.target_texts = {new[0]: [old[0]], new[1]: [old[1]]}
        self._import_evolution_source([(False, text) for text in new] + [(True, '收到。')], when=self.when + timedelta(days=1))
        self.assertEqual({m['text'] for m in self.memories()}, set(new))
        self.assertTrue(all(m['supersedes_memory_id'] for m in self.memories()))

    def test_multi_target_update_retires_all_old_current_facts(self):
        first, second, new = '周末参加跑步。', '平日参加游泳。', '锻炼安排更新为周末瑜伽，平日休息。'
        self.extraction_model.facts = {text: ('preference', 'health') for text in [first, second, new]}
        self._import_evolution_source([(False, first), (False, second), (True, '收到。')], when=self.when)
        self._import_evolution_source([(False, new)], when=self.when + timedelta(days=1))
        self.assertEqual([m['text'] for m in self.memories()], [new])

    def test_skip_repeated_fact_preserves_current_memory(self):
        old, new = '周末固定游泳。', '我每个周末都会去游泳。'
        self.extraction_model.facts = {text: ('preference', 'health') for text in [old, new]}
        self._import_evolution_source([(False, old)], when=self.when)
        previous = self.memories()[0]['memory_id']
        self.extraction_model.action = 'skip'
        self._import_evolution_source([(False, new)], when=self.when + timedelta(days=1))
        self.assertEqual([m['memory_id'] for m in self.memories()], [previous])

    def test_out_of_scope_target_stays_pending_and_does_not_add_conflict(self):
        old, new = '周末固定游泳。', '周末改为跑步。'
        self.extraction_model.facts = {text: ('preference', 'health') for text in [old, new]}
        self._import_evolution_source([(False, old)], when=self.when)
        self.extraction_model.invalid_targets = True
        self._import_evolution_source([(False, new)], when=self.when + timedelta(days=1))
        self.assertEqual([m['text'] for m in self.memories()], [old])
        candidates = self._ok(f'/api/contacts/{self.contact_id}/memory-candidates')['candidates']
        self.assertTrue(any(c['text'] == new and c['status'] == 'pending' for c in candidates))

    def test_user_corrected_memory_is_not_replaced_by_batch_decision(self):
        old, new = '周末固定游泳。', '周末改为跑步。'
        self.extraction_model.facts = {text: ('preference', 'health') for text in [old, new]}
        self._import_evolution_source([(False, old)], when=self.when)
        identifier = self.memories()[0]['memory_id']
        self._ok(f'/api/contacts/{self.contact_id}/memories/{identifier}/correct',
                 {'text': '用户确认周末固定读书。', 'change_kind': 'error_correction'})
        self._import_evolution_source([(False, new)], when=self.when + timedelta(days=1))
        self.assertEqual([m['text'] for m in self.memories()], ['用户确认周末固定读书。'])

    def test_owner_updates_remain_separate_from_contact_and_other_owner(self):
        old, new = '本人周末长期跑步。', '本人周末改为游泳。'
        self.extraction_model.facts = {text: ('preference', 'health') for text in [old, new]}
        self._import_evolution_source([(True, old), (False, '好的，收到。')], when=self.when)
        self._import_evolution_source([(True, new), (False, '好的，收到。')], when=self.when + timedelta(days=1))
        self.assertEqual(self.memories(), [])
        self.assertEqual([m['text'] for m in self._ok('/api/memories/owner')['memories']], [new])
        self.assertEqual(self._get(self.other_backend, '/api/memories/owner')['memories'], [])

    def test_deleting_one_required_parent_source_removes_merged_current_memory(self):
        old, new = '周末固定游泳。', '游泳固定在社区泳馆。'
        self.extraction_model.facts = {text: ('preference', 'health') for text in [old, new]}
        first = self._import_evolution_source([(False, old)], when=self.when)
        self.extraction_model.action = 'merge'
        self.extraction_model.final_text = '周末固定在社区泳馆游泳。'
        self._import_evolution_source([(False, new)], when=self.when + timedelta(days=1))
        self.assertEqual(len(self.memories()), 1)
        self._delete_source(first['source']['source_id'])
        self.assertEqual(self.memories(), [])
