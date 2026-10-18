"""09 本人与当前联系人沿真实 HTTP、PG 和受控模型组合。"""
import unittest
from tests.integration.server import test_layered_reply_context as layered_support
from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture


class OwnerContactLayeredReplyHttpTest(OverviewReplyHttpFixture, unittest.TestCase):
    controlled = layered_support.LayeredReplyHttpTest.controlled
    enable = layered_support.LayeredReplyHttpTest.enable
    read = layered_support.LayeredReplyHttpTest.read
    prepare_layered_reply = layered_support.LayeredReplyHttpTest.prepare_layered_reply
    def test_owner_without_explicit_read_budget_stays_closed_in_saved_basis(self):
        contact, _, management, _, path = self.prepare_layered_reply()
        self.manual_owner('本人学习合成课程。')
        status, organized = management.request('/api/memories/owner/layered-memory/enable',
            {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, organized)
        self.reply_model.plans.append({'text': '聊聊课程。', 'basis': '按草稿。'})
        status, turn = self.backend.request(path + '/replies', self.rewrite_body(contact, '聊聊课程。'))
        self.assertEqual(status, 200, turn)
        evidence = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertEqual(evidence.get('owner_layered_status'), 'quality_closed')
        self.assertIsNone(evidence.get('owner_layered_context'))

    def test_both_scopes_freeze_independent_actual_materials(self):
        from notalone.reply.layered_context import LayeredReplyBudget, ScenarioReadBudget
        contact, _, management, contact_ready, path = self.prepare_layered_reply()
        self.manual_owner('本人学习合成课程。')
        status, organized = management.request('/api/memories/owner/layered-memory/enable',
            {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, organized)
        owner_ready = organized['layered_memory']
        self.layered_reply_options['owner_layered_reply_budget'] = LayeredReplyBudget(1, 1, 3000, ScenarioReadBudget(1, 1, 3000))
        self.backend = self._backend(self.owner_id)
        self.reply_model.plans.append({'text': '聊聊课程。', 'basis': '按草稿。'})
        status, turn = self.backend.request(path + '/replies', self.rewrite_body(contact, '聊聊课程。'))
        self.assertEqual(status, 200, turn)
        evidence = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertEqual(evidence['owner_layered_status'], 'loaded')
        for prefix, ready, kind in (('', contact_ready, 'contact'), ('owner_', owner_ready, 'owner')):
            actual = evidence[prefix + 'layered_context']
            self.assertEqual(actual['scope_kind'], kind)
            self.assertEqual(actual['profile_version_id'], ready['profile']['version_id'])
            self.assertEqual(actual['directory'][0]['version_id'], ready['scenarios'][0]['version_id'])
        system = '\n'.join(str(message.content) for call in self.reply_model.seen_calls for message in call)
        self.assertIn(owner_ready['profile']['version_id'], system)
        self.assertEqual(evidence['retrieval']['budgets']['contact_memory']['limit'], 5)
        self.assertEqual(evidence['retrieval']['budgets']['owner_memory']['limit'], 3)

    def test_tool_routes_only_actual_directories_and_keeps_side_budgets_independent(self):
        from notalone.reply.layered_context import LayeredReplyBudget, ScenarioReadBudget
        contact, _, management, contact_ready, path = self.prepare_layered_reply()
        self.manual_owner('本人学习合成课程。')
        status, organized = management.request('/api/memories/owner/layered-memory/enable',
            {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, organized)
        owner_ready = organized['layered_memory']
        for key in ('layered_reply_budget', 'owner_layered_reply_budget'):
            self.layered_reply_options[key] = LayeredReplyBudget(1, 1, 3000, ScenarioReadBudget(1, 1, 3000))
        self.backend = self._backend(self.owner_id)
        args = [{'scenario_id': ready['scenarios'][0]['scenario_id'], 'paragraph_start': 0, 'paragraph_end': 1}
                for ready in (owner_ready, contact_ready)]
        self.reply_model.plans.extend([{'parallel_scenarios': args + args},
            {'text': '聊聊课程。', 'basis': '按草稿。'}])
        status, turn = self.backend.request(path + '/replies', self.rewrite_body(contact, '聊聊课程。'))
        self.assertEqual(status, 200, turn)
        evidence = self._get(self.backend, self.evidence_path(contact, turn))
        for prefix, ready in (('', contact_ready), ('owner_', owner_ready)):
            receipts = evidence[prefix + 'layered_scenario_reads']
            self.assertEqual([item['status'] for item in receipts], ['succeeded', 'budget_exceeded'])
            self.assertEqual(receipts[0]['document']['version_id'], ready['scenarios'][0]['version_id'])
            self.assertEqual(receipts[-1]['budget']['used_calls'], 1)

    def dual_scope(self, *, calls=2):
        from notalone.reply.layered_context import LayeredReplyBudget, ScenarioReadBudget
        contact, _, management, contact_ready, path = self.prepare_layered_reply()
        owner_memory = self.manual_owner('本人学习合成课程。')
        status, organized = management.request('/api/memories/owner/layered-memory/enable',
            {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, organized)
        self.layered_reply_options['owner_layered_reply_budget'] = LayeredReplyBudget(1, 1, 3000, ScenarioReadBudget(calls, 2, 6000))
        self.backend = self._backend(self.owner_id)
        return contact, management, organized['layered_memory'], owner_memory, path

    def generate(self, contact, path, text='合成候选。', *, include_context=True):
        self.reply_model.plans.append({'text': text, 'basis': '按本次草稿。'})
        status, turn = self.backend.request(path + '/replies',
            self.rewrite_body(contact, '聊聊课程。', include_context=include_context))
        self.assertEqual(status, 200, turn)
        return turn

    def test_owner_correction_keeps_audit_but_disables_all_affected_generation(self):
        contact, management, ready, memory, path = self.dual_scope()
        first = self.generate(contact, path)
        second, _, _ = self.import_contact('另一位合成联系人。')
        self.activate_replies(second)
        second_path = self.reply_path(second)
        other = self.generate(second, second_path)
        status, isolated = self.backend.request(f'/api/contacts/{second}/assistant-sessions', {}, method='POST')
        self.assertEqual(status, 200, isolated)
        isolated_path = f"/api/contacts/{second}/assistant-sessions/{isolated['session_id']}"
        unrelated = self.generate(second, isolated_path, '无背景候选。', include_context=False)
        prepared = self.rewrite_body(contact, '旧本人准备不得复活。')
        self.assertEqual(self.backend.request(path + '/replies/prepare', prepared)[0], 200)
        status, corrected = self.backend.request('/api/memories/owner/' + memory['memory_id'] + '/correct',
            {'text': '本人已结束合成课程。'})
        self.assertEqual(status, 200, corrected)
        for selected, turn in ((contact, first), (second, other)):
            evidence = self._get(self.backend, self.evidence_path(selected, turn))
            self.assertIn('memory_generation_forbidden', [item['reason'] for item in evidence['basis_changes']])
        self.assertEqual(self.backend.request(self.evidence_path(second, unrelated))[0], 200)
        self.assertNotEqual(self.backend.request(path + '/replies', prepared)[0], 200)

    def test_owner_disable_preserves_history_and_reconnect_never_resigns_old_prepare(self):
        contact, management, ready, _, path = self.dual_scope()
        old = self.generate(contact, path)
        saved = self._get(self.backend, self.evidence_path(contact, old))
        body = self.rewrite_body(contact, '旧本人准备ABA。')
        self.assertEqual(self.backend.request(path + '/replies/prepare', body)[0], 200)
        status, disabled = management.request('/api/memories/owner/layered-memory/disable',
            {'settings_generation': ready['settings_generation']})
        self.assertEqual(status, 200, disabled)
        self.assertEqual(self._get(self.backend, self.evidence_path(contact, old)), saved)
        self.assertNotEqual(self.backend.request(path + '/replies', body)[0], 200)
        # 新会话用仍合法的联系人材料；本人停用只回退本人侧。
        status, new_session = self.backend.request(f'/api/contacts/{contact}/assistant-sessions', {}, method='POST')
        self.assertEqual(status, 200, new_session)
        new_path = f"/api/contacts/{contact}/assistant-sessions/{new_session['session_id']}"
        turn = self.generate(contact, new_path)
        actual = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertIsNone(actual['owner_layered_context'])
        self.assertIsNotNone(actual['layered_context'])
        self.assertEqual(actual['retrieval']['budgets']['owner_memory']['limit'], 3)
        status, reopened = management.request('/api/memories/owner/layered-memory/enable',
            {'settings_generation': disabled['layered_memory']['settings_generation'], 'purpose_confirmed': True})
        self.assertEqual(status, 200, reopened)
        self.backend = self._backend(self.owner_id)
        before = len(self.reply_model.seen_calls)
        self.assertNotEqual(self.backend.request(path + '/replies', body)[0], 200)
        self.assertEqual(len(self.reply_model.seen_calls), before)
        self.assertEqual(self._get(self.backend, self.evidence_path(contact, old)), saved)

    def test_owner_read_then_disable_blocks_next_actual_send(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        contact, management, ready, _, path = self.dual_scope()
        entered, release = Event(), Event()
        service = self.service
        class ReadBarrier:
            def __getattr__(self, name):
                return getattr(service, name)
            def read_scenario(self, snapshot, identifier, span):
                result = service.read_scenario(snapshot, identifier, span)
                entered.set()
                if not release.wait(5):
                    raise TimeoutError('合成正文读取门未释放。')
                return result
        self.layered_reply_options['layered_memory'] = ReadBarrier()
        self.backend = self._backend(self.owner_id)
        self.reply_model.plans.extend([{'history': {'name': 'read_scenario', 'args': {
            'scenario_id': ready['scenarios'][0]['scenario_id'], 'paragraph_start': 0, 'paragraph_end': 1}}},
            {'text': '不得进行下一次模型调用。', 'basis': '迟到。'}])
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, path + '/replies', self.rewrite_body(contact, '你好。'))
            try:
                self.assertTrue(entered.wait(5))
                status, result = management.request('/api/memories/owner/layered-memory/disable',
                    {'settings_generation': ready['settings_generation']})
                self.assertEqual(status, 200, result)
                release.set()
                self.assertNotEqual(pending.result(timeout=10)[0], 200)
            finally:
                release.set()
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        self.assertNotIn('不得进行下一次', str(self._get(self.backend, path)))

    def test_owner_actual_profile_and_tool_text_reach_generation_and_saved_basis(self):
        import json
        from langchain_core.messages import SystemMessage, ToolMessage
        contact, _, ready, _, path = self.dual_scope()
        decisions = []
        self.layered_reply_options['on_input_budget'] = decisions.append
        self.backend = self._backend(self.owner_id)
        args = {'scenario_id': ready['scenarios'][0]['scenario_id'], 'paragraph_start': 0, 'paragraph_end': 1}
        self.reply_model.plans.extend([{'history': {'name': 'read_scenario', 'args': args}},
            {'text': '你好，想起学习的时光。', 'basis': '合成事实。'}])
        body = self.rewrite_body(contact, '你好。')
        body['content']['user_instruction'] = '自然表达。'
        status, turn = self.backend.request(path + '/replies', body)
        self.assertEqual(status, 200, turn)
        self.assertEqual(self.reply_model.review_calls, 0)
        self.assertEqual(len(self.reply_model.seen_calls), 2)
        actual_messages = self.reply_model.seen_calls[-1]
        saved = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertEqual(saved['owner_layered_context']['profile_version_id'], ready['profile']['version_id'])
        system = '\n'.join(
            item.content if isinstance(item.content, str) else '\n'.join(block['text'] for block in item.content)
            for item in actual_messages if isinstance(item, SystemMessage))
        backgrounds = [json.loads(section.split('</relationship_background>')[0].strip().splitlines()[-1])
                       for section in system.split('<relationship_background>\n')[1:]]
        self.assertIn(saved['owner_layered_context'], backgrounds)
        actual_reads = [json.loads(item.content) for item in actual_messages
                        if isinstance(item, ToolMessage) and item.name == 'read_scenario']
        self.assertEqual(actual_reads, saved['owner_layered_scenario_reads'])
        self.assertEqual(actual_reads[0]['status'], 'succeeded')
        actual = self.reply_model.seen_model_payloads
        for request, decision in zip(actual, decisions[-len(actual):], strict=True):
            self.assertEqual(decision.input_tokens,
                len(json.dumps(request, ensure_ascii=False, separators=(',', ':'))) + 17)
            self.assertEqual(decision.total_tokens, decision.input_tokens + 4096)
        self.assertIn('read_scenario', str(actual[0]['tools']))
        self.assertIn(ready['profile']['version_id'], str(actual[-1]['messages']))


    def source_dual_scope(self):
        from notalone.memory.models import FactSubject
        from notalone.reply.layered_context import LayeredReplyBudget, ScenarioReadBudget
        contact, _, _ = self.import_contact('当前关系的合成问候。')
        self.manual_contact(contact, '双方共同参加过课程。')
        original, source, message = self.import_contact('其它关系合成隐私原话：我今天在海边散步。')
        self.confirm(original, '本人喜欢合成学习课程。', message, subject=FactSubject.SELF)
        management = self.controlled()
        self.enable(management, contact)
        status, organized = management.request('/api/memories/owner/layered-memory/enable',
            {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, organized)
        self.layered_reply_options = {'layered_memory': self.service,
            'layered_reply_budget': LayeredReplyBudget(1, 1, 3000),
            'owner_layered_reply_budget': LayeredReplyBudget(1, 1, 3000, ScenarioReadBudget(2, 2, 6000))}
        self.activate_replies(contact)
        return contact, original, source, management, organized['layered_memory'], self.reply_path(contact)

    def edit_and_carry(self, contact, path, turn):
        from uuid import uuid4
        candidate = turn['candidates'][0]
        versions = path + '/candidates/' + candidate['candidate_id'] + '/versions'
        status, edited = self.backend.request(versions, {'edit_key': str(uuid4()),
            'parent_version_id': candidate['candidate_id'], 'messages': [{
                'message_id': candidate['messages'][0]['message_id'], 'text': '合成用户编辑：你好。'}]})
        self.assertEqual(status, 200, edited)
        version = edited['versions'][-1]['version_id']
        status, selected = self.backend.request(path + '/selections', {'selection_key': str(uuid4()),
            'candidate_id': candidate['candidate_id'], 'version_id': version})
        self.assertEqual(status, 200, selected)
        status, carried = self.backend.request(path + '/new-with-candidate', {
            'expected_selection_id': selected['selection_id'], 'candidate_id': candidate['candidate_id'], 'version_id': version})
        self.assertEqual(status, 200, carried)
        child = f"/api/contacts/{contact}/assistant-sessions/{carried['session_id']}"
        body = self.rewrite_body(contact, '你好。', include_context=False)
        body['expected_input_version_id'] = carried['input_version_id']
        self.reply_model.plans.append({'text': '合成携入后继。', 'basis': '按当前输入。'})
        status, descendant = self.backend.request(child + '/replies', body)
        self.assertEqual(status, 200, descendant)
        self.last_carry_selection = selected
        return versions, child, descendant

    def test_owner_origin_is_backend_only_and_source_delete_clears_tool_edit_carry_and_descendant(self):
        import json
        contact, original, source, management, ready, path = self.source_dual_scope()
        self.reply_model.plans.extend([
            {'history': {'name': 'read_scenario', 'args': {'scenario_id': ready['scenarios'][0]['scenario_id'],
                'paragraph_start': 0, 'paragraph_end': 1}}},
            {'history': {'name': 'conversation_search', 'args': {'query': '海边', 'top_k': 2}}},
            {'text': '你好。', 'basis': '按草稿。'}])
        status, first = self.backend.request(path + '/replies', self.rewrite_body(contact, '你好。'))
        self.assertEqual(status, 200, first)
        saved = self._get(self.backend, self.evidence_path(contact, first))
        self.assertEqual(saved['owner_layered_scenario_reads'][0]['status'], 'succeeded')
        actual = '\n'.join(str(item.content) for call in self.reply_model.seen_calls for item in call)
        self.assertNotIn('其它关系合成隐私原话：我今天在海边散步。', actual)
        self.assertNotIn(original, actual)
        versions, child, descendant = self.edit_and_carry(contact, path, first)
        self.delete_source(original, source)
        for turn in (first, descendant):
            self.assertNotEqual(self.backend.request(self.evidence_path(contact, turn))[0], 200)
        self.assertNotEqual(self.backend.request(versions)[0], 200)
        self.assertNotIn('合成用户编辑', json.dumps(self._get(self.backend, child), ensure_ascii=False))
        self.backend = self._backend(self.owner_id)
        self.assertNotEqual(self.backend.request(self.evidence_path(contact, first))[0], 200)

    def test_owner_source_delete_before_late_result_cannot_commit_or_restore(self):
        from concurrent.futures import ThreadPoolExecutor
        contact, original, source, _, ready, path = self.source_dual_scope()
        self.reply_model.plans.append({'text': '来源删除后不得保存。', 'basis': '迟到。'})
        gate = self.reply_model.pause_next_response()
        body = self.rewrite_body(contact, '你好。')
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, path + '/replies', body)
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                self.delete_source(original, source)
                gate.set()
                self.assertNotEqual(pending.result(timeout=10)[0], 200)
            finally:
                gate.set()
        self.backend = self._backend(self.owner_id)
        self.assertNotEqual(self.backend.request(path + '/replies', body)[0], 200)
        self.assertNotIn('来源删除后不得保存', str(self._get(self.backend, path)))

    def test_owner_generation_is_rechecked_in_final_writer_transaction(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        from unittest.mock import patch
        from notalone.persistence.reply_store import PostgresReplyStore
        contact, management, ready, _, path = self.dual_scope()
        entered, release = Event(), Event()
        class CommitBarrier(PostgresReplyStore):
            def save(self, request, context, reply):
                entered.set()
                if not release.wait(5):
                    raise TimeoutError('合成最终提交门未释放。')
                return super().save(request, context, reply)
        store = CommitBarrier(self.database_url, layered_memory=self.service,
            layered_budget=self.layered_reply_options['layered_reply_budget'],
            owner_layered_budget=self.layered_reply_options['owner_layered_reply_budget'])
        with patch('notalone.server.reply_wiring.PostgresReplyStore', return_value=store):
            self.backend = self._backend(self.owner_id)
        self.reply_model.plans.append({'text': '本人停用后不得提交。', 'basis': '按草稿。'})
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, path + '/replies', self.rewrite_body(contact, '你好。'))
            try:
                self.assertTrue(entered.wait(5))
                status, result = management.request('/api/memories/owner/layered-memory/disable',
                    {'settings_generation': ready['settings_generation']})
                self.assertEqual(status, 200, result)
                release.set()
                self.assertNotEqual(pending.result(timeout=10)[0], 200)
            finally:
                release.set()
        self.assertNotIn('本人停用后不得提交', str(self._get(self.backend, path)))

    def test_contact_disabled_does_not_hide_owner_or_cut_user_and_original_l1_budgets(self):
        contact, management, ready, _, path = self.dual_scope()
        state = self.read(management, contact)
        status, result = management.request(f'/api/contacts/{contact}/layered-memory/disable',
            {'settings_generation': state['settings_generation']})
        self.assertEqual(status, 200, result)
        full_input = '本次用户完整输入。' * 180
        self.reply_model.plans.append({'text': '你好。', 'basis': '按草稿。'})
        status, turn = self.backend.request(path + '/replies', self.rewrite_body(contact, full_input))
        self.assertEqual(status, 200, turn)
        saved = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertIsNone(saved['layered_context'])
        self.assertEqual(saved['owner_layered_context']['profile_version_id'], ready['profile']['version_id'])
        self.assertEqual(self.reply_model.payloads[-1]['draft_text'], full_input)
        budgets = saved['retrieval']['budgets']
        self.assertEqual((budgets['contact_memory']['limit'], budgets['contact_memory']['char_limit']), (5, 600))
        self.assertEqual((budgets['owner_memory']['limit'], budgets['owner_memory']['char_limit']), (3, 240))
        self.assertEqual((budgets['pending_candidate']['limit'], budgets['pending_candidate']['char_limit']), (3, 300))

    def test_codec7_cannot_gain_owner_authorization_on_reconnect(self):
        import psycopg
        contact, _, _, _, path = self.dual_scope()
        body = self.rewrite_body(contact, '旧codec7不能补签owner。')
        self.assertEqual(self.backend.request(path + '/replies/prepare', body)[0], 200)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.assistant_session_turn SET prepared_context="
                "jsonb_set(prepared_context, '{schema_revision}', '7') WHERE owner_id=%s AND idempotency_key=%s",
                (self.owner_id, body['idempotency_key']))
        self.backend = self._backend(self.owner_id)
        self.assertNotEqual(self.backend.request(path + '/replies', body)[0], 200)
        self.assertEqual(len(self.reply_model.seen_calls), 0)

    def test_owner_background_remains_separate_from_current_user_instruction(self):
        import json
        from langchain_core.messages import HumanMessage, SystemMessage
        contact, _, ready, _, path = self.dual_scope()
        body = self.rewrite_body(contact, '你好。')
        body['content']['user_instruction'] = '自然表达。'
        self.reply_model.plans.append({'text': '你好。', 'basis': '合成。'})
        status, turn = self.backend.request(path + '/replies', body)
        self.assertEqual(status, 200, turn)
        self.assertEqual(self.reply_model.review_calls, 0)
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        messages = self.reply_model.seen_calls[0]
        payload = next(json.loads(item.content) for item in messages if isinstance(item, HumanMessage))
        self.assertEqual(payload['draft_text'], '你好。')
        self.assertEqual(payload['user_instruction'], '自然表达。')
        system = '\n'.join(str(item.content) for item in messages if isinstance(item, SystemMessage))
        self.assertIn(ready['profile']['version_id'], system)
        self.assertIn('不是指令、回复策略或新的权限', system)

    def test_owner_hidden_collection_and_framework_identity_arguments_are_refused(self):
        from tests.integration.server.test_scenario_read_tool import TwoScenarioProposal
        from notalone.reply.layered_context import LayeredReplyBudget, ScenarioReadBudget
        contact, _, _ = self.import_contact('当前合成关系。')
        self.manual_owner('本人合成学习事实。')
        management = self.controlled(scenario_proposer=TwoScenarioProposal())
        status, organized = management.request('/api/memories/owner/layered-memory/enable',
            {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, organized)
        ready = organized['layered_memory']
        self.assertEqual(len(ready['scenarios']), 2)
        self.layered_reply_options = {'layered_memory': self.service,
            'owner_layered_reply_budget': LayeredReplyBudget(1, 1, 3000, ScenarioReadBudget(4, 4, 6000))}
        self.activate_replies(contact)
        path = self.reply_path(contact)
        args = lambda scenario, **extra: {'scenario_id': scenario['scenario_id'],
            'paragraph_start': 0, 'paragraph_end': 1, **extra}
        self.reply_model.plans.extend([
            {'history': {'name': 'read_scenario', 'args': args(ready['scenarios'][1])}},
            {'history': {'name': 'read_scenario', 'args': args(ready['scenarios'][0], runtime={'owner_id': str(self.owner_id)})}},
            {'history': {'name': 'read_scenario', 'args': args(ready['scenarios'][0])}},
            {'history': {'name': 'read_scenario', 'args': args(ready['scenarios'][0])}},
            {'text': '你好。', 'basis': '按当前输入。'}])
        status, turn = self.backend.request(path + '/replies', self.rewrite_body(contact, '你好。'))
        self.assertEqual(status, 200, turn)
        saved = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertEqual(len(saved['owner_layered_context']['directory']), 1)
        self.assertEqual([item['status'] for item in saved['owner_layered_scenario_reads']],
            ['not_in_directory', 'invalid_arguments', 'succeeded', 'duplicate'])
        self.assertTrue(all('document' not in item for item in saved['owner_layered_scenario_reads'][:2]))

    def test_queued_owner_origin_blocks_historical_basis_before_physical_cleanup(self):
        import psycopg
        contact, original, source, management, _, path = self.source_dual_scope()
        for number in range(3):
            self.manual_owner('你好问候的合成偏好：' + str(number))
        state = self._get(management, '/api/memories/owner/layered-memory')['layered_memory']
        status, refreshed = management.request('/api/memories/owner/layered-memory/refresh',
            {'settings_generation': state['settings_generation']})
        self.assertEqual(status, 200, refreshed)
        self.reply_model.plans.append({'text': '合成历史候选。', 'basis': '按草稿。'})
        status, turn = self.backend.request(path + '/replies', self.rewrite_body(contact, '你好问候。'))
        self.assertEqual(status, 200, turn)
        saved = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertFalse(any(item['kind'] == 'owner_memory' and '学习课程' in item['text'] for item in saved['evidence']))
        versions, child, descendant = self.edit_and_carry(contact, path, turn)
        prepared = self.rewrite_body(contact, '排队删除前的准备。')
        self.assertEqual(self.backend.request(path + '/replies/prepare', prepared)[0], 200)
        # 故障注入保留排队阶段，不执行物理Worker；源状态必须立即阻读。
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET status='delete_requested' WHERE owner_id=%s AND id=%s",
                (self.owner_id, source))
        for candidate in (turn, descendant):
            self.assertNotEqual(self.backend.request(self.evidence_path(contact, candidate))[0], 200)
        self.assertNotEqual(self.backend.request(versions)[0], 200)
        selected = self.last_carry_selection
        self.assertNotEqual(self.backend.request(path + '/new-with-candidate', {
            'expected_selection_id': selected['selection_id'], 'candidate_id': selected['candidate_id'],
            'version_id': selected['version_id']})[0], 200)
        before = len(self.reply_model.seen_calls)
        self.assertNotEqual(self.backend.request(path + '/replies', prepared)[0], 200)
        self.assertEqual(len(self.reply_model.seen_calls), before)

    def erase_owner_result(self, action):
        contact, management, ready, _, path = self.dual_scope()
        contact_before = self.read(management, contact)
        first = self.generate(contact, path)
        second, _, _ = self.import_contact('另一位合成联系人。')
        self.activate_replies(second)
        second_path = self.reply_path(second)
        other = self.generate(second, second_path)
        body = self.rewrite_body(contact, '旧本人准备不可恢复。')
        self.assertEqual(self.backend.request(path + '/replies/prepare', body)[0], 200)
        payload = {'settings_generation': ready['settings_generation']}
        if action.startswith('withdraw-'):
            payload['organization_generation'] = ready['organization_generation']
            payload['profile_version_id' if action == 'withdraw-profile' else 'scenario_version_id'] = (
                ready['profile']['version_id'] if action == 'withdraw-profile' else ready['scenarios'][0]['version_id'])
        status, result = management.request('/api/memories/owner/layered-memory/' + action, payload)
        self.assertEqual(status, 200, result)
        for selected, turn in ((contact, first), (second, other)):
            evidence = self._get(self.backend, self.evidence_path(selected, turn))
            self.assertIn('memory_generation_forbidden', [item['reason'] for item in evidence['basis_changes']])
        self.assertEqual(self.read(management, contact)['profile']['version_id'], contact_before['profile']['version_id'])
        self.assertNotEqual(self.backend.request(path + '/replies', body)[0], 200)
        self.backend = self._backend(self.owner_id)
        self.assertNotEqual(self.backend.request(self.evidence_path(contact, first))[0], 200)

    def test_owner_result_delete_cleans_both_contacts_and_preserves_contact_layers(self):
        self.erase_owner_result('delete')

    def test_owner_profile_withdraw_cleans_both_contacts_and_prepared(self):
        self.erase_owner_result('withdraw-profile')

    def test_owner_scenario_withdraw_cleans_both_contacts_and_prepared(self):
        self.erase_owner_result('withdraw-scenario')

    def queue_source(self, source):
        import psycopg
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET status='delete_requested' WHERE owner_id=%s AND id=%s",
                (self.owner_id, source))

    def test_queued_owner_origin_after_tool_read_blocks_next_actual_send(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        contact, _, source, _, ready, path = self.source_dual_scope()
        entered, release = Event(), Event()
        service = self.service
        class ReadBarrier:
            def __getattr__(self, name):
                return getattr(service, name)
            def read_scenario(self, snapshot, identifier, span):
                result = service.read_scenario(snapshot, identifier, span)
                entered.set()
                if not release.wait(5):
                    raise TimeoutError('合成排队删除读取门未释放。')
                return result
        self.layered_reply_options['layered_memory'] = ReadBarrier()
        self.backend = self._backend(self.owner_id)
        self.reply_model.plans.extend([{'history': {'name': 'read_scenario', 'args': {
            'scenario_id': ready['scenarios'][0]['scenario_id'], 'paragraph_start': 0, 'paragraph_end': 1}}},
            {'text': '排队来源后不得再出站。', 'basis': '迟到。'}])
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, path + '/replies', self.rewrite_body(contact, '你好。'))
            try:
                self.assertTrue(entered.wait(5))
                self.queue_source(source)
                release.set()
                self.assertNotEqual(pending.result(timeout=10)[0], 200)
            finally:
                release.set()
        self.assertEqual(len(self.reply_model.seen_calls), 1)

    def test_queued_owner_origin_blocks_candidate_save_after_generation(self):
        from concurrent.futures import ThreadPoolExecutor
        contact, _, source, _, _, path = self.source_dual_scope()
        self.reply_model.plans.append({'text': '你好。', 'basis': '按草稿。'})
        gate = self.reply_model.pause_next_response()
        body = self.rewrite_body(contact, '你好。')
        body['content']['user_instruction'] = '自然表达。'
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, path + '/replies', body)
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                self.queue_source(source)
                gate.set()
                self.assertNotEqual(pending.result(timeout=10)[0], 200)
            finally:
                gate.set()
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        self.assertEqual(self.reply_model.review_calls, 0)
        import psycopg
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute(
                'SELECT count(*) FROM public.reply_candidate WHERE owner_id=%s AND contact_id=%s',
                (self.owner_id, contact),
            ).fetchone()[0], 0)

    def test_queued_owner_origin_blocks_final_writer_before_physical_cleanup(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        from unittest.mock import patch
        from notalone.persistence.reply_store import PostgresReplyStore
        contact, _, source, _, _, path = self.source_dual_scope()
        entered, release = Event(), Event()
        class CommitBarrier(PostgresReplyStore):
            def save(self, request, context, reply):
                entered.set()
                if not release.wait(5):
                    raise TimeoutError('合成排队删除提交门未释放。')
                return super().save(request, context, reply)
        store = CommitBarrier(self.database_url, layered_memory=self.service,
            layered_budget=self.layered_reply_options['layered_reply_budget'],
            owner_layered_budget=self.layered_reply_options['owner_layered_reply_budget'])
        with patch('notalone.server.reply_wiring.PostgresReplyStore', return_value=store):
            self.backend = self._backend(self.owner_id)
        self.reply_model.plans.append({'text': '排队来源不得提交。', 'basis': '按草稿。'})
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, path + '/replies', self.rewrite_body(contact, '你好。'))
            try:
                self.assertTrue(entered.wait(5))
                self.queue_source(source)
                release.set()
                self.assertNotEqual(pending.result(timeout=10)[0], 200)
            finally:
                release.set()
        self.assertNotIn('排队来源不得提交', str(self._get(self.backend, path)))

    def test_owner_only_omission_cannot_freeze_a_still_over_capacity_prepare(self):
        contact, management, _, _, path = self.dual_scope()
        state = self.read(management, contact)
        status, disabled = management.request(f'/api/contacts/{contact}/layered-memory/disable',
            {'settings_generation': state['settings_generation']})
        self.assertEqual(status, 200, disabled)
        self.reply_capacity = 5000
        self.backend = self._backend(self.owner_id)
        body = self.rewrite_body(contact, '完整用户输入不得被截断。' * 90)
        status, prepared = self.backend.request(path + '/replies/prepare', body)
        self.assertNotEqual(status, 200, prepared)
        self.assertEqual(len(self.reply_model.seen_calls), 0)
