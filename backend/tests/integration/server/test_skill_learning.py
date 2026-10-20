"""自动经验草稿的合成 HTTP／隔离 PostgreSQL 验收。"""

import unittest
import time
import json
import threading
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg

from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture, ScriptedCoreModel, tool_response
from tests.integration.server.test_assistant_candidate_versions import CandidateVersionModel


class ControlledLearningModel(ScriptedCoreModel):
    entered: object = None

    def __init__(self):
        super().__init__()
        self.entered = threading.Event()

    def wait_for_response(self):
        if len(self.seen_calls) in self.response_gates:
            self.entered.set()
        super().wait_for_response()


def synthetic_proposal(*, kind='create', targets=(), replaces=()):
    return {'outcome': 'draft', 'proposal_kind': kind, 'target_skill_ids': list(targets),
            'name': 'careful-response', 'description': '先核实含义，再组织回应。', 'scene': '谨慎回应',
            'scope_suggestion': {'kind': 'contact', 'reason': '目前只有此联系人的有限经验，待审核。'},
            'methods': [{'key': 'clarify', 'title': '先澄清', 'instruction': '区分已知与推测，再给出可编辑的说法。',
                         'replaces_method_ids': list(replaces)}]}


class SkillLearningHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    production_model_wiring = True
    dimension_release = None
    extraction_model_factory = ControlledLearningModel
    reply_model_factory = CandidateVersionModel
    def setUp(self):
        super().setUp()
        self.contact_id, self.second_contact_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            for contact_id, name in ((self.contact_id, '合成学习甲联系人'), (self.second_contact_id, '合成学习乙联系人')):
                connection.execute(
                    "INSERT INTO public.contact(id,owner_id,display_name) VALUES (%s,%s,%s)",
                    (contact_id, self.owner_id, name),
                )
        self.path = f"/api/contacts/{self.contact_id}/skill-learning"

    def _bind(self, contact_id):
        return self.bindings.create_binding(owner_id=self.owner_id, contact_id=contact_id,
            channel='wechat', account_scope='synthetic-learning-account', conversation_locator=f'synthetic-{contact_id}')

    def _configure(self, enabled=True, *, expected=None, operation=None):
        if expected is None:
            expected = self._get(self.backend, self.path)['scope_revision']
        command = {'enabled': enabled, 'confirmed': True, 'expected_revision': expected,
                   'operation_key': operation or str(uuid4())}
        return self.backend.request(self.path, command), command

    def _discussion(self, *, correction='合成纠正：先澄清含义再作答。', target=None):
        status, session = self.backend.request(f'/api/contacts/{self.contact_id}/assistant-session/default', {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"
        content = ({'type': 'response_exploration', 'target_message_id': str(target)} if target
                   else {'type': 'purpose_exploration', 'purpose_hint': '讨论下一次怎样表达。'})
        if correction is not None:
            content['correction'] = correction
        status, recorded = self.backend.request(path + '/inputs', {'content': content})
        self.assertEqual(status, 200, recorded)
        return path, recorded['input_version_id']

    def _wait_learning(self, *, statuses=('succeeded',), backend=None):
        backend = backend or self.backend
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            state = self._get(backend, self.path)
            if state['task'] and state['task']['status'] in statuses:
                return state
            time.sleep(.02)
        self.fail('有界学习未在时限内到达预期状态。')

    def _source_message(self):
        source_id, message_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES(%s,%s,%s,'wechat_jsonl','synthetic-learning.jsonl',%s,1)",
                               (source_id, self.owner_id, self.contact_id, uuid4().hex * 2))
            connection.execute("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES(%s,%s,%s,'contact','text','合成私密来话：先核对安排，再说明原因。',now())",
                               (message_id, self.owner_id, self.contact_id))
            connection.execute("INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES(%s,%s,%s,'source_document',%s,'synthetic-1','{}')",
                               (message_id, self.owner_id, self.contact_id, source_id))
        return source_id, message_id

    def _delete_source(self, source_id):
        path = f'/api/contacts/{self.contact_id}/sources'
        status, response = self.backend.request(f'{path}/{source_id}', method='DELETE')
        self.assertEqual(status, 202, response)
        deadline = time.monotonic() + 12
        next_resume = time.monotonic() + .1
        while time.monotonic() < deadline:
            source = next(row for row in self._get(self.backend, path)['sources'] if row['source_id'] == str(source_id))
            self.assertNotEqual(source['task_status'], 'failed', source)
            if source['status'] == 'deleted' and source['task_status'] == 'succeeded':
                return
            # 全局 Worker 忙时来源入口保留 queued；验收显式继续该删除，不把 GET 当作唤醒。
            if source['task_status'] == 'queued' and time.monotonic() >= next_resume:
                resumed, result = self.backend.request(f'{path}/{source_id}', method='DELETE')
                self.assertEqual(resumed, 202, result)
                next_resume = time.monotonic() + .1
            time.sleep(.02)
        self.fail('合成学习来源删除未完成。')

    def test_pending_review_entry_starts_empty_and_rejects_other_owner(self):
        self.assertEqual(self._get(self.backend, self.path)["drafts"], [])
        self.assertEqual(self.other_backend.request(self.path)[0], 404)

    def test_explicit_contact_learning_automatically_forms_durable_non_running_draft(self):
        self._bind(self.contact_id)
        self.assertEqual(self._get(self.backend, self.path)['enabled'], False)
        self.assertEqual(self._get(self.backend, self.path)['drafts'], [])
        self.extraction_model.responses.append(tool_response('SkillLearningProposal', synthetic_proposal()))
        (status, enabled), enable_command = self._configure()
        self.assertEqual(status, 200, enabled)
        self.assertEqual(enabled['scope_revision'], 1)
        session_path, material = self._discussion()
        state = self._wait_learning()
        self.assertEqual(len(state['drafts']), 1, state)
        draft = state['drafts'][0]
        self.assertEqual(draft['revision'], 1)
        self.assertEqual(draft['proposal_kind'], 'create')
        self.assertEqual(draft['target_versions'], [])
        self.assertEqual(draft['private_evidence']['materials'][0]['material_id'], material)
        self.assertIn('合成纠正', json.dumps(draft['private_evidence'], ensure_ascii=False))
        self.assertNotIn('合成纠正', draft['sanitized_strategy']['document'])
        self.assertEqual(len(self.extraction_model.seen_calls), 1)
        self.assertEqual(self._get(self.backend, '/api/skills')['skills'], [])
        self.assertEqual(self._get(self.backend, f'/api/contacts/{self.second_contact_id}/skill-learning')['drafts'], [])
        self.assertEqual(self.other_backend.request(self.path)[0], 404)
        self.assertEqual(self.backend.request(self.path + '/publish', {})[0], 404)
        (status, disabled), _ = self._configure(False)
        self.assertEqual(status, 200, disabled)
        self.assertEqual(disabled['enabled'], False)
        self.assertEqual(self.backend.request(self.path, enable_command)[1]['enabled'], False)
        restored = self._production_backend(self.owner_id)
        recovered = self._get(restored, self.path)
        self.assertEqual(recovered['drafts'], [draft])
        self.assertFalse(recovered['enabled'])
        self.assertEqual(len(self.extraction_model.seen_calls), 1)


    def _assert_erased_learning(self):
        state = self._get(self.backend, self.path)
        self.assertEqual(state['drafts'], [])
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.skill_draft WHERE owner_id=%s AND contact_id=%s AND (strategy<>'{}' OR private_evidence<>'{}' OR target_versions<>'[]' OR source_generation<>'{}' OR cardinality(dependency_ids)>0)", (self.owner_id,self.contact_id)).fetchone()[0],0)
            self.assertEqual(connection.execute("SELECT count(*) FROM public.skill_learning_batch WHERE owner_id=%s AND contact_id=%s AND (outcome<>'invalidated' OR cardinality(dependency_ids)>0)", (self.owner_id,self.contact_id)).fetchone()[0],0)
            self.assertEqual(connection.execute('SELECT count(*) FROM public.skill_learning_receipt WHERE owner_id=%s AND contact_id=%s AND digest IS NOT NULL', (self.owner_id,self.contact_id)).fetchone()[0],0)
        restored = self._production_backend(self.owner_id)
        self.assertEqual(self._get(restored,self.path)['drafts'],[])

    def test_correction_first_bounded_ordinary_batches_no_change_and_repeated_reads(self):
        self._bind(self.contact_id)
        ordinary = [self._discussion(correction=None)[1] for _ in range(10)]
        _, correction = self._discussion(correction='合成明确纠正：核对已知信息后作答。')
        self.assertEqual(len(self.extraction_model.seen_calls),0)
        self.extraction_model.responses.extend(tool_response('SkillLearningProposal',{'outcome':'no_change'}) for _ in range(2))
        self.assertEqual(self._configure()[0][0],200)
        state=self._wait_learning()
        self.assertEqual(state['drafts'],[])
        self.assertEqual(state['recent_outcomes'],['no_change','no_change'])
        self.assertEqual(len(self.extraction_model.seen_calls),2)
        material_batches=[json.loads(call[-1].content)['materials'] for call in self.extraction_model.seen_calls]
        self.assertEqual(material_batches[0][0]['material_id'],correction)
        self.assertTrue(all(1<=len(items)<=8 for items in material_batches))
        consumed=[item['material_id'] for items in material_batches for item in items]
        self.assertEqual(set(consumed),set(ordinary+[correction]))
        self.assertEqual(len(consumed),11)
        for _ in range(3):
            self.assertEqual(self._get(self.backend,self.path)['drafts'],[])
        self.assertEqual(len(self.extraction_model.seen_calls),2)

    def test_session_and_raw_source_deletion_both_orders_erase_workflow_copies(self):
        for session_first in (True,False):
            with self.subTest(session_first=session_first):
                self.contact_id=uuid4()
                self.path=f'/api/contacts/{self.contact_id}/skill-learning'
                with psycopg.connect(self.database_url) as connection:
                    connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成删除联系人')",(self.contact_id,self.owner_id))
                self._bind(self.contact_id)
                source,message=self._source_message()
                self.extraction_model.responses.append(tool_response('SkillLearningProposal',synthetic_proposal()))
                self.assertEqual(self._configure()[0][0],200)
                session,_=self._discussion(target=message)
                state=self._wait_learning()
                self.assertEqual(len(state['drafts']),1)
                if session_first:
                    self.assertEqual(self.backend.request(session,{'confirmed':True},method='DELETE')[0],200)
                    self._assert_erased_learning()
                    self._delete_source(source)
                else:
                    self._delete_source(source)
                    self._assert_erased_learning()
                    self.assertIn(self.backend.request(session,{'confirmed':True},method='DELETE')[0],(200,404))
                self._assert_erased_learning()
                self._delete_source(source)
                self.assertEqual(len(self.extraction_model.seen_calls),1 if session_first else 2)

    def test_source_deleted_during_model_call_discards_late_proposal_and_cannot_restore(self):
        self._bind(self.contact_id)
        source,message=self._source_message()
        gate=self.extraction_model.pause_next_response()
        self.extraction_model.responses.append(tool_response('SkillLearningProposal',synthetic_proposal()))
        self.assertEqual(self._configure()[0][0],200)
        self._discussion(target=message)
        self.assertTrue(self.extraction_model.entered.wait(5))
        try:
            status,response=self.backend.request(f'/api/contacts/{self.contact_id}/sources/{source}',method='DELETE')
            self.assertEqual(status,202,response)
        finally:
            gate.set()
        self._delete_source(source)
        self.assertEqual(self._get(self.backend,self.path)['drafts'],[])
        restored=self._production_backend(self.owner_id)
        self.assertEqual(self._get(restored,self.path)['drafts'],[])
        self.assertEqual(len(self.extraction_model.seen_calls),1)

    def test_disable_enable_aba_rejects_old_generation_and_stale_authorization(self):
        self._bind(self.contact_id)
        gate=self.extraction_model.pause_next_response()
        self.extraction_model.responses.extend([tool_response('SkillLearningProposal',synthetic_proposal()),tool_response('SkillLearningProposal',synthetic_proposal())])
        (_,enabled),old_enable=self._configure()
        self._discussion()
        self.assertTrue(self.extraction_model.entered.wait(5))
        try:
            self.assertEqual(self._configure(False)[0][0],200)
            self.assertEqual(self._configure(True)[0][0],200)
            self.assertEqual(self.backend.request(self.path,{**old_enable,'operation_key':str(uuid4())})[0],409)
        finally:
            gate.set()
        state=self._wait_learning()
        self.assertTrue(state['enabled'])
        self.assertEqual(len(state['drafts']),1)
        self.assertEqual(len(self.extraction_model.seen_calls),2)
        self.assertEqual(state['scope_revision'],3)
        self.assertTrue(self.backend.request(self.path,old_enable)[1]['enabled'])
        self.assertEqual(self._configure(False)[0][0],200)
        self.assertFalse(self.backend.request(self.path,old_enable)[1]['enabled'])

    def test_temporary_model_failure_retries_are_bounded_and_explicit_resume_keeps_task(self):
        self._bind(self.contact_id)
        self.extraction_model.responses.extend(tool_response('unused_after_temporary_failure',{}) for _ in range(3))
        self.assertEqual(self._configure()[0][0],200)
        def unavailable(model,messages,stop=None,run_manager=None,**kwargs):
            model.seen_calls.append(messages)
            raise RuntimeError('合成模型暂时不可用')
        with patch.object(ControlledLearningModel,'_generate',unavailable):
            self._discussion()
            failed=self._wait_learning(statuses=('failed',))
        self.assertEqual(failed['drafts'],[])
        self.assertEqual(len(self.extraction_model.seen_calls),3)
        for _ in range(3):self._get(self.backend,self.path)
        self.assertEqual(len(self.extraction_model.seen_calls),3)
        self.extraction_model.responses.append(tool_response('SkillLearningProposal',{'outcome':'no_change'}))
        self.assertEqual(self.backend.request(self.path,{'resume':True})[0],200)
        recovered=self._wait_learning()
        self.assertEqual(recovered['task']['task_id'],failed['task']['task_id'])
        self.assertEqual(recovered['recent_outcomes'],['no_change'])
        self.assertEqual(len(self.extraction_model.seen_calls),4)

    def test_invalid_proposal_stops_once_until_explicit_resume(self):
        self._bind(self.contact_id)
        self.extraction_model.responses.append(tool_response('WrongProposal',{}))
        self.assertEqual(self._configure()[0][0],200)
        self._discussion()
        failed=self._wait_learning(statuses=('failed',))
        self.assertEqual(failed['drafts'],[])
        self.assertEqual(len(self.extraction_model.seen_calls),1)
        for _ in range(3):
            self.assertEqual(self._get(self.backend,self.path)['task']['status'],'failed')
        self.assertEqual(len(self.extraction_model.seen_calls),1)
        self.extraction_model.responses.append(tool_response('SkillLearningProposal',{'outcome':'no_change'}))
        self.assertEqual(self.backend.request(self.path,{'resume':True})[0],200)
        recovered=self._wait_learning()
        self.assertEqual(recovered['task']['task_id'],failed['task']['task_id'])
        self.assertEqual(recovered['recent_outcomes'],['no_change'])
        self.assertEqual(len(self.extraction_model.seen_calls),2)

    def test_saved_draft_verification_failure_resumes_without_second_model_or_duplicate_draft(self):
        self._bind(self.contact_id)
        self.extraction_model.responses.append(tool_response('SkillLearningProposal',synthetic_proposal()))
        self.assertEqual(self._configure()[0][0],200)
        with patch('notalone.persistence.skill_learning.PostgresSkillLearningStore.verify',side_effect=psycopg.OperationalError('合成无正文核验暂不可用')):
            self._discussion()
            failed=self._wait_learning(statuses=('failed',))
            self.assertEqual(len(failed['drafts']),1)
            self.assertEqual(len(self.extraction_model.seen_calls),1)
        self.assertEqual(self.backend.request(self.path,{'resume':True})[0],200)
        recovered=self._wait_learning()
        self.assertEqual(recovered['drafts'],failed['drafts'])
        self.assertEqual(recovered['task']['task_id'],failed['task']['task_id'])
        self.assertEqual(len(self.extraction_model.seen_calls),1)

    def test_source_removed_while_waiting_for_foreground_never_enters_model(self):
        from notalone.application.model_priority import ModelPriorityControl
        control=ModelPriorityControl()
        with patch('tests.integration.server.core_business_flow_support.ModelPriorityControl',return_value=control):
            self.backend=self._production_backend(self.owner_id)
        self._bind(self.contact_id)
        source,message=self._source_message()
        self.extraction_model.responses.append(tool_response('SkillLearningProposal',synthetic_proposal()))
        self.assertEqual(self._configure()[0][0],200)
        with control.foreground():
            self._discussion(target=message)
            deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                state=self._get(self.backend,self.path)
                if state['task'] and state['task']['status']=='running':break
                time.sleep(.01)
            else:self.fail('合成学习未领取原任务。')
            status,response=self.backend.request(f'/api/contacts/{self.contact_id}/sources/{source}',method='DELETE')
            self.assertEqual(status,202,response)
            self.assertEqual(len(self.extraction_model.seen_calls),0)
        self._delete_source(source)
        self.assertEqual(self._get(self.backend,self.path)['drafts'],[])
        self.assertEqual(len(self.extraction_model.seen_calls),0)

    def test_actual_draft_insert_failure_rolls_back_receipts_and_explicit_resume(self):
        from psycopg import sql
        self._bind(self.contact_id)
        self.extraction_model.responses.extend(tool_response('SkillLearningProposal',synthetic_proposal()) for _ in range(3))
        self.assertEqual(self._configure()[0][0],200)
        function='synthetic_learning_failure_'+uuid4().hex
        with psycopg.connect(self.database_url) as connection:
            connection.execute(sql.SQL("CREATE FUNCTION public.{}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE check_violation USING MESSAGE='合成保存失败'; END; $$").format(sql.Identifier(function)))
            connection.execute(sql.SQL('CREATE TRIGGER synthetic_learning_failure BEFORE INSERT ON public.skill_draft FOR EACH ROW EXECUTE FUNCTION public.{}()').format(sql.Identifier(function)))
        try:
            self._discussion()
            failed=self._wait_learning(statuses=('failed',))
            self.assertEqual(failed['drafts'],[])
            self.assertEqual(len(self.extraction_model.seen_calls),3)
            with psycopg.connect(self.database_url) as connection:
                for table in ('skill_draft','skill_learning_receipt','skill_learning_batch','skill_method_identity'):
                    self.assertEqual(connection.execute(sql.SQL('SELECT count(*) FROM public.{} WHERE owner_id=%s').format(sql.Identifier(table)),(self.owner_id,)).fetchone()[0],0)
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute('DROP TRIGGER synthetic_learning_failure ON public.skill_draft')
                connection.execute(sql.SQL('DROP FUNCTION public.{}()').format(sql.Identifier(function)))
        self.extraction_model.responses.append(tool_response('SkillLearningProposal',synthetic_proposal()))
        self.assertEqual(self.backend.request(self.path,{'resume':True})[0],200)
        recovered=self._wait_learning()
        self.assertEqual(len(recovered['drafts']),1)
        self.assertEqual(recovered['task']['task_id'],failed['task']['task_id'])
        self.assertEqual(len(self.extraction_model.seen_calls),4)

    def test_saved_proposal_before_last_step_receipt_recovers_from_committed_batch_without_model(self):
        from notalone.persistence.skill_learning import PostgresSkillLearningStore
        self._bind(self.contact_id)
        self.extraction_model.responses.append(tool_response('SkillLearningProposal',synthetic_proposal()))
        self.assertEqual(self._configure()[0][0],200)
        original_capture=PostgresSkillLearningStore.capture
        captures=[]
        def temporary_capture_failures(store,scope):
            captures.append(scope)
            if len(captures)<3:
                raise psycopg.OperationalError('合成取材暂时不可用')
            return original_capture(store,scope)
        original=PostgresSkillLearningStore.save
        def committed_without_receipt(store,scope,claim,batch,proposal):
            count=original(store,scope,claim,batch,proposal)
            self.assertEqual(claim.attempt_count,3)
            # 控制丢失步骤回执后的租约回收，保留真实已提交草稿／材料回执。
            with psycopg.connect(self.database_url) as connection:
                connection.execute("UPDATE public.background_task_step SET status='failed',worker_id=NULL,lease_expires_at=NULL,lease_generation=lease_generation+1,last_error_code='synthetic_lost_receipt' WHERE id=%s",(claim.step_id,))
                connection.execute("UPDATE public.background_task SET status='failed',last_error_code='synthetic_lost_receipt' WHERE id=%s",(claim.task_id,))
            return count
        with patch.object(PostgresSkillLearningStore,'capture',temporary_capture_failures), \
                patch.object(PostgresSkillLearningStore,'save',committed_without_receipt):
            self._discussion()
            failed=self._wait_learning(statuses=('failed',))
        self.assertEqual(len(failed['drafts']),1)
        self.assertEqual(len(captures),3)
        self.assertEqual(len(self.extraction_model.seen_calls),1)
        self.assertEqual(self.backend.request(self.path,{'resume':True})[0],200)
        recovered=self._wait_learning()
        self.assertEqual(recovered['task']['task_id'],failed['task']['task_id'])
        self.assertEqual(recovered['drafts'],failed['drafts'])
        self.assertEqual(len(self.extraction_model.seen_calls),1)
        with psycopg.connect(self.database_url) as connection:
            row=connection.execute("SELECT status,processed_count,total_count FROM public.background_task_step WHERE task_id=%s AND step_name='propose_skill'",(recovered['task']['task_id'],)).fetchone()
            self.assertEqual(row,('succeeded',1,1))

    def test_empty_proposal_after_material_redaction_can_resume_failed_verification_without_batch(self):
        from notalone.persistence.skill_learning import PostgresSkillLearningStore
        self._bind(self.contact_id)
        self.assertEqual(self._configure()[0][0], 200)
        original = PostgresSkillLearningStore.capture
        def redact_before_capture(store, scope):
            with psycopg.connect(self.database_url) as connection:
                connection.execute("UPDATE public.assistant_session_input SET state='redacted',content=NULL,"
                    "dependency_ids='{}' WHERE owner_id=%s AND contact_id=%s AND turn_id IS NULL",
                    (scope.owner_id, scope.contact_id))
            return original(store, scope)
        with patch.object(PostgresSkillLearningStore, 'capture', redact_before_capture), \
                patch.object(PostgresSkillLearningStore, 'verify', side_effect=psycopg.OperationalError('合成空批次末步故障')):
            self._discussion()
            failed = self._wait_learning(statuses=('failed',))
        self.assertEqual(failed['drafts'], [])
        self.assertEqual(self.extraction_model.seen_calls, [])
        self.assertEqual(self.backend.request(self.path, {'resume': True})[0], 200)
        recovered = self._wait_learning()
        self.assertEqual(recovered['task']['task_id'], failed['task']['task_id'])
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM public.skill_learning_batch '
                'WHERE owner_id=%s AND contact_id=%s', (self.owner_id, self.contact_id)).fetchone()[0], 0)
            self.assertEqual(connection.execute("SELECT status,processed_count FROM public.background_task_step "
                "WHERE task_id=%s AND step_name='propose_skill'", (UUID(recovered['task']['task_id']),)).fetchone(),
                ('succeeded', 0))
        self.assertEqual(self.extraction_model.seen_calls, [])

    def test_new_capture_failure_does_not_reuse_old_batch_or_restart_from_authority_reads(self):
        from notalone.persistence.skill_learning import PostgresSkillLearningStore
        from threading import Event
        self._bind(self.contact_id)
        self.extraction_model.responses.append(tool_response('SkillLearningProposal', synthetic_proposal()))
        self.assertEqual(self._configure()[0][0], 200)
        self._discussion()
        first = self._wait_learning()
        entered, release = Event(), Event()
        captures, verifications = [], []
        original_capture, original_verify = PostgresSkillLearningStore.capture, PostgresSkillLearningStore.verify
        def fail_then_capture(store, scope):
            captures.append(len(captures)+1)
            if len(captures) <= 3:
                raise psycopg.OperationalError('合成新轮捕获故障')
            entered.set()
            if not release.wait(10):
                raise TimeoutError('合成新轮捕获等待超时。')
            return original_capture(store, scope)
        def verify(store, scope):
            verifications.append('verify')
            return original_verify(store, scope)
        self.extraction_model.responses.append(tool_response('SkillLearningProposal', synthetic_proposal()))
        with patch.object(PostgresSkillLearningStore, 'capture', fail_then_capture), \
                patch.object(PostgresSkillLearningStore, 'verify', verify):
            self._discussion(correction='合成第二轮纠正：补问含义后再表达。')
            failed = self._wait_learning(statuses=('failed',))
            self.assertEqual(len(captures), 3)
            for _ in range(3):
                self.assertEqual(self._get(self.backend, self.path)['task']['status'], 'failed')
            self.assertEqual(len(captures), 3)
            self.assertEqual(failed['task']['task_id'], first['task']['task_id'])
            try:
                self.assertEqual(self.backend.request(self.path, {'resume': True})[0], 200)
                self.assertTrue(entered.wait(5))
                self.assertEqual(verifications, [])
            finally:
                release.set()
            recovered = self._wait_learning()
        self.assertEqual(recovered['task']['task_id'], first['task']['task_id'])
        self.assertEqual(len(self.extraction_model.seen_calls), 2)
        self.assertEqual(len(recovered['drafts']), 2)

    def test_quoted_ordinary_materials_and_target_metadata_fit_actual_json_without_livelock(self):
        from pathlib import Path
        self._bind(self.contact_id)
        package=Path(self.temporary.name)/'quoted-context'
        package.mkdir()
        (package/'SKILL.md').write_text('---\nname: quoted-context\ndescription: '+json.dumps('"'*900)+'\n---\n\n# 合成方法\n'+('x'*9000)+'\n')
        self.assertEqual(self.backend.request('/api/skills/import',{'package_path':str(package)})[0],200)
        status,session=self.backend.request(f'/api/contacts/{self.contact_id}/assistant-session/default',{})
        self.assertEqual(status,200,session)
        for _ in range(2):
            status,result=self.backend.request(f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}/inputs",{
                'content':{'type':'purpose_exploration','purpose_hint':'"'*4096,'requirements':'"'*4096}})
            self.assertEqual(status,200,result)
        self.extraction_model.responses.extend(tool_response('SkillLearningProposal',{'outcome':'no_change'}) for _ in range(2))
        self.assertEqual(self._configure()[0][0],200)
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            state=self._get(self.backend,self.path)
            if state['task'] and state['task']['status']=='succeeded' and len(state['recent_outcomes'])==2:break
            self.assertFalse(state['task'] and state['task']['status']=='failed',state)
            time.sleep(.02)
        else:self.fail('合法长材料未能在原JSON预算内逐批完成。')
        self.assertEqual(len(self.extraction_model.seen_calls),2)
        for call in self.extraction_model.seen_calls:
            encoded=call[1].content;payload=json.loads(encoded)
            self.assertLessEqual(len(encoded),24000)
            self.assertEqual(len(payload['materials']),1)
            self.assertEqual(payload['materials'][0]['content']['purpose_hint'],'"'*4096)
            self.assertEqual(payload['materials'][0]['content']['requirements'],'"'*4096)
            self.assertEqual(payload['existing_skills'],[])
        self.assertEqual(state['drafts'],[])

    def test_oversized_32_material_prefix_does_not_block_later_valid_correction(self):
        self._bind(self.contact_id)
        status,session=self.backend.request(f'/api/contacts/{self.contact_id}/assistant-session/default',{})
        self.assertEqual(status,200,session)
        path=f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}/inputs"
        oversized={'type':'purpose_exploration','purpose_hint':'"'*4096,
                   'requirements':'"'*4096,'correction':'"'*4096,'answer':'"'*4096}
        skipped=[]
        for _ in range(32):
            status,recorded=self.backend.request(path,{'content':oversized})
            self.assertEqual(status,200,recorded)
            skipped.append(recorded['input_version_id'])
        status,recorded=self.backend.request(path,{'content':{
            'type':'purpose_exploration','purpose_hint':'合成后续经验',
            'correction':'先核实问题，不要凭猜测回答。'}})
        self.assertEqual(status,200,recorded)
        self.extraction_model.responses.append(tool_response('SkillLearningProposal',{'outcome':'no_change'}))
        self.assertEqual(self._configure()[0][0],200)
        state=self._wait_learning()
        self.assertEqual(state['drafts'],[])
        self.assertEqual(len(self.extraction_model.seen_calls),1)
        payload=json.loads(self.extraction_model.seen_calls[0][1].content)
        self.assertEqual([item['material_id'] for item in payload['materials']],
                         [recorded['input_version_id']])
        with psycopg.connect(self.database_url) as connection:
            rows=connection.execute('''SELECT material_id FROM public.skill_learning_receipt
                WHERE owner_id=%s AND contact_id=%s''',(self.owner_id,self.contact_id)).fetchall()
            self.assertEqual([str(row[0]) for row in rows],[recorded['input_version_id']])
            self.assertEqual(connection.execute('''SELECT count(*) FROM public.assistant_session_input
                WHERE owner_id=%s AND contact_id=%s AND id=ANY(%s::uuid[]) AND state='active' ''',
                (self.owner_id,self.contact_id,skipped)).fetchone()[0],32)

    def test_existing_same_name_outside_bounded_target_catalog_cannot_create_duplicate_identity(self):
        from pathlib import Path
        self._bind(self.contact_id)
        for name in (*('a'+str(index)+'-response' for index in range(8)),'careful-response'):
            package=Path(self.temporary.name)/name
            package.mkdir()
            (package/'SKILL.md').write_text(f'---\nname: {name}\ndescription: 合成已有方法\n---\n\n# 有限方法\n\n先核实问题。\n')
            self.assertEqual(self.backend.request('/api/skills/import',{'package_path':str(package)})[0],200)
        catalog=self._get(self.backend,'/api/skills')['skills']
        self.extraction_model.responses.append(tool_response('SkillLearningProposal',synthetic_proposal()))
        self.assertEqual(self._configure()[0][0],200)
        self._discussion()
        failed=self._wait_learning(statuses=('failed','succeeded'))
        self.assertEqual(failed['task']['status'],'failed')
        self.assertEqual(failed['drafts'],[])
        self.assertEqual(len(self.extraction_model.seen_calls),1)
        self.assertEqual(self._get(self.backend,'/api/skills')['skills'],catalog)
        self.extraction_model.responses.append(tool_response('SkillLearningProposal',{'outcome':'no_change'}))
        self.assertEqual(self.backend.request(self.path,{'resume':True})[0],200)
        self.assertEqual(self._wait_learning()['drafts'],[])
        self.assertEqual(len(self.extraction_model.seen_calls),2)

    def test_existing_skill_update_merge_and_reuse_keep_version_and_method_provenance(self):
        from pathlib import Path
        from uuid import UUID,uuid5
        self._bind(self.contact_id)
        identifiers=[]
        for name in ('careful-response','calm-response'):
            package=Path(self.temporary.name)/name
            package.mkdir()
            (package/'SKILL.md').write_text(f'---\nname: {name}\ndescription: 合成已有方法\n---\n\n# 有限方法\n\n先确认含义，再提出说明。\n')
            status,result=self.backend.request('/api/skills/import',{'package_path':str(package)})
            self.assertEqual(status,200,result)
            identifiers.append(result['skill_id'])
        catalog=self._get(self.backend,'/api/skills')['skills']
        methods=[str(uuid5(UUID(identifier),'whole_strategy')) for identifier in identifiers]
        self.extraction_model.responses.append(tool_response('SkillLearningProposal',synthetic_proposal(kind='update',targets=identifiers[:1],replaces=methods[:1])))
        self.assertEqual(self._configure()[0][0],200)
        self._discussion(correction='合成第一次纠正：先明确问题。')
        first=self._wait_learning()
        self.assertEqual(len(first['drafts']),1)
        update=first['drafts'][0]
        self.assertEqual(update['logical_skill_id'],identifiers[0])
        self.assertEqual(update['target_versions'][0]['version_number'],1)
        self.assertEqual(update['sanitized_strategy']['methods'][0]['replaces_method_ids'],methods[:1])
        self.extraction_model.responses.append(tool_response('SkillLearningProposal',synthetic_proposal(kind='merge',targets=identifiers,replaces=methods)))
        self._discussion(correction='合成第二次纠正：补充核实语境。')
        merged=self._wait_learning()
        self.assertEqual(len(merged['drafts']),2)
        merge=next(item for item in merged['drafts'] if item['proposal_kind']=='merge')
        self.assertEqual(merge['sanitized_strategy']['methods'][0]['method_id'],update['sanitized_strategy']['methods'][0]['method_id'])
        self.assertEqual(set(merge['sanitized_strategy']['methods'][0]['replaces_method_ids']),set(methods))
        self.extraction_model.responses.append(tool_response('SkillLearningProposal',{'outcome':'reuse','target_skill_ids':identifiers[:1]}))
        self._discussion(correction='合成第三次纠正：现有方法足够，不添加新方法。')
        reused=self._wait_learning()
        self.assertEqual(len(reused['drafts']),2)
        self.assertEqual(reused['recent_outcomes'][0],'reuse')
        self.assertEqual(self._get(self.backend,'/api/skills')['skills'],catalog)
        self.assertEqual(len(self.extraction_model.seen_calls),3)
        self.assertEqual(self.backend.request(f'/api/skills/{identifiers[0]}/delete',{})[0],200)
        self._assert_erased_learning()

    def _generated_candidate(self):
        _, message = self._source_message()
        status, session = self.backend.request(f'/api/contacts/{self.contact_id}/assistant-session/default', {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"
        status, generated = self.backend.request(path + '/replies', {
            'contact_id': str(self.contact_id), 'idempotency_key': str(uuid4()),
            'content': {'type': 'reply_to_message', 'target_message_id': str(message),
                        'direction': '合成任务：先核实安排。'},
        })
        self.assertEqual(status, 200, generated)
        return path, generated['candidates'][0]

    def _historical_skill_usage(self):
        from pathlib import Path
        self._bind(self.contact_id)
        name = 'historical-learning-method'
        package = Path(self.temporary.name) / name
        package.mkdir()
        (package / 'SKILL.md').write_text(
            f'---\nname: {name}\ndescription: 合成历史表达方法\n---\n\n# 历史方法\n\n先核对含义，再组织说明。\n')
        status, imported = self.backend.request('/api/skills/import', {'package_path': str(package)})
        self.assertEqual(status, 200, imported)
        skill = next(item for item in self._get(self.backend, '/api/skills')['skills']
                     if item['skill_id'] == imported['skill_id'])
        source, message = self._source_message()
        status, session = self.backend.request(f'/api/contacts/{self.contact_id}/assistant-session/default', {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"
        # 复用既有脚本模型，真实read_file仍由生产SkillPort执行。
        self.reply_model.responses.extend([
            tool_response('read_file', {'file_path': f'/notalone/reply-skills/{name}/SKILL.md'}),
            tool_response('ReplyRuntimeOutput', {'candidates': [{
                'text': '合成历史方法候选。', 'messages': ['合成历史方法候选。'],
                'basis': '依据当前合成来话和实际读取的方法。', 'citation_ids': [str(message)], 'risk_notes': [],
            }], 'used_skill_version_id': skill['current_version_id']}),
        ])
        with patch.object(CandidateVersionModel, '_generate', ScriptedCoreModel._generate):
            status, generated = self.backend.request(path + '/replies', {
                'contact_id': str(self.contact_id), 'idempotency_key': str(uuid4()),
                'content': {'type': 'reply_to_message', 'target_message_id': str(message),
                            'direction': '合成任务：先核实安排。'},
            })
        self.assertEqual(status, 200, generated)
        self.assertEqual(generated['used_skill']['skill_id'], skill['skill_id'])
        self.assertEqual(generated['used_skill']['version_id'], skill['current_version_id'])
        self.assertEqual(generated['used_skill']['load_state'], 'loaded')
        return path, generated['candidates'][0], skill, source

    def _record_learning_edit_and_selection(self, path, candidate):
        status, edited = self.backend.request(path + f"/candidates/{candidate['candidate_id']}/versions", {
            'edit_key': str(uuid4()), 'parent_version_id': candidate['candidate_id'],
            'messages': [{'message_id': candidate['messages'][0]['message_id'], 'text': '合成用户修正后的表达。'}],
            'requirements': '合成明确纠正：先确认意愿。',
        })
        self.assertEqual(status, 200, edited)
        status, selected = self.backend.request(path + '/selections', {
            'selection_key': str(uuid4()), 'candidate_id': candidate['candidate_id'],
            'version_id': edited['versions'][1]['version_id'],
        })
        self.assertEqual(status, 200, selected)

    def _assert_historical_skill_materials(self, draft, skill, source):
        materials = draft['private_evidence']['materials']
        self.assertEqual({item['kind'] for item in materials},
                         {'assistant_usage', 'candidate_edit', 'candidate_selection'})
        expected = {skill['skill_id'], skill['current_version_id'], str(source)}
        for material in materials:
            self.assertTrue(expected <= set(material['dependency_ids']), material['kind'])
        self.assertTrue(expected <= set(draft['private_evidence']['source_dependencies']))
        self.assertEqual(draft['target_versions'], [])
        self.assertEqual(draft['private_evidence']['existing_skills'], [])
        self.assertEqual(draft['status'], 'pending')

    def _assert_learning_storage_erased_before_read(self):
        """直接核对删除提交或迟到任务结束后的副本，不让GET失效掩盖残留。"""
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.skill_draft WHERE owner_id=%s AND contact_id=%s AND (strategy<>'{}' OR private_evidence<>'{}' OR target_versions<>'[]' OR source_generation<>'{}' OR cardinality(dependency_ids)>0)", (self.owner_id, self.contact_id)).fetchone()[0], 0)
            self.assertEqual(connection.execute("SELECT count(*) FROM public.skill_learning_batch WHERE owner_id=%s AND contact_id=%s AND (outcome<>'invalidated' OR cardinality(dependency_ids)>0)", (self.owner_id, self.contact_id)).fetchone()[0], 0)
            self.assertEqual(connection.execute('SELECT count(*) FROM public.skill_learning_receipt WHERE owner_id=%s AND contact_id=%s AND digest IS NOT NULL', (self.owner_id, self.contact_id)).fetchone()[0], 0)

    def _wait_learning_storage_settled(self):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            with psycopg.connect(self.database_url) as connection:
                row = connection.execute("SELECT status FROM public.background_task WHERE owner_id=%s AND contact_id=%s AND task_type='skill_learning' ORDER BY created_at DESC,id DESC LIMIT 1", (self.owner_id, self.contact_id)).fetchone()
            if row and row[0] in ('succeeded', 'failed', 'cancelled'):
                return
            time.sleep(.02)
        self.fail('迟到任务未在时限内结束。')

    def test_disabled_used_skill_delete_erases_saved_usage_edit_selection_and_restart_copies(self):
        path, candidate, skill, source = self._historical_skill_usage()
        self._record_learning_edit_and_selection(path, candidate)
        self.assertEqual(self.backend.request(f"/api/skills/{skill['skill_id']}/disable", {})[0], 200)
        self.extraction_model.responses.append(tool_response('SkillLearningProposal', synthetic_proposal()))
        self.assertEqual(self._configure()[0][0], 200)
        draft = self._wait_learning()['drafts'][0]
        restored = self._production_backend(self.owner_id)
        self.assertEqual(self._get(restored, self.path)['drafts'], [draft], '停用不抹去合法历史经验')
        delete_path = f"/api/skills/{skill['skill_id']}/delete"
        first = self.backend.request(delete_path, {})
        self.assertEqual(first[0], 200, first)
        self.assertEqual(self.backend.request(delete_path, {}), first, '重复删除沿原无正文回执')
        self._assert_learning_storage_erased_before_read()
        self._assert_erased_learning()
        self._assert_historical_skill_materials(draft, skill, source)
        self.assertEqual(restored.request(self.path, {'resume': True})[0], 200)
        self.assertEqual(self._get(restored, self.path)['drafts'], [])
        self.assertEqual(len(self.extraction_model.seen_calls), 1)

    def test_disabled_used_skill_delete_during_model_discards_late_save_and_repeat_restart(self):
        path, candidate, skill, source = self._historical_skill_usage()
        self._record_learning_edit_and_selection(path, candidate)
        self.assertEqual(self.backend.request(f"/api/skills/{skill['skill_id']}/disable", {})[0], 200)
        gate = self.extraction_model.pause_next_response()
        self.extraction_model.responses.append(tool_response('SkillLearningProposal', synthetic_proposal()))
        try:
            self.assertEqual(self._configure()[0][0], 200)
            self.assertTrue(self.extraction_model.entered.wait(5))
            delete_path = f"/api/skills/{skill['skill_id']}/delete"
            first = self.backend.request(delete_path, {})
            self.assertEqual(first[0], 200, first)
            self.assertEqual(self.backend.request(delete_path, {}), first)
        finally:
            gate.set()
        self._wait_learning_storage_settled()
        self._assert_learning_storage_erased_before_read()
        self.assertEqual(self._wait_learning(statuses=('failed', 'cancelled', 'succeeded'))['drafts'], [])
        self._assert_erased_learning()
        captured = json.loads(self.extraction_model.seen_calls[0][-1].content)['materials']
        for material in captured:
            self.assertTrue({skill['skill_id'], skill['current_version_id'], str(source)}
                            <= set(material['dependency_ids']))
        self.assertEqual(self.backend.request(self.path, {'resume': True})[0], 200)
        self.assertEqual(self._get(self.backend, self.path)['drafts'], [])
        self.assertEqual(len(self.extraction_model.seen_calls), 1)


    def test_actual_usage_edits_and_selection_are_bounded_material_without_sending_claim(self):
        self._bind(self.contact_id)
        path, candidate = self._generated_candidate()
        status, edited = self.backend.request(path + f"/candidates/{candidate['candidate_id']}/versions", {
            'edit_key': str(uuid4()), 'parent_version_id': candidate['candidate_id'],
            'messages': [{'message_id': candidate['messages'][0]['message_id'],
                          'text': '合成用户修改：先确认时间，再回应。'}],
            'requirements': '合成明确纠正：不要先作承诺。',
        })
        self.assertEqual(status, 200, edited)
        status, selected = self.backend.request(path + '/selections', {
            'selection_key': str(uuid4()), 'candidate_id': candidate['candidate_id'],
            'version_id': edited['versions'][1]['version_id'],
        })
        self.assertEqual(status, 200, selected)
        self.extraction_model.responses.append(tool_response('SkillLearningProposal', synthetic_proposal()))
        self.assertEqual(self._configure()[0][0], 200)
        state = self._wait_learning()
        materials = state['drafts'][0]['private_evidence']['materials']
        self.assertEqual({item['kind'] for item in materials},
                         {'assistant_usage', 'candidate_edit', 'candidate_selection'})
        self.assertEqual(materials[0]['kind'], 'candidate_edit')
        usage = next(item for item in materials if item['kind'] == 'assistant_usage')
        self.assertEqual(usage['candidates'][0]['candidate_id'], candidate['candidate_id'])
        self.assertEqual(usage['candidates'][0]['message_group'], candidate['messages'])
        selection = next(item for item in materials if item['kind'] == 'candidate_selection')
        self.assertEqual(selection['content']['sending_status'], 'unknown')
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        self.assertEqual(len(self.extraction_model.seen_calls), 1)
        self.assertEqual(self._get(self.backend, '/api/skills')['skills'], [])
        self.assertEqual(self.backend.request(path, {'confirmed': True}, method='DELETE')[0], 200)
        self._assert_erased_learning()

    def test_actual_preference_use_is_learning_source_and_delete_erases_before_any_read(self):
        self._bind(self.contact_id)
        status, saved = self.backend.request('/api/expression-preferences', {
            'operation_key': str(uuid4()), 'text': '长期保留核实后再回应的表达习惯。',
            'scope': {'contact_id': None, 'reply_mode': None},
            'origin': {'kind': 'manual'}, 'confirm_long_term': True,
        })
        self.assertEqual(status, 200, saved)
        preference = saved['preference']
        path, candidate = self._generated_candidate()
        self._record_learning_edit_and_selection(path, candidate)
        self.extraction_model.responses.append(tool_response('SkillLearningProposal', synthetic_proposal()))
        self.assertEqual(self._configure()[0][0], 200)
        draft = self._wait_learning()['drafts'][0]
        self.assertIn(preference['preference_id'], draft['private_evidence']['source_dependencies'])
        for material in draft['private_evidence']['materials']:
            self.assertIn(preference['preference_id'], material['dependency_ids'])
        deleted = self.backend.request(
            f"/api/expression-preferences/{preference['preference_id']}?contact_id={self.contact_id}",
            {'operation_key': str(uuid4()), 'expected_revision': preference['revision']}, method='DELETE',
        )
        self.assertEqual(deleted[0], 200, deleted)
        self._assert_learning_storage_erased_before_read()
        self.assertEqual(self._get(self._production_backend(self.owner_id), self.path)['drafts'], [])
        self.assertEqual(len(self.extraction_model.seen_calls), 1)

    def test_preference_revision_changed_during_proposal_rejects_late_draft(self):
        self._bind(self.contact_id)
        status, saved = self.backend.request('/api/expression-preferences', {
            'operation_key': str(uuid4()), 'text': '平时先核实再回答。',
            'scope': {'contact_id': None, 'reply_mode': None},
            'origin': {'kind': 'manual'}, 'confirm_long_term': True,
        })
        self.assertEqual(status, 200, saved)
        preference = saved['preference']
        path, candidate = self._generated_candidate()
        self._record_learning_edit_and_selection(path, candidate)
        gate = self.extraction_model.pause_next_response()
        self.extraction_model.responses.append(tool_response('SkillLearningProposal', synthetic_proposal()))
        try:
            self.assertEqual(self._configure()[0][0], 200)
            self.assertTrue(self.extraction_model.entered.wait(5))
            changed = self.backend.request(
                f"/api/expression-preferences/{preference['preference_id']}?contact_id={self.contact_id}",
                {'operation_key': str(uuid4()), 'expected_revision': preference['revision'],
                 'text': '以后先问清楚具体范围。', 'confirm_long_term': True,
                 'scope': {'contact_id': str(self.contact_id), 'reply_mode': 'initiate_conversation'}},
                method='PATCH',
            )
            self.assertEqual(changed[0], 200, changed)
        finally:
            gate.set()
        self._wait_learning_storage_settled()
        self._assert_learning_storage_erased_before_read()
        self.assertEqual(self._get(self.backend, self.path)['drafts'], [])
        self.assertEqual(len(self.extraction_model.seen_calls), 1)


    def test_corrected_memory_keeps_legal_historical_edit_as_learning_material(self):
        self._bind(self.contact_id)
        status, saved = self.backend.request('/api/memories/manual-contact', {
            'contact_id': str(self.contact_id), 'text': '合成私密来话：先核对安排，再说明原因。',
            'category': 'preference', 'topic': 'other',
        })
        self.assertEqual(status, 200, saved)
        memory_id = saved['memory']['memory_id']
        path, candidate = self._generated_candidate()
        status, history = self.backend.request(path)
        self.assertEqual(status, 200, history)
        request_id = history['turns'][0]['reply']['reply_request_id']
        evidence_path = f'/api/contacts/{self.contact_id}/replies/{request_id}/evidence'
        evidence = self._get(self.backend, evidence_path)
        self.assertIn(memory_id, {item['evidence_id'] for item in evidence['evidence']})
        corrected = self.backend.request(
            f'/api/contacts/{self.contact_id}/memories/{memory_id}/correct',
            {'text': '现在希望先询问意愿，不直接作承诺。'},
        )
        self.assertEqual(corrected[0], 200, corrected)
        self.assertEqual(self.backend.request(evidence_path)[0], 200)
        self._record_learning_edit_and_selection(path, candidate)
        self.extraction_model.responses.append(tool_response('SkillLearningProposal', synthetic_proposal()))
        self.assertEqual(self._configure()[0][0], 200)
        draft = self._wait_learning()['drafts'][0]
        self.assertIn(memory_id, draft['private_evidence']['source_dependencies'])
        self.assertNotIn(corrected[1]['memory']['memory_id'], draft['private_evidence']['source_dependencies'])
        self.assertIn('合成用户修正后的表达', json.dumps(draft['private_evidence'], ensure_ascii=False))

    def test_reliable_same_binding_followups_auto_notify_and_metadata_change_erases_draft(self):
        from datetime import timedelta
        from notalone.server.command import _build_sync_host
        from notalone.scopes import ContactScope
        binding = self._bind(self.contact_id)
        self._generated_candidate()
        self.extraction_model.responses.append(tool_response('SkillLearningProposal', {'outcome': 'no_change'}))
        self.assertEqual(self._configure()[0][0], 200)
        # 普通使用不足合批，先加一份普通讨论，消费原任务材料。
        self._discussion(correction=None)
        self._wait_learning()
        with psycopg.connect(self.database_url) as connection:
            created = connection.execute('SELECT created_at FROM public.assistant_session_turn WHERE owner_id=%s AND contact_id=%s ORDER BY created_at LIMIT 1', (self.owner_id, self.contact_id)).fetchone()[0]
        other_binding = self.bindings.create_binding(owner_id=self.owner_id, contact_id=self.contact_id,
            channel='wechat', account_scope='synthetic-other-account', conversation_locator='synthetic-other-binding')
        observations, included, excluded = [], [], []
        with psycopg.connect(self.database_url) as connection:
            for index, (actual_binding, offset, reliable) in enumerate([
                (binding, 1, True), (binding, 2, True),
                (binding, 25, True), (other_binding, 3, True), (binding, 4, False),
            ], 1):
                observation, message = uuid4(), uuid4()
                occurred = created + timedelta(hours=offset)
                connection.execute("INSERT INTO public.local_wechat_observation(id,owner_id,contact_id,binding_id,mode,cli_version,conversation_locator,read_at,last_local_id,last_cursor,record_count,event_count,is_reliable) VALUES(%s,%s,%s,%s,'live','synthetic-version',%s,%s,%s,%s,1,1,%s)",
                    (observation, self.owner_id, self.contact_id, actual_binding.binding_id, actual_binding.conversation_locator, occurred, index, f'synthetic-{index}', reliable))
                connection.execute("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES(%s,%s,%s,'contact','text',%s,%s)",
                    (message, self.owner_id, self.contact_id, f'合成后续观察{index}，不证明发送或方法效果。', occurred))
                connection.execute("INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,observation_id,source_locator,raw_payload) VALUES(%s,%s,%s,'local_wechat_observation',%s,%s,'{}')",
                    (message, self.owner_id, self.contact_id, observation, f'synthetic-{index}'))
                (included if index <= 2 else excluded).append(message)
                observations.append(observation)
        self.extraction_model.responses.append(tool_response('SkillLearningProposal', synthetic_proposal()))
        app = self.backend.server._app
        captured = {}
        def build_engine(**kwargs):
            captured.update(kwargs)
            return object()
        # 只替换CLI引擎和另一用途的观察调度；学习仍用生产装配的通知、持久任务和Worker。
        with patch('notalone.server.command.owner_wechat_account_scope', return_value='synthetic-learning-account'), patch('notalone.server.command.build_cli_full_sync_engine', side_effect=build_engine), patch('notalone.application.import_service.TaskHost.wake_observation'):
            self.assertIsNotNone(_build_sync_host(database_url=self.database_url, owner_id=self.owner_id,
                interval=3, events=app.events, task_host=app._task_host))
            publisher = captured['message_events']
            for message in included:
                publisher.publish_message_created(scope=ContactScope(self.owner_id, self.contact_id), occurred_at=created + timedelta(hours=2), message_id=message)
            state = self._wait_learning()
        materials = state['drafts'][0]['private_evidence']['materials']
        self.assertEqual({item['material_id'] for item in materials}, {str(value) for value in included})
        self.assertEqual({item['kind'] for item in materials}, {'followup_observation'})
        self.assertTrue(all(item['content']['effectiveness'] == 'unknown' for item in materials))
        self.assertTrue(all(item['content']['sending_status'] == 'unknown' for item in materials))
        self.assertEqual(len(self.extraction_model.seen_calls), 2)
        with psycopg.connect(self.database_url) as connection:
            connection.execute('UPDATE public.local_wechat_observation SET is_reliable=false WHERE id=%s', (observations[0],))
        self.assertEqual(self._get(self.backend, self.path)['drafts'], [])
        restored = self._production_backend(self.owner_id)
        self.assertEqual(self._get(restored, self.path)['drafts'], [])
        self.assertEqual(len(self.extraction_model.seen_calls), 2)
