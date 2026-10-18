"""聊天至画像公开接口；仅脚本化模型HTTP响应，不替换画像业务代码。"""
import json
import unittest
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from threading import Event
from time import monotonic
from unittest.mock import patch

import psycopg
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server import test_tencent_scene_tools as scene_fixture
from tests.integration.server.test_tencent_l1_flow import BatchMemoryModel


class ProfileToolsHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    production_model_wiring = True
    dimension_release = None
    extraction_model_factory = BatchMemoryModel
    _ok = scene_fixture.SceneToolsHttpTest._ok
    _import_evolution_source = scene_fixture.SceneToolsHttpTest._import_evolution_source
    scene_backend = scene_fixture.SceneToolsHttpTest.scene_backend
    ready = scene_fixture.SceneToolsHttpTest.ready

    def setUp(self):
        self.addCleanup(patch.stopall)
        patch('notalone.memory_extraction.recall.embed_texts', side_effect=lambda texts: [(1., 0.) for _ in texts]).start()
        super().setUp()
        self.contact_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成增量画像联系人')",
                               (self.contact_id, self.owner_id))
        self.when = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.scene_mode = 'create'
        self.scene_inputs = []
        self.profile_inputs = []
        self.profile_mode = 'normal'

    def test_bad_profile_tool_path_can_be_corrected_before_publication(self):
        text = '长期每周参加合成读书会。'
        self.extraction_model.facts = {text: ('common_fact', 'other')}
        self._import_evolution_source([(False, text)], when=self.when)
        self.profile_mode = 'recover_path'
        state = self.ready(self.scene_backend(with_profile=True))
        self.assertEqual([e['text'] for e in state['profile']['entries']], [text])
        self.assertEqual(state['model_calls_used'], 7)

    def test_uncorrected_profile_path_exhausts_bounded_rounds_without_publication(self):
        text = '长期每周参加合成读书会。'
        self.extraction_model.facts = {text: ('common_fact', 'other')}
        self._import_evolution_source([(False, text)], when=self.when)
        self.profile_mode = 'escape'
        backend = self.scene_backend(with_profile=True)
        deadline = monotonic() + 8
        while True:
            state = self._ok(f'/api/contacts/{self.contact_id}/layered-memory', backend=backend)['layered_memory']
            if state['status'] in {'failed', 'paused'}:
                break
            self.assertLess(monotonic(), deadline, state)
            Event().wait(.04)
        self.assertIsNone(state['profile'])
        self.assertEqual(state['model_calls_used'], 8)

    def test_new_chat_updates_existing_profile_using_changed_scenes(self):
        first, new = '长期每周参加合成读书会。', '长期每月参加合成写作课。'
        self.extraction_model.facts = {t: ('common_fact', 'other') for t in (first, new)}
        self.extraction_model.action = 'store'
        self._import_evolution_source([(False, first)], when=self.when)
        backend = self.scene_backend(with_profile=True)
        before = self.ready(backend)
        self.assertEqual([e['text'] for e in before['profile']['entries']], [first])
        self._import_evolution_source([(False, new)], when=self.when + timedelta(days=1))
        after = self.ready(backend)
        self.assertEqual({e['text'] for e in after['profile']['entries']}, {first, new})
        incremental = self.profile_inputs[-1]
        self.assertEqual(incremental['base_profile_version_id'], before['profile']['version_id'])
        self.assertEqual(incremental['existing_profile']['entries'], before['profile']['entries'])
        self.assertTrue(incremental['changed_scenarios'])
        self.assertEqual(after['model_calls_used'], 7, 'L2四次加L3工具两次及独立核验一次。')

    def test_incremental_writer_cannot_drop_unaffected_profile_entry(self):
        first, new = '长期每周参加合成读书会。', '长期每月参加合成写作课。'
        self.extraction_model.facts = {t: ('common_fact', 'other') for t in (first, new)}
        self.extraction_model.action = 'store'
        self._import_evolution_source([(False, first)], when=self.when)
        backend = self.scene_backend(with_profile=True)
        before = self.ready(backend)
        self.scene_mode, self.profile_mode = 'append', 'drop_old'
        self._import_evolution_source([(False, new)], when=self.when + timedelta(days=1))
        deadline = monotonic() + 8
        while True:
            state = self._ok(f'/api/contacts/{self.contact_id}/layered-memory', backend=backend)['layered_memory']
            if state['status'] == 'failed':
                break
            self.assertLess(monotonic(), deadline, state)
            Event().wait(.04)
        self.assertIsNone(state['profile'], '丢弃未变化有效条目的画像不能发布。')
        self.assertEqual(len(state['scenarios']), 2)
        self.assertEqual(self.profile_inputs[-1]['existing_profile']['version_id'], before['profile']['version_id'])

    def test_fact_correction_rebuilds_without_invalid_old_profile_text(self):
        old, corrected = '长期每周参加合成读书会。', '长期每周参加合成绘画课。'
        self.extraction_model.facts = {old: ('common_fact', 'other')}
        self._import_evolution_source([(False, old)], when=self.when)
        backend = self.scene_backend(with_profile=True)
        before = self.ready(backend)
        memory = self._ok(f'/api/contacts/{self.contact_id}/memories')['memories'][0]
        self._ok(f'/api/contacts/{self.contact_id}/memories/{memory["memory_id"]}/correct',
            {'text': corrected, 'revision': memory['revision'], 'category': 'common_fact'})
        after = self.ready(backend)
        self.assertEqual([e['text'] for e in after['profile']['entries']], [corrected])
        self.assertIsNone(self.profile_inputs[-1]['existing_profile'], '失效基准正文不外发作新画像依据。')
        self.assertNotEqual(after['profile']['version_id'], before['profile']['version_id'])
        self.assertNotIn(old, json.dumps(self.profile_inputs[-1], ensure_ascii=False))

    def test_unchanged_scene_keeps_profile_version_without_profile_tool_calls(self):
        first, new = '长期每周参加合成读书会。', '再次确认原有合成读书安排。'
        self.extraction_model.facts = {t: ('common_fact', 'other') for t in (first, new)}
        self.extraction_model.action = 'store'
        self._import_evolution_source([(False, first)], when=self.when)
        backend = self.scene_backend(with_profile=True)
        before = self.ready(backend)
        self.scene_mode = 'unchanged'
        self._import_evolution_source([(False, new)], when=self.when + timedelta(days=1))
        after = self.ready(backend)
        self.assertEqual(after['profile'], before['profile'])
        self.assertEqual(after['model_calls_used'], 2)

    def test_deleting_source_erases_profile_and_prevents_old_basis_reuse(self):
        from tests.integration.server.test_skill_learning import SkillLearningHttpTest
        first = '长期每周参加合成读书会。'
        self.extraction_model.facts = {first: ('common_fact', 'other')}
        source = self._import_evolution_source([(False, first)], when=self.when)
        backend = self.scene_backend(with_profile=True)
        self.ready(backend)
        SkillLearningHttpTest._delete_source(self, source['source']['source_id'])
        state = self._ok(f'/api/contacts/{self.contact_id}/layered-memory', backend=backend)['layered_memory']
        self.assertIsNone(state['profile'])
        self.assertEqual(state['scenarios'], [])
        self.assertEqual(self._ok(f'/api/contacts/{self.contact_id}/memories')['memories'], [])

    def profile_response(self, payload):
        from notalone.memory.organization_quality import content_digest
        data = json.loads(payload['messages'][1]['content'])
        if 'proposal' in data:
            entries = []
            source = {m['memory_id']: m for m in data['memories']}
            for i, entry in enumerate(data['proposal']['entries']):
                entries.append({'entry_index': i, 'entry_sha256': content_digest(entry),
                    'references': entry['references'], 'supported': True,
                    'temporal_basis': 'current_unverified', 'temporal_references': [], 'basis': '保留未核实的持续状态。',
                    'claims': [{'text': entry['text'], 'sources': [{**r, 'quote': source[r['memory_id']]['text']} for r in entry['references']],
                        'subject_role': 'contact', 'subject_basis': '联系人直接陈述。', 'supported': True,
                        'value_category': 'enduring_fact_or_preference', 'relationship_impact': None,
                        'eligibility_basis': '合成长期事实，工程合同测试。'}]})
            return {'content': json.dumps({'supported': True, 'reasons': [], 'entries': entries})}
        results = [m for m in payload['messages'] if m['role'] == 'tool']
        if self.profile_mode == 'escape' or self.profile_mode == 'recover_path' and not results:
            return {'content': '', 'tool_calls': [{'id': 'bad-read', 'type': 'function', 'function': {
                'name': 'read', 'arguments': json.dumps({'path': '/memories/preferences.md'})}}]}
        if not results or self.profile_mode == 'recover_path' and len(results) == 1:
            if results:
                self.assertIn('工具错误', results[0]['content'])
                self.assertNotIn('/memories/preferences.md', results[0]['content'])
            self.profile_inputs.append(data)
            memories = data['memories']
            if self.profile_mode == 'drop_old':
                changed = {r['memory_id'] for scene in data['changed_scenarios'] for p in scene['paragraphs'] for r in p['references']}
                memories = [m for m in memories if m['memory_id'] in changed]
            content = '# 长期背景\n\n' + '\n\n'.join('<!-- ENTRY ' + json.dumps({
                'temporal_status': 'uncertain', 'uncertainty': '当前持续情况未核实。',
                'references': [{'memory_id': m['memory_id'], 'revision': m['revision']}]}) + ' -->\n' + m['text']
                for m in memories)
            return {'content': '', 'tool_calls': [{'id': 'profile-write', 'type': 'function', 'function': {
                'name': 'write', 'arguments': json.dumps({'path': 'profile.md', 'content': content})}}]}
        return {'content': '完成', 'tool_calls': []}
