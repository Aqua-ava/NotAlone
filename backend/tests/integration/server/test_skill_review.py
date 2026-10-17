"""审核对照与发布的公开HTTP验收；仅替换外部模型，使用专属测试库。"""

import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage

from tests.integration.server import test_skill_learning as learning
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture, ScriptedCoreModel, tool_response


class SkillReviewModel(ScriptedCoreModel):
    """实际读取受控策略后才声明已用版本；不替代运行时或应用。"""

    respect_catalog: bool = True
    provider_calls: int = 0
    fail_at_provider_call: int | None = None
    on_provider_enter: object = None

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.provider_calls += 1
        if callable(self.on_provider_enter):
            self.on_provider_enter(self.provider_calls)
        if self.fail_at_provider_call == self.provider_calls:
            raise RuntimeError('合成SDK异常，不含真实模型或正文。')
        payload = next(json.loads(item.content) for item in messages if isinstance(item, HumanMessage))
        selection = payload['skill_selection']
        chosen = selection.get('version_id') if selection['mode'] == 'user' else None
        visible = any(isinstance(item, SystemMessage) and
            '/notalone/reply-skills/careful-response/SKILL.md' in str(item.content) for item in messages)
        if self.respect_catalog and not visible:
            chosen = None
        read = any(isinstance(item, ToolMessage) and item.name == 'read_file' for item in messages)
        if chosen and not read:
            self.responses.append(tool_response('read_file', {'file_path': '/notalone/reply-skills/careful-response/SKILL.md'}))
        else:
            self.responses.append(tool_response('ReplyRuntimeOutput', {
                'candidates': [{'text': '先核对一下，再说明我的想法。' if chosen else '我先说明一下想法。',
                    'basis': '依据用户本次明确的审核输入，不证明外部发送。',
                    'citation_ids': [item['evidence_id'] for item in payload['evidence']], 'risk_notes': []}],
                'used_skill_version_id': chosen}))
        return super()._generate(messages, stop, run_manager, **kwargs)


class SkillReviewHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    production_model_wiring = True
    dimension_release = None
    extraction_model_factory = learning.ControlledLearningModel
    reply_model_factory = SkillReviewModel
    _bind = learning.SkillLearningHttpTest._bind
    _configure = learning.SkillLearningHttpTest._configure
    _discussion = learning.SkillLearningHttpTest._discussion
    _wait_learning = learning.SkillLearningHttpTest._wait_learning
    _source_message = learning.SkillLearningHttpTest._source_message
    _delete_source = learning.SkillLearningHttpTest._delete_source

    def setUp(self):
        super().setUp()
        self.contact_id, self.second_contact_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            for identifier in (self.contact_id, self.second_contact_id):
                connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成审核联系人')",
                                   (identifier, self.owner_id))
        self.path = f'/api/contacts/{self.contact_id}/skill-learning'

    def _draft_for_review(self, *, with_source=False):
        self._bind(self.contact_id)
        source = self._source_message() if with_source else (None, None)
        self.extraction_model.responses.append(tool_response('SkillLearningProposal', learning.synthetic_proposal()))
        self.assertEqual(self._configure()[0][0], 200)
        session, _ = self._discussion(target=source[1])
        draft = self._wait_learning()['drafts'][0]
        return self.path + '/drafts/' + draft['draft_id'], draft, session, source[0]

    def _compare(self, path, draft, *, kind='contact', operation=None):
        scope = {'kind': kind, 'contact_id': str(self.contact_id) if kind == 'contact' else None,
                 'scene': '核对安排' if kind == 'scene' else None}
        command = {'expected_revision': draft['revision'], 'operation_key': operation or str(uuid4()),
                   'input': {'incoming_text': '合成审核情境：怎样说明自己的想法？',
                             'intent': '说明想法，不作额外承诺', 'scene': '核对安排'}, 'scope': scope}
        status, result = self.backend.request(path + '/compare', command)
        self.assertEqual(status, 200, result)
        return result['draft'], command

    def _approve(self, path, draft, *, operation=None):
        command = {'expected_revision': draft['revision'], 'operation_key': operation or str(uuid4()),
                   'comparison_id': draft['comparison']['comparison_id'], 'scope': draft['comparison']['scope'],
                   'confirmed': True, 'replacements_confirmed': True}
        status, result = self.backend.request(path + '/approve', command)
        self.assertEqual(status, 200, result)
        return result, command

    def test_review_compares_identical_input_without_publishing_then_approves_once(self):
        path, draft, _, _ = self._draft_for_review()
        compared, command = self._compare(path, draft)
        comparison = compared['comparison']
        self.assertTrue(comparison['valid'])
        self.assertEqual(comparison['draft_revision'], draft['revision'])
        self.assertEqual(comparison['before']['load_state'], 'not_used')
        self.assertEqual(comparison['after']['load_state'], 'loaded')
        self.assertEqual(self._get(self.backend, '/api/skills')['skills'], [])
        calls = len(self.reply_model.seen_calls)
        self.assertEqual(self.backend.request(path + '/compare', command)[0], 200)
        self.assertEqual(len(self.reply_model.seen_calls), calls)
        payloads = [json.loads(next(item.content for item in call if isinstance(item, HumanMessage)))
                    for call in self.reply_model.seen_calls]
        self.assertEqual({item['draft_text'] for item in payloads}, {'合成审核情境：怎样说明自己的想法？'})
        self.assertEqual({item['user_instruction'] for item in payloads},
                         {'审核演示输入，不证明收到或发送。用户本次明确意图：说明想法，不作额外承诺'})
        result, approve = self._approve(path, compared)
        self.assertEqual(result['draft']['status'], 'published')
        self.assertEqual(result['published']['version_number'], 1)
        self.assertEqual(self.backend.request(path + '/approve', approve), (200, result))
        self.assertEqual(len(self._get(self.backend, '/api/skills')['skills']), 1)
        restored = self._production_backend(self.owner_id)
        self.assertEqual(self._get(restored, path)['published'], result['published'])
        request = {'contact_id': str(self.contact_id), 'idempotency_key': str(uuid4()),
                   'content': {'type': 'rewrite_draft', 'draft_text': '合成实际候选输入'},
                   'skill_version_id': result['published']['version_id']}
        status, reply = self.backend.request('/api/reply/generate', request)
        self.assertEqual(status, 200, reply)
        self.assertEqual(reply['used_skill']['version_id'], result['published']['version_id'])
        self.assertEqual(reply['used_skill']['scope'], comparison['scope'])

    def test_edit_invalidates_old_comparison_and_defer_or_reject_persist(self):
        path, draft, _, _ = self._draft_for_review()
        compared, _ = self._compare(path, draft)
        strategy = compared['sanitized_strategy']
        editable = {key: strategy[key] for key in ('name', 'description', 'scene')}
        editable['methods'] = [{key: item[key] for key in ('key', 'title', 'instruction', 'replaces_method_ids')}
                               for item in strategy['methods']]
        editable['methods'][0]['instruction'] = '先核对表达意愿，再给出两种可编辑说法。'
        status, edited = self.backend.request(path + '/edit', {'expected_revision': compared['revision'],
            'operation_key': str(uuid4()), 'strategy': editable})
        self.assertEqual(status, 200, edited)
        self.assertIsNone(edited['draft']['comparison'])
        self.assertEqual(edited['draft']['revision'], compared['revision'] + 1)
        self.assertEqual(self.backend.request(path + '/approve', {'expected_revision': compared['revision'],
            'operation_key': str(uuid4()), 'comparison_id': compared['comparison']['comparison_id'],
            'confirmed': True, 'replacements_confirmed': True, 'scope': compared['comparison']['scope']})[0], 409)
        for decision in ('defer', 'reject'):
            status, edited = self.backend.request(path + '/decision', {'expected_revision': edited['draft']['revision'],
                'operation_key': str(uuid4()), 'decision': decision})
            self.assertEqual(status, 200, edited)
            self.assertEqual(edited['draft']['status'], 'rejected' if decision == 'reject' else 'pending')
        self.assertEqual(self._get(self._production_backend(self.owner_id), path)['draft'], edited['draft'])

    def test_scene_publication_requires_explicit_exact_scene_in_actual_candidates(self):
        path, draft, _, _ = self._draft_for_review()
        compared, _ = self._compare(path, draft, kind='scene')
        result, _ = self._approve(path, compared)
        for scene, used in ((None, False), ('其他场景', False), ('核对安排', True)):
            with self.subTest(scene=scene):
                status, reply = self.backend.request('/api/reply/generate', {'contact_id': str(self.contact_id),
                    'idempotency_key': str(uuid4()), 'scene': scene,
                    'content': {'type': 'rewrite_draft', 'draft_text': '合成场景输入'},
                    'skill_version_id': result['published']['version_id']})
                self.assertEqual(status, 200, reply)
                self.assertEqual(reply['used_skill'] is not None, used)
                provider_input = self.reply_model.seen_calls[-1]
                self.assertEqual(any(isinstance(item, SystemMessage) and
                    '/notalone/reply-skills/careful-response/SKILL.md' in str(item.content)
                    for item in provider_input), used)
        # 模型虚报不可读版本仍必须失败，不能靠修夹具放宽执行层门禁。
        self.reply_model.respect_catalog = False
        status, reply = self.backend.request('/api/reply/generate', {'contact_id': str(self.contact_id),
            'idempotency_key': str(uuid4()), 'scene': None,
            'content': {'type': 'rewrite_draft', 'draft_text': '合成越界声明反例'},
            'skill_version_id': result['published']['version_id']})
        self.assertEqual((status, reply), (500, {'error': 'reply_generation_failed'}))

    def test_published_content_and_preview_are_erased_when_original_source_is_deleted(self):
        path, draft, _, source = self._draft_for_review(with_source=True)
        compared, command = self._compare(path, draft, kind='owner')
        result, approve = self._approve(path, compared)
        self._delete_source(source)
        self.assertEqual(self.backend.request(path)[0], 409)
        self.assertEqual(self.backend.request(path + '/compare', command)[0], 409)
        self.assertEqual(self.backend.request(path + '/approve', approve)[0], 409)
        self.assertEqual(self._get(self._production_backend(self.owner_id), self.path)['drafts'], [])
        preview = self.backend.request('/api/skills/' + result['published']['skill_id'] + '/preview')
        self.assertIn(preview[0], (404, 409))

    def _publish_review_with_description(self, description):
        path, draft, _, source = self._draft_for_review(with_source=True)
        strategy = draft['sanitized_strategy']
        editable = {key: strategy[key] for key in ('name', 'description', 'scene')}
        editable['description'] = description
        editable['methods'] = [{key: item[key] for key in ('key', 'title', 'instruction', 'replaces_method_ids')}
                               for item in strategy['methods']]
        status, edited = self.backend.request(path + '/edit', {'expected_revision': draft['revision'],
            'operation_key': str(uuid4()), 'strategy': editable})
        self.assertEqual(status, 200, edited)
        compared, _ = self._compare(path, edited['draft'])
        published, _ = self._approve(path, compared)
        return source, published['published']

    @contextmanager
    def _source_delete_before_get(self, source):
        from notalone.persistence.locks import release_global_worker_lock, try_acquire_global_worker_lock
        with psycopg.connect(self.database_url, autocommit=True) as gate:
            self.assertTrue(try_acquire_global_worker_lock(gate))
            try:
                status, receipt = self.backend.request(f'/api/contacts/{self.contact_id}/sources/{source}', method='DELETE')
                self.assertEqual(status, 202, receipt)
                yield
            finally:
                release_global_worker_lock(gate)
        self._delete_source(source)

    def test_source_delete_erases_review_descriptions_before_get_and_preserves_independent_package(self):
        from pathlib import Path
        marker = '合成审核摘要删除标记一一〇七'
        source, published = self._publish_review_with_description(marker)
        package = Path(self.temporary.name) / 'independent-summary'
        package.mkdir()
        (package / 'SKILL.md').write_text('---\nname: independent-summary\ndescription: 合成独立包摘要保留\n---\n先核对含义。\n')
        status, independent = self.backend.request('/api/skills/import', {'package_path': str(package)})
        self.assertEqual(status, 200, independent)
        with self._source_delete_before_get(source):
            with psycopg.connect(self.database_url) as connection:
                descriptions = connection.execute('SELECT skill.description,version.description FROM public.reply_skill skill '
                    'JOIN public.reply_skill_version version ON version.skill_id=skill.id WHERE version.id=%s',
                    (UUID(published['version_id']),)).fetchone()
                self.assertNotIn(marker, json.dumps(descriptions, ensure_ascii=False))
                self.assertEqual(connection.execute('SELECT skill.description,version.description FROM public.reply_skill skill '
                    'JOIN public.reply_skill_version version ON version.skill_id=skill.id WHERE skill.id=%s',
                    (UUID(independent['skill_id']),)).fetchone(), ('合成独立包摘要保留', '合成独立包摘要保留'))
        self.assertNotIn(marker, json.dumps(self._get(self.backend, '/api/skills'), ensure_ascii=False))
        restarted = self._production_backend(self.owner_id)
        self.assertNotIn(marker, json.dumps(self._get(restarted, '/api/skills'), ensure_ascii=False))

    def test_source_delete_preserves_new_independent_current_version_and_catalog_description(self):
        from pathlib import Path
        from notalone.persistence.skill_library import PostgresSkillLibrary
        source, published = self._publish_review_with_description('合成旧审核摘要必须删除')
        package = Path(self.temporary.name) / published['name']
        package.mkdir()
        (package / 'SKILL.md').write_text(f"---\nname: {published['name']}\ndescription: 合成新版独立摘要保留\n---\n合成新版独立正文保留。\n")
        updated = PostgresSkillLibrary(self.database_url).update_package(self.owner_id, package)
        with self._source_delete_before_get(source):
            with psycopg.connect(self.database_url) as connection:
                self.assertEqual(connection.execute('SELECT description,content FROM public.reply_skill_version WHERE id=%s',
                    (UUID(published['version_id']),)).fetchone(), ('来源已删除', None))
                self.assertEqual(connection.execute('SELECT skill.description,skill.status,version.description,version.content,'
                    'version.is_current,version.review_origin FROM public.reply_skill skill JOIN public.reply_skill_version version '
                    'ON version.skill_id=skill.id WHERE version.id=%s', (updated.version_id,)).fetchone(),
                    ('合成新版独立摘要保留', 'active', '合成新版独立摘要保留', '合成新版独立正文保留。\n', True, False))
        self.assertEqual(self._get(self.backend, '/api/skills')['skills'][0]['description'], '合成新版独立摘要保留')

    def test_review_with_captured_candidate_history_loads_read_only_and_remains_source_deletable(self):
        from notalone.persistence.skill_port import PostgresSkillPort
        from notalone.scopes import ContactScope
        self._bind(self.contact_id)
        source, message = self._source_message()
        session_path, _ = self._discussion(target=message)
        status, first = self.backend.request(session_path + '/replies', {
            'contact_id': str(self.contact_id), 'idempotency_key': str(uuid4()),
            'content': {'type': 'reply_to_message', 'target_message_id': str(message), 'direction': '合成说明想法'}})
        self.assertEqual(status, 200, first)
        status, second = self.backend.request(session_path + '/replies', {
            'contact_id': str(self.contact_id), 'idempotency_key': str(uuid4()),
            'content': {'type': 'rewrite_draft', 'draft_text': '合成第二轮明确意愿。'}})
        self.assertEqual(status, 200, second)
        candidate = second['candidates'][0]
        versions_path = session_path + f"/candidates/{candidate['candidate_id']}/versions"
        status, edited = self.backend.request(versions_path, {'edit_key': str(uuid4()),
            'parent_version_id': candidate['candidate_id'], 'messages': [{
                'message_id': candidate['messages'][0]['message_id'], 'text': '合成用户编辑：先核对，再说明。'}],
            'requirements': '合成明确纠正：保持自己的边界。'})
        self.assertEqual(status, 200, edited)
        status, selected = self.backend.request(session_path + '/selections', {'selection_key': str(uuid4()),
            'candidate_id': candidate['candidate_id'], 'version_id': edited['versions'][-1]['version_id']})
        self.assertEqual(status, 200, selected)
        with psycopg.connect(self.database_url) as connection:
            snapshot = connection.execute('SELECT context_snapshot FROM public.reply_request WHERE id=%s',
                (UUID(second['reply_request_id']),)).fetchone()[0]
            self.assertIn('assistant_discussion_snapshot', snapshot)
        self._discussion(correction='合成纠正：先核对自己的表达意愿。')
        self.extraction_model.responses.append(tool_response('SkillLearningProposal', learning.synthetic_proposal()))
        self.assertEqual(self._configure()[0][0], 200)
        draft = self._wait_learning()['drafts'][0]
        path = self.path + '/drafts/' + draft['draft_id']
        compared, _ = self._compare(path, draft)
        published, approval = self._approve(path, compared)
        version_id = UUID(published['published']['version_id'])
        loaded = PostgresSkillPort(self.database_url).load_version(ContactScope(self.owner_id, self.contact_id), version_id)
        self.assertTrue(loaded.content)
        status, actual = self.backend.request('/api/reply/generate', {'contact_id': str(self.contact_id),
            'idempotency_key': str(uuid4()), 'skill_version_id': str(version_id),
            'content': {'type': 'rewrite_draft', 'draft_text': '合成正式加载输入。'}})
        self.assertEqual(status, 200, actual)
        self.assertEqual(actual['used_skill']['version_id'], str(version_id))
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM public.assistant_candidate_version WHERE candidate_id=%s',
                (UUID(first['candidates'][0]['candidate_id']),)).fetchone()[0], 0)
        with self._source_delete_before_get(source):
            self._assert_physical_review_erasure(draft['draft_id'], str(version_id))
            with psycopg.connect(self.database_url) as connection:
                self.assertEqual(connection.execute('SELECT count(*) FROM public.assistant_candidate_version WHERE candidate_id=%s',
                    (UUID(candidate['candidate_id']),)).fetchone()[0], 0)
        self.assertEqual(self.backend.request(path + '/approve', approval)[0], 409)

    def test_scene_publication_used_in_same_contact_after_restart_is_source_deletable(self):
        path, draft, _, source = self._draft_for_review(with_source=True)
        compared, _ = self._compare(path, draft, kind='scene')
        published, _ = self._approve(path, compared)
        self.backend.close()
        self.backend = self._production_backend(self.owner_id)
        status, session = self.backend.request(f'/api/contacts/{self.contact_id}/assistant-session/default', {})
        self.assertEqual(status, 200, session)
        session_path = f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"
        for scene, expected in (('核对安排', True), ('其他场景', False)):
            status, reply = self.backend.request(session_path + '/replies', {
                'contact_id': str(self.contact_id), 'idempotency_key': str(uuid4()), 'scene': scene,
                'content': {'type': 'initiate_conversation', 'purpose': '说明想法，不作额外承诺'},
                'skill_version_id': published['published']['version_id']})
            self.assertEqual(status, 200, reply)
            self.assertEqual(reply['used_skill'] is not None, expected)
        self._delete_source(source)
        self._assert_physical_review_erasure(draft['draft_id'], published['published']['version_id'])

    def test_prepared_wide_skill_without_reply_request_is_erased_before_read_and_scene_cannot_change(self):
        path, draft, _, source = self._draft_for_review(with_source=True)
        compared, _ = self._compare(path, draft, kind='owner')
        published, approval = self._approve(path, compared)
        self._bind(self.second_contact_id)
        status, session = self.backend.request(f'/api/contacts/{self.second_contact_id}/assistant-session/default', {})
        self.assertEqual(status, 200, session)
        session_path = f"/api/contacts/{self.second_contact_id}/assistant-sessions/{session['session_id']}"
        key = str(uuid4())
        command = {'contact_id': str(self.second_contact_id), 'idempotency_key': key, 'scene': '核对安排',
                   'content': {'type': 'rewrite_draft', 'draft_text': '合成跨联系人准备输入'},
                   'skill_version_id': published['published']['version_id']}
        calls = self.reply_model.provider_calls
        status, receipt = self.backend.request(session_path + '/replies/prepare', command)
        self.assertEqual(status, 200, receipt)
        self.assertEqual(self.reply_model.provider_calls, calls)
        self.assertEqual(self.backend.request(session_path + '/replies/prepare', {**command, 'scene': '其他场景'})[0], 409)
        with psycopg.connect(self.database_url) as connection:
            saved = connection.execute('SELECT id,input_payload,prepared_context FROM public.assistant_session_turn '
                'WHERE owner_id=%s AND idempotency_key=%s', (self.owner_id, UUID(key))).fetchone()
            self.assertEqual(saved[1]['scene'], '核对安排')
            self.assertIsNotNone(saved[2])
            self.assertEqual(connection.execute('SELECT count(*) FROM public.reply_request WHERE owner_id=%s AND idempotency_key=%s',
                (self.owner_id, UUID(key))).fetchone()[0], 0)
        self._delete_source(source)
        # 在任何恢复GET之前核原锁/事务内的物理擦除，不能只靠下次执行失败。
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute('SELECT input_payload,prepared_context,dependency_ids,state '
                'FROM public.assistant_session_turn WHERE id=%s', (saved[0],)).fetchone(), (None, None, [], 'redacted'))
        self.backend.close()
        self.backend = self._production_backend(self.owner_id)
        self.assertEqual(self.backend.request(path + '/approve', approval)[0], 409)
        self.assertEqual(self.backend.request(path + '/approve', {**approval, 'operation_key': str(uuid4())})[0], 409)
        self.assertEqual(self.reply_model.provider_calls, calls)

    def test_busy_source_delete_keeps_original_task_for_explicit_retry(self):
        from notalone.application import source_service
        from notalone.persistence.locks import try_acquire_global_worker_lock, release_global_worker_lock

        path, draft, _, source = self._draft_for_review(with_source=True)
        compared, _ = self._compare(path, draft, kind='scene')
        published, _ = self._approve(path, compared)
        attempted = threading.Event()
        original = source_service.run_worker

        def record_attempt(**kwargs):
            result = original(**kwargs)
            attempted.set()
            return result

        with psycopg.connect(self.database_url, autocommit=True) as lock:
            self.assertTrue(try_acquire_global_worker_lock(lock))
            with patch.object(source_service, 'run_worker', side_effect=record_attempt):
                status, accepted = self.backend.request(f'/api/contacts/{self.contact_id}/sources/{source}', method='DELETE')
                self.assertEqual((status, accepted['status']), (202, 'queued'))
                self.assertTrue(attempted.wait(3))
            release_global_worker_lock(lock)
        task = self._get(self.backend, f"/api/tasks/status?contact_id={self.contact_id}&task_id={accepted['task_id']}")
        self.assertEqual(task['status'], 'queued')
        self._delete_source(source)
        listed = self._get(self.backend, f'/api/contacts/{self.contact_id}/sources')['sources']
        self.assertEqual(listed[0]['task_id'], accepted['task_id'])
        self._assert_physical_review_erasure(draft['draft_id'], published['published']['version_id'])

    def test_every_provider_round_is_accounted_and_local_rejection_has_no_fake_call(self):
        path, draft, _, _ = self._draft_for_review()
        baseline = self._get(self.backend, '/api/ledger/summary')['total_calls']
        _, command = self._compare(path, draft)
        self.assertEqual(self.reply_model.provider_calls, 3)
        self.assertEqual(self._get(self.backend, '/api/ledger/summary')['total_calls'] - baseline, 3)
        self.reply_model.fail_at_provider_call = self.reply_model.provider_calls + 1
        baseline = self._get(self.backend, '/api/ledger/summary')['total_calls']
        status, _ = self.backend.request(path + '/compare', {**command, 'operation_key': str(uuid4())})
        self.assertEqual(status, 500)
        self.assertEqual(self._get(self.backend, '/api/ledger/summary')['total_calls'] - baseline, 1)
        self.assertEqual(self._get(self.backend, '/api/ledger/summary')['outcome_counts']['run_failed'], 1)
        self.reply_model.fail_at_provider_call = None
        self.reply_model.extra_body = {'messages': []}
        baseline = self._get(self.backend, '/api/ledger/summary')['total_calls']
        calls = self.reply_model.provider_calls
        self.assertEqual(self.backend.request(path + '/compare', {**command, 'operation_key': str(uuid4())})[0], 500)
        self.assertEqual(self.reply_model.provider_calls, calls)
        self.assertEqual(self._get(self.backend, '/api/ledger/summary')['total_calls'], baseline)

    def test_expired_comparison_rejects_late_provider_result_without_new_lease_holder(self):
        path, draft, _, _ = self._draft_for_review()
        now = [datetime(2026, 10, 15, tzinfo=timezone.utc)]
        self.reply_model.on_provider_enter = lambda _: now.__setitem__(0, now[0] + timedelta(minutes=3))
        with patch('notalone.persistence.skill_review.review_now', side_effect=lambda: now[0]):
            scope = {'kind': 'contact', 'contact_id': str(self.contact_id), 'scene': None}
            status, result = self.backend.request(path + '/compare', {'expected_revision': draft['revision'],
                'operation_key': str(uuid4()), 'input': {'incoming_text': '合成租约输入', 'intent': '说明想法', 'scene': '核对安排'},
                'scope': scope})
            self.assertEqual((status, result), (409, {'error': 'skill_learning_stale_or_disabled'}))
        self.assertIsNone(self._get(self.backend, path)['draft']['comparison'])
        self.assertEqual(self.reply_model.provider_calls, 1)

    def test_edit_cannot_publish_contact_identity_or_private_source_quote(self):
        path, draft, _, _ = self._draft_for_review(with_source=True)
        strategy = draft['sanitized_strategy']
        editable = {key: strategy[key] for key in ('name', 'description', 'scene')}
        editable['methods'] = [{key: item[key] for key in ('key', 'title', 'instruction', 'replaces_method_ids')}
                               for item in strategy['methods']]
        for private in ('合成审核联系人', '合成私密来话：先核对安排，再说明原因。'):
            editable['methods'][0]['instruction'] = private
            status, _ = self.backend.request(path + '/edit', {'expected_revision': draft['revision'],
                'operation_key': str(uuid4()), 'strategy': editable})
            self.assertEqual(status, 409)
            self.assertEqual(self._get(self.backend, path)['draft']['revision'], draft['revision'])

    def test_changed_input_and_library_revision_invalidate_old_approval(self):
        path, draft, _, _ = self._draft_for_review()
        first, command = self._compare(path, draft)
        second = self.backend.request(path + '/compare', {**command, 'operation_key': str(uuid4()),
            'input': {**command['input'], 'intent': '只确认含义，不承诺安排'}})[1]['draft']
        self.assertNotEqual(first['comparison']['input_version'], second['comparison']['input_version'])
        approve = {'expected_revision': draft['revision'], 'operation_key': str(uuid4()),
            'comparison_id': first['comparison']['comparison_id'], 'confirmed': True,
            'replacements_confirmed': True, 'scope': first['comparison']['scope']}
        self.assertEqual(self.backend.request(path + '/approve', approve)[0], 409)
        from pathlib import Path
        package = Path(self.temporary.name) / 'independent-method'
        package.mkdir()
        (package / 'SKILL.md').write_text('---\nname: independent-method\ndescription: 独立导入方法\n---\n\n先核对含义。\n')
        self.assertEqual(self.backend.request('/api/skills/import', {'package_path': str(package)})[0], 200)
        self.assertIsNone(self._get(self.backend, path)['draft']['comparison'])
        self.assertEqual(self.backend.request(path + '/approve', {**approve,
            'comparison_id': second['comparison']['comparison_id'], 'operation_key': str(uuid4())})[0], 409)

    def test_cross_scope_and_changed_approval_are_rejected_and_concurrent_approval_publishes_once(self):
        path, draft, _, _ = self._draft_for_review()
        self.assertEqual(self.other_backend.request(path)[0], 404)
        self.assertEqual(self.backend.request(path.replace(str(self.contact_id), str(self.second_contact_id)))[0], 404)
        compared, _ = self._compare(path, draft)
        comparison = compared['comparison']
        command = {'expected_revision': compared['revision'], 'operation_key': str(uuid4()),
                   'comparison_id': comparison['comparison_id'], 'scope': comparison['scope'],
                   'confirmed': True, 'replacements_confirmed': True}
        wrong = {**command, 'operation_key': str(uuid4()), 'scope': {'kind': 'owner', 'contact_id': None, 'scene': None}}
        self.assertEqual(self.backend.request(path + '/approve', wrong)[0], 409)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.backend.request(path + '/approve', command), range(2)))
        self.assertEqual([status for status, _ in results], [200, 200])
        self.assertEqual(results[0][1], results[1][1])
        versions = self._get(self.backend, '/api/skills/' + results[0][1]['published']['skill_id'] + '/versions')
        self.assertEqual(len(versions['versions']), 1)

    def test_source_delete_during_provider_discards_late_comparison_and_stops_next_call(self):
        self._late_deleted_comparison(delete_source=True)

    def test_preference_scope_and_revision_change_during_comparison_rejects_late_result(self):
        path, draft, _, _ = self._draft_for_review()
        status, saved = self.backend.request('/api/expression-preferences', {
            'operation_key': str(uuid4()), 'text': '合成长期要求：先核对，再说明。',
            'scope': {'contact_id': None, 'reply_mode': None},
            'origin': {'kind': 'manual'}, 'confirm_long_term': True})
        self.assertEqual(status, 200, saved)
        entered, release = threading.Event(), threading.Event()
        def pause(_):
            entered.set()
            if not release.wait(8):
                raise RuntimeError('合成偏好审核门超时。')
        self.reply_model.on_provider_enter = pause
        command = {'expected_revision': draft['revision'], 'operation_key': str(uuid4()),
            'input': {'incoming_text': '合成偏好审核输入', 'intent': '先说明想法', 'scene': '核对安排'},
            'scope': {'kind': 'owner', 'contact_id': None, 'scene': None}}
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, path + '/compare', command)
            self.assertTrue(entered.wait(5))
            try:
                preference = saved['preference']
                status, changed = self.backend.request('/api/expression-preferences/' + preference['preference_id']
                    + f'?contact_id={self.contact_id}', {'operation_key': str(uuid4()),
                        'expected_revision': preference['revision'], 'text': '合成修订要求：只回应重点。',
                        'scope': {'contact_id': str(self.contact_id), 'reply_mode': 'rewrite_draft'},
                        'confirm_long_term': True}, method='PATCH')
                self.assertEqual(status, 200, changed)
            finally:
                release.set()
            self.assertEqual(pending.result()[0], 409)
        self.assertEqual(self.reply_model.provider_calls, 1)
        self.assertIsNone(self._get(self.backend, path)['draft']['comparison'])
        self.assertEqual(self._get(self.backend, '/api/skills')['skills'], [])

    def test_session_delete_during_provider_discards_late_comparison_and_stops_next_call(self):
        self._late_deleted_comparison(delete_source=False)

    def _late_deleted_comparison(self, *, delete_source):
        path, draft, session, source = self._draft_for_review(with_source=True)
        entered, release = threading.Event(), threading.Event()

        def pause(_):
            entered.set()
            if not release.wait(8):
                raise RuntimeError('合成验收门超时。')

        self.reply_model.on_provider_enter = pause
        command = {'expected_revision': draft['revision'], 'operation_key': str(uuid4()),
            'input': {'incoming_text': '合成迟到审核输入', 'intent': '说明想法', 'scene': '核对安排'},
            'scope': {'kind': 'contact', 'contact_id': str(self.contact_id), 'scene': None}}
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, path + '/compare', command)
            self.assertTrue(entered.wait(5))
            if delete_source:
                self._delete_source(source)
            else:
                self.assertEqual(self.backend.request(session, {'confirmed': True}, method='DELETE')[0], 200)
            release.set()
            self.assertEqual(pending.result()[0], 409)
        self.assertEqual(self.reply_model.provider_calls, 1)
        self.assertEqual(self.backend.request(path + '/compare', command)[0], 409)
        self.assertEqual(self._get(self._production_backend(self.owner_id), self.path)['drafts'], [])

    def test_extra_preview_source_erases_wide_publication_and_other_contact_reply_before_get(self):
        path, draft, _, _ = self._draft_for_review()
        source, message = self._source_message()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.message SET speaker='user' WHERE id=%s", (message,))
        status, sample = self.backend.request(f'/api/contacts/{self.contact_id}/style-samples', {
            'idempotency_key': str(uuid4()), 'text': '用户主动保存的合成参考表达。',
            'origin': {'kind': 'message', 'id': str(message)}})
        self.assertEqual(status, 200, sample)
        compared, _ = self._compare(path, draft, kind='owner')
        self.assertTrue(any(json.loads(next(item.content for item in call if isinstance(item, HumanMessage)))['style_references']
                            for call in self.reply_model.seen_calls))
        result, approve = self._approve(path, compared)
        self._bind(self.second_contact_id)
        status, session = self.backend.request(f'/api/contacts/{self.second_contact_id}/assistant-session/default', {})
        self.assertEqual(status, 200, session)
        session_path = f"/api/contacts/{self.second_contact_id}/assistant-sessions/{session['session_id']}"
        status, reply = self.backend.request(session_path + '/replies', {'contact_id': str(self.second_contact_id),
            'idempotency_key': str(uuid4()), 'content': {'type': 'rewrite_draft', 'draft_text': '合成广范围实际候选'},
            'skill_version_id': result['published']['version_id']})
        self.assertEqual(status, 200, reply)
        self.assertIsNotNone(reply['used_skill'])
        self._delete_source(source)
        self._assert_physical_review_erasure(draft['draft_id'], result['published']['version_id'])
        self.assertEqual(self.backend.request(path + '/approve', approve)[0], 409)
        restored = self._production_backend(self.owner_id)
        self.assertNotIn('先核对一下，再说明我的想法。', json.dumps(self._get(restored, session_path), ensure_ascii=False))

    def _assert_physical_review_erasure(self, draft_id, version_id):
        # 来源删除必须先完成同事务擦除，后续GET不能掩盖私密副本残留。
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute('SELECT status,strategy,private_evidence FROM public.skill_draft WHERE id=%s',
                (UUID(draft_id),)).fetchone(), ('invalidated', None, None))
            self.assertEqual(connection.execute('SELECT content,content_sha256,source_locator,status FROM public.reply_skill_version WHERE id=%s',
                (UUID(version_id),)).fetchone(), (None, None, None, 'deleted'))
            self.assertEqual(connection.execute('SELECT count(*) FROM public.skill_review_comparison WHERE draft_id=%s AND '
                '(input IS NOT NULL OR result IS NOT NULL OR context_fingerprint IS NOT NULL OR cardinality(dependency_ids)>0)',
                (UUID(draft_id),)).fetchone()[0], 0)
            self.assertEqual(connection.execute('SELECT count(*) FROM public.reply_skill_method WHERE version_id=%s AND '
                '(title IS NOT NULL OR instruction IS NOT NULL)', (UUID(version_id),)).fetchone()[0], 0)
            self.assertEqual(connection.execute('SELECT count(*) FROM public.skill_review_operation WHERE draft_id=%s '
                'AND request_fingerprint IS NOT NULL', (UUID(draft_id),)).fetchone()[0], 0)
            self.assertEqual(connection.execute('SELECT count(*) FROM public.reply_request WHERE owner_id=%s AND skill_version_id=%s',
                (self.owner_id, UUID(version_id))).fetchone()[0], 0)

    def test_owner_navigation_only_source_erases_comparison_and_publication_before_read(self):
        self._navigation_only_source_erasure(owner=True)

    def test_contact_navigation_only_source_erases_comparison_and_publication_before_read(self):
        self._navigation_only_source_erasure(owner=False)

    def test_owner_navigation_from_another_contact_keeps_private_window_out_and_erases_publication(self):
        self._navigation_only_source_erasure(owner=True, other_origin=True)

    def _navigation_only_source_erasure(self, *, owner, other_origin=False):
        from notalone.memory.models import FactSubject, MemoryCandidate, MemoryCategory, MemoryTopic
        from notalone.memory_extraction.cli_support import load_contact_messages
        from notalone.memory_extraction.evidence import build_dimension_evidence
        from notalone.memory_extraction.models import ExtractedFact, ExtractionWindow
        from notalone.persistence.memory_store import PostgresMemoryStore
        from notalone.scopes import ContactScope

        path, draft, _, _ = self._draft_for_review()
        review_contact = self.contact_id
        if other_origin:
            self.contact_id = self.second_contact_id
        _, direct = self._source_message()
        hidden_source, hidden = self._source_message()
        text = ('本人' if owner else '对方') + '偏好先说明自己的想法。'
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.message SET speaker='user',text_content=%s WHERE id=%s", (text, direct))
            connection.execute("UPDATE public.message SET text_content='合成窗口中的额外私密背景。' WHERE id=%s", (hidden,))
        scope = ContactScope(self.owner_id, self.contact_id)
        fact = ExtractedFact(text=text, category=MemoryCategory.PREFERENCE, subject=FactSubject.SELF if owner else FactSubject.CONTACT,
            topic=MemoryTopic.OTHER, source_message_ids=(direct,), confidence=.95)
        evidence = build_dimension_evidence(ExtractionWindow(self.owner_id, self.contact_id,
            load_contact_messages(scope, self.database_url)), fact, None)
        candidate = PostgresMemoryStore(self.database_url).create_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=scope, text=text, category=fact.category, subject=fact.subject,
            topic=fact.topic, source_ids=(direct,), dimension_evidence=evidence))
        status, confirmed = self.backend.request(f'/api/contacts/{self.contact_id}/memory-candidates/{candidate.candidate_id}/confirm', {})
        self.assertEqual(status, 200, confirmed)
        self.contact_id = review_contact
        compared, command = self._compare(path, draft, kind='owner')
        payload = json.loads(next(item.content for item in self.reply_model.seen_calls[-1] if isinstance(item, HumanMessage)))
        memory = next(item for item in payload['evidence'] if item['kind'] == ('owner_memory' if owner else 'confirmed_memory'))
        self.assertEqual(memory['evidence_id'], confirmed['memory']['memory_id'])
        self.assertNotIn(str(hidden_source), str(payload['evidence']))
        self.assertNotIn(str(hidden), str(payload['evidence']))
        self.assertNotIn('合成窗口中的额外私密背景', str(payload))
        published, approve = self._approve(path, compared)
        self._bind(self.second_contact_id)
        status, used = self.backend.request('/api/reply/generate', {
            'contact_id': str(self.second_contact_id), 'idempotency_key': str(uuid4()),
            'content': {'type': 'rewrite_draft', 'draft_text': '合成其他关系实际使用已审核方法'},
            'skill_version_id': published['published']['version_id']})
        self.assertEqual(status, 200, used)
        self.assertEqual(used['used_skill']['version_id'], published['published']['version_id'])
        if other_origin:
            self.contact_id = self.second_contact_id
        self._delete_source(hidden_source)
        self.contact_id = review_contact
        self._assert_physical_review_erasure(draft['draft_id'], published['published']['version_id'])
        self.assertEqual(self.backend.request(path + '/compare', command)[0], 409)
        self.assertEqual(self.backend.request(path + '/approve', approve)[0], 409)

    def test_delete_after_completed_comparison_blocks_approval_replay_and_restore(self):
        from notalone.application.source_service import SourceService

        path, draft, _, source = self._draft_for_review(with_source=True)
        compared, _ = self._compare(path, draft)
        approve = {'expected_revision': compared['revision'], 'operation_key': str(uuid4()),
            'comparison_id': compared['comparison']['comparison_id'], 'scope': compared['comparison']['scope'],
            'confirmed': True, 'replacements_confirmed': True}
        with patch.object(SourceService, '_start', return_value=None):
            status, queued = self.backend.request(f'/api/contacts/{self.contact_id}/sources/{source}', method='DELETE')
            self.assertEqual((status, queued['status']), (202, 'queued'))
        self.assertEqual(self.backend.request(path + '/approve', approve)[0], 409)
        self._delete_source(source)
        for backend in (self.backend, self._production_backend(self.owner_id)):
            self.assertEqual(backend.request(path + '/approve', approve)[0], 409)
            self.assertEqual(self._get(backend, '/api/skills')['skills'], [])

    def test_missing_publication_after_physical_origin_contact_delete_cannot_load_as_import(self):
        path, draft, _, _ = self._draft_for_review()
        compared, _ = self._compare(path, draft, kind='owner')
        result, _ = self._approve(path, compared)
        self._bind(self.second_contact_id)
        body = {'contact_id': str(self.second_contact_id), 'idempotency_key': str(uuid4()),
            'content': {'type': 'rewrite_draft', 'draft_text': '合成其他关系实际候选'},
            'skill_version_id': result['published']['version_id']}
        status, reply = self.backend.request('/api/reply/generate', body)
        self.assertEqual(status, 200, reply)
        self.assertIsNotNone(reply['used_skill'])
        # 隔离库的FK故障夹具；不宣称存在联系人删除产品入口。
        with psycopg.connect(self.database_url) as connection:
            connection.execute('DELETE FROM public.contact WHERE owner_id=%s AND id=%s', (self.owner_id, self.contact_id))
            self.assertEqual(connection.execute('SELECT count(*) FROM public.reply_skill_publication WHERE version_id=%s',
                (UUID(result['published']['version_id']),)).fetchone()[0], 0)
        restored = self._production_backend(self.owner_id)
        status, reply = restored.request('/api/reply/generate', {**body, 'idempotency_key': str(uuid4())})
        self.assertEqual(status, 200, reply)
        self.assertIsNone(reply['used_skill'])
        self.assertFalse(any(isinstance(item, SystemMessage) and '/careful-response/SKILL.md' in str(item.content)
            for item in self.reply_model.seen_calls[-1]))

    def test_competing_target_update_invalidates_old_update_and_merge_approvals_after_restore(self):
        from pathlib import Path
        from uuid import uuid5
        import time

        self._bind(self.contact_id)
        targets = []
        for name in ('careful-response', 'calm-response'):
            package = Path(self.temporary.name) / name
            package.mkdir()
            (package / 'SKILL.md').write_text(f'---\nname: {name}\ndescription: 合成已有方法\n---\n\n先确认含义，再提出说明。\n')
            status, imported = self.backend.request('/api/skills/import', {'package_path': str(package)})
            self.assertEqual(status, 200, imported)
            targets.append(imported['skill_id'])
        self.assertEqual(self._configure()[0][0], 200)
        methods = [str(uuid5(UUID(item), 'whole_strategy')) for item in targets]
        seen, compared = set(), []
        for number, kind in enumerate(('update', 'merge', 'update')):
            self.extraction_model.responses.append(tool_response('SkillLearningProposal', learning.synthetic_proposal(
                kind=kind, targets=targets if kind == 'merge' else targets[:1],
                replaces=methods if kind == 'merge' else methods[:1])))
            _, material = self._discussion(correction=f'合成第{number}次明确纠正：先核对意图再组织说明。')
            deadline = time.monotonic() + 12
            while True:
                state = self._get(self.backend, self.path)
                fresh = [item for item in state['drafts'] if item['draft_id'] not in seen
                    and item['proposal_kind'] == kind
                    and any(source['material_id'] == material for source in item['private_evidence']['materials'])]
                if fresh:
                    break
                self.assertLess(time.monotonic(), deadline, '新材料未形成对应草稿。')
                time.sleep(.02)
            self.assertEqual(len(fresh), 1)
            draft = fresh[0]
            seen.add(draft['draft_id'])
            self.assertTrue(all(item['version_number'] == 1 for item in draft['target_versions']))
            path = self.path + '/drafts/' + draft['draft_id']
            preview, _ = self._compare(path, draft)
            compared.append((path, preview))
        published, _ = self._approve(*compared[-1])
        self.assertEqual(published['published']['version_number'], 2)
        for path, draft in compared[:2]:
            approve = {'expected_revision': draft['revision'], 'operation_key': str(uuid4()),
                'comparison_id': draft['comparison']['comparison_id'], 'scope': draft['comparison']['scope'],
                'confirmed': True, 'replacements_confirmed': True}
            for backend in (self.backend, self._production_backend(self.owner_id)):
                self.assertEqual(backend.request(path + '/approve', approve)[0], 409)
                self.assertEqual(backend.request(path + '/approve', approve)[0], 409)
        self.assertEqual(len(self._get(self.backend, f'/api/skills/{targets[0]}/versions')['versions']), 2)
        self.assertEqual(len(self._get(self.backend, f'/api/skills/{targets[1]}/versions')['versions']), 1)
        remaining = next(item for item in self._get(self.backend, '/api/skills')['skills'] if item['skill_id'] == targets[1])
        self.assertEqual(remaining['status'], 'active')

    def test_legacy_input_without_scene_stays_unscoped_after_interrupt_restore(self):
        path, draft, session_path, _ = self._draft_for_review()
        compared, _ = self._compare(path, draft, kind='scene')
        result, _ = self._approve(path, compared)
        body = {'contact_id': str(self.contact_id), 'idempotency_key': str(uuid4()),
            'content': {'type': 'rewrite_draft', 'draft_text': '合成没有场景的旧请求'},
            'skill_version_id': result['published']['version_id']}
        status, prepared = self.backend.request(session_path + '/replies/prepare', body)
        self.assertEqual(status, 200, prepared)
        self.assertEqual(self.backend.request(session_path + '/interrupt', {
            'request_key': prepared['request_key'], 'input_version_id': prepared['input_version_id']})[0], 200)
        restored = self._production_backend(self.owner_id)
        status, reply = restored.request(session_path + '/retry-interrupted', {
            'original_turn_id': prepared['turn_id'], 'original_input_version_id': prepared['input_version_id'],
            'request_key': str(uuid4())})
        self.assertEqual(status, 200, reply)
        self.assertIsNone(reply['used_skill'])
