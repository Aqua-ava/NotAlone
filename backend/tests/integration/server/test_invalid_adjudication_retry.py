"""无效裁决须经正式任务重试，不能零写入后推进成功水位。"""
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4
import unittest
import psycopg
from tests.integration.server import test_memory_batch_updates as replay
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server.memory_skill_evolution_support import EvolutionHttpSupport

_INVALID = deepcopy(replay.FIXTURE['steps'][2])
for item in _INVALID['arguments']['decisions']:
    item['relation'] = {'kind': 'independent', 'explanation': '空池不应编造旧版本关系。',
        'related_memory_ids': [], 'evidence': [], 'claim_changed': False, 'condition_changed': False}


class InvalidThenRecoveredModel(replay.BatchUpdateReplayModel):
    steps: list[dict] = [*replay.FIXTURE['steps'][:2], _INVALID, *replay.FIXTURE['steps'][:3]]


class InvalidAdjudicationRetryHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    production_model_wiring = True
    dimension_release = None
    extraction_model_factory = InvalidThenRecoveredModel
    _ok = EvolutionHttpSupport._ok
    _import_evolution_source = EvolutionHttpSupport._import_evolution_source

    def test_invalid_empty_relation_retries_before_success_and_preserves_all_sources(self):
        self.contact_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'裁决恢复合成联系人')",
                (self.contact_id, self.owner_id))
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=self.contact_id,
            channel='wechat', account_scope='synthetic-retry', conversation_locator='synthetic-'+self.contact_id.hex)
        imported = self._import_evolution_source([(False, text) for text in replay.FIXTURE['initial']]+[(True,'收到。')],
            when=datetime(2026,10,22,9,tzinfo=timezone.utc))
        path = f'/api/contacts/{self.contact_id}'
        memories = self._ok(path+'/memories')['memories']
        self.assertEqual(len(memories), 2)
        self.assertTrue(all(memory['status'] == 'active' and memory['adoption_method'] == 'auto' for memory in memories))
        self.assertEqual(self._ok(path+'/memory-candidates')['candidates'], [])
        self.assertEqual(len(self.extraction_model.seen_calls), 6)
        task = self._ok(f'/api/tasks/status?contact_id={self.contact_id}&task_id={imported["task_id"]}')
        self.assertEqual(task['status'], 'succeeded')
        source_ids = {row['message_id'] for row in imported['messages'].values()}
        self.assertTrue(all(set(memory['source_ids']) <= source_ids for memory in memories))
