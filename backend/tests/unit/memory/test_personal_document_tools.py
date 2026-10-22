"""个人资料合同和受限文档工具合并后的合成回归。"""
from copy import deepcopy
import json
import time
from types import SimpleNamespace
import unittest
from uuid import UUID

from langchain_core.messages import AIMessage

from notalone.application.layered_memory_service import LayeredMemoryService
from notalone.memory.layered import OrganizationBudget, OrganizationInput
from notalone.memory.organization_deadline import OrganizationCallDeadline
from notalone.memory.organization_sdk import DeepSeekOrganizationProposal
from notalone.memory.organization_isolation import isolate_proposal
from notalone.memory.profile_validation import validate_profile
from notalone.memory.profile_workspace import ProfileWorkspace, render_profile, validate_incremental_profile
from notalone.memory.scenario_validation import validate_proposal
from notalone.memory.scene_workspace import SceneWorkspace, render_scene
from notalone.scopes import OwnerScope


class PersonalDocumentToolsTest(unittest.TestCase):
    def setUp(self):
        self.budget = OrganizationBudget(max_model_calls=16, max_characters=128000)
        self.memory = OrganizationInput(UUID(int=1), 1, '本人从某年起每周参加绘画课。',
            'manual_entry', {'current_status': 'current_unverified'}, None, 'common_fact', None, None)
        self.paragraph = {'text': '本人可能对绘画有持续兴趣，尚不能确定。',
            'kind': 'inference', 'section': 'implicit_signals', 'basis': '持续参加课程提供兴趣线索。',
            'uncertainty': '没有直接确认偏好。', 'references': [{'memory_id': str(self.memory.memory_id), 'revision': 1}]}
        self.scene = {'scenario_id': str(UUID(int=2)), 'version_id': str(UUID(int=3)),
            'title': '绘画经历', 'hint': '长期课程与兴趣线索', 'paragraphs': [self.paragraph]}
        self.entry = {**self.paragraph, 'section': 'interests', 'temporal_status': 'uncertain'}

    def propose(self, layer, document, *, existing=None):
        test = self
        class Model:
            def __init__(self):
                self.messages, self.options = [], []

            def bind(self, **options):
                self.options.append(options)
                return self

            def invoke(self, messages):
                self.messages.append(deepcopy(messages))
                if len(self.messages) == 1:
                    return AIMessage(content='', tool_calls=[{'id': 'write', 'name': 'write',
                        'args': {'path': 'profile.md' if layer == 'l3' else 'drawing.md', 'content': document}}],
                        response_metadata={'finish_reason': 'tool_calls'})
                test.assertIn('已暂存', messages[-1].content)
                return AIMessage(content='完成', response_metadata={'finish_reason': 'stop'})
        model = Model()
        adapter = DeepSeekOrganizationProposal(model, layer=layer, budget=self.budget, transport=None,
            personal=True, document_tools=True)
        proposal = adapter.propose(memories=(self.memory,), scenarios=(), existing_profile=existing,
            budget=self.budget, deadline=OrganizationCallDeadline(time.monotonic() + 10))
        prompt = model.messages[0][0].content
        self.assertIn('可以从具体情境推断', prompt)
        self.assertNotIn('不得补造事实、推断性格动机', prompt)
        self.assertNotIn('不得从暂态推断人格', prompt)
        self.assertIn('行动', prompt)
        self.assertNotIn('输出完整JSON', prompt)
        self.assertEqual(model.options[0]['max_tokens'], 8192)
        return proposal, model

    def test_personal_scene_tool_preserves_inference_and_uncertainty(self):
        proposal, _ = self.propose('l2', render_scene(self.scene))
        checked = validate_proposal(proposal, (self.memory,), self.budget)
        paragraph = checked['scenarios'][0]['paragraphs'][0]
        for key, value in self.paragraph.items():
            if key != 'references':
                self.assertEqual(paragraph[key], value)

    def test_invalid_document_write_gets_feedback_before_model_finishes(self):
        scene_document = render_scene(self.scene)
        profile_document = render_profile({'entries':[self.entry]})
        test = self

        class RepairingModel:
            calls = 0

            def bind(self, **options):
                return self

            def invoke(self, messages):
                self.calls += 1
                if self.calls == 2:
                    test.assertIn('工具错误', messages[-1].content)
                if self.calls < 3:
                    return AIMessage(content='', tool_calls=[{'id':str(self.calls), 'name':'write',
                        'args':{'path':path, 'content':bad_document if self.calls == 1 else document}}],
                        response_metadata={'finish_reason':'tool_calls'})
                return AIMessage(content='完成', response_metadata={'finish_reason':'stop'})

        missing_metadata = '\n'.join(line for line in scene_document.split('\n') if not line.startswith('<!-- PERSONAL '))
        missing_entry_metadata = profile_document.replace('"kind": "inference", "section": "interests", "basis": "持续参加课程提供兴趣线索。", ', '')
        cases = [('l2','drawing.md',scene_document,scene_document.replace('\n', r'\n')),
                 ('l2','drawing.md',scene_document,missing_metadata),
                 ('l3','profile.md',profile_document,profile_document.replace('# 长期背景\n', '# 长期背景\n\n## interests\n')),
                 ('l3','profile.md',profile_document,missing_entry_metadata)]
        for layer, path, document, bad_document in cases:
            with self.subTest(layer=layer, bad_document=bad_document[:80]):
                model = RepairingModel()
                proposal = DeepSeekOrganizationProposal(model, layer=layer, budget=self.budget, transport=None,
                    personal=True, document_tools=True).propose(memories=(self.memory,), scenarios=(),
                        budget=self.budget, deadline=OrganizationCallDeadline(time.monotonic()+10))
                self.assertEqual(model.calls, 3)
                checked = (validate_proposal if layer == 'l2' else validate_profile)(proposal, (self.memory,), self.budget)
                actual = checked['scenarios'][0]['paragraphs'][0] if layer == 'l2' else checked['entries'][0]
                self.assertEqual(actual['text'], self.paragraph['text'])

    def test_personal_profile_tool_preserves_inference_and_old_context(self):
        existing = {'version_id': str(UUID(int=4)), 'entries': [self.entry]}
        proposal, model = self.propose('l3', render_profile(existing), existing=existing)
        checked = validate_profile(proposal, (self.memory,), self.budget)
        self.assertEqual(checked['entries'][0]['kind'], 'inference')
        self.assertEqual(checked['entries'][0]['basis'], self.entry['basis'])
        self.assertEqual(checked['entries'][0]['uncertainty'], self.entry['uncertainty'])
        self.assertEqual(json.loads(model.messages[0][1].content)['previous_profile'], existing)

    def test_unaffected_personal_profile_cannot_lose_classification(self):
        previous = {'entries': [self.entry]}
        changed = {**self.entry, 'kind': 'fact', 'basis': '错误地升级为确定事实。'}
        with self.assertRaises(ValueError):
            validate_incremental_profile({'entries': [changed]}, previous, ())

    def test_owner_profile_context_keeps_personal_metadata_and_strips_extra_references(self):
        service = object.__new__(LayeredMemoryService)
        service._profile_proposer = SimpleNamespace(document_tools=True)
        entry = deepcopy(self.entry)
        entry['references'][0]['private_note'] = '不进入模型的额外字段'
        work = SimpleNamespace(scope=OwnerScope(UUID(int=5)), existing_profile={'version_id': 'base', 'entries': [entry]},
            changed_scenarios=(), removed_scenario_version_ids=(), base_profile_version_id=UUID(int=4))
        result = service._incremental_profile_arguments(work)['existing_profile']['entries'][0]
        self.assertEqual(result['kind'], 'inference')
        self.assertEqual(result['basis'], self.entry['basis'])
        self.assertEqual(result['references'], self.entry['references'])

    def test_profile_read_and_compile_keep_contradictions(self):
        entry = {**self.entry, 'kind': 'contradiction', 'section': 'contradictions'}
        workspace = ProfileWorkspace({'entries': [entry]}, (self.scene,), self.budget)
        self.assertEqual(workspace.compile()['entries'], [entry])
        self.assertIn('PERSONAL', workspace.execute('read', {'path': self.scene['scenario_id'] + '.md'}))

    def test_bad_scene_metadata_or_sources_do_not_discard_valid_sibling(self):
        good = render_scene(self.scene)
        bad_documents = [good.replace('<!-- META {', '<!-- META {broken,', 1),
            good.replace('<!-- PERSONAL {', '<!-- PERSONAL {broken,', 1),
            good.replace('<!-- SOURCES [', '<!-- SOURCES [broken,', 1)]
        for bad in bad_documents:
            with self.subTest(document=bad[:35]):
                workspace = SceneWorkspace((), self.budget)
                workspace.execute('write', {'path': 'bad.md', 'content': bad})
                workspace.execute('write', {'path': 'good.md', 'content': good})
                raw = workspace.compile()
                filtered, _, rejected = isolate_proposal(raw, 'scenarios',
                    lambda value: validate_proposal(value, (self.memory,), self.budget), self.budget.max_scenarios)
                self.assertEqual(len(filtered['scenarios']), 1)
                self.assertEqual(len(rejected), 1)
                self.assertIn('reason', raw['scenarios'][0])

    def test_bad_profile_entry_does_not_discard_later_valid_entry(self):
        workspace = ProfileWorkspace(None, (), self.budget)
        good = render_profile({'entries': [self.entry]}).split('\n', 1)[1].strip()
        for bad in ('<!-- ENTRY {broken} -->\n坏元数据。', '<!-- ENTRY {broken\n未闭合元数据。'):
            with self.subTest(entry=bad):
                workspace.execute('write', {'path': 'profile.md', 'content': '# 长期背景\n\n' + bad + '\n\n' + good})
                raw = workspace.compile()
                filtered, _, rejected = isolate_proposal(raw, 'entries',
                    lambda value: validate_profile(value, (self.memory,), self.budget), self.budget.max_profile_entries)
                self.assertEqual(filtered['entries'], [self.entry])
                self.assertEqual(len(rejected), 1)
                self.assertIn('reason', raw['entries'][0])

    def test_profile_top_level_format_still_fails_closed(self):
        workspace = ProfileWorkspace(None, (), self.budget)
        workspace.execute('write', {'path': 'profile.md', 'content': '没有画像标题和条目边界。'})
        with self.assertRaises(ValueError):
            workspace.compile()
