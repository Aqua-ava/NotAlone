"""合成观察行验证来源世代；实际SQL与删除闭包另由PG用户用例覆盖。"""

from contextlib import nullcontext
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.persistence.skill_learning_generation import capture_generation
from notalone.scopes import ContactScope
from tests.unit.skills.test_learning_materials import MaterialRows


class GenerationQueries:
    def __init__(self, scope, observation):
        self.scope, self.observation = scope, observation

    def cursor(self, **_):
        return nullcontext(self)

    def execute(self, query, params):
        if 'FROM public.local_wechat_observation' in query:
            if params[:2] != (self.scope.owner_id, self.scope.contact_id):
                raise AssertionError('观察世代查询必须保持原联系人范围。')
            if 'to_jsonb(' in query:
                return MaterialRows([(self.observation['id'], dict(self.observation))])
            # 原四列查询的真实投影不包含绑定、可靠性或事件计数。
            return MaterialRows([tuple(self.observation[key] for key in
                                      ('id', 'record_count', 'last_cursor', 'read_at'))])
        if any(fragment in query for fragment in (
            'FROM public.message WHERE', 'FROM public.source_document',
            'FROM public.confirmed_memory AS memory',
            'FROM public.expression_preference AS preference',
        )):
            return MaterialRows([])
        raise AssertionError('合成世代端口出现未声明查询。')


class LearningGenerationTest(unittest.TestCase):
    def test_binding_reliability_and_observation_metadata_change_generation_without_retaining_raw_metadata(self):
        scope = ContactScope(uuid4(), uuid4())
        observation = {'id': uuid4(), 'owner_id': str(scope.owner_id), 'contact_id': str(scope.contact_id),
                       'binding_id': str(uuid4()), 'record_count': 1, 'last_cursor': 'synthetic-cursor',
                       'read_at': '2026-01-01T00:00:00Z', 'event_count': 1, 'is_reliable': True,
                       'conversation_locator': 'synthetic-private-observation-locator'}
        connection = GenerationQueries(scope, observation)
        with patch('notalone.persistence.skill_learning_generation.capture_message_snapshot', return_value={}):
            frozen = capture_generation(connection, scope, [observation['id']])
            for key, value in (('binding_id', str(uuid4())), ('is_reliable', False), ('event_count', 2)):
                with self.subTest(changed=key):
                    previous = observation[key]
                    observation[key] = value
                    current = capture_generation(connection, scope, [observation['id']])
                    self.assertNotEqual(current, frozen)
                    self.assertNotIn(observation['conversation_locator'], json.dumps(current))
                    observation[key] = previous
