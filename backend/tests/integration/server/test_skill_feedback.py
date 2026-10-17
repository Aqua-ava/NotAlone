"""明确方法停用的公开HTTP与实际执行视图；只使用合成资料和受控模型。"""

import hashlib
import json
import threading
import unittest
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from uuid import UUID, uuid4, uuid5

import psycopg
from psycopg.types.json import Jsonb
from langchain_core.messages import SystemMessage

from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server import test_skill_lifecycle as lifecycle, test_skill_review as review, test_skill_learning as learning
from tests.integration.server import test_assistant_continuation as continuation
from tests.integration.server import test_historical_reply_basis as commit_support
from tests.integration.persistence.concurrency import wait_for_blocked_operations


class SkillFeedbackHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    production_model_wiring = True
    dimension_release = None
    extraction_model_factory = lifecycle.SkillLifecycleHttpTest.extraction_model_factory
    reply_model_factory = review.SkillReviewModel
    _bind = lifecycle.SkillLifecycleHttpTest._bind
    _import = lifecycle.SkillLifecycleHttpTest._import
    _get_import = lifecycle.SkillLifecycleHttpTest._get_import
    _configure = lifecycle.SkillLifecycleHttpTest._configure
    _discussion = lifecycle.SkillLifecycleHttpTest._discussion
    _wait_learning = lifecycle.SkillLifecycleHttpTest._wait_learning
    _source_message = lifecycle.SkillLifecycleHttpTest._source_message
    _compare = lifecycle.SkillLifecycleHttpTest._compare
    _approve = lifecycle.SkillLifecycleHttpTest._approve
    _delete_source = lifecycle.SkillLifecycleHttpTest._delete_source
    _frame = continuation.AssistantContinuationHttpTest._frame
    _command = continuation.AssistantContinuationHttpTest._command

    def setUp(self):
        super().setUp()
        self.contact_id, self.second_contact_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            for identifier in (self.contact_id, self.second_contact_id):
                connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成反馈联系人')",
                                   (identifier, self.owner_id))
        self.path = f'/api/contacts/{self.contact_id}/skill-learning'

    def _reply(self, contact, version, *, scene=None):
        status, result = self.backend.request('/api/reply/generate', {
            'contact_id': str(contact), 'idempotency_key': str(uuid4()), 'scene': scene,
            'content': {'type': 'rewrite_draft', 'draft_text': '合成范围反馈后的当前表达'},
            'skill_version_id': version})
        self.assertEqual(status, 200, result)
        return result

    def _publish_two_methods(self, *, bind=True):
        if bind:
            self._bind(self.contact_id)
        source, message = self._source_message()
        proposal = learning.synthetic_proposal()
        proposal['description'] = '合成两条独立教学方法，待用户核验。'
        proposal['methods'] = [
            {'key': 'clarify', 'title': '合成被排除方法甲', 'instruction': '合成被排除方法甲：先作过度承诺。', 'replaces_method_ids': []},
            {'key': 'listen', 'title': '合成允许方法乙', 'instruction': '合成允许方法乙：先询问用户自己的边界。', 'replaces_method_ids': []}]
        self.extraction_model.responses.append(learning.tool_response('SkillLearningProposal', proposal))
        self.assertEqual(self._configure()[0][0], 200)
        self._discussion(target=message)
        draft = self._wait_learning()['drafts'][0]
        path = self.path + '/drafts/' + draft['draft_id']
        compared, _ = self._compare(path, draft, kind='owner')
        result, command = self._approve(path, compared)
        self._last_feedback_approval = (path, command)
        return result['published'], source

    def test_method_stop_filters_actual_body_and_receipt_only_in_explicit_contact_scene(self):
        published, _ = self._publish_two_methods()
        self._bind(self.second_contact_id)
        skill, version = published['skill_id'], published['version_id']
        first, second = (str(uuid5(UUID(skill), 'method:' + key)) for key in ('clarify', 'listen'))
        status, result = self.backend.request(self.path + '/policies', {
            'skill_id': skill, 'version_id': version, 'method_id': first,
            'scope': {'kind': 'scene', 'contact_id': str(self.contact_id), 'scene': '核对安排'},
            'disabled': True, 'expected_revision': 0, 'operation_key': str(uuid4())})
        self.assertEqual(status, 200, result)
        reply = self._reply(self.contact_id, version, scene='核对安排')
        self.assertEqual(reply['used_skill']['execution_view']['method_ids'], [second])
        self.assertEqual(reply['used_skill']['execution_view']['policy_revision'], result['revision'])
        self.assertEqual(len(reply['used_skill']['execution_view']['sha256']), 64)
        provider_input = str(self.reply_model.seen_calls[-1])
        self.assertNotIn('合成被排除方法甲', provider_input)
        self.assertIn('合成允许方法乙', provider_input)
        for contact, scene in ((self.contact_id, '其他场景'), (self.second_contact_id, '核对安排')):
            self._reply(contact, version, scene=scene)
            self.assertIn('合成被排除方法甲', str(self.reply_model.seen_calls[-1]))
        history = self._get(self.backend, self.path + '/skills/' + skill)
        self.assertIn('合成被排除方法甲', history['versions'][0]['document'], '执行视图不能改写原不可变发布。')

    def test_explicit_contact_skill_disable_is_immediate_durable_isolated_and_explicitly_reversible(self):
        self._bind(self.contact_id)
        self._bind(self.second_contact_id)
        skill = self._import()
        version = self._get(self.backend, '/api/skills')['skills'][0]['current_version_id']
        self.assertIsNotNone(self._reply(self.contact_id, version)['used_skill'])
        command = {'skill_id': skill, 'version_id': version, 'method_id': None,
            'scope': {'kind': 'contact', 'contact_id': str(self.contact_id), 'scene': None},
            'disabled': True, 'expected_revision': 0, 'operation_key': str(uuid4())}
        status, disabled = self.backend.request(self.path + '/policies', command)
        self.assertEqual(status, 200, disabled)
        self.assertEqual(self.backend.request(self.path + '/policies', command), (200, disabled))
        self.assertIsNone(self._reply(self.contact_id, version)['used_skill'])
        self.assertFalse(any(isinstance(item, SystemMessage) and '/careful-response/SKILL.md' in str(item.content)
                             for item in self.reply_model.seen_calls[-1]))
        self.assertIsNotNone(self._reply(self.second_contact_id, version)['used_skill'])
        self.backend = self._production_backend(self.owner_id)
        self.assertIsNone(self._reply(self.contact_id, version)['used_skill'])
        self.assertEqual(self.other_backend.request(self.path + '/policies')[0], 404)
        self.assertEqual(self.backend.request(self.path + '/policies', {
            **command, 'disabled': False, 'expected_revision': disabled['revision'], 'operation_key': str(uuid4())})[0], 200)
        self.assertIsNotNone(self._reply(self.contact_id, version)['used_skill'])
        self.assertEqual(self.backend.request(self.path + '/policies', command)[0], 409)

    def test_policy_change_rejects_completed_replay_and_continuation_but_keeps_user_edits_on_restore(self):
        self._bind(self.contact_id)
        skill = self._import()
        version = self._get(self.backend, '/api/skills')['skills'][0]['current_version_id']
        status, session = self.backend.request(f'/api/contacts/{self.contact_id}/assistant-session/default', {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"
        body = {'contact_id': str(self.contact_id), 'idempotency_key': str(uuid4()),
            'content': {'type': 'rewrite_draft', 'draft_text': '合成已有候选，不覆盖我的编辑。'}, 'skill_version_id': version}
        status, generated = self.backend.request(path + '/replies', body)
        self.assertEqual(status, 200, generated)
        candidate = generated['candidates'][0]
        versions_path = path + f"/candidates/{candidate['candidate_id']}/versions"
        original = self._get(self.backend, versions_path)['versions'][0]
        status, edited = self.backend.request(versions_path, {'edit_key': str(uuid4()),
            'parent_version_id': original['version_id'], 'requirements': '只保留用户自己的明确编辑。',
            'messages': [{'message_id': original['messages'][0]['message_id'], 'text': '合成用户独立编辑的完整文字。'}]})
        self.assertEqual(status, 200, edited)
        frame = self._frame(path, generated)
        status, policy = self.backend.request(self.path + '/policies', {'skill_id': skill, 'version_id': version,
            'method_id': None, 'scope': {'kind': 'contact', 'contact_id': str(self.contact_id), 'scene': None},
            'disabled': True, 'expected_revision': 0, 'operation_key': str(uuid4())})
        self.assertEqual(status, 200, policy)
        self.assertEqual(self.backend.request(path + '/replies', body)[0], 409)
        calls = self.reply_model.provider_calls
        self.assertEqual(self.backend.request(path + '/continue/prepare', self._command(generated, frame,
            instruction='保持用户编辑，仅调整当前表达。'))[0], 409)
        self.assertEqual(self.reply_model.provider_calls, calls)
        restored = self._production_backend(self.owner_id)
        history = self._get(restored, versions_path)
        self.assertEqual(history['versions'], edited['versions'])
        self.assertEqual(history['default_display_version_id'], edited['default_display_version_id'])
        turn = self._get(restored, path)['turns'][0]
        self.assertIn('skill_policy_changed', str(turn['reply']['basis_changes']))

    def test_stop_after_last_actual_read_rejects_late_commit_and_same_key_retry_reads_current_policy(self):
        self._bind(self.contact_id)
        skill = self._import()
        version = self._get(self.backend, '/api/skills')['skills'][0]['current_version_id']
        store = commit_support.CommitBoundaryReplyStore(self.database_url)
        with patch('notalone.server.reply_wiring.PostgresReplyStore', return_value=store):
            self.backend = self._production_backend(self.owner_id)
        body = {'contact_id': str(self.contact_id), 'idempotency_key': str(uuid4()),
            'content': {'type': 'rewrite_draft', 'draft_text': '合成读取后才停用的候选'}, 'skill_version_id': version}
        store.hold_before_commit = True
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, '/api/reply/generate', body)
            try:
                self.assertTrue(store.entered.wait(5), '已完成真实策略读取和模型验证。')
                status, policy = self.backend.request(self.path + '/policies', {
                    'skill_id': skill, 'version_id': version, 'method_id': None,
                    'scope': {'kind': 'contact', 'contact_id': str(self.contact_id), 'scene': None},
                    'disabled': True, 'expected_revision': 0, 'operation_key': str(uuid4())})
                self.assertEqual(status, 200, policy)
                store.release.set()
                self.assertNotEqual(pending.result(timeout=10)[0], 200)
            finally:
                store.release.set()
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM public.reply_candidate WHERE owner_id=%s',
                                               (self.owner_id,)).fetchone()[0], 0)
        status, retried = self.backend.request('/api/reply/generate', body)
        self.assertEqual(status, 200, retried)
        self.assertIsNone(retried['used_skill'])

    def test_unmapped_local_update_cannot_bypass_method_stop_and_rollback_keeps_the_stop(self):
        published, _ = self._publish_two_methods()
        skill, original = published['skill_id'], published['version_id']
        stopped = str(uuid5(UUID(skill), 'method:clarify'))
        status, result = self.backend.request(self.path + '/policies', {'skill_id': skill, 'version_id': original,
            'method_id': stopped, 'scope': {'kind': 'contact', 'contact_id': str(self.contact_id), 'scene': None},
            'disabled': True, 'expected_revision': 0, 'operation_key': str(uuid4())})
        self.assertEqual(status, 200, result)
        package = Path(self.temporary.name) / 'careful-response'
        package.mkdir()
        (package / 'SKILL.md').write_text('---\nname: careful-response\ndescription: 合成无细分映射的新版\n---\n合成被排除方法甲仍藏在旧式包正文。')
        (package / 'references').mkdir()
        (package / 'references/rules.md').write_text('合成被排除方法甲的辅助资源。')
        # 现有本地包更新是管理端口，HTTP并没有update路由。
        from notalone.persistence.skill_library import PostgresSkillLibrary
        PostgresSkillLibrary(self.database_url).update_package(self.owner_id, package)
        current = self._get(self.backend, self.path + '/skills/' + skill)
        self.assertIsNone(self._reply(self.contact_id, current['current_version_id'])['used_skill'],
                          '无可证方法映射的新旧包只能回退，不能换版本恢复停用方法。')
        status, rolled = self.backend.request(self.path + '/skills/' + skill + '/rollback', {
            'version_id': original, 'expected_revision': current['revision'],
            'expected_current_version_id': current['current_version_id'], 'operation_key': str(uuid4())})
        self.assertEqual(status, 200, rolled)
        self.assertEqual(self._reply(self.contact_id, original)['used_skill']['execution_view']['method_ids'],
                         [str(uuid5(UUID(skill), 'method:listen'))])

    def test_explicit_policy_can_be_removed_after_source_erasure_without_restoring_deleted_strategy(self):
        published, source = self._publish_two_methods()
        status, result = self.backend.request(self.path + '/policies', {
            'skill_id': published['skill_id'], 'version_id': published['version_id'], 'method_id': None,
            'scope': {'kind': 'contact', 'contact_id': str(self.contact_id), 'scene': None},
            'disabled': True, 'expected_revision': 0, 'operation_key': str(uuid4())})
        self.assertEqual(status, 200, result)
        self._delete_source(source)
        self.assertEqual(self.backend.request(self.path + '/skills/' + published['skill_id'])[0], 404)

        path = self.path + '/policies/' + result['policies'][0]['policy_id'] + '/undo'
        command = {'expected_revision': result['revision'], 'operation_key': str(uuid4())}
        status, undone = self.backend.request(path, command)
        self.assertEqual(status, 200, undone)
        self.assertEqual(undone['policies'], [])
        self.assertEqual(self.backend.request(path, command), (200, undone))
        self.assertEqual(self._get(self._production_backend(self.owner_id), self.path + '/policies'), undone)
        self.assertEqual(self.backend.request(self.path + '/skills/' + published['skill_id'])[0], 404)

    def test_review_preview_and_updated_version_filter_proposed_method_replacements_before_any_model_read(self):
        published, _ = self._publish_two_methods()
        skill, version = published['skill_id'], published['version_id']
        stopped, retained = (str(uuid5(UUID(skill), 'method:' + key)) for key in ('clarify', 'listen'))
        status, policy = self.backend.request(self.path + '/policies', {'skill_id': skill, 'version_id': version,
            'method_id': stopped, 'scope': {'kind': 'contact', 'contact_id': str(self.contact_id), 'scene': None},
            'disabled': True, 'expected_revision': 0, 'operation_key': str(uuid4())})
        self.assertEqual(status, 200, policy)
        proposal = learning.synthetic_proposal(kind='update', targets=[skill])
        proposal['methods'] = [
            {'key': 'revised-clarify', 'title': '合成仍被排除的新方法甲', 'instruction': '合成仍被排除的新方法甲：先过度承诺。', 'replaces_method_ids': [stopped]},
            {'key': 'revised-listen', 'title': '合成允许的新方法乙', 'instruction': '合成允许的新方法乙：先听取用户边界。', 'replaces_method_ids': [retained]}]
        self.extraction_model.responses.append(learning.tool_response('SkillLearningProposal', proposal))
        self._discussion(correction='合成明确长期调整：请提出待审核的更新，不改变停用。')
        draft = self._wait_learning()['drafts'][0]
        self.assertEqual(draft['status'], 'pending')
        self.assertEqual(draft['target_versions'][0]['skill_id'], skill)
        path = self.path + '/drafts/' + draft['draft_id']
        compared, _ = self._compare(path, draft, kind='owner')
        allowed = str(uuid5(UUID(skill), 'method:revised-listen'))
        self.assertNotIn('合成仍被排除的新方法甲', str(self.reply_model.seen_calls[-1]))
        self.assertIn('合成允许的新方法乙', str(self.reply_model.seen_calls[-1]))
        self.assertEqual(compared['comparison']['after']['execution_view']['method_ids'], [allowed])
        updated, _ = self._approve(path, compared)
        self.assertEqual(self._reply(self.contact_id, updated['published']['version_id'])['used_skill']['execution_view']['method_ids'], [allowed])

    def _ok(self, path, body=None):
        status, result = self.backend.request(path, body)
        self.assertEqual(status, 200, result)
        return result

    def _legacy_session(self):
        self._bind(self.contact_id)
        skill = self._import()
        version = self._ok('/api/skills')['skills'][0]['current_version_id']
        session = self._ok(f'/api/contacts/{self.contact_id}/assistant-session/default', {})
        path = f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"
        body = {'contact_id': str(self.contact_id), 'idempotency_key': str(uuid4()),
            'content': {'type': 'rewrite_draft', 'draft_text': '合成政策边界当前原句。'}, 'skill_version_id': version}
        return skill, version, path, body

    def _stop_skill(self, skill, version):
        status, result = self.backend.request(self.path + '/policies', {'skill_id': skill, 'version_id': version,
            'method_id': None, 'scope': {'kind': 'contact', 'contact_id': str(self.contact_id), 'scene': None},
            'disabled': True, 'expected_revision': 0, 'operation_key': str(uuid4())})
        self.assertEqual(status, 200, result)

    def _completion_after_saved_policy_change(self, *, interrupt):
        from tests.integration.server.test_assistant_generation_prepare import AssistantCompletionBarrierStore
        skill, version, path, body = self._legacy_session()
        barrier = AssistantCompletionBarrierStore(self.database_url)
        with patch('notalone.server.app.PostgresAssistantSessionStore', return_value=barrier):
            self.backend = self._production_backend(self.owner_id)
        prepared = self._ok(path + '/replies/prepare', body)
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + '/replies', body, timeout=20)
            try:
                self.assertTrue(barrier.entered.wait(5), '必须先实际保存C，再暂停A完成。')
                self._stop_skill(skill, version)
                if interrupt:
                    status, result = self.backend.request(path + '/interrupt', {
                        'request_key': prepared['request_key'], 'input_version_id': prepared['input_version_id']})
                    self.assertEqual(status, 409, result)
                    self.assertEqual(result['reason'], 'skill_policy_changed')
            finally:
                barrier.release.set()
            self.assertEqual(running.result(timeout=10)[0], 409)
        turn = self._get(self._production_backend(self.owner_id), path)['turns'][0]
        self.assertNotEqual(turn['state'], 'completed')
        self.assertIsNone(turn['reply'])

    def test_policy_change_between_saved_reply_and_assistant_completion_rejects_late_result(self):
        self._completion_after_saved_policy_change(interrupt=False)

    def test_policy_change_between_saved_reply_and_interrupt_cannot_complete_the_old_result(self):
        self._completion_after_saved_policy_change(interrupt=True)

    def test_carry_created_before_stop_cannot_restore_old_candidate_and_stop_prevents_new_carry(self):
        skill, version, path, body = self._legacy_session()
        generated = self._ok(path + '/replies', body)
        candidate = generated['candidates'][0]['candidate_id']
        original = self._ok(path + f'/candidates/{candidate}/versions')['versions'][0]
        selected = self._ok(path + '/selections', {'selection_key': str(uuid4()),
            'candidate_id': candidate, 'version_id': original['version_id']})
        carry = {'expected_selection_id': selected['selection_id'], 'candidate_id': candidate, 'version_id': original['version_id']}
        created = self._ok(path + '/new-with-candidate', carry)
        self._stop_skill(skill, version)
        self.assertEqual(self.backend.request(path + '/new-with-candidate', carry)[0], 409)
        self.backend = self._production_backend(self.owner_id)
        child = f"/api/contacts/{self.contact_id}/assistant-sessions/{created['session_id']}"
        calls = self.reply_model.provider_calls
        status, result = self.backend.request(child + '/replies', {**body, 'idempotency_key': str(uuid4()),
            'expected_input_version_id': created['input_version_id']})
        self.assertEqual(status, 409, result)
        self.assertEqual(self.reply_model.provider_calls, calls)
        self.assertEqual(self._ok(path + f'/candidates/{candidate}/versions')['versions'], [original])

    def test_prepared_unnumbered_continuation_and_interrupted_retry_revalidate_parent_policy(self):
        skill, version, path, body = self._legacy_session()
        generated = self._ok(path + '/replies', body)
        command = self._command(generated, self._frame(path, generated), instruction='再简短一些')
        prepared = self._ok(path + '/continue/prepare', command)
        self._stop_skill(skill, version)
        calls = self.reply_model.provider_calls
        self.assertEqual(self.backend.request(path + '/continue', command)[0], 409)
        interrupted = self._ok(path + '/interrupt', {
            'request_key': prepared['request_key'], 'input_version_id': prepared['input_version_id']})
        self.assertEqual(interrupted['state'], 'failed')
        self.backend = self._production_backend(self.owner_id)
        recovery = {'request_key': str(uuid4()), 'original_turn_id': prepared['turn_id'],
            'original_input_version_id': prepared['input_version_id']}
        for suffix in ('/retry-interrupted/prepare', '/retry-interrupted'):
            self.assertEqual(self.backend.request(path + suffix, recovery)[0], 409)
        self.assertEqual(self.reply_model.provider_calls, calls)

    def test_generic_descendant_that_actually_read_old_candidate_keeps_the_policy_edge(self):
        skill, version, path, body = self._legacy_session()
        first = self._ok(path + '/replies', body)
        generic_body = {**body, 'idempotency_key': str(uuid4()), 'skill_version_id': None,
            'skill_disabled': True, 'expected_input_version_id': first['input_version_id']}
        generic = self._ok(path + '/replies', generic_body)
        self.assertIsNone(generic['used_skill'])
        self.assertIn(first['candidates'][0]['text'], str(self.reply_model.seen_calls[-1]))
        self._stop_skill(skill, version)
        self.assertEqual(self.backend.request(path + '/replies', generic_body)[0], 409)
        restored = self._get(self._production_backend(self.owner_id), path)
        self.assertEqual(len(restored['turns']), 2)
        self.assertIn('skill_policy_changed', str(restored['turns'][1]['reply']['basis_changes']))
        # 独立的新输入可以重新生成，旧受影响候选不再进入模型历史。
        fresh = self._ok(path + '/replies', {**generic_body, 'idempotency_key': str(uuid4()),
            'expected_input_version_id': generic['input_version_id']})
        self.assertIsNone(fresh['used_skill'])
        self.assertNotIn('candidate_version', str(self.reply_model.seen_calls[-1]))

    def test_all_blocked_update_preview_is_rejected_before_any_model_call(self):
        published, _ = self._publish_two_methods()
        skill, version = published['skill_id'], published['version_id']
        self.extraction_model.responses.append(learning.tool_response('SkillLearningProposal',
            learning.synthetic_proposal(kind='update', targets=[skill],
                replaces=[str(uuid5(UUID(skill), 'method:' + key)) for key in ('clarify', 'listen')])))
        self._discussion(correction='合成明确长期调整：请形成待审核草稿。')
        draft = self._wait_learning()['drafts'][0]
        self._stop_skill(skill, version)
        calls = self.reply_model.provider_calls
        status, result = self.backend.request(self.path + '/drafts/' + draft['draft_id'] + '/compare', {
            'expected_revision': draft['revision'], 'operation_key': str(uuid4()),
            'input': {'incoming_text': '合成审核来话', 'intent': '核对含义', 'scene': '核对安排'},
            'scope': {'kind': 'owner', 'contact_id': None, 'scene': None}})
        self.assertEqual(status, 409, result)
        self.assertEqual(self.reply_model.provider_calls, calls)

    def test_existing_global_disable_also_rejects_old_candidate_replay(self):
        skill, version, path, body = self._legacy_session()
        self._ok(path + '/replies', body)
        self._ok('/api/skills/' + skill + '/disable', {})
        calls = self.reply_model.provider_calls
        self.assertEqual(self.backend.request(path + '/replies', body)[0], 409)
        self.assertEqual(self.reply_model.provider_calls, calls)

    def _unmapped_merge_ancestor_stop(self, *, method_only):
        from notalone.persistence.skill_library import PostgresSkillLibrary
        self._bind(self.contact_id)
        primary, secondary = [self._import(name) for name in ('careful-response', 'calm-response')]
        secondary_version = self._get(self.backend, self.path + '/skills/' + secondary)['current_version_id']
        self.assertEqual(self._configure()[0][0], 200)
        inherited = str(uuid5(UUID(secondary), 'whole_strategy'))
        status, result = self.backend.request(self.path + '/policies', {'skill_id': secondary,
            'version_id': secondary_version, 'method_id': inherited if method_only else None,
            'scope': {'kind': 'contact', 'contact_id': str(self.contact_id), 'scene': None},
            'disabled': True, 'expected_revision': 0, 'operation_key': str(uuid4())})
        self.assertEqual(status, 200, result)
        proposal = learning.synthetic_proposal(kind='merge', targets=[primary, secondary])
        proposal['methods'] = [
            {'key': 'primary-safe', 'title': '合成主方法', 'instruction': '合成主方法：保留当前意图。',
             'replaces_method_ids': [str(uuid5(UUID(primary), 'whole_strategy'))]},
            {'key': 'secondary-blocked', 'title': '合成被停用的合并祖先', 'instruction': '合成被停用的合并祖先：不能重现。',
             'replaces_method_ids': [inherited]}]
        self.extraction_model.responses.append(learning.tool_response('SkillLearningProposal', proposal))
        self._discussion(correction='合成明确合并，保留既有停用。')
        draft = self._wait_learning()['drafts'][0]
        path = self.path + '/drafts/' + draft['draft_id']
        compared, _ = self._compare(path, draft, kind='owner')
        published, _ = self._approve(path, compared)
        self.assertEqual(len(self._reply(self.contact_id, published['published']['version_id'])['used_skill']['execution_view']['method_ids']), 1)
        package = Path(self.temporary.name) / 'careful-response'
        (package / 'SKILL.md').write_text('---\nname: careful-response\ndescription: 合成丢失细分映射的更新\n---\n合成被停用的合并祖先重新混入完整正文。')
        PostgresSkillLibrary(self.database_url).update_package(self.owner_id, package)
        current = self._get(self.backend, self.path + '/skills/' + primary)
        self.assertIsNone(self._reply(self.contact_id, current['current_version_id'])['used_skill'],
                          '合并祖先的停用不能被当前逻辑Skill的无映射包清洗。')

    def test_unmapped_package_update_keeps_method_stop_from_merged_ancestor(self):
        self._unmapped_merge_ancestor_stop(method_only=True)

    def test_unmapped_package_update_keeps_whole_skill_stop_from_merged_ancestor(self):
        self._unmapped_merge_ancestor_stop(method_only=False)

    def test_prepared_policy_change_seals_old_permission_and_allows_explicit_reprepare_without_losing_edit(self):
        skill, version, path, body = self._legacy_session()
        body['content']['draft_text'] = '合成用户保留的独立编辑，不随政策变化丢失。'
        prepared = self._ok(path + '/replies/prepare', body)
        self._stop_skill(skill, version)
        calls = self.reply_model.provider_calls
        self.assertEqual(self.backend.request(path + '/replies', body)[0], 409)
        self.assertEqual(self.reply_model.provider_calls, calls)
        identity = {'request_key': prepared['request_key'],
                    'input_version_id': prepared['input_version_id']}
        status, checked = self.backend.request(path + '/preparation-format', identity)
        self.assertEqual(status, 200, checked)
        self.assertEqual(checked['format_status'], 'reprepare_required')
        restored = self._get(self._production_backend(self.owner_id), path)
        old = next(turn for turn in restored['turns'] if turn['turn_id'] == prepared['turn_id'])
        self.assertEqual(old['input']['content']['draft_text'], body['content']['draft_text'])
        self.assertFalse(old['generation_active'])
        self.assertTrue(old['requires_reprepare'])
        self.assertEqual(self.backend.request(path + '/replies', body)[0], 409)
        fresh = {**body, 'idempotency_key': str(uuid4()),
                 'expected_input_version_id': prepared['input_version_id']}
        new = self._ok(path + '/replies/prepare', fresh)
        self.assertNotEqual(new['request_key'], prepared['request_key'])
        self.assertEqual(self.reply_model.provider_calls, calls)
        result = self._ok(path + '/replies', fresh)
        self.assertIsNone(result['used_skill'])
        saved = next(turn for turn in self._get(self.backend, path)['turns']
                     if turn['turn_id'] == new['turn_id'])
        self.assertEqual(saved['input']['content']['draft_text'], body['content']['draft_text'])

    def test_partial_policy_catalog_resource_and_selected_body_never_materialize_stopped_instruction(self):
        from notalone.persistence.skill_port import PostgresSkillPort
        from notalone.scopes import ContactScope

        published, _ = self._publish_two_methods()
        skill, version = UUID(published['skill_id']), UUID(published['version_id'])
        content = '合成被排除方法甲的未分离资源。'.encode()
        with psycopg.connect(self.database_url) as connection:
            connection.execute('INSERT INTO public.reply_skill_resource(skill_version_id,relative_path,resource_kind,'
                'media_type,byte_size,content_sha256,content) VALUES(%s,\'references/blocked.md\',\'reference\','
                '\'text/markdown\',%s,%s,%s)', (version, len(content), hashlib.sha256(content).hexdigest(), content))
        self._ok(self.path + '/policies', {'skill_id': str(skill), 'version_id': str(version),
            'method_id': str(uuid5(skill, 'method:clarify')),
            'scope': {'kind': 'contact', 'contact_id': str(self.contact_id), 'scene': None},
            'disabled': True, 'expected_revision': 0, 'operation_key': str(uuid4())})
        port, scope = PostgresSkillPort(self.database_url), ContactScope(self.owner_id, self.contact_id)
        materialized = []
        fetchall, fetchone = psycopg.Cursor.fetchall, psycopg.Cursor.fetchone

        def observed_all(cursor):
            rows = fetchall(cursor)
            materialized.append(json.dumps(rows, ensure_ascii=False, default=str))
            return rows

        def observed_one(cursor):
            row = fetchone(cursor)
            materialized.append(json.dumps(row, ensure_ascii=False, default=str))
            return row

        with patch.object(psycopg.Cursor, 'fetchall', observed_all), patch.object(psycopg.Cursor, 'fetchone', observed_one):
            catalog = port.catalog(scope)
            self.assertEqual([item.version_id for item in catalog.entries], [version])
            self.assertNotIn('合成被排除方法甲', str(materialized))
            materialized.clear()
            with self.assertRaises(PermissionError):
                port.load_resource(scope, version, 'references/blocked.md')
            self.assertNotIn('合成被排除方法甲', str(materialized))
            materialized.clear()
            loaded = port.load_version(scope, version)
            self.assertIn('合成允许方法乙', loaded.content)
            self.assertNotIn('合成被排除方法甲', str(materialized))
        self.assertEqual(loaded.resource_paths, ())
        self.assertEqual(loaded.execution_view.method_ids, (uuid5(skill, 'method:listen'),))

    def test_unknown_policy_targets_scopes_and_changed_receipts_never_change_permission(self):
        self._bind(self.contact_id)
        skill = self._import()
        version = self._ok('/api/skills')['skills'][0]['current_version_id']
        command = {'skill_id': skill, 'version_id': version, 'method_id': None,
            'scope': {'kind': 'contact', 'contact_id': str(self.contact_id), 'scene': None},
            'disabled': True, 'expected_revision': 0, 'operation_key': str(uuid4())}
        for invalid in (
            {**command, 'skill_id': str(uuid4())}, {**command, 'version_id': str(uuid4())},
            {**command, 'method_id': str(uuid4())}, {**command, 'expected_revision': True},
            {**command, 'disabled': 'true'}, {**command, 'future_field': None},
            {**command, 'scope': {'kind': 'unknown', 'contact_id': None, 'scene': None}},
            {**command, 'scope': {'kind': 'contact', 'contact_id': str(self.second_contact_id), 'scene': None}},
        ):
            with self.subTest(invalid=invalid):
                self.assertIn(self.backend.request(self.path + '/policies', invalid)[0], (400, 404, 409))
                self.assertEqual(self._ok(self.path + '/policies'), {'revision': 0, 'policies': []})
        stopped = self._ok(self.path + '/policies', command)
        self.assertEqual(self.backend.request(self.path + '/policies', {**command, 'disabled': False})[0], 409)
        self.assertEqual(self.backend.request(self.path + '/policies', {**command, 'operation_key': str(uuid4())})[0], 409)
        policy = stopped['policies'][0]['policy_id']
        self._ok(self.path + '/policies/' + policy + '/undo', {
            'expected_revision': stopped['revision'], 'operation_key': str(uuid4())})
        self.assertEqual(self.backend.request(self.path + '/policies', command)[0], 409)
        self.assertEqual(self._ok(self.path + '/policies')['policies'], [])

    def test_policy_posts_validate_target_metadata_without_projecting_any_history_body(self):
        published, source = self._publish_two_methods()
        skill, version = published['skill_id'], published['version_id']
        self._bind(self.second_contact_id)
        command = {'skill_id': skill, 'version_id': version, 'method_id': str(uuid5(UUID(skill), 'method:clarify')),
            'scope': {'kind': 'contact', 'contact_id': str(self.contact_id), 'scene': None},
            'disabled': True, 'expected_revision': 0, 'operation_key': str(uuid4())}
        calls = (self.reply_model.provider_calls, len(self.reply_model.seen_calls),
                 len(self.extraction_model.seen_calls))
        execute = psycopg.Cursor.execute
        observations = []

        def post(label, body, *, backend=None, path=None, allowed=(200,)):
            projections = []

            def observed(cursor, query, *args, **kwargs):
                result = execute(cursor, query, *args, **kwargs)
                statement = query if isinstance(query, str) else query.as_string(cursor.connection)
                if (statement.lstrip().upper().startswith('SELECT')
                        and any(table in statement for table in
                                ('public.reply_skill_version', 'public.reply_skill_method'))):
                    # 观察实际结果列；content IS NOT NULL 和 content_sha256 都不是正文投影。
                    columns = [column.name for column in cursor.description or ()]
                    projections.append({'columns': columns,
                        'body_columns': sorted(set(columns) & {'content', 'version_content', 'title', 'instruction'})})
                return result

            with patch.object(psycopg.Cursor, 'execute', observed):
                status, result = (backend or self.backend).request(path or self.path + '/policies', body)
            observations.append({'case': label, 'status': status, 'allowed_statuses': allowed,
                'skill_id': body['skill_id'], 'version_id': body['version_id'], 'method_id': body['method_id'],
                'select_projections': projections})
            return status, result

        post('method', command)
        post('whole_skill', {**command, 'method_id': None, 'expected_revision': 1, 'operation_key': str(uuid4())})
        base = {**command, 'expected_revision': 2}
        for label, changed in [('unknown_version', {'version_id': str(uuid4())}),
                               ('unknown_method', {'method_id': str(uuid4())}),
                               ('unknown_skill', {'skill_id': str(uuid4())})]:
            post(label, {**base, **changed, 'operation_key': str(uuid4())}, allowed=(404, 409))
        post('other_owner', {**base, 'operation_key': str(uuid4())}, backend=self.other_backend, allowed=(404,))
        with psycopg.connect(self.database_url) as connection:
            publication = connection.execute('SELECT scope_kind,scope_contact_id FROM public.reply_skill_publication '
                'WHERE version_id=%s', (UUID(version),)).fetchone()
            connection.execute("UPDATE public.reply_skill_publication SET scope_kind='contact',scope_contact_id=%s "
                'WHERE version_id=%s', (self.contact_id, UUID(version)))
        try:
            post('other_contact_publication', {**base, 'operation_key': str(uuid4()),
                'scope': {'kind': 'contact', 'contact_id': str(self.second_contact_id), 'scene': None}},
                path=f'/api/contacts/{self.second_contact_id}/skill-learning/policies', allowed=(404, 409))
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute('UPDATE public.reply_skill_publication SET scope_kind=%s,scope_contact_id=%s '
                    'WHERE version_id=%s', (*publication, UUID(version)))
        with psycopg.connect(self.database_url) as connection:
            source_hash = connection.execute('SELECT content_sha256 FROM public.source_document WHERE id=%s',
                                             (source,)).fetchone()[0]
            self.assertNotEqual(source_hash, '0' * 64)
            connection.execute('UPDATE public.source_document SET content_sha256=%s WHERE id=%s', ('0' * 64, source))
        try:
            post('stale_source_generation', {**base, 'operation_key': str(uuid4())}, allowed=(404, 409))
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute('UPDATE public.source_document SET content_sha256=%s WHERE id=%s', (source_hash, source))
        print('policy_write_projection_observations:' + json.dumps(observations, ensure_ascii=False))
        self.assertEqual([(item['case'], item['status']) for item in observations
                          if item['status'] not in item['allowed_statuses']], [])
        self.assertEqual(len(observations), 8)
        self.assertTrue(all(item['select_projections'] for item in observations[:4]))
        self.assertEqual(self._ok(self.path + '/policies')['revision'], 2)
        self.assertEqual((self.reply_model.provider_calls, len(self.reply_model.seen_calls),
                          len(self.extraction_model.seen_calls)), calls)
        self.assertEqual([(item['case'], projection['body_columns']) for item in observations
                          for projection in item['select_projections'] if projection['body_columns']], [],
                         '政策POST只需身份与来源元数据，不应读取选中或未选历史正文。')

    def test_owner_scene_stop_reaches_same_owner_contacts_and_preserves_other_owner(self):
        self._bind(self.contact_id)
        self._bind(self.second_contact_id)
        skill = self._import()
        version = self._ok('/api/skills')['skills'][0]['current_version_id']
        foreign = self.other_backend.request('/api/skills/import', {
            'package_path': str(Path(self.temporary.name) / 'careful-response')})
        self.assertEqual(foreign[0], 200, foreign)
        self._ok(self.path + '/policies', {'skill_id': skill, 'version_id': version, 'method_id': None,
            'scope': {'kind': 'scene', 'contact_id': None, 'scene': '精确安排'},
            'disabled': True, 'expected_revision': 0, 'operation_key': str(uuid4())})
        for contact in (self.contact_id, self.second_contact_id):
            self.assertIsNone(self._reply(contact, version, scene='精确安排')['used_skill'])
            self.assertIsNotNone(self._reply(contact, version, scene='其他安排')['used_skill'])
        self.assertEqual(self.other_backend.request(self.path + '/policies')[0], 404)
        status, foreign_versions = self.other_backend.request('/api/skills')
        self.assertEqual(status, 200, foreign_versions)
        self.assertEqual([item['skill_id'] for item in foreign_versions['skills']], [foreign[1]['skill_id']])

    def test_saved_execution_receipt_rejects_wrong_scene_and_damage_and_legacy_only_before_relevant_stop(self):
        published, _ = self._publish_two_methods()
        version = published['version_id']
        body = {'contact_id': str(self.contact_id), 'idempotency_key': str(uuid4()), 'scene': '精确场景',
            'content': {'type': 'rewrite_draft', 'draft_text': '合成旧凭证核验。'}, 'skill_version_id': version}
        generated = self._ok('/api/reply/generate', body)
        request_id = UUID(generated['reply_request_id'])
        with psycopg.connect(self.database_url) as connection:
            snapshot = connection.execute('SELECT context_snapshot FROM public.reply_request WHERE id=%s', (request_id,)).fetchone()[0]
        legacy = {key: value for key, value in snapshot.items() if key != 'skill_execution_view'}

        def replace_snapshot(value):
            with psycopg.connect(self.database_url) as connection:
                connection.execute('UPDATE public.reply_request SET context_snapshot=%s WHERE id=%s', (Jsonb(value), request_id))

        replace_snapshot(legacy)
        self.assertEqual(self.backend.request('/api/reply/generate', body)[0], 200)
        calls = self.reply_model.provider_calls
        for invalid in ({**snapshot, 'skill_execution_view': None},
                        {**snapshot, 'skill_execution_scene': '伪造的其他场景'},
                        {**snapshot, 'skill_execution_view': {**snapshot['skill_execution_view'], 'policy_revision': True}}):
            replace_snapshot(invalid)
            self.assertEqual(self.backend.request('/api/reply/generate', body)[0], 409)
            self.assertEqual(self.reply_model.provider_calls, calls)
        replace_snapshot(legacy)
        self._ok(self.path + '/policies', {'skill_id': published['skill_id'], 'version_id': version,
            'method_id': str(uuid5(UUID(published['skill_id']), 'method:clarify')),
            'scope': {'kind': 'scene', 'contact_id': str(self.contact_id), 'scene': '精确场景'},
            'disabled': True, 'expected_revision': 0, 'operation_key': str(uuid4())})
        self.assertEqual(self.backend.request('/api/reply/generate', body)[0], 409)
        self.assertEqual(self.reply_model.provider_calls, calls)

    def test_explicit_null_execution_receipt_cannot_enter_continuation_or_candidate_carry(self):
        skill, skill_version, path, body = self._legacy_session()
        generated = self._ok(path + '/replies', body)
        candidate = generated['candidates'][0]['candidate_id']
        version = self._ok(path + f'/candidates/{candidate}/versions')['versions'][0]
        selected = self._ok(path + '/selections', {'selection_key': str(uuid4()),
            'candidate_id': candidate, 'version_id': version['version_id']})
        carry = {'expected_selection_id': selected['selection_id'],
            'candidate_id': candidate, 'version_id': version['version_id']}
        continued = self._command(generated, self._frame(path, generated), instruction='合成只调整当前候选。')
        self._bind(self.second_contact_id)
        policy = {'skill_id': skill, 'version_id': skill_version, 'method_id': None,
            'scope': {'kind': 'scene', 'contact_id': None, 'scene': '合成无关场景'},
            'disabled': True, 'expected_revision': 0, 'operation_key': str(uuid4())}
        self._ok(self.path + '/policies', policy)
        self._ok(f'/api/contacts/{self.second_contact_id}/skill-learning/policies', {**policy,
            'scope': {'kind': 'contact', 'contact_id': str(self.second_contact_id), 'scene': None},
            'expected_revision': 1, 'operation_key': str(uuid4())})
        request = UUID(generated['reply_request_id'])
        with psycopg.connect(self.database_url) as connection:
            snapshot = connection.execute('SELECT context_snapshot FROM public.reply_request WHERE id=%s',
                                          (request,)).fetchone()[0]

        def replace(value):
            with psycopg.connect(self.database_url) as connection:
                connection.execute('UPDATE public.reply_request SET context_snapshot=%s WHERE id=%s', (Jsonb(value), request))

        calls = (self.reply_model.provider_calls, len(self.reply_model.seen_calls))
        try:
            replace({key: value for key, value in snapshot.items() if key != 'skill_execution_view'})
            legacy = self.backend.request(path + '/new-with-candidate', carry)
            replace({**snapshot, 'skill_execution_view': None})
            replay = self.backend.request('/api/reply/generate', body)
            carried = self.backend.request(path + '/new-with-candidate', carry)
            prepared = self.backend.request(path + '/continue/prepare', continued)
            replace({key: value for key, value in snapshot.items() if key != 'skill_execution_view'})
            compatible = self.backend.request(path + '/continue/prepare', {**continued, 'idempotency_key': str(uuid4())})
        finally:
            replace(snapshot)
        observations = {'legacy_missing_related_zero_carry': legacy[0], 'explicit_null_replay': replay[0],
            'explicit_null_carry': carried[0], 'explicit_null_continue_prepare': prepared[0],
            'legacy_missing_unrelated_policies_continue_prepare': compatible[0],
            'provider_calls_before': calls[0], 'provider_calls_after': self.reply_model.provider_calls,
            'seen_calls_before': calls[1], 'seen_calls_after': len(self.reply_model.seen_calls)}
        print('null_execution_receipt_observations:' + json.dumps(observations, ensure_ascii=False))
        self.assertEqual((legacy[0], replay[0], compatible[0]), (200, 409, 200))
        self.assertEqual((self.reply_model.provider_calls, len(self.reply_model.seen_calls)), calls)
        self.assertEqual((carried[0], prepared[0]), (409, 409),
                         '存在但为null的凭证必须拒绝；只有真正缺字段且相关修订为0才兼容。')

    def test_writer_commits_before_independent_backend_waiting_stop(self):
        self._writer_stop_order(stop_first=False)

    def test_stop_commits_before_independent_backend_waiting_writer(self):
        self._writer_stop_order(stop_first=True)

    def _writer_stop_order(self, *, stop_first):
        from notalone.persistence import skill_port, skill_policies

        self._bind(self.contact_id)
        skill = self._import()
        version = self._ok('/api/skills')['skills'][0]['current_version_id']
        store = commit_support.CommitBoundaryReplyStore(self.database_url)
        with patch('notalone.server.reply_wiring.PostgresReplyStore', return_value=store):
            writing = self._production_backend(self.owner_id)
        stopping = self._production_backend(self.owner_id)
        self.assertNotEqual(writing.base_url, stopping.base_url)
        body = {'contact_id': str(self.contact_id), 'idempotency_key': str(uuid4()),
            'content': {'type': 'rewrite_draft', 'draft_text': '合成真实锁序最终候选。'}, 'skill_version_id': version}
        command = {'skill_id': skill, 'version_id': version, 'method_id': None,
            'scope': {'kind': 'contact', 'contact_id': str(self.contact_id), 'scene': None},
            'disabled': True, 'expected_revision': 0, 'operation_key': str(uuid4())}
        entered, release, holders = threading.Event(), threading.Event(), []
        self.addCleanup(release.set)
        self.addCleanup(store.release.set)

        def hold(connection):
            holders.append(connection.info.backend_pid)
            entered.set()
            if not release.wait(10):
                raise TimeoutError('合成政策与最终写入锁门超时。')

        if stop_first:
            original = skill_policies.PostgresSkillPolicies._read
            armed = True

            def held_read(connection, scope):
                nonlocal armed
                result = original(connection, scope)
                if armed and scope.owner_id == self.owner_id and scope.contact_id == self.contact_id:
                    armed = False
                    hold(connection)
                return result

            gate = patch.object(skill_policies.PostgresSkillPolicies, '_read', staticmethod(held_read))
            store.hold_before_commit = True
        else:
            original = skill_port.require_reply_skill_current

            def held_writer(connection, context, used):
                original(connection, context, used)
                if context.command.idempotency_key == UUID(body['idempotency_key']):
                    hold(connection)

            gate = patch.object(skill_port, 'require_reply_skill_current', held_writer)
        with gate, ThreadPoolExecutor(max_workers=2) as pool:
            writer = pool.submit(writing.request, '/api/reply/generate', body, timeout=20)
            if stop_first:
                self.assertTrue(store.entered.wait(5), '先完成实际模型读取，再让停用持锁。')
                stopper = pool.submit(stopping.request, self.path + '/policies', command, timeout=20)
                self.assertTrue(entered.wait(5))
                store.release.set()
                waiter = writer
            else:
                self.assertTrue(entered.wait(5))
                stopper = pool.submit(stopping.request, self.path + '/policies', command, timeout=20)
                waiter = stopper
            try:
                blocked = wait_for_blocked_operations(self.database_url, set(holders), 1)
                self.assertTrue(blocked - set(holders))
                self.assertFalse(waiter.done())
            finally:
                release.set()
            written, stopped = writer.result(timeout=10), stopper.result(timeout=10)
        print(json.dumps({'policy_lock_order': 'stop_first' if stop_first else 'writer_first',
            'writer_base_url': writing.base_url, 'stop_base_url': stopping.base_url,
            'blocker_pids': holders, 'waiting_pids': sorted(blocked)}, sort_keys=True))
        self.assertEqual(stopped[0], 200, stopped)
        self.assertEqual(written[0], 409 if stop_first else 200, written)
        with psycopg.connect(self.database_url) as connection:
            candidates = connection.execute('SELECT candidate.id FROM public.reply_candidate AS candidate '
                'JOIN public.reply_request AS request ON request.id=candidate.reply_request_id '
                'WHERE request.owner_id=%s AND request.idempotency_key=%s', (self.owner_id, UUID(body['idempotency_key']))).fetchall()
        self.assertEqual(bool(candidates), not stop_first)

    def test_plain_candidate_edit_and_explicit_long_term_draft_do_not_create_policy(self):
        self._bind(self.contact_id)
        session = self._ok(f'/api/contacts/{self.contact_id}/assistant-session/default', {})
        path = f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"
        generated = self._ok(path + '/replies', {'contact_id': str(self.contact_id),
            'idempotency_key': str(uuid4()), 'skill_disabled': True,
            'content': {'type': 'rewrite_draft', 'draft_text': '合成措辞反馈只修改本条。'}})
        versions_path = path + f"/candidates/{generated['candidates'][0]['candidate_id']}/versions"
        original = self._ok(versions_path)['versions'][0]
        edited = self._ok(versions_path, {'edit_key': str(uuid4()), 'parent_version_id': original['version_id'],
            'requirements': '这句太生硬，只改当前表达。',
            'messages': [{'message_id': original['messages'][0]['message_id'], 'text': '合成用户自己的柔和说法。'}]})
        self.assertEqual(self._ok(self.path + '/policies'), {'revision': 0, 'policies': []})
        self.extraction_model.responses.append(learning.tool_response('SkillLearningProposal', learning.synthetic_proposal()))
        self.assertEqual(self._configure()[0][0], 200)
        self._discussion(correction='合成明确长期调整：整理成待审核草稿。')
        draft = self._wait_learning()['drafts'][0]
        self.assertEqual(draft['status'], 'pending')
        self.assertEqual(self._ok(self.path + '/policies'), {'revision': 0, 'policies': []})
        self.assertEqual(self._ok('/api/skills')['skills'], [])
        self.assertEqual(self._ok(versions_path)['versions'], edited['versions'])

    def test_source_erasure_clears_cross_contact_policy_execution_prepared_edit_and_carry_before_any_get(self):
        from notalone.application.source_service import SourceService

        published, source = self._publish_two_methods()
        skill, version = published['skill_id'], published['version_id']
        content = '合成来源删除前确实存在的辅助资源。'.encode()
        with psycopg.connect(self.database_url) as connection:
            connection.execute('INSERT INTO public.reply_skill_resource(skill_version_id,relative_path,resource_kind,'
                'media_type,byte_size,content_sha256,content) VALUES(%s,\'references/source.md\',\'reference\','
                '\'text/markdown\',%s,%s,%s)', (UUID(version), len(content), hashlib.sha256(content).hexdigest(), content))
            self.assertEqual(connection.execute('SELECT content FROM public.reply_skill_resource WHERE skill_version_id=%s '
                'AND relative_path=\'references/source.md\'', (UUID(version),)).fetchone()[0], content)
        stop_command = {'skill_id': skill, 'version_id': version,
            'method_id': str(uuid5(UUID(skill), 'method:clarify')),
            'scope': {'kind': 'owner', 'contact_id': None, 'scene': None},
            'disabled': True, 'expected_revision': 0, 'operation_key': str(uuid4())}
        stopped = self._ok(self.path + '/policies', stop_command)
        history = self._ok(self.path + '/skills/' + skill)
        rollback = {'version_id': version, 'expected_revision': history['revision'],
            'expected_current_version_id': version, 'operation_key': str(uuid4())}
        self._bind(self.second_contact_id)
        session = self._ok(f'/api/contacts/{self.second_contact_id}/assistant-session/default', {})
        path = f"/api/contacts/{self.second_contact_id}/assistant-sessions/{session['session_id']}"
        body = {'contact_id': str(self.second_contact_id), 'idempotency_key': str(uuid4()), 'scene': '合成B精确场景',
            'content': {'type': 'rewrite_draft', 'draft_text': '合成B使用A来源方法。'}, 'skill_version_id': version}
        generated = self._ok(path + '/replies', body)
        self.assertEqual(len(generated['used_skill']['execution_view']['method_ids']), 1)
        candidate = generated['candidates'][0]['candidate_id']
        versions_path = path + f'/candidates/{candidate}/versions'
        original = self._ok(versions_path)['versions'][0]
        edited = self._ok(versions_path, {'edit_key': str(uuid4()), 'parent_version_id': original['version_id'],
            'requirements': '合成B用户编辑。', 'messages': [{'message_id': original['messages'][0]['message_id'],
                'text': '合成政策来源删除必须擦除的用户编辑。'}]})
        selected = self._ok(path + '/selections', {'selection_key': str(uuid4()), 'candidate_id': candidate,
            'version_id': edited['default_display_version_id']})
        carry = self._ok(path + '/new-with-candidate', {'expected_selection_id': selected['selection_id'],
            'candidate_id': candidate, 'version_id': edited['default_display_version_id']})
        prepared = self._ok(path + '/replies/prepare', {**body, 'idempotency_key': str(uuid4()),
            'expected_input_version_id': generated['input_version_id']})
        with psycopg.connect(self.database_url) as connection:
            draft_id = connection.execute('SELECT id FROM public.skill_draft WHERE published_version_id=%s',
                (UUID(version),)).fetchone()[0]
        # DELETE同步执行真实worker；任何恢复GET之前检查原事务的物理闭包。
        with patch.object(SourceService, '_start', SourceService._drain):
            status, deleted = self.backend.request(f'/api/contacts/{self.contact_id}/sources/{source}', method='DELETE')
        self.assertEqual(status, 202, deleted)
        review.SkillReviewHttpTest._assert_physical_review_erasure(self, str(draft_id), version)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute('SELECT status FROM public.source_document WHERE id=%s', (source,)).fetchone()[0], 'deleted')
            self.assertEqual(connection.execute('SELECT dependency_ids,source_generation,scene FROM public.reply_skill_publication WHERE version_id=%s',
                (UUID(version),)).fetchone(), ([], {}, None))
            self.assertEqual(connection.execute('SELECT target_versions,source_generation,dependency_ids FROM public.skill_draft WHERE id=%s',
                (draft_id,)).fetchone(), ([], {}, []))
            comparisons = connection.execute('SELECT input,result,source_generation,dependency_ids FROM public.skill_review_comparison WHERE draft_id=%s',
                (draft_id,)).fetchall()
            self.assertTrue(comparisons)
            self.assertTrue(all(row == (None, None, {}, []) for row in comparisons))
            batches = connection.execute('SELECT outcome,dependency_ids FROM public.skill_learning_batch WHERE draft_id=%s', (draft_id,)).fetchall()
            self.assertTrue(batches)
            self.assertTrue(all(row == ('invalidated', []) for row in batches))
            self.assertIsNone(connection.execute('SELECT receipt.material_id FROM public.skill_learning_receipt AS receipt '
                'JOIN public.skill_learning_batch AS batch ON batch.id=receipt.batch_id WHERE batch.draft_id=%s AND receipt.digest IS NOT NULL',
                (draft_id,)).fetchone())
            self.assertIsNone(connection.execute('SELECT id FROM public.reply_skill_resource WHERE skill_version_id=%s', (UUID(version),)).fetchone())
            for turn in (generated['turn_id'], prepared['turn_id']):
                self.assertEqual(connection.execute('SELECT input_payload,prepared_context,dependency_ids,state FROM public.assistant_session_turn WHERE id=%s',
                    (UUID(turn),)).fetchone(), (None, None, [], 'redacted'))
            self.assertIsNone(connection.execute('SELECT id FROM public.assistant_candidate_version WHERE candidate_id=%s', (UUID(candidate),)).fetchone())
            self.assertEqual(connection.execute('SELECT content,state FROM public.assistant_session_input WHERE id=%s',
                (UUID(carry['input_version_id']),)).fetchone(), (None, 'redacted'))
        undone = self._ok(self.path + '/policies/' + stopped['policies'][0]['policy_id'] + '/undo', {
            'expected_revision': stopped['revision'], 'operation_key': str(uuid4())})
        self.assertEqual(undone['policies'], [])
        restarted = self._production_backend(self.owner_id)
        self.assertEqual(restarted.request(self.path + '/skills/' + skill)[0], 404)
        approve_path, approve = self._last_feedback_approval
        for operation in (approve, {**approve, 'operation_key': str(uuid4())}):
            self.assertEqual(restarted.request(approve_path + '/approve', operation)[0], 409)
        self.assertIn(restarted.request(self.path + '/skills/' + skill + '/rollback', rollback)[0], (404, 409))
        for operation in (stop_command, {**stop_command, 'operation_key': str(uuid4())}):
            self.assertIn(restarted.request(self.path + '/policies', operation)[0], (404, 409))
        self.assertNotIn('合成政策来源删除必须擦除的用户编辑', str(self._get(restarted, path)))
