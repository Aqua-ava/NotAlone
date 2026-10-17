"""明确升级用户入口的合成HTTP验收；不读取业务历史或外部模型。"""

from datetime import datetime, timezone, timedelta
import json
import os
import threading
import time
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4
import psycopg
from psycopg import sql

from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server.grounded_upgrade_support import GroundedUpgradeModel, CurrentProofBusinessFlowFixture


class UpgradeHttpSupport:
    production_model_wiring=True
    extraction_model_factory=GroundedUpgradeModel
    dimension_release=None

    def setUp(self):
        super().setUp()
        self.contact_id,self.second_contact_id=uuid4(),uuid4()
        with psycopg.connect(self.database_url) as connection:
            for identifier in (self.contact_id,self.second_contact_id):
                connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成升级联系人')",(identifier,self.owner_id))
        for identifier in (self.contact_id,self.second_contact_id):
            self.bindings.create_binding(owner_id=self.owner_id,contact_id=identifier,channel='wechat',
                account_scope='synthetic-upgrade',conversation_locator=str(identifier))
        self.addCleanup(self._release_upgrade_gates)

    def _release_upgrade_gates(self):
        for gate in self.extraction_model.gates.values():gate.release.set()
        if self.extraction_model.adjudication_gate:self.extraction_model.adjudication_gate.release.set()

    def _raw(self, texts=('我平时喜欢合成红茶。',), *, contact=None, speaker='contact'):
        contact=contact or self.contact_id
        source=uuid4();ids=[]
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES(%s,%s,%s,'wechat_jsonl','synthetic-upgrade.jsonl',%s,%s)",
                (source,self.owner_id,contact,uuid4().hex*2,len(texts)))
            for number,text in enumerate(texts):
                identifier=uuid4();ids.append(identifier)
                connection.execute("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES(%s,%s,%s,%s,'text',%s,%s)",
                    (identifier,self.owner_id,contact,speaker,text,datetime.now(timezone.utc)-timedelta(days=2)+timedelta(seconds=number)))
                connection.execute("INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES(%s,%s,%s,'source_document',%s,%s,'{}')",
                    (identifier,self.owner_id,contact,source,str(number)))
        return source,ids

    def _query(self, kind='contact', contact=None):
        return 'scope=owner' if kind=='owner' else f'contact_id={contact or self.contact_id}'

    def _prepare(self, *, kind='contact', limit=20, size=1, calls=8, operation=None):
        body={'scope':{'kind':'owner'} if kind=='owner' else {'kind':'contact','contact_id':str(self.contact_id)},
              'budget':{'message_limit':limit,'batch_size':size,'model_calls':calls},'confirmed':True,'operation_key':operation or str(uuid4())}
        status,result=self.backend.request('/api/memory-upgrades',body)
        self.assertEqual(status,202,result)
        return result,body

    def _wait(self, job, *, kind='contact', states=('ready',), backend=None):
        backend=backend or self.backend;deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            state=self._get(backend,f"/api/memory-upgrades/{job['job_id']}?{self._query(kind)}")
            if all(batch['state'] in states and batch['task_status'] in ('succeeded','failed','cancelled') for batch in state['batches']):return state
            if any(batch['task_status']=='failed' for batch in state['batches']) and 'failed' not in states:
                self.fail('升级固定步骤提前失败：'+json.dumps(state,ensure_ascii=False))
            time.sleep(.02)
        self.fail('升级工作未在有限时段完成。')

    def _action(self, job, action, *, kind='contact', chosen=None, key=None, backend=None):
        body={'action':action,'expected_revision':job['revision'],'operation_key':key or str(uuid4()),'confirmed':True}
        if action in ('apply','undo'):
            body['batches']=[{'batch_id':batch['batch_id'],'expected_revision':batch['revision']} for batch in (job['batches'] if chosen is None else chosen)]
        return (backend or self.backend).request(f"/api/memory-upgrades/{job['job_id']}?{self._query(kind)}",body,
            method='DELETE' if action=='delete' else 'POST'),body

    def _delete_source(self, source, contact=None):
        path=f'/api/contacts/{contact or self.contact_id}/sources'
        status,result=self.backend.request(f'{path}/{source}',method='DELETE');self.assertEqual(status,202,result)
        deadline=time.monotonic()+12
        while time.monotonic()<deadline:
            source_state=next(item for item in self._get(self.backend,path)['sources'] if item['source_id']==str(source))
            self.assertNotEqual(source_state['task_status'],'failed',source_state)
            if source_state['status']=='deleted' and source_state['task_status']=='succeeded':return
            time.sleep(.02)
        with psycopg.connect(self.database_url) as connection:
            tasks=connection.execute('SELECT task_type,status,current_step,last_error_code FROM public.background_task WHERE owner_id=%s AND contact_id=%s',
                (self.owner_id,contact or self.contact_id)).fetchall()
        self.fail('升级合成来源未完成删除。'+json.dumps({
            'source':{key:source_state.get(key) for key in ('status','task_status','error_code')},
            'tasks':tasks},ensure_ascii=False))

    def _assert_workflow_erased(self, job):
        with psycopg.connect(self.database_url) as connection:
            row=connection.execute("SELECT count(*) FROM public.memory_upgrade_batch WHERE owner_id=%s AND job_id=%s AND (cardinality(message_ids)>0 OR source_generation<>'{}' OR memory_generation IS NOT NULL OR extracted_outcome IS NOT NULL OR comparison IS NOT NULL OR adjudications IS NOT NULL OR applied_records IS NOT NULL OR cardinality(dependency_ids)>0 OR trace_id IS NOT NULL)", (self.owner_id,UUID(job['job_id']))).fetchone()
            self.assertEqual(row[0],0)
            self.assertEqual(connection.execute('''SELECT count(*) FROM public.memory_extraction_trace_event AS event
                JOIN public.memory_extraction_trace AS trace USING(trace_id,owner_id,contact_id)
                JOIN public.memory_upgrade_batch AS batch ON batch.id=trace.run_id
                    AND batch.owner_id=trace.owner_id AND batch.contact_id=trace.contact_id
                WHERE batch.owner_id=%s AND batch.job_id=%s''',
                (self.owner_id, UUID(job['job_id']))).fetchone()[0], 0)

    def _trace_fault(self, stage):
        with psycopg.connect(self.database_url) as connection:
            connection.execute(sql.SQL('''CREATE FUNCTION public.synthetic_upgrade_trace_fault() RETURNS trigger
                LANGUAGE plpgsql AS $$ BEGIN
                IF NEW.stage={} THEN RAISE EXCEPTION 'synthetic upgrade trace failure'; END IF;
                RETURN NEW; END $$''').format(sql.Literal(stage)))
            connection.execute('''CREATE TRIGGER synthetic_upgrade_trace_fault BEFORE INSERT
                ON public.memory_extraction_trace_event FOR EACH ROW
                EXECUTE FUNCTION public.synthetic_upgrade_trace_fault()''')

    def _drop_trace_fault(self):
        with psycopg.connect(self.database_url) as connection:
            connection.execute('DROP TRIGGER IF EXISTS synthetic_upgrade_trace_fault ON public.memory_extraction_trace_event')
            connection.execute('DROP FUNCTION IF EXISTS public.synthetic_upgrade_trace_fault()')

    def _trace_details(self):
        path=f'/api/contacts/{self.contact_id}/memory-traces'
        return [self._get(self.backend, path+'/'+batch['trace_id'])
                for batch in self._get(self.backend,path)['batches']]


class MemoryUpgradeHttpTest(UpgradeHttpSupport,CoreBusinessFlowFixture,unittest.TestCase):
    def _authority(self):
        with psycopg.connect(self.database_url) as connection:
            return {table: connection.execute(f'SELECT to_jsonb(row) FROM public.{table} row WHERE owner_id=%s ORDER BY to_jsonb(row)::text',
                    (self.owner_id,)).fetchall() for table in
                    ('memory_candidate', 'confirmed_memory', 'owner_memory', 'memory_extraction_watermark')}

    def test_ready_algorithm_change_rejects_old_approval_and_operation_key(self):
        self._raw()
        prepared, operation = self._prepare(limit=1)
        ready = self._wait(prepared)
        before = self._authority()
        identity = ready['algorithm']
        self.assertEqual(identity['protocol'], 'grounded-labels-v3')
        self.assertEqual(identity['compiler'], 'grounded-source-event-v1')
        self.assertEqual(identity['configuration']['max_retries'], 0)
        self.assertEqual(ready['batches'][0]['algorithm'], identity)
        with patch.dict(os.environ, {'NOTALONE_MEMORY_DIMENSION_GATE': '0'}):
            (status, result), _ = self._action(ready, 'apply')
            self.assertEqual(status, 409, result)
            self.assertEqual(self.backend.request('/api/memory-upgrades', operation)[0], 409)
        self.assertEqual(self._authority(), before)
        self.assertEqual(len(self.extraction_model.seen_calls), 2)

    def test_old_null_algorithm_is_readable_unknown_but_cannot_apply_or_resume(self):
        self._raw()
        prepared, _ = self._prepare(limit=1)
        ready = self._wait(prepared)
        before = self._authority()
        with psycopg.connect(self.database_url) as connection:
            connection.execute('UPDATE public.memory_upgrade_job SET algorithm=NULL WHERE id=%s', (UUID(ready['job_id']),))
            connection.execute('UPDATE public.memory_upgrade_batch SET algorithm=NULL WHERE job_id=%s', (UUID(ready['job_id']),))
        unknown = self._get(self.backend, f"/api/memory-upgrades/{ready['job_id']}?{self._query()}")
        self.assertIsNone(unknown['algorithm'])
        self.assertIsNone(unknown['batches'][0]['algorithm'])
        self.assertEqual(self._action(unknown, 'apply')[0][0], 409)
        self.assertEqual(self._action(unknown, 'resume')[0][0], 409)
        self.assertEqual(self._authority(), before)

    def test_approved_algorithm_change_before_claim_never_writes(self):
        from notalone.application.memory_upgrade import MemoryUpgradeTaskRunner
        self._raw()
        prepared, _ = self._prepare(limit=1)
        ready = self._wait(prepared)
        before = self._authority()
        entered, release = threading.Event(), threading.Event()
        original = MemoryUpgradeTaskRunner.apply
        def blocked(runner, claim):
            entered.set()
            if not release.wait(5):
                raise TimeoutError('合成批准门未释放。')
            return original(runner, claim)
        self.addCleanup(release.set)
        with patch.object(MemoryUpgradeTaskRunner, 'apply', blocked):
            self.assertEqual(self._action(ready, 'apply')[0][0], 200)
            self.assertTrue(entered.wait(3))
            with patch.dict(os.environ, {'NOTALONE_MEMORY_DIMENSION_GATE': '0'}):
                release.set()
                failed = self._wait(prepared, states=('apply_queued',))
                self.assertEqual(failed['batches'][0]['error_code'], 'algorithm_changed')
                self.assertEqual(failed['batches'][0]['task_status'], 'failed')
        self.assertEqual(self._authority(), before)

    def test_algorithm_change_at_final_writer_rolls_back_actual_business_write(self):
        from notalone.memory_extraction.adoption import MemoryAdoption
        from notalone.persistence.memory_store import PostgresMemoryStore
        self._raw()
        prepared, _ = self._prepare(limit=1)
        ready = self._wait(prepared)
        before = self._authority()
        wrote = threading.Event()
        original = MemoryAdoption.adopt
        def changed(adoption, scope, outcome):
            result = original(adoption, scope, outcome)
            if isinstance(adoption._memory_port, PostgresMemoryStore):
                wrote.set()
                os.environ['NOTALONE_MEMORY_DIMENSION_GATE'] = '0'
            return result
        with patch.dict(os.environ, {'NOTALONE_MEMORY_DIMENSION_GATE': '1'}), patch.object(MemoryAdoption, 'adopt', changed):
            self.assertEqual(self._action(ready, 'apply')[0][0], 200)
            failed = self._wait(prepared, states=('apply_queued',))
            self.assertTrue(wrote.is_set())
            self.assertEqual(failed['batches'][0]['error_code'], 'algorithm_changed')
        self.assertEqual(self._authority(), before)

    def test_local_binding_failure_reserves_budget_without_creating_outbound_calls(self):
        self._raw()
        with patch.object(type(self.extraction_model),'bind_tools',side_effect=RuntimeError('合成本地绑定失败')):
            prepared,_=self._prepare(limit=1,calls=3)
            failed=self._wait(prepared,states=('failed',))
        self.assertEqual(failed['model_calls_used'],3)
        self.assertEqual(len(self.extraction_model.seen_calls),0)
        self.assertIsNone(failed['batches'][0]['comparison'])
        traces=self._trace_details()
        self.assertEqual(len(traces),3)
        self.assertTrue(all(trace['status']=='model_failed' for trace in traces))
        self.assertEqual(sum(len(trace['calls']) for trace in traces),0)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute('''SELECT count(*) FROM public.outbound_ledger_entry
                WHERE owner_id=%s AND contact_id=%s''',(self.owner_id,self.contact_id)).fetchone()[0],0)
        (status,resumed),_=self._action(failed,'resume')
        self.assertEqual(status,200,resumed)
        stopped=self._wait(prepared,states=('failed',))
        self.assertEqual(stopped['model_calls_used'],3)
        self.assertEqual(len(self.extraction_model.seen_calls),0)

    def test_preview_response_trace_fault_blocks_private_comparison_and_retry_preserves_actual_calls(self):
        self._raw()
        self._trace_fault('model_response')
        try:
            prepared,_=self._prepare(limit=1,calls=12)
            failed=self._wait(prepared,states=('failed',))
            self.assertEqual(failed['batches'][0]['error_code'],'trace_write_failed')
            self.assertIsNone(failed['batches'][0]['comparison'])
            self.assertEqual(len(self.extraction_model.seen_calls),3)
            traces=self._trace_details()
            self.assertEqual(len(traces),3)
            self.assertTrue(all(trace['status']=='trace_failed' for trace in traces))
            self.assertEqual(sum(len(trace['calls']) for trace in traces),3)
            self.assertEqual(self._get(self.backend,f'/api/contacts/{self.contact_id}/memory-candidates')['candidates'],[])
        finally:
            self._drop_trace_fault()
        (status,resumed),_=self._action(failed,'resume');self.assertEqual(status,200,resumed)
        recovered=self._wait(prepared)
        self.assertEqual(recovered['model_calls_used'],5)
        self.assertEqual(len(self.extraction_model.seen_calls),5)
        traces=self._trace_details()
        succeeded=[trace for trace in traces if trace['status']=='succeeded']
        self.assertEqual(len(succeeded),1)
        self.assertIn('upgrade_preview_write_result',[event['stage'] for event in succeeded[0]['events']])

    def test_apply_trace_fault_rolls_back_business_write_and_resume_reuses_approved_preview(self):
        self._raw();prepared,_=self._prepare(limit=1,calls=8);job=self._wait(prepared)
        self._trace_fault('write_result')
        try:
            (status,queued),_=self._action(job,'apply');self.assertEqual(status,200,queued)
            failed=self._wait(job,states=('apply_queued',))
            self.assertEqual(failed['batches'][0]['task_status'],'failed')
            self.assertEqual(failed['batches'][0]['error_code'],'trace_write_failed')
            self.assertEqual(len(self.extraction_model.seen_calls),2)
            self.assertEqual(self._get(self.backend,f'/api/contacts/{self.contact_id}/memory-candidates')['candidates'],[])
            self.assertEqual(self._get(self.backend,f'/api/contacts/{self.contact_id}/memories')['memories'],[])
            self.assertEqual(sum(trace['status']=='trace_failed' for trace in self._trace_details()),3)
        finally:
            self._drop_trace_fault()
        (status,resumed),_=self._action(failed,'resume');self.assertEqual(status,200,resumed)
        applied=self._wait(job,states=('applied',))
        self.assertEqual(len(self.extraction_model.seen_calls),2)
        self.assertEqual(applied['model_calls_used'],2)
        candidates=self._get(self.backend,f'/api/contacts/{self.contact_id}/memory-candidates')['candidates']
        self.assertEqual(len(candidates),1)
        self.assertTrue(any(event['stage']=='write_result' for trace in self._trace_details()
                            if trace['status']=='succeeded' for event in trace['events']))

    def test_preview_keeps_facts_untouched_and_explicit_apply_is_atomic_durable_idempotent(self):
        self._raw()
        with psycopg.connect(self.database_url) as connection:
            before=connection.execute('SELECT to_jsonb(w) FROM public.memory_extraction_watermark w WHERE owner_id=%s AND contact_id=%s',(self.owner_id,self.contact_id)).fetchall()
        prepared,command=self._prepare(limit=1)
        job=self._wait(prepared)
        self.assertEqual(job['model_calls_used'],2)
        self.assertEqual(job['batches'][0]['comparison']['actions'][0]['kind'],'pending')
        preview_trace=self._trace_details()[0]
        original_candidates={event['candidate_trace_id'] for event in preview_trace['events']
                             if event['stage']=='candidate_raw'}
        self.assertEqual(len(original_candidates),1)
        path=f'/api/contacts/{self.contact_id}/memories'
        self.assertEqual(self._get(self.backend,path)['memories'],[])
        self.assertEqual(self._get(self.backend,f'/api/contacts/{self.contact_id}/memory-candidates')['candidates'],[])
        self.assertEqual(self.other_backend.request(f"/api/memory-upgrades/{job['job_id']}?{self._query()}")[0],404)
        self.assertEqual(self.backend.request(f"/api/memory-upgrades/{job['job_id']}?{self._query(contact=self.second_contact_id)}")[0],404)
        status,repeated=self.backend.request('/api/memory-upgrades',command)
        self.assertEqual(status,202,repeated);self.assertEqual(repeated['job_id'],job['job_id'])
        (status,queued),approval=self._action(job,'apply');self.assertEqual(status,200,queued)
        applied=self._wait(job,states=('applied',))
        apply_trace=next(trace for trace in self._trace_details() if trace['trace_id']!=preview_trace['trace_id'])
        self.assertEqual(apply_trace['status'],'succeeded')
        committed=[event for event in apply_trace['events'] if event['stage']=='write_result']
        replanned=[event for event in apply_trace['events'] if event['stage']=='upgrade_preview_write_result']
        self.assertEqual(len(committed),1);self.assertEqual(len(replanned),1)
        self.assertEqual({event['candidate_trace_id'] for event in (*committed,*replanned)},original_candidates)
        self.assertEqual(replanned[0]['payload']['commit_status'],'planned')
        self.assertEqual(committed[0]['payload']['commit_status'],'committed')
        actual=self._get(self.backend,path)
        self.assertEqual(len(self._get(self.backend,f'/api/contacts/{self.contact_id}/memory-candidates')['candidates']),1)
        self.assertEqual(actual['memories'],[])
        self.assertEqual(len(self.extraction_model.seen_calls),2)
        self.assertEqual(self.backend.request(f"/api/memory-upgrades/{job['job_id']}?{self._query()}",approval)[0],200)
        restored=self._production_backend(self.owner_id)
        self.assertEqual(self._get(restored,path),actual)
        self.assertEqual(self._get(restored,f"/api/memory-upgrades/{job['job_id']}?{self._query()}")['batches'],applied['batches'])
        self.assertEqual(len(self.extraction_model.seen_calls),2)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute('SELECT to_jsonb(w) FROM public.memory_extraction_watermark w WHERE owner_id=%s AND contact_id=%s',(self.owner_id,self.contact_id)).fetchall(),before)
        (status,undone),_=self._action(applied,'undo');self.assertEqual(status,200,undone)
        self.assertEqual(undone['batches'][0]['state'],'undone')
        self.assertEqual(self._get(self.backend,f'/api/contacts/{self.contact_id}/memory-candidates')['candidates'],[])

    def test_manual_decisions_and_old_unknown_proofs_remain_unchanged(self):
        self._raw()
        path=f'/api/contacts/{self.contact_id}/memories'
        status,created=self.backend.request('/api/memories/manual-contact',{
            'contact_id':str(self.contact_id),'text':'联系人喜欢合成绿茶。','category':'preference','topic':'other'})
        self.assertEqual(status,200,created)
        before=self._get(self.backend,path)
        prepared,_=self._prepare(limit=1);job=self._wait(prepared)
        current=job['batches'][0]['comparison']['current']
        self.assertEqual(current[0]['text'],'联系人喜欢合成绿茶。')
        self.assertEqual(current[0]['adoption_method'],'manual');self.assertEqual(current[0]['proof_kind'],'unknown')
        (status,queued),_=self._action(job,'apply');self.assertEqual(status,200,queued)
        self._wait(job,states=('applied',))
        after=self._get(self.backend,path)
        self.assertEqual(after['memories'],before['memories'])
        self.assertEqual(len(self._get(self.backend,f'/api/contacts/{self.contact_id}/memory-candidates')['candidates']),1)

    def test_source_and_workflow_deletion_both_orders_duplicate_and_restart(self):
        for workflow_first in (True,False):
            with self.subTest(workflow_first=workflow_first):
                source,_=self._raw()
                prepared,_=self._prepare(limit=1);job=self._wait(prepared)
                if workflow_first:
                    (status,deleted),body=self._action(job,'delete');self.assertEqual(status,200,deleted)
                    self._assert_workflow_erased(job)
                    self.assertEqual(self.backend.request(f"/api/memory-upgrades/{job['job_id']}?{self._query()}",body,method='DELETE')[0],200)
                    self._delete_source(source)
                else:
                    self._delete_source(source)
                    self._assert_workflow_erased(job)
                    state=self._get(self.backend,f"/api/memory-upgrades/{job['job_id']}?{self._query()}")
                    self.assertIsNone(state['batches'][0]['comparison'])
                    (status,deleted),_=self._action(state,'delete');self.assertEqual(status,200,deleted)
                self._assert_workflow_erased(job)
                restored=self._production_backend(self.owner_id)
                self.assertEqual(restored.request(f"/api/memory-upgrades/{job['job_id']}?{self._query()}")[0],410)
                self._delete_source(source)
        self.assertEqual(len(self.extraction_model.seen_calls),4)

    def test_source_deleted_during_model_response_never_saves_preview(self):
        source,_=self._raw();gate=self.extraction_model.block_call(0)
        prepared,_=self._prepare(limit=1)
        self.assertTrue(gate.entered.wait(5))
        try:
            status,result=self.backend.request(f'/api/contacts/{self.contact_id}/sources/{source}',method='DELETE');self.assertEqual(status,202,result)
        finally:gate.release.set()
        # 来源服务在全局Worker忙时保留queued并要求显式继续；先确认旧宿主退场。
        self.backend.close()
        self.backend=self._production_backend(self.owner_id)
        self._delete_source(source)
        self._assert_workflow_erased(prepared)
        state=self._get(self.backend,f"/api/memory-upgrades/{prepared['job_id']}?{self._query()}")
        self.assertIsNone(state['batches'][0]['comparison'])
        self.assertEqual(len(self.extraction_model.seen_calls),1)

    def test_source_delete_keeps_other_contact_and_failed_task_for_explicit_resume(self):
        from notalone.persistence.source_tasks import PostgresSourceTasks
        selected,_=self._raw()
        failed_source,_=self._raw()
        other_source,_=self._raw(contact=self.second_contact_id)
        sources=PostgresSourceTasks(self.database_url)
        failed=sources.request_delete(self.owner_id,self.contact_id,failed_source)
        other=sources.request_delete(self.owner_id,self.second_contact_id,other_source)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.background_task SET status='failed',last_error_code='synthetic_failure' WHERE id=%s",(failed,))
            connection.execute("UPDATE public.background_task_step SET status='failed',attempt_count=3,last_error_code='synthetic_failure' WHERE task_id=%s AND step_name='mark_deleted'",(failed,))
            untouched=connection.execute('SELECT id,to_jsonb(task) FROM public.background_task task WHERE id=ANY(%s::uuid[]) ORDER BY id',([failed,other],)).fetchall()
        self._delete_source(selected)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute('SELECT id,to_jsonb(task) FROM public.background_task task WHERE id=ANY(%s::uuid[]) ORDER BY id',([failed,other],)).fetchall(),untouched)
        self._delete_source(failed_source)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute('SELECT status FROM public.background_task WHERE id=%s',(other,)).fetchone()[0],'queued')
        self._delete_source(other_source,contact=self.second_contact_id)

    def test_cancel_after_saved_preview_before_step_receipt_recovers_without_model(self):
        from notalone.persistence.memory_upgrade import PostgresMemoryUpgradeStore
        self._raw();saved=__import__('threading').Event();release=__import__('threading').Event()
        original=PostgresMemoryUpgradeStore.save_preview
        def save_then_pause(store,*args,**kwargs):
            result=original(store,*args,**kwargs);saved.set()
            if not release.wait(10):raise TimeoutError('合成提交回执等待超时')
            return result
        with patch.object(PostgresMemoryUpgradeStore,'save_preview',save_then_pause):
            prepared,_=self._prepare(limit=1)
            self.assertTrue(saved.wait(5))
            state=self._get(self.backend,f"/api/memory-upgrades/{prepared['job_id']}?{self._query()}")
            try:
                (status,cancelled),_=self._action(state,'cancel');self.assertEqual(status,200,cancelled)
            finally:release.set()
        (status,resumed),_=self._action(cancelled,'resume');self.assertEqual(status,200,resumed)
        recovered=self._wait(prepared)
        self.assertEqual(len(self.extraction_model.seen_calls),2)
        self.assertEqual(recovered['batches'][0]['task_status'],'succeeded')

    def test_apply_verification_failure_resumes_only_unfinished_receipt(self):
        from notalone.persistence.memory_upgrade import PostgresMemoryUpgradeStore
        self._raw();prepared,_=self._prepare(limit=1);job=self._wait(prepared)
        original=PostgresMemoryUpgradeStore.verify
        def unavailable(store,claim):
            if claim.name.value=='verify_upgrade_apply':raise psycopg.OperationalError('合成末步核验故障')
            return original(store,claim)
        with patch.object(PostgresMemoryUpgradeStore,'verify',unavailable):
            (status,queued),_=self._action(job,'apply');self.assertEqual(status,200,queued)
            failed=self._wait(job,states=('applied',))
            self.assertEqual(failed['batches'][0]['task_status'],'failed')
        path=f'/api/contacts/{self.contact_id}/memories'
        before=self._get(self.backend,path)
        (status,resumed),_=self._action(failed,'resume');self.assertEqual(status,200,resumed)
        recovered=self._wait(job,states=('applied',))
        self.assertEqual(recovered['batches'][0]['task_status'],'succeeded')
        self.assertEqual(self._get(self.backend,path),before)
        self.assertEqual(len(self.extraction_model.seen_calls),2)

    def test_approve_saved_preview_before_first_receipt_preserves_fixed_step_order(self):
        from notalone.persistence.memory_upgrade import PostgresMemoryUpgradeStore
        from threading import Event
        self._raw()
        saved, release = Event(), Event()
        original = PostgresMemoryUpgradeStore.save_preview
        def save_then_pause(store, *args, **kwargs):
            result = original(store, *args, **kwargs)
            saved.set()
            if not release.wait(10):
                raise TimeoutError('合成批准等待超时。')
            return result
        with patch.object(PostgresMemoryUpgradeStore, 'save_preview', save_then_pause):
            prepared, _ = self._prepare(limit=1)
            self.assertTrue(saved.wait(5))
            try:
                current = self._get(self.backend, f"/api/memory-upgrades/{prepared['job_id']}?{self._query()}")
                (status, queued), _ = self._action(current, 'apply')
                self.assertEqual(status, 200, queued)
            finally:
                release.set()
        recovered = self._wait(prepared, states=('applied',))
        self.assertEqual(recovered['batches'][0]['task_status'], 'succeeded')
        self.assertEqual(len(self.extraction_model.seen_calls), 2)
        with psycopg.connect(self.database_url) as connection:
            rows = connection.execute('SELECT step.step_name,step.status FROM public.background_task_step AS step '
                'JOIN public.memory_upgrade_batch AS batch ON batch.task_id=step.task_id '
                'WHERE batch.owner_id=%s AND batch.job_id=%s AND batch.id=%s ORDER BY step.step_order',
                (self.owner_id, UUID(recovered['job_id']), UUID(recovered['batches'][0]['batch_id']))).fetchall()
            self.assertEqual(rows, [(name, 'succeeded') for name in (
                'preview_upgrade', 'verify_upgrade_preview', 'apply_upgrade', 'verify_upgrade_apply')])

    def test_old_failed_callback_after_explicit_resume_cannot_overwrite_new_lease(self):
        from threading import Event
        from notalone.persistence.memory_upgrade import PostgresMemoryUpgradeStore
        self._raw()
        entered, release = Event(), Event()
        original = PostgresMemoryUpgradeStore.failed
        paused = []
        def delayed_failure(store, claim, code):
            if not paused:
                paused.append(claim.lease_generation)
                entered.set()
                if not release.wait(10):
                    raise TimeoutError('合成失败回执等待超时。')
            return original(store, claim, code)
        with patch.object(PostgresMemoryUpgradeStore, 'failed', delayed_failure):
            with patch.object(PostgresMemoryUpgradeStore, 'save_preview', side_effect=psycopg.OperationalError('合成预览保存故障')):
                prepared, _ = self._prepare(limit=1, calls=12)
                self.assertTrue(entered.wait(8))
            try:
                current = self._get(self.backend, f"/api/memory-upgrades/{prepared['job_id']}?{self._query()}")
                self.assertEqual(current['batches'][0]['task_status'], 'failed')
                (status, resumed), _ = self._action(current, 'resume')
                self.assertEqual(status, 200, resumed)
            finally:
                release.set()
            recovered = self._wait(prepared)
        self.assertEqual(recovered['batches'][0]['state'], 'ready')
        self.assertEqual(recovered['batches'][0]['task_status'], 'succeeded')
        self.assertIsNone(recovered['batches'][0]['error_code'])
        self.assertEqual(len(self.extraction_model.seen_calls), 8)

    def test_budget_exhaustion_partial_progress_and_restart_do_not_add_calls(self):
        self._raw(('我平时喜欢合成红茶。','我平时喜欢合成绿茶。'))
        prepared,_=self._prepare(limit=2,size=1,calls=3)
        job=self._wait(prepared,states=('ready','failed'))
        self.assertEqual([batch['state'] for batch in job['batches']],['ready','failed'])
        self.assertEqual(job['model_calls_used'],3)
        self.assertEqual(len(self.extraction_model.seen_calls),3)
        restored=self._production_backend(self.owner_id)
        self.assertEqual(self._get(restored,f"/api/memory-upgrades/{job['job_id']}?{self._query()}")['model_calls_used'],3)
        (status,resumed),_=self._action(job,'resume',backend=restored);self.assertEqual(status,200,resumed)
        final=self._wait(job,states=('ready','failed'),backend=restored)
        self.assertEqual(final['model_calls_used'],3);self.assertEqual(len(self.extraction_model.seen_calls),3)


    def test_original_manual_revision_change_rejects_stale_approval_and_user_rejection_is_preserved(self):
        self._raw()
        path=f'/api/contacts/{self.contact_id}/memories'
        status,created=self.backend.request('/api/memories/manual-contact',{
            'contact_id':str(self.contact_id),'text':'联系人喜欢合成绿茶。','category':'preference','topic':'other'})
        self.assertEqual(status,200,created)
        prepared,_=self._prepare(limit=1);job=self._wait(prepared)
        memory=self._get(self.backend,path)['memories'][0]
        status,corrected=self.backend.request(f"{path}/{memory['memory_id']}/correct",{'text':'用户已确认联系人喜欢合成白茶。'})
        self.assertEqual(status,200,corrected)
        self.assertEqual(self._action(job,'apply')[0][0],409)
        self.assertEqual(self._get(self.backend,f'/api/contacts/{self.contact_id}/memory-candidates')['candidates'],[])
        current=self._get(self.backend,path)['memories']
        second,_=self._prepare(limit=1);ready=self._wait(second)
        self.assertEqual(self._action(ready,'apply')[0][0],200)
        applied=self._wait(second,states=('applied',))
        candidate=self._get(self.backend,f'/api/contacts/{self.contact_id}/memory-candidates')['candidates'][0]
        status,result=self.backend.request(f"/api/contacts/{self.contact_id}/memory-candidates/{candidate['candidate_id']}/discard",{})
        self.assertEqual(status,200,result)
        self.assertEqual(self._action(applied,'undo')[0][0],409)
        third,_=self._prepare(limit=1);compared=self._wait(third)
        self.assertEqual(compared['batches'][0]['comparison']['actions'],[])
        self.assertEqual(self._action(compared,'apply')[0][0],200)
        self._wait(third,states=('applied',))
        self.assertEqual(self._get(self.backend,path)['memories'],current)
        self.assertEqual(self._get(self.backend,f'/api/contacts/{self.contact_id}/memory-candidates')['candidates'],[])

    def test_owner_preview_cross_contact_source_is_erased_immediately_by_controlled_contact_cleanup(self):
        from notalone.memory.models import OwnerMemory,AdoptionMethod,ConfirmedMemoryStatus,MemoryCategory,MemoryTopic
        from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
        from notalone.persistence.contact_deletion import delete_contact
        from notalone.scopes import ContactScope
        source,identifiers=self._raw(contact=self.second_contact_id,speaker='user')
        old=PostgresOwnerMemoryStore(self.database_url).create(OwnerMemory(memory_id=uuid4(),owner_id=self.owner_id,
            text='合成旧本人偏好来自另一已确认联系人。',category=MemoryCategory.PREFERENCE,topic=MemoryTopic.OTHER,
            source_ids=(identifiers[0],),adoption_method=AdoptionMethod.AUTO,status=ConfirmedMemoryStatus.ACTIVE))
        self._raw(speaker='user')
        prepared,_=self._prepare(kind='owner',limit=2)
        job=self._wait(prepared,kind='owner')
        self.assertTrue(any(old.memory_id==UUID(record['memory_id']) for batch in job['batches'] for record in batch['comparison']['current']))
        self.assertTrue(delete_contact(self.database_url,ContactScope(self.owner_id,self.second_contact_id)))
        # 在任何升级GET之前检查本批持久副本，不以懒读取擦除冒充原子删除。
        with psycopg.connect(self.database_url) as connection:
            values=connection.execute("SELECT comparison,extracted_outcome,memory_generation FROM public.memory_upgrade_batch WHERE owner_id=%s AND job_id=%s AND contact_id=%s",(self.owner_id,UUID(job['job_id']),self.contact_id)).fetchall()
            self.assertTrue(values)
            self.assertTrue(all(row==(None,None,None) for row in values))
        state=self._get(self.backend,f"/api/memory-upgrades/{job['job_id']}?scope=owner")
        self.assertTrue(all(batch['comparison'] is None for batch in state['batches']))


class UpdatingUpgradeModel(GroundedUpgradeModel):
    adjudication_action: str = 'update'


class MemoryUpgradeCurrentProofHttpTest(UpgradeHttpSupport,CurrentProofBusinessFlowFixture,unittest.TestCase):
    extraction_model_factory=UpdatingUpgradeModel
    dimension_release=CurrentProofBusinessFlowFixture.dimension_release

    def _archive(self,texts,*,speaker='contact',offset=0):
        from pathlib import Path
        from notalone.application.import_service import ImportService
        from notalone.persistence.postgres_repository import PostgresIngestRepository
        from notalone.server.app import create_app
        from tests.integration.server.core_business_flow_support import HttpBackend
        archive=HttpBackend(create_app(database_url=self.database_url,owner_id=self.owner_id,token=f'synthetic-archive-{self.owner_id}',
            import_service=ImportService(repository=PostgresIngestRepository(self.database_url))),self.owner_id)
        self.addCleanup(archive.close)
        path=Path(self.temporary.name)/('synthetic-archive-'+uuid4().hex+'.jsonl')
        external=str(self.contact_id)
        owner_external=f'wxid_synthetic_{self.backend.token}'
        rows=[{'id':{'local_id':index+1+offset,'server_id_str':str(index+1+offset),'talker':external},
               'create_time':1786500000+60*(index+1+offset),'is_from_me':speaker=='user','kind':'text',
               'sender':'合成本人' if speaker=='user' else '合成联系人','sender_wxid':owner_external if speaker=='user' else external,
               'text':text,'time':'2026-08-12','time_iso':datetime.fromtimestamp(1786500000+60*(index+1+offset),timezone.utc).isoformat()}
              for index,text in enumerate(texts)]
        # 公开导入须同时具备本人和联系人的渠道身份；后置身份消息不占本例升级首批。
        identity_time=1786500000+1000000+offset
        rows.append({'id':{'local_id':1000000+offset,'server_id_str':f'identity-{offset}','talker':external},
            'create_time':identity_time,'is_from_me':speaker!='user','kind':'text',
            'sender':'合成本人' if speaker!='user' else '合成联系人',
            'sender_wxid':owner_external if speaker!='user' else external,
            'text':'合成导入身份确认。','time':'2026-08-24',
            'time_iso':datetime.fromtimestamp(identity_time,timezone.utc).isoformat()})
        path.write_text('\n'.join(json.dumps(row,ensure_ascii=False) for row in rows))
        status,preview=archive.request('/api/imports/preview',{'path':str(path)});self.assertEqual(status,200,preview);self.assertTrue(preview['valid'])
        status,imported=archive.request('/api/imports/commit',{'path':str(path),'contact_id':str(self.contact_id)});self.assertEqual(status,200,imported)
        return imported

    def test_real_current_proof_preview_does_not_auto_apply_and_legitimate_update_can_undo(self):
        first_source=self._archive(('我刚刚到家。',))
        prepared,_=self._prepare(limit=1);job=self._wait(prepared)
        self.assertEqual(job['batches'][0]['comparison']['actions'][0]['kind'],'auto_add')
        path=f'/api/contacts/{self.contact_id}/memories'
        self.assertEqual(self._get(self.backend,path)['memories'],[])
        self.assertEqual(self._action(job,'apply')[0][0],200)
        first=self._wait(job,states=('applied',))
        original=self._get(self.backend,path)['memories'][0]
        second_source=self._archive(('我刚到家。',),offset=1)
        prepared,_=self._prepare(limit=2);compared=self._wait(prepared)
        update=next(batch for batch in compared['batches'] if any(action['kind']=='auto_update' for action in batch['comparison']['actions']))
        self.assertEqual(self._action(compared,'apply',chosen=[update])[0][0],200)
        applied=self._wait(prepared,states=('ready','applied'))
        current=self._get(self.backend,path)['memories'][0]
        self.assertEqual(current['supersedes_memory_id'],original['memory_id'])
        chosen=next(batch for batch in applied['batches'] if batch['state']=='applied')
        self.assertEqual(self._action(applied,'undo',chosen=[chosen])[0][0],200)
        restored=self._get(self.backend,path)['memories'][0]
        self.assertEqual(restored['memory_id'],original['memory_id'])
        self.assertEqual(restored['adoption_method'],'auto')

    def test_multiple_message_proof_keeps_pending_batch_and_undo_preserves_manual_decisions(self):
        from notalone.memory_extraction.dimensions import DimensionRelease
        # 原全文语法不为Grounded包装正文补证明；本方法明确沿默认空放行门。
        self.dimension_release = DimensionRelease()
        self.backend = self._backend(self.owner_id)
        self._archive(('我刚刚到家。','我刚到家。','我刚刚到家。'))
        status,created=self.backend.request('/api/memories/manual-contact',{
            'contact_id':str(self.contact_id),'text':'合成人工资料必须保留。','category':'common_fact','topic':'other'})
        self.assertEqual(status,200,created)
        path=f'/api/contacts/{self.contact_id}/memories'
        before=self._get(self.backend,path)['memories']
        prepared,_=self._prepare(limit=3,size=3,calls=8);job=self._wait(prepared)
        actions=job['batches'][0]['comparison']['actions']
        self.assertEqual([action['kind'] for action in actions],['pending']*3)
        self.assertEqual(self._action(job,'apply')[0][0],200)
        applied=self._wait(job,states=('applied',))
        self.assertEqual(self._get(self.backend,path)['memories'],before)
        self.assertEqual(len(self._get(self.backend,f'/api/contacts/{self.contact_id}/memory-candidates')['candidates']),3)
        self.assertEqual(self._action(applied,'undo')[0][0],200)
        self.assertEqual(self._get(self.backend,path)['memories'],before)
        self.assertEqual(self._get(self.backend,f'/api/contacts/{self.contact_id}/memory-candidates')['candidates'],[])

    def test_direct_undo_after_message_generation_changes_returns_409_without_partial_revert(self):
        self._archive(('我刚刚到家。',))
        prepared,_=self._prepare(limit=1)
        first=self._wait(prepared)
        self.assertEqual(self._action(first,'apply')[0][0],200)
        self._wait(prepared,states=('applied',))
        self._archive(('我刚到家。',),offset=1)
        prepared,_=self._prepare(limit=2)
        compared=self._wait(prepared)
        update=next(batch for batch in compared['batches'] if any(
            action['kind']=='auto_update' for action in batch['comparison']['actions']))
        self.assertEqual(self._action(compared,'apply',chosen=[update])[0][0],200)
        applied=self._wait(prepared,states=('ready','applied'))
        chosen=next(batch for batch in applied['batches'] if batch['state']=='applied')

        def stored_records():
            with psycopg.connect(self.database_url) as connection:
                return tuple(connection.execute(query,(self.owner_id,self.contact_id)).fetchall()
                    for query in (
                        'SELECT to_jsonb(memory) FROM public.confirmed_memory AS memory WHERE owner_id=%s AND contact_id=%s ORDER BY id',
                        'SELECT to_jsonb(candidate) FROM public.memory_candidate AS candidate WHERE owner_id=%s AND contact_id=%s ORDER BY id',
                        'SELECT to_jsonb(batch) FROM public.memory_upgrade_batch AS batch WHERE owner_id=%s AND contact_id=%s ORDER BY id'))

        before=stored_records()
        calls=len(self.extraction_model.seen_calls)
        with psycopg.connect(self.database_url) as connection:
            changed=connection.execute('''UPDATE public.message SET text_content=%s WHERE id=(
                SELECT id FROM public.message WHERE owner_id=%s AND contact_id=%s
                ORDER BY occurred_at,id LIMIT 1) RETURNING id''',
                ('合成规范消息已修正，原版本依据不再相同。',self.owner_id,self.contact_id)).fetchall()
            self.assertEqual(len(changed),1)
        # 不经GET刷新工作状态，直接从已加载的明确批准版本发起撤销。
        (status,result),_=self._action(applied,'undo',chosen=[chosen])
        self.assertEqual(status,409,result)
        self.assertEqual(result,{'error':'memory_upgrade_stale_or_unavailable'})
        self.assertEqual(stored_records(),before)
        self.assertEqual(len(self.extraction_model.seen_calls),calls)

    def test_independent_owner_upgrade_reads_only_user_messages_and_writes_only_owner_facts(self):
        self._archive(('我刚到家。',),speaker='user')
        self._raw(('我平时喜欢不应读取的其他主体。',),contact=self.second_contact_id)
        prepared,_=self._prepare(kind='owner',limit=10)
        job=self._wait(prepared,kind='owner')
        self.assertEqual(len(job['batches']),1)
        self.assertEqual(job['batches'][0]['comparison']['actions'][0]['new']['subject'],'self')
        self.assertEqual(self._action(job,'apply',kind='owner')[0][0],200)
        applied=self._wait(job,kind='owner',states=('applied',))
        self.assertEqual(self._get(self.backend,f'/api/contacts/{self.contact_id}/memories')['memories'],[])
        owner=self._get(self.backend,'/api/memories/owner')['memories']
        self.assertEqual(len(owner),1)
        seen='\n'.join(str(call[-1].content) for call in self.extraction_model.seen_calls)
        self.assertNotIn('不应读取的其他主体',seen)
        self.assertEqual(self._action(applied,'undo',kind='owner')[0][0],200)
        self.assertEqual(self._get(self.backend,'/api/memories/owner')['memories'],[])
