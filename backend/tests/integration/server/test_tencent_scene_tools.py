"""聊天导入后经正式SDK和文档工具维护场景；只替换模型HTTP边界。"""
import json
import unittest
from datetime import datetime, timezone, timedelta
from threading import Event
from time import monotonic
from uuid import uuid4
from unittest.mock import patch

import httpx
import psycopg
from langchain_core.messages import AIMessage
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture, HttpBackend
from tests.integration.server.memory_skill_evolution_support import EvolutionHttpSupport
from tests.integration.server.test_tencent_l1_flow import BatchMemoryModel


class SceneToolsHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    production_model_wiring = True
    dimension_release = None
    extraction_model_factory = BatchMemoryModel
    _ok = EvolutionHttpSupport._ok
    _import_evolution_source = EvolutionHttpSupport._import_evolution_source

    def setUp(self):
        self.addCleanup(patch.stopall)
        patch('notalone.memory_extraction.recall.embed_texts', side_effect=lambda texts: [(1., 0.) for _ in texts]).start()
        super().setUp()
        self.contact_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成场景联系人')",
                               (self.contact_id, self.owner_id))
        self.scene_mode = 'create'
        self.scene_inputs = []
        self.when = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def test_bad_tool_path_can_be_corrected_before_publication(self):
        text = '长期每周参加合成读书会。'
        self.extraction_model.facts = {text: ('common_fact', 'other')}
        self._import_evolution_source([(False, text)], when=self.when)
        self.scene_mode = 'recover_path'
        state = self.ready(self.scene_backend())
        self.assertEqual([p['text'] for s in state['scenarios'] for p in s['paragraphs']], [text])
        self.assertEqual(state['model_calls_used'], 4)

    def test_imported_chat_becomes_scene_through_document_tools(self):
        text = '每周与联系人一起参加合成读书会。'
        self.extraction_model.facts = {text: ('common_fact', 'other')}
        self._import_evolution_source([(False, text)], when=self.when)
        backend = self.scene_backend()
        state = self.ready(backend)
        self.assertEqual([p['text'] for s in state['scenarios'] for p in s['paragraphs']], [text])
        self.assertEqual(state['model_calls_used'], 3, '写工具、完成和独立核验的实际请求都计费。')
        memories = self._ok(f'/api/contacts/{self.contact_id}/memories')['memories']
        self.assertEqual(state['scenarios'][0]['paragraphs'][0]['references'][0]['memory_id'], memories[0]['memory_id'])

    def test_personal_document_tools_keep_metadata_and_no_change_receipt(self):
        text, repeated = '长期每周参加合成读书会。', '重复确认合成读书安排。'
        self.extraction_model.facts = {value: ('common_fact', 'other') for value in (text, repeated)}
        self.extraction_model.action = 'store'
        self._import_evolution_source([(False, text)], when=self.when)
        backend = self.scene_backend(personal=True)
        before = self.ready(backend)
        paragraph = before['scenarios'][0]['paragraphs'][0]
        self.assertEqual(paragraph['kind'], 'fact')
        self.assertEqual(paragraph['section'], 'narrative')
        self.assertEqual(paragraph['basis'], '本条直接引用合成聊天事实。')
        self.scene_mode = 'unchanged'
        self._import_evolution_source([(False, repeated)], when=self.when + timedelta(days=1))
        final = self.ready(backend)
        self.assertEqual(final['scenarios'], before['scenarios'])
        self.assertEqual(final['covered_count'], 2)
        self.assertEqual(final['model_calls_used'], 2)

    def test_bad_document_does_not_reject_valid_sibling(self):
        text = '长期每周参加合成读书会。'
        self.extraction_model.facts = {text: ('common_fact', 'other')}
        self._import_evolution_source([(False, text)], when=self.when)
        self.scene_mode = 'mixed_bad_document'
        state = self.ready(self.scene_backend())
        self.assertEqual([p['text'] for s in state['scenarios'] for p in s['paragraphs']], [text])
        with psycopg.connect(self.database_url) as connection:
            trace = connection.execute('SELECT output_payload FROM public.layered_memory_batch '
                'WHERE owner_id=%s AND contact_id=%s ORDER BY created_at DESC LIMIT 1',
                (self.owner_id, self.contact_id)).fetchone()[0]
        self.assertEqual(len(trace['original']['scenarios']), 2)
        self.assertEqual(len(trace['rejected']), 1)

    def test_all_bad_documents_fail_without_claiming_coverage(self):
        text = '长期每周参加合成读书会。'
        self.extraction_model.facts = {text: ('common_fact', 'other')}
        self._import_evolution_source([(False, text)], when=self.when)
        self.scene_mode = 'all_bad_documents'
        backend = self.scene_backend()
        deadline = monotonic() + 8
        while True:
            state = self._ok(f'/api/contacts/{self.contact_id}/layered-memory', backend=backend)['layered_memory']
            if state['status'] == 'failed':
                break
            self.assertLess(monotonic(), deadline, state)
            Event().wait(.04)
        self.assertEqual(state['scenarios'], [])
        self.assertEqual(state['covered_count'], 0)
        self.assertEqual(state['error_code'], 'proposal_invalid')

    def test_merge_cannot_silently_drop_a_previous_source(self):
        first, second, new = '每周一起参加合成读书会。', '每月一起参加合成写作课。', '读书活动增加合成讨论环节。'
        self.extraction_model.facts = {text: ('common_fact', 'other') for text in (first, second, new)}
        self.extraction_model.action = 'store'
        self._import_evolution_source([(False, first), (False, second), (True, '收到合成安排。')], when=self.when)
        backend = self.scene_backend()
        before = self.ready(backend)
        self.assertEqual(len(before['scenarios']), 2)
        self.scene_mode = 'lossy_merge'
        self._import_evolution_source([(False, new)], when=self.when + timedelta(days=1))
        deadline = monotonic() + 8
        while True:
            state = self._ok(f'/api/contacts/{self.contact_id}/layered-memory', backend=backend)['layered_memory']
            if state['status'] == 'failed':
                break
            self.assertLess(monotonic(), deadline, state)
            Event().wait(.04)
        self.assertEqual(state['scenarios'], before['scenarios'], '未保留旧来源的合并不得部分发布或删除旧场景。')

    def test_new_chat_merges_documents_and_deleting_source_removes_derived_scene(self):
        from tests.integration.server.test_skill_learning import SkillLearningHttpTest
        first, second, new = '每周一起参加合成读书会。', '每月一起参加合成写作课。', '读书活动增加合成讨论环节。'
        self.extraction_model.facts = {text: ('common_fact', 'other') for text in (first, second, new)}
        self.extraction_model.action = 'store'
        source = self._import_evolution_source([(False, first), (False, second), (True, '收到合成安排。')], when=self.when)
        backend = self.scene_backend()
        before = self.ready(backend)
        self.scene_mode = 'merge'
        self._import_evolution_source([(False, new)], when=self.when + timedelta(days=1))
        after = self.ready(backend)
        self.assertEqual(len(after['scenarios']), 1)
        self.assertEqual({p['text'] for p in after['scenarios'][0]['paragraphs']}, {first, second, new})
        self.assertIn(after['scenarios'][0]['scenario_id'], {s['scenario_id'] for s in before['scenarios']})
        self.assertEqual(len(after['scenario_mappings']), 2)
        SkillLearningHttpTest._delete_source(self, source['source']['source_id'])
        state = self._ok(f'/api/contacts/{self.contact_id}/layered-memory', backend=backend)['layered_memory']
        self.assertEqual(state['scenarios'], [])

    def test_exact_edit_updates_same_document_with_both_sources(self):
        first, new = '每周一起参加合成读书会。', '读书活动增加合成讨论环节。'
        self.extraction_model.facts = {text: ('common_fact', 'other') for text in (first, new)}
        self.extraction_model.action = 'store'
        self._import_evolution_source([(False, first)], when=self.when)
        backend = self.scene_backend()
        before = self.ready(backend)
        self.scene_mode = 'edit'
        self._import_evolution_source([(False, new)], when=self.when + timedelta(days=1))
        after = self.ready(backend)
        self.assertEqual(len(after['scenarios']), 1)
        self.assertEqual(after['scenarios'][0]['scenario_id'], before['scenarios'][0]['scenario_id'])
        self.assertEqual({p['text'] for p in after['scenarios'][0]['paragraphs']}, {first, new})

    def test_tool_cannot_access_outside_scope_and_keeps_old_scene(self):
        self.assert_failed_tool_keeps_old_scene('escape')

    def test_tool_loop_exhaustion_keeps_old_scene_and_finite_physical_budget(self):
        self.assert_failed_tool_keeps_old_scene('endless')

    def assert_failed_tool_keeps_old_scene(self, mode):
        first, new = '每周一起参加合成读书会。', '读书活动增加合成讨论环节。'
        self.extraction_model.facts = {text: ('common_fact', 'other') for text in (first, new)}
        self.extraction_model.action = 'store'
        self._import_evolution_source([(False, first)], when=self.when)
        backend = self.scene_backend()
        before = self.ready(backend)
        self.scene_mode = mode
        self._import_evolution_source([(False, new)], when=self.when + timedelta(days=1))
        deadline = monotonic() + 8
        while True:
            state = self._ok(f'/api/contacts/{self.contact_id}/layered-memory', backend=backend)['layered_memory']
            if state['status'] in {'failed', 'paused'}:
                break
            self.assertLess(monotonic(), deadline, state)
            Event().wait(.04)
        self.assertEqual(state['scenarios'], before['scenarios'])
        self.assertEqual(state['model_calls_used'], 5)

    def test_unchanged_documents_acknowledge_new_input_without_new_scene_version(self):
        first, new = '每周一起参加合成读书会。', '这次只是重复确认读书安排。'
        self.extraction_model.facts = {text: ('common_fact', 'other') for text in (first, new)}
        self.extraction_model.action = 'store'
        self._import_evolution_source([(False, first)], when=self.when)
        backend = self.scene_backend(with_profile=True)
        before = self.ready(backend)
        self.scene_mode = 'unchanged'
        self._import_evolution_source([(False, new)], when=self.when + timedelta(days=1))
        after = self.ready(backend)
        self.assertEqual(after['scenarios'], before['scenarios'])
        self.assertEqual(after['organization_generation'], before['organization_generation'])
        self.assertEqual(after['covered_count'], 2)
        self.assertFalse(after['maintenance_pending'])
        self.assertEqual(after['profile']['version_id'], before['profile']['version_id'])
        self.assertEqual(after['model_calls_used'], 2, '无变化只运行提案和独立跳过核验，不重写画像。')
        third = '再次确认合成读书安排不变。'
        self.extraction_model.facts[third] = ('common_fact', 'other')
        self._import_evolution_source([(False, third)], when=self.when + timedelta(days=2))
        final = self.ready(backend)
        self.assertNotIn(new, self.scene_inputs[-1], '已核验无变化的资料不能在新任务重复成为输入。')
        self.assertIn(third, self.scene_inputs[-1])
        self.assertEqual(final['covered_count'], 3)
        self.assertEqual(final['scenarios'], before['scenarios'])
        self.assertEqual(final['model_calls_used'], 2)

    def test_deleted_no_change_source_is_not_reused_by_a_later_task(self):
        from tests.integration.server.test_skill_learning import SkillLearningHttpTest
        first, repeated, third = '每周一起参加合成读书会。', '重复确认合成读书安排。', '增加合成阅读讨论。'
        self.extraction_model.facts = {text: ('common_fact', 'other') for text in (first, repeated, third)}
        self.extraction_model.action = 'store'
        self._import_evolution_source([(False, first)], when=self.when)
        backend = self.scene_backend(with_profile=True)
        self.ready(backend)
        self.scene_mode = 'unchanged'
        source = self._import_evolution_source([(False, repeated)], when=self.when + timedelta(days=1))
        self.assertEqual(self.ready(backend)['covered_count'], 2)
        SkillLearningHttpTest._delete_source(self, source['source']['source_id'])
        self._import_evolution_source([(False, third)], when=self.when + timedelta(days=2))
        final = self.ready(backend)
        self.assertEqual(final['covered_count'], 2, '删除的无改动资料不得继续计入跨任务覆盖。')
        self.assertNotIn(repeated, self.scene_inputs[-1])
        self.assertIn(third, self.scene_inputs[-1])
        self.assertFalse(final['maintenance_pending'])

    def scene_backend(self, *, with_profile=False, personal=False):
        from notalone.memory.layered import OrganizationBudget
        from notalone.memory.organization_sdk import DeepSeekOrganizationProposal, DeepSeekOrganizationVerification
        from notalone.memory.organization_quality_transport import OrganizationQualityHTTPTransport
        from notalone.application.layered_memory_service import LayeredMemoryService
        from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
        from notalone.server.app import create_app
        budget = OrganizationBudget(max_model_calls=16, max_characters=32000)
        def respond(request):
            payload = json.loads(request.content)
            messages = payload['messages']
            initial = json.loads(messages[1]['content'])
            if payload.get('tools'):
                self.assertNotIn('只输出JSON', messages[0]['content'])
                self.assertNotIn('返回空列表', messages[0]['content'])
            if initial.get('layer') == 'l3' and hasattr(self, 'profile_response'):
                message = self.profile_response(payload)
            elif payload.get('tools'):
                documents = initial['documents']
                tool_results = [m for m in messages if m['role'] == 'tool']
                if not tool_results:
                    self.scene_inputs.append([memory['text'] for memory in initial['memories']])
                def call(name, args, index):
                    return {'id': str(index), 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}
                def document(memories, replaces=()):
                    meta = {'topic_key': 'reading-' + memories[0]['memory_id'], 'title': '共同活动', 'hint': '定期活动', 'replaces': list(replaces)}
                    return '<!-- META ' + json.dumps(meta) + ' -->\n\n' + '\n\n'.join(m['text'] + ('\n<!-- PERSONAL ' + json.dumps({'kind': 'fact', 'section': 'narrative', 'basis': '本条直接引用合成聊天事实。', 'uncertainty': ''}) + ' -->' if personal else '') + '\n<!-- SOURCES ' + json.dumps([{'memory_id': m['memory_id'], 'revision': m['revision']}]) + ' -->' for m in memories)
                if self.scene_mode == 'recover_path' and not tool_results:
                    calls = [call('read', {'path': '/memories/preferences.md'}, 0)]
                elif self.scene_mode in {'mixed_bad_document', 'all_bad_documents'}:
                    calls = []
                    if not tool_results:
                        calls = [call('write', {'path': 'bad.md', 'content': '<!-- META {broken} -->\n坏主题。'}, 0)]
                        if self.scene_mode == 'mixed_bad_document':
                            calls.append(call('write', {'path': 'good.md', 'content': document(initial['memories'])}, 1))
                elif self.scene_mode == 'recover_path' and len(tool_results) == 1:
                    self.assertIn('工具错误', tool_results[0]['content'])
                    self.assertNotIn('/memories/preferences.md', tool_results[0]['content'])
                    calls = [call('write', {'path': 'reading.md', 'content': document(initial['memories'])}, 1)]
                elif self.scene_mode == 'unchanged':
                    calls = []
                elif self.scene_mode == 'escape':
                    calls = [call('read', {'path': '../other-owner.md'}, 0)]
                elif self.scene_mode == 'endless':
                    calls = [call('read', {'path': documents[0]['path']}, len(tool_results))]
                elif documents and not tool_results:
                    calls = [call('read', {'path': d['path']}, i) for i, d in enumerate(documents)]
                elif not tool_results and not documents:
                    calls = [call('write', {'path': 'scene-' + m['memory_id'] + '.md', 'content': document([m])}, i) for i, m in enumerate(initial['memories'])]
                elif documents and len(tool_results) == len(documents):
                    memories = initial['memories'][:1] if self.scene_mode == 'lossy_merge' else initial['memories']
                    calls = [call('write', {'path': documents[0]['path'], 'content': document(memories, [d['version_id'] for d in documents])}, 10)]
                    if self.scene_mode == 'append':
                        old_content = '\n'.join(m['content'] for m in tool_results)
                        added = [m for m in memories if m['memory_id'] not in old_content]
                        calls = [call('write', {'path': 'scene-' + m['memory_id'] + '.md', 'content': document([m])}, 10+i) for i,m in enumerate(added)]
                    if self.scene_mode == 'edit':
                        calls = [call('edit', {'path': documents[0]['path'], 'edits': [{'oldText': tool_results[0]['content'], 'newText': document(memories)}]}, 10)]
                    if self.scene_mode != 'append':
                        calls += [call('write', {'path': d['path'], 'content': '[DELETED]'}, 11+i) for i, d in enumerate(documents[1:])]
                else:
                    calls = []
                message = {'content': '' if calls else '完成', 'tool_calls': calls}
            else:
                data = json.loads(messages[-1]['content'])
                if data.get('layer') == 'l3':
                    result = {'supported': True, 'reasons': [], 'entries': []} if 'proposal' in data else {'entries': []}
                elif 'no_change_target' in data:
                    result = {'sha256': data['no_change_target'], 'supported': True, 'reasons': ['重复确认无需改文档。']}
                elif personal:
                    by_id = {m['memory_id']: m for m in data['memories']}
                    result = {'items': [{**target, 'supported': True, 'contains_action_guidance': False,
                        'correction_respected': True, 'reasons': [], 'statements': [
                            {'index': index, 'kind': paragraph['kind'], 'support_type': 'direct',
                             'supported': True, 'uncertainty_preserved': True, 'basis': paragraph['basis'],
                             'sources': [{**ref, 'quote': by_id[ref['memory_id']]['text']} for ref in paragraph['references']]}
                            for index, paragraph in enumerate(data['proposal']['scenarios'][target['index']]['paragraphs'])]}
                        for target in data['verification_targets']]}
                else:
                    result = {'items': [{**target, 'supported': True, 'reasons': []} for target in data['verification_targets']]}
                message = {'content': json.dumps(result)}
            return httpx.Response(200, json={'model': 'unconfigured', 'choices': [{'message': message, 'finish_reason': 'tool_calls' if message.get('tool_calls') else 'stop'}]})
        transport = OrganizationQualityHTTPTransport(httpx.MockTransport(respond))
        client = httpx.Client(transport=transport)
        self.addCleanup(client.close)
        class Model:
            def bind(self, **options):
                self.options = options
                return self
            def invoke(self, messages):
                rows = [{'role': {'human': 'user', 'ai': 'assistant'}.get(m.type, m.type), 'content': m.content} for m in messages]
                result = client.post('https://synthetic.invalid/chat/completions', json={'model': 'unconfigured', 'messages': rows, **self.options}).json()['choices'][0]
                raw = result['message']
                return AIMessage(content=raw['content'], tool_calls=[{'id': c['id'], 'name': c['function']['name'], 'args': json.loads(c['function']['arguments'])} for c in raw.get('tool_calls', [])], response_metadata={'finish_reason': result['finish_reason']})
        proposer = DeepSeekOrganizationProposal(Model(), layer='l2', budget=budget, transport=transport, personal=personal, document_tools=True)
        verifier = DeepSeekOrganizationVerification(Model(), layer='l2', budget=budget, transport=transport, personal=personal, document_tools=True)
        from notalone.memory.organization_deadline import SYNTHETIC_ORGANIZATION_TIMEOUT
        proposer.timeout_contract = verifier.timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT
        profile = {}
        if with_profile:
            pp = DeepSeekOrganizationProposal(Model(), layer='l3', budget=budget, transport=transport, document_tools=hasattr(self, 'profile_response'))
            pv = DeepSeekOrganizationVerification(Model(), layer='l3', budget=budget, transport=transport)
            pp.timeout_contract = pv.timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT
            profile = {'profile_proposer': pp, 'profile_verifier': pv}
        service = LayeredMemoryService(PostgresLayeredMemoryStore(self.database_url), proposer=proposer, verifier=verifier,
                                      budget=budget, synthetic=True, runtime_policy='verified_items', **profile)
        backend = HttpBackend(create_app(database_url=self.database_url, owner_id=self.owner_id, token='synthetic-scene-tools', layered_memory=service), self.owner_id)
        self.addCleanup(backend.close)
        return backend

    def ready(self, backend):
        deadline = monotonic() + 8
        while True:
            state = self._ok(f'/api/contacts/{self.contact_id}/layered-memory', backend=backend)['layered_memory']
            if state['status'] == 'ready' and not state['maintenance_pending']:
                return state
            self.assertNotIn(state['status'], ('failed', 'paused'), state)
            self.assertLess(monotonic(), deadline, state)
            Event().wait(.04)
