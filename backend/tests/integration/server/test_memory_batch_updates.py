"""同批替代与补充经过正式来源、裁决和写入门；模型边界重放合成失败。"""
import json
from pathlib import Path
import re
import unittest
from uuid import uuid4
from datetime import datetime, timedelta, timezone

import psycopg

from tests.integration.server.core_business_flow_support import (
    CoreBusinessFlowFixture, ScriptedCoreModel, tool_response,
)
from tests.integration.server.memory_skill_evolution_support import EvolutionHttpSupport
from tests.fidelity_http_support import FidelityControlledModel

FIXTURE = json.loads((Path(__file__).parent/'fixtures/batch_update_replay.json').read_text())


class BatchUpdateReplayModel(ScriptedCoreModel):
    identifiers: dict[str, str] = {}

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        step = FIXTURE['steps'][len(self.seen_calls)]
        name = kwargs['tools'][0]['function']['name']
        if name != step['name']:
            raise AssertionError('模型请求顺序与冻结的合成边界不符。')
        current = str(messages[-1].content)
        if 'old_message_ids' in step:
            for identifier, sender, text in re.findall(
                r'\[target\] \[message_id=([0-9a-f-]+)\] occurred_at=\S+ sender=(contact|self): (.*)', current
            ):
                if text in step['old_message_ids']:
                    self.identifiers[step['old_message_ids'][text]] = identifier
        if 'old_memory_ids' in step:
            for candidate in json.loads(current):
                for memory in candidate['similar']:
                    if memory['text'] in step['old_memory_ids']:
                        self.identifiers[step['old_memory_ids'][memory['text']]] = memory['memory_id']

        def remap(value):
            if isinstance(value, str):
                return self.identifiers.get(value, value)
            if isinstance(value, list):
                return [remap(item) for item in value]
            if isinstance(value, dict):
                return {key: remap(item) for key, item in value.items()}
            return value

        self.responses.append(tool_response(name, remap(step['arguments'])))
        return super()._generate(messages, stop, run_manager, **kwargs)


class MemoryBatchUpdatesHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    production_model_wiring = True
    dimension_release = None
    extraction_model_factory = BatchUpdateReplayModel
    reply_model_factory = FidelityControlledModel
    _ok = EvolutionHttpSupport._ok
    _import_evolution_source = EvolutionHttpSupport._import_evolution_source

    def test_same_batch_replacements_keep_independent_supplement_and_current_reply_sources(self):
        self.contact_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'同批合成联系人')",
                (self.contact_id, self.owner_id),
            )
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=self.contact_id,
            channel='wechat', account_scope='synthetic-batch', conversation_locator='synthetic-'+self.contact_id.hex)
        when = datetime(2026, 10, 22, 9, tzinfo=timezone(timedelta(hours=8)))
        self._import_evolution_source([(False, text) for text in FIXTURE['initial']]+[(True,'收到。')], when=when)
        path = f'/api/contacts/{self.contact_id}'
        before = self._ok(path+'/memories')['memories']
        self.assertEqual(len(before), 2)
        self._import_evolution_source([(False, text) for text in FIXTURE['updated']]+[(True,'收到。')],
                                      when=when+timedelta(hours=1))
        memories = self._ok(path+'/memories')['memories']
        old_ids = {row['memory_id'] for row in before}
        retired = [row for row in memories if row['memory_id'] in old_ids]
        self.assertEqual([(row['status'], row['revision']) for row in retired], [('invalidated',2)]*2)
        active = [row for row in memories if row['status']=='active']
        self.assertEqual(len(active), 3)
        late = next(row for row in active if '晚上不喝' in row['text'])
        self.assertTrue(late['evolution']['source_supported'])
        self.assertTrue(late['conditions']['items'][0]['source_supported'])
        self.assertEqual(self._ok(path+'/memory-candidates')['candidates'], [])
        self.reply_model.plans.append({'text':'今晚想请你喝不含咖啡因的饮料。',
                                       'basis':'保留晚间饮品限制。'})
        reply = self._ok('/api/reply/generate', {'contact_id':str(self.contact_id),
            'idempotency_key':str(uuid4()), 'content':{'type':'rewrite_draft',
                'draft_text':'今晚想请你喝不含咖啡因的饮料。', 'include_relationship_context':True}})
        evidence = self._ok(path+'/replies/'+reply['reply_request_id']+'/evidence')['evidence']
        self.assertTrue(any(row.get('evidence_id')==late['memory_id'] for row in evidence), evidence)
