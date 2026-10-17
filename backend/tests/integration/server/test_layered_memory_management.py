"""主题资料从公开管理 HTTP 穿过真实隔离库；模型边界仅接收合成资料。"""

import unittest
from datetime import datetime, timezone
from uuid import UUID

from notalone.application.layered_memory_service import LayeredMemoryService
from notalone.memory.layered import OrganizationBudget
from notalone.memory.organization_deadline import SYNTHETIC_ORGANIZATION_TIMEOUT
from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
from notalone.server.app import create_app
from tests.integration.server.core_business_flow_support import HttpBackend

from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture


class LayeredMemoryManagementHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    def test_unknown_quality_keeps_confirmed_contact_scope_closed_to_models(self):
        contact, _, _ = self.import_contact("合成联系人范围。")
        status, manual = self.backend.request("/api/memories/manual-contact", {
            "contact_id": contact, "text": "双方共同参加合成课程。", "category": "common_fact",
        })
        self.assertEqual(status, 200, manual)
        path = f"/api/contacts/{contact}/layered-memory"
        status, result = self.backend.request(path)
        self.assertEqual(status, 200, result)
        state = result["layered_memory"]
        self.assertEqual((state["enabled"], state["quality_status"], state["eligible_count"]),
                         (False, "unknown", 1))
        status, enabled = self.backend.request(path + "/enable", {
            "settings_generation": state["settings_generation"], "purpose_confirmed": True,
        })
        self.assertEqual(status, 200, enabled)
        self.assertEqual(enabled["layered_memory"]["status"], "blocked")
        self.assertEqual(enabled["layered_memory"]["scenarios"], [])
        self.assertEqual(self._get(self.backend, path)["layered_memory"]["status"], "blocked")

    def controlled(self, *, proposer=None, verifier=None, budget=None, clock=None, call_timeout_seconds=30, model_priority=None, asynchronous=False):
        self.proposal = proposer or ControlledProposal()
        self.verification = verifier or ControlledVerification()
        self.service = LayeredMemoryService(PostgresLayeredMemoryStore(self.database_url, clock=clock),
            proposer=self.proposal, verifier=self.verification, synthetic=True,
            budget=budget or OrganizationBudget(), call_timeout_seconds=call_timeout_seconds,
            model_priority=model_priority)
        task_host=None
        if asynchronous:
            import psycopg
            from threading import Event
            from notalone.application.import_service import TaskHost
            from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
            from notalone.tasks.worker import BackgroundTaskWorker
            self.task_finished=Event()
            self.receipt_failed=Event()
            service=self.service
            def progress(update):
                if update.status=='succeeded':
                    self.task_finished.set()
                if update.error_code=='temporary_failure':
                    self.receipt_failed.set()
            task_host=TaskHost(worker_builder=lambda: BackgroundTaskWorker(
                repository=PostgresBackgroundTaskRepository(self.database_url),organization_runner=service),
                lock_connection_builder=lambda: psycopg.connect(self.database_url,autocommit=True),
                task_repository=PostgresBackgroundTaskRepository(self.database_url),event_publisher=progress)
            self.task_host=task_host
            self.service.attach_task_host(task_host)
            self.addCleanup(task_host.stop)
        backend = HttpBackend(create_app(database_url=self.database_url, owner_id=self.owner_id,
            token="synthetic-layered-token", layered_memory=self.service,task_host=task_host), self.owner_id)
        self.addCleanup(backend.close)
        return backend

    def enable(self, backend, contact):
        path = f"/api/contacts/{contact}/layered-memory"
        state = self._get(backend, path)["layered_memory"]
        status, result = backend.request(path + "/enable", {
            "settings_generation": state["settings_generation"], "purpose_confirmed": True,
        })
        self.assertEqual(status, 200, result)
        return result["layered_memory"]

    def test_finite_batch_publishes_traceable_system_document_and_reuses_unchanged_work(self):
        contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
        original = self.confirm(contact, "双方共同参加过课程。", message)
        status, manual = self.backend.request("/api/memories/manual-contact", {
            "contact_id": contact, "text": "双方共同完成合成练习。", "category": "common_fact",
        })
        self.assertEqual(status, 200, manual)
        backend = self.controlled(budget=OrganizationBudget(max_memories=1))
        state = self.enable(backend, contact)
        self.assertEqual((state["status"], state["covered_count"], state["remaining_count"]), ("paused", 1, 1))
        document = state["scenarios"][0]
        self.assertEqual(document["title"], "共同学习经历")
        self.assertTrue(document["system_generated"])
        self.assertEqual(document["paragraphs"][0]["text"], "双方共同参加过课程。")
        reference = document["paragraphs"][0]["references"][0]
        self.assertEqual((reference["memory_id"], reference["revision"]),
                         (original["memory_id"], original["revision"]))
        self.assertEqual(reference["provenance_kind"], "source_supported")
        self.assertEqual(reference["timing"]["current_status"], "current_unverified")
        self.assertEqual(len(self.proposal.inputs), 1)
        path = f"/api/contacts/{contact}/layered-memory"
        status, repeated = backend.request(path + "/refresh", {"settings_generation": state["settings_generation"]})
        self.assertEqual(status, 200, repeated)
        self.assertEqual(repeated["layered_memory"]["scenarios"], state["scenarios"])
        self.assertEqual(len(self.proposal.inputs), 1)


    def test_multiple_batches_continue_same_work_without_losing_first_batch(self):
        contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact, "双方共同参加过课程。", message)
        self.backend.request("/api/memories/manual-contact", {
            "contact_id": contact, "text": "双方共同完成合成练习。", "category": "common_fact",
        })
        backend = self.controlled(proposer=EchoProposal(),budget=OrganizationBudget(max_memories=1))
        state = self.enable(backend, contact)
        self.assertEqual((state["status"], state["covered_count"], state["remaining_count"]), ("paused", 1, 1))
        self.assertEqual(state["current_batch"], 1)
        work = state["work_id"]
        command = {"settings_generation": state["settings_generation"], "work_revision": state["work_revision"]}
        status, continued = backend.request(f"/api/contacts/{contact}/layered-memory/continue", command)
        self.assertEqual(status, 200, continued)
        done = continued["layered_memory"]
        self.assertEqual((done["status"],done["covered_count"],done["remaining_count"]), ("ready",2,0))
        self.assertEqual(done["work_id"], work)
        self.assertEqual(done["current_batch"],2)
        texts = [paragraph["text"] for scenario in done["scenarios"] for paragraph in scenario["paragraphs"]]
        self.assertIn("双方共同参加过课程。",texts)
        self.assertIn("双方共同完成合成练习。",texts)
        status, repeated = backend.request(f"/api/contacts/{contact}/layered-memory/continue", command)
        self.assertEqual(status,200,repeated)
        self.assertEqual(repeated["layered_memory"],done)
        self.assertEqual(len(self.proposal.inputs),2)

    def test_task_host_restart_resumes_authorized_queued_work_and_keeps_budget_pause(self):
        import psycopg
        from notalone.persistence.locks import try_acquire_global_worker_lock, release_global_worker_lock
        contact, _, message=self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact,"双方共同参加过课程。",message)
        self.backend.request("/api/memories/manual-contact",{
            "contact_id":contact,"text":"双方共同完成合成练习。","category":"common_fact"})
        proposer=EchoProposal()
        with psycopg.connect(self.database_url,autocommit=True) as blocker:
            self.assertTrue(try_acquire_global_worker_lock(blocker))
            first=self.controlled(proposer=proposer,budget=OrganizationBudget(max_memories=1),asynchronous=True)
            queued=self.enable(first,contact)
            self.assertEqual((queued['covered_count'],queued['current_batch']),(0,0))
            self.task_host.stop()
            release_global_worker_lock(blocker)
        restarted=self.controlled(proposer=proposer,budget=OrganizationBudget(max_memories=1),asynchronous=True)
        path=f"/api/contacts/{contact}/layered-memory"
        self._get(restarted,path)
        self.assertTrue(self.task_finished.wait(5))
        paused=self._get(restarted,path)['layered_memory']
        self.assertEqual((paused['work_id'],paused['status'],paused['covered_count'],paused['model_calls_used']),
                         (queued['work_id'],'paused',1,2))
        self.task_host.stop()
        third=self.controlled(proposer=proposer,budget=OrganizationBudget(max_memories=1),asynchronous=True)
        still_paused=self._get(third,path)['layered_memory']
        self.assertEqual(still_paused,paused)
        self.assertEqual(len(proposer.inputs),1)

    def test_committed_batch_without_last_attempt_receipt_recovers_without_repeating_model(self):
        import psycopg
        contact, _, message=self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact,"双方共同参加过课程。",message)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("CREATE SEQUENCE synthetic_receipt_fault")
            connection.execute("""CREATE FUNCTION synthetic_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    IF NEW.step_name='organize_memory' AND NEW.status='succeeded' AND OLD.status='running'
                       AND nextval('synthetic_receipt_fault')=1 THEN RAISE EXCEPTION 'synthetic receipt loss'; END IF;
                    RETURN NEW;
                END; $$""")
            connection.execute("CREATE TRIGGER synthetic_receipt BEFORE UPDATE ON public.background_task_step "
                               "FOR EACH ROW EXECUTE FUNCTION synthetic_reject_receipt()")
        proposer=EchoProposal()
        first=self.controlled(proposer=proposer,asynchronous=True)
        state=self.enable(first,contact)
        self.assertTrue(self.receipt_failed.wait(5))
        self.task_host.stop()
        with psycopg.connect(self.database_url) as connection:
            # 故障夹具：模拟最后一次领取在提交后失联并过期，恢复仍从公开HTTP触发。
            connection.execute("UPDATE public.background_task_step SET attempt_count=3,lease_expires_at=now()-interval '1 second' WHERE task_id=%s",
                               (state['work_id'],))
        restarted=self.controlled(proposer=proposer,asynchronous=True)
        path=f"/api/contacts/{contact}/layered-memory"
        self._get(restarted,path)
        self.assertTrue(self.task_finished.wait(5))
        ready=self._get(restarted,path)['layered_memory']
        self.assertEqual((ready['work_id'],ready['status'],ready['current_batch'],ready['covered_count']),
                         (state['work_id'],'ready',1,1))
        self.assertEqual(len(proposer.inputs),1)
        self.assertEqual(ready['model_calls_used'],2)

    def test_deleting_future_batch_input_revokes_the_work_before_continue(self):
        contact, _, message=self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact,"双方共同参加过课程。",message)
        _, future_source, future_message=self.import_contact("双方共同完成合成练习。",contact_id=contact,
            when=datetime(2024,2,1,tzinfo=timezone.utc))
        self.confirm(contact,"双方共同完成合成练习。",future_message)
        backend=self.controlled(proposer=EchoProposal(),budget=OrganizationBudget(max_memories=1))
        paused=self.enable(backend,contact)
        self.delete_source(contact,future_source)
        path=f"/api/contacts/{contact}/layered-memory"
        status,result=backend.request(path+'/continue',{
            'settings_generation':paused['settings_generation'],'work_revision':paused['work_revision']})
        self.assertEqual(status,409,result)
        current=self._get(backend,path)['layered_memory']
        self.assertEqual(current['status'],'stale')
        self.assertEqual(len(self.proposal.inputs),1)
        self.assertEqual(current['covered_count'],1)
        self.assertEqual(current['remaining_count'],0)

    def test_same_topic_later_batch_inherits_first_batch_full_erasure_dependencies(self):
        contact, first_source, message=self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact,"双方共同参加过课程。",message)
        self.backend.request('/api/memories/manual-contact',{
            'contact_id':contact,'text':'双方共同完成合成练习。','category':'common_fact'})
        backend=self.controlled(proposer=EchoProposal(),budget=OrganizationBudget(max_memories=1))
        paused=self.enable(backend,contact)
        path=f'/api/contacts/{contact}/layered-memory'
        status,result=backend.request(path+'/continue',{
            'settings_generation':paused['settings_generation'],'work_revision':paused['work_revision']})
        self.assertEqual(status,200,result)
        self.assertEqual(len(result['layered_memory']['scenarios'][0]['paragraphs']),2)
        self.delete_source(contact,first_source)
        current=self._get(backend,path)['layered_memory']
        self.assertEqual(current['scenarios'],[])
        self.assertEqual(current['status'],'stale')
        self.assertEqual(len(self.proposal.inputs),2)
        import psycopg
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM public.layered_memory_batch WHERE contact_id=%s',
                                               (contact,)).fetchone()[0],0)
            self.assertEqual(connection.execute("SELECT target_manifest,dependency_ids FROM public.layered_memory_job WHERE task_id=%s",
                                               (paused['work_id'],)).fetchone(),([],[]))

    def test_pause_revokes_inflight_result_and_continue_uses_a_fresh_lease(self):
        from threading import Event
        contact, _, message=self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact,"双方共同参加过课程。",message)
        started,release,finished=Event(),Event(),Event()
        self.addCleanup(release.set)
        class FirstGated(EchoProposal):
            first=True
            def propose(self, *, memories,budget,deadline):
                if self.first:
                    self.first=False
                    started.set()
                    try:
                        if not release.wait(deadline.remaining_seconds()):
                            raise TimeoutError('合成暂停门等待超时')
                    finally:
                        finished.set()
                return super().propose(memories=memories,budget=budget,deadline=deadline)
        proposer=FirstGated()
        backend=self.controlled(proposer=proposer,asynchronous=True)
        updating=self.enable(backend,contact)
        self.assertTrue(started.wait(3))
        path=f'/api/contacts/{contact}/layered-memory'
        status,result=backend.request(path+'/pause',{
            'settings_generation':updating['settings_generation'],'work_revision':updating['work_revision']})
        self.assertEqual(status,200,result)
        paused=result['layered_memory']
        self.assertEqual((paused['status'],paused['covered_count'],paused['scenarios']),('paused',0,[]))
        release.set()
        self.assertTrue(finished.wait(3))
        self.task_host.stop()
        restarted=self.controlled(proposer=proposer,asynchronous=True)
        still_paused=self._get(restarted,path)['layered_memory']
        self.assertEqual(still_paused['status'],'paused')
        status,result=restarted.request(path+'/continue',{
            'settings_generation':paused['settings_generation'],'work_revision':paused['work_revision']})
        self.assertEqual(status,200,result)
        self.assertTrue(self.task_finished.wait(5))
        ready=self._get(restarted,path)['layered_memory']
        self.assertEqual((ready['status'],ready['covered_count'],ready['current_batch']),('ready',1,1))
        self.assertEqual(ready['model_calls_used'],3)
        self.assertEqual(len(ready['scenarios'][0]['paragraphs']),1)

    def test_transport_retry_cannot_reset_consumed_budget_on_restart_or_continue(self):
        contact, _, message=self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact,"双方共同参加过课程。",message)
        class TransientProposal(EchoProposal):
            attempts=0
            def propose(self, *, memories,budget,deadline):
                self.attempts+=1
                if self.attempts==1:
                    raise ConnectionError('合成传输故障')
                return super().propose(memories=memories,budget=budget,deadline=deadline)
        proposer=TransientProposal()
        backend=self.controlled(proposer=proposer)
        paused=self.enable(backend,contact)
        self.assertEqual((paused['status'],paused['model_calls_used'],paused['model_call_limit']),('paused',2,2))
        self.assertEqual(paused['error_code'],'model_budget_exhausted')
        restarted=self.controlled(proposer=proposer)
        path=f'/api/contacts/{contact}/layered-memory'
        self.assertEqual(self._get(restarted,path)['layered_memory'],paused)
        status,result=restarted.request(path+'/continue',{
            'settings_generation':paused['settings_generation'],'work_revision':paused['work_revision']})
        self.assertEqual(status,200,result)
        ready=result['layered_memory']
        self.assertEqual((ready['status'],ready['model_calls_used'],ready['model_call_limit']),('ready',4,4))
        self.assertEqual(ready['current_batch'],1)

    def test_unaffected_topic_remains_readable_after_another_batch_source_is_deleted(self):
        from notalone.scopes import ContactScope
        class SeparateTopics(EchoProposal):
            def propose(self, *, memories,budget,deadline):
                result=super().propose(memories=memories,budget=budget,deadline=deadline)
                result['scenarios'][0]['topic_key']='practice' if '练习' in memories[0].text else 'course'
                return result
        contact, source, message=self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact,"双方共同参加过课程。",message)
        self.backend.request('/api/memories/manual-contact',{
            'contact_id':contact,'text':'双方共同完成合成练习。','category':'common_fact'})
        backend=self.controlled(proposer=SeparateTopics(),budget=OrganizationBudget(max_memories=1))
        paused=self.enable(backend,contact)
        path=f'/api/contacts/{contact}/layered-memory'
        status,result=backend.request(path+'/continue',{
            'settings_generation':paused['settings_generation'],'work_revision':paused['work_revision']})
        self.assertEqual(status,200,result)
        self.delete_source(contact,source)
        remaining=self._get(backend,path)['layered_memory']
        self.assertEqual((remaining['covered_count'],remaining['remaining_count']),(1,0))
        self.assertEqual([p['text'] for doc in remaining['scenarios'] for p in doc['paragraphs']],['双方共同完成合成练习。'])
        snapshot=self.service.capture(ContactScope(self.owner_id,UUID(contact)))
        self.assertIsNotNone(snapshot)
        self.assertTrue(self.service.validate(snapshot))
        self.assertEqual(self.service.read_scenario(snapshot,snapshot.scenarios[0].scenario_id,(0,1))['paragraphs'][0]['text'],
                         '双方共同完成合成练习。')

    def test_lease_takeover_rejects_old_result_and_resumes_without_duplicate_body(self):
        import psycopg
        contact, _, message=self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact,"双方共同参加过课程。",message)
        class TakeoverProposal(EchoProposal):
            first=True
            def propose(adapter, *, memories,budget,deadline):
                result=super(TakeoverProposal,adapter).propose(memories=memories,budget=budget,deadline=deadline)
                if adapter.first:
                    adapter.first=False
                    with psycopg.connect(self.database_url) as connection:
                        # 外部故障事件：旧worker租约已失效，迟到响应仍必须被writer拒绝。
                        connection.execute("UPDATE public.background_task_step s SET lease_generation=lease_generation+1,"
                            "lease_expires_at=now()-interval '1 second' FROM public.background_task t "
                            "WHERE t.id=s.task_id AND t.owner_id=%s AND t.contact_id=%s AND s.step_name='organize_memory'",
                            (self.owner_id,contact))
                return result
        proposer=TakeoverProposal()
        backend=self.controlled(proposer=proposer)
        paused=self.enable(backend,contact)
        self.assertEqual((paused['status'],paused['covered_count'],paused['scenarios']),('paused',0,[]))
        self.assertEqual(paused['model_calls_used'],2)
        status,result=backend.request(f'/api/contacts/{contact}/layered-memory/continue',{
            'settings_generation':paused['settings_generation'],'work_revision':paused['work_revision']})
        self.assertEqual(status,200,result)
        ready=result['layered_memory']
        self.assertEqual((ready['status'],ready['covered_count'],ready['current_batch']),('ready',1,1))
        self.assertEqual(len(ready['scenarios'][0]['paragraphs']),1)
        self.assertEqual(ready['model_calls_used'],4)

    def test_three_batches_keep_documents_bounded_and_duplicate_continue_does_not_advance(self):
        contact, _, message=self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact,"双方共同参加过课程。",message)
        for text in ('双方共同完成合成练习。','双方共同整理合成笔记。'):
            self.backend.request('/api/memories/manual-contact',{
                'contact_id':contact,'text':text,'category':'common_fact'})
        backend=self.controlled(proposer=EchoProposal(),budget=OrganizationBudget(max_memories=1,max_paragraphs=1))
        first=self.enable(backend,contact)
        path=f'/api/contacts/{contact}/layered-memory/continue'
        command={'settings_generation':first['settings_generation'],'work_revision':first['work_revision']}
        status,second=backend.request(path,command)
        self.assertEqual(status,200,second)
        second=second['layered_memory']
        self.assertEqual((second['status'],second['covered_count'],second['remaining_count']),('paused',2,1))
        status,duplicate=backend.request(path,command)
        self.assertEqual(status,200,duplicate)
        self.assertEqual(duplicate['layered_memory'],second)
        status,third=backend.request(path,{
            'settings_generation':second['settings_generation'],'work_revision':second['work_revision']})
        self.assertEqual(status,200,third)
        done=third['layered_memory']
        self.assertEqual((done['work_id'],done['status'],done['covered_count'],done['remaining_count'],done['current_batch']),
            (first['work_id'],'ready',3,0,3))
        self.assertEqual([len(doc['paragraphs']) for doc in done['scenarios']],[1,1,1])
        self.assertEqual({p['text'] for doc in done['scenarios'] for p in doc['paragraphs']},
            {'双方共同参加过课程。','双方共同完成合成练习。','双方共同整理合成笔记。'})
        self.assertEqual(done['model_calls_used'],6)

    def test_deleting_an_uncited_input_erases_body_history_and_batch_artifacts(self):
        contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact, "双方共同参加过课程。", message)
        _, hidden_source, hidden_message = self.import_contact("合成背景：双方曾一起做练习。", contact_id=contact,
            when=datetime(2024, 2, 1, tzinfo=timezone.utc))
        self.confirm(contact, "双方曾一起做练习。", hidden_message)
        backend = self.controlled()
        ready = self.enable(backend, contact)
        self.assertEqual(ready["covered_count"], 2)
        self.assertEqual(len(ready["scenarios"][0]["paragraphs"][0]["references"]), 1)
        self.delete_source(contact, hidden_source)
        state = self._get(backend, f"/api/contacts/{contact}/layered-memory")["layered_memory"]
        self.assertEqual(state["scenarios"], [])
        self.assertEqual(state["status"], "stale")
        import psycopg
        with psycopg.connect(self.database_url) as connection:
            artifacts = connection.execute("SELECT count(*) FROM public.layered_memory_batch "
                "WHERE owner_id=%s AND contact_id=%s", (self.owner_id,contact)).fetchone()[0]
        self.assertEqual(artifacts, 0, "完整删除依赖包括实际读入但未引用的输入、输出及历史")


    def test_disabled_documents_remain_viewable_delete_erases_artifacts_and_stale_aba_request_fails(self):
        contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
        memory = self.confirm(contact, "双方共同参加过课程。", message)
        backend = self.controlled()
        ready = self.enable(backend, contact)
        path = f"/api/contacts/{contact}/layered-memory"
        status, disabled = backend.request(path + "/disable", {"settings_generation": ready["settings_generation"]})
        self.assertEqual(status, 200, disabled)
        self.assertEqual(disabled["layered_memory"]["scenarios"], ready["scenarios"])
        status, repeated = backend.request(path + "/disable", {"settings_generation": ready["settings_generation"]})
        self.assertEqual(status, 200, repeated)
        self.assertEqual(repeated, disabled)
        restored = self.enable(backend, contact)
        self.assertGreater(restored["settings_generation"], ready["settings_generation"])
        self.assertEqual(restored["scenarios"][0]["scenario_id"], ready["scenarios"][0]["scenario_id"])
        status, stale = backend.request(path + "/delete", {"settings_generation": ready["settings_generation"]})
        self.assertEqual(status, 409, stale)
        status, deleted = backend.request(path + "/delete", {"settings_generation": restored["settings_generation"]})
        self.assertEqual(status, 200, deleted)
        self.assertFalse(deleted["layered_memory"]["enabled"])
        self.assertEqual(deleted["layered_memory"]["scenarios"], [])
        self.assertEqual(self.overview(contact)["entries"][0]["memory"]["memory_id"], memory["memory_id"])
        import psycopg
        with psycopg.connect(self.database_url) as connection:
            count = connection.execute("SELECT count(*) FROM public.layered_memory_batch WHERE owner_id=%s "
                "AND contact_id=%s", (self.owner_id,contact)).fetchone()[0]
        self.assertEqual(count, 0)

    def test_unknown_pending_and_other_contact_material_never_enter_actual_model_input(self):
        import psycopg
        from uuid import uuid4
        from notalone.memory.models import MemoryCandidate, MemoryCategory
        from notalone.persistence.memory_store import PostgresMemoryStore
        from notalone.scopes import ContactScope
        contact, _, message = self.import_contact("合成来历未知资料。")
        unknown = self.confirm(contact,"这条旧资料缺失原始证明。",message)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.memory_candidate SET correction_evidence=NULL WHERE id="
                "(SELECT source_candidate_id FROM public.confirmed_memory WHERE id=%s)", (unknown["memory_id"],))
        PostgresMemoryStore(self.database_url).create_candidate(MemoryCandidate(candidate_id=uuid4(),
            scope=ContactScope(self.owner_id,UUID(contact)),text="尚未采纳的资料。",
            category=MemoryCategory.COMMON_FACT,source_ids=(message,)))
        status, manual = self.backend.request("/api/memories/manual-contact", {
            "contact_id": contact,"text": "双方共同参加过课程。","category": "common_fact",
        })
        self.assertEqual(status,200,manual)
        other, _, _ = self.import_contact("另一联系人隔离范围。")
        self.backend.request("/api/memories/manual-contact", {
            "contact_id": other,"text": "另一联系人私人资料。","category": "common_fact",
        })
        backend = self.controlled()
        ready = self.enable(backend,contact)
        self.assertEqual(ready["eligible_count"],1)
        self.assertEqual([item.text for item in self.proposal.inputs[0]], ["双方共同参加过课程。"])
        self.assertEqual(self.proposal.inputs[0][0].provenance_kind,"manual_entry")
        self.assertFalse(self._get(backend,f"/api/contacts/{other}/layered-memory")["layered_memory"]["enabled"])
        foreign = self._backend(uuid4())
        status, result = foreign.request(f"/api/contacts/{contact}/layered-memory")
        self.assertEqual(status,404,result)

    def test_controlled_adapter_transport_deadline_discards_timeout_output(self):
        from threading import Event
        contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact, "双方共同参加过课程。", message)
        release = Event()
        self.addCleanup(release.set)
        proposer = GatedProposal(release)
        backend = self.controlled(proposer=proposer, call_timeout_seconds=0.2)
        state = self.enable(backend, contact)
        self.assertEqual((state["status"],state["error_code"]), ("failed","model_call_timeout"))
        release.set()
        self.assertTrue(proposer.finished.wait(2))
        current = self._get(backend,f"/api/contacts/{contact}/layered-memory")["layered_memory"]
        self.assertEqual(current["scenarios"], [])
        self.assertEqual(current["status"], "failed")

    def test_adapter_transport_deadlines_release_shared_foreground_without_opening_the_gate(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        from notalone.application.model_priority import ModelPriorityControl
        for slow_phase in ("proposal", "verification"):
            with self.subTest(slow_phase=slow_phase):
                contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
                self.confirm(contact, "双方共同参加过课程。", message)
                slow = DeadlineTransportAdapter(slow_phase)
                priority = ModelPriorityControl()
                backend = self.controlled(proposer=slow if slow_phase == "proposal" else None,
                    verifier=slow if slow_phase == "verification" else None,
                    call_timeout_seconds=0.2, model_priority=priority)
                foreground_entered = Event()
                def foreground():
                    with priority.foreground():
                        foreground_entered.set()
                with ThreadPoolExecutor(max_workers=2) as workers:
                    organizing = workers.submit(self.enable, backend, contact)
                    self.assertTrue(slow.started.wait(2), "必须实际到达受控传输")
                    replying = workers.submit(foreground)
                    self.assertTrue(slow.finished.wait(2), "Adapter须按剩余期限自行返回，不人工放门")
                    self.assertTrue(foreground_entered.wait(1), "实际调用超时返回后前台必须取得共享许可")
                    replying.result(timeout=1)
                    state = organizing.result(timeout=2)
                self.assertFalse(slow.gate.is_set())
                self.assertEqual((state["status"], state["error_code"]), ("failed", "model_call_timeout"))
                self.assertEqual(state["scenarios"], [])

    def test_legacy_and_unqualified_sdk_adapters_cannot_open_a_synthetic_scope(self):
        from notalone.memory.organization_deadline import OrganizationAdapterTimeoutContract
        contact, _, _ = self.import_contact("合成范围：Adapter期限准入。")
        class LegacyProposal:
            def propose(self, *, memories, budget):
                raise AssertionError("无期限Adapter不得调用")
        class MissingDeadlineProposal(LegacyProposal):
            timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT
        class UnqualifiedSdkProposal(ControlledProposal):
            timeout_contract = OrganizationAdapterTimeoutContract("sdk")
        for adapter in (LegacyProposal(), MissingDeadlineProposal(), UnqualifiedSdkProposal()):
            with self.subTest(adapter=type(adapter).__name__), self.assertRaises(ValueError):
                self.controlled(proposer=adapter)
        state = self._get(self.backend, f"/api/contacts/{contact}/layered-memory")["layered_memory"]
        self.assertEqual((state["enabled"], state["settings_generation"], state["scenarios"]), (False, 0, []))

    def test_complete_verification_input_over_budget_never_calls_verifier_or_publishes(self):
        contact, _, _ = self.import_contact("合成范围：核验输入也须有界。")
        status, manual = self.backend.request("/api/memories/manual-contact", {
            "contact_id": contact, "text": "合成" * 1250, "category": "common_fact",
        })
        self.assertEqual(status, 200, manual)
        verifier = RecordingVerification()
        backend = self.controlled(proposer=EchoProposal(), verifier=verifier)
        state = self.enable(backend, contact)
        self.assertEqual((state["status"], state["error_code"]),
                         ("failed", "verification_input_budget_exceeded"))
        self.assertEqual(verifier.inputs, [])
        self.assertEqual((state["scenarios"], state["covered_count"], state["remaining_count"]), ([], 0, 1))
        self.assertEqual(state["organization_generation"], 0)
        self.assertEqual(len(self.proposal.inputs), 1, "提案记忆和生成文字各自合法，但完整核验输入超限")
        self.assertEqual(self._get(backend, f"/api/contacts/{contact}/layered-memory")["layered_memory"], state)

    def test_oversized_single_memory_pauses_without_sending_unbounded_model_input(self):
        contact, _, _ = self.import_contact("合成范围：有限输入。")
        status, manual = self.backend.request("/api/memories/manual-contact", {
            "contact_id": contact, "text": "合成资料。" * 1000, "category": "common_fact",
        })
        self.assertEqual(status, 200, manual)
        backend = self.controlled()
        state = self.enable(backend, contact)
        self.assertEqual((state["status"], state["error_code"], state["remaining_count"]),
                         ("failed", "input_budget_exceeded", 1))
        self.assertEqual(self.proposal.inputs, [])

    def test_late_verification_after_delete_and_reenable_cannot_cross_settings_aba(self):
        contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact, "双方共同参加过课程。", message)
        path = f"/api/contacts/{contact}/layered-memory"
        def delete_and_reenable():
            state = self._get(self.backend, path)["layered_memory"]
            status, deleted = self.backend.request(path+"/delete", {"settings_generation": state["settings_generation"]})
            self.assertEqual(status, 200, deleted)
            self.enable(self.backend, contact)
        backend = self.controlled(verifier=HookVerification(delete_and_reenable))
        state = self.enable(backend, contact)
        self.assertEqual(state["status"], "blocked")
        self.assertEqual(state["scenarios"], [])
        self.assertGreaterEqual(state["settings_generation"], 3)
        import psycopg
        with psycopg.connect(self.database_url) as connection:
            count = connection.execute("SELECT count(*) FROM public.layered_memory_batch WHERE owner_id=%s "
                "AND contact_id=%s", (self.owner_id,contact)).fetchone()[0]
        self.assertEqual(count, 0)

    def test_clock_boundary_invalidates_a_frozen_current_paragraph_and_refresh_preserves_history(self):
        from notalone.scopes import ContactScope
        contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact, "双方共同参加过课程。", message,
            valid_at=datetime(2024, 1, 1, tzinfo=timezone.utc),
            invalid_at=datetime(2099, 1, 2, tzinfo=timezone.utc))
        now = [datetime(2099, 1, 1, tzinfo=timezone.utc)]
        backend = self.controlled(clock=lambda: now[0])
        ready = self.enable(backend, contact)
        snapshot = self.service.capture(ContactScope(self.owner_id,UUID(contact)))
        self.assertTrue(self.service.validate(snapshot))
        now[0] = datetime(2099, 1, 3, tzinfo=timezone.utc)
        self.assertFalse(self.service.validate(snapshot))
        path = f"/api/contacts/{contact}/layered-memory"
        self.assertEqual(self._get(backend,path)["layered_memory"]["status"], "stale")
        status, refreshed = backend.request(path+"/refresh", {"settings_generation": ready["settings_generation"]})
        self.assertEqual(status, 200, refreshed)
        reference = refreshed["layered_memory"]["scenarios"][0]["paragraphs"][0]["references"][0]
        self.assertEqual(reference["timing"]["current_status"], "historical")
        self.assertEqual(datetime.fromisoformat(self.proposal.inputs[-1][0].invalid_at),
                         datetime(2099, 1, 2, tzinfo=timezone.utc))

    def test_public_read_port_freezes_one_generation_and_revokes_snapshot_on_disable(self):
        from notalone.scopes import ContactScope
        contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact, "双方共同参加过课程。", message)
        backend = self.controlled()
        ready = self.enable(backend, contact)
        scope = ContactScope(self.owner_id, UUID(contact))
        snapshot = self.service.capture(scope)
        self.assertEqual(snapshot.organization_generation, ready["organization_generation"])
        self.assertTrue(self.service.validate(snapshot))
        document = self.service.read_scenario(snapshot, UUID(ready["scenarios"][0]["scenario_id"]), (0, 1))
        self.assertEqual(document["paragraphs"][0]["text"], "双方共同参加过课程。")
        self.assertEqual(document["version_id"], ready["scenarios"][0]["version_id"])
        status, disabled = backend.request(f"/api/contacts/{contact}/layered-memory/disable", {
            "settings_generation": ready["settings_generation"],
        })
        self.assertEqual(status, 200, disabled)
        self.assertFalse(self.service.validate(snapshot))
        self.assertIsNone(self.service.capture(scope))
        with self.assertRaises(Exception):
            self.service.read_scenario(snapshot, UUID(ready["scenarios"][0]["scenario_id"]), (0, 1))

    def test_empty_and_independent_verification_rejection_have_distinct_visible_states(self):
        contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
        backend = self.controlled(verifier=RejectVerification())
        empty = self.enable(backend, contact)
        self.assertEqual((empty["status"], empty["scenarios"]), ("empty", []))
        self.confirm(contact, "双方共同参加过课程。", message)
        status, failed = backend.request(f"/api/contacts/{contact}/layered-memory/refresh", {
            "settings_generation": empty["settings_generation"],
        })
        self.assertEqual(status, 200, failed)
        self.assertEqual(failed["layered_memory"]["status"], "failed")
        self.assertEqual(failed["layered_memory"]["error_code"], "faithfulness_rejected")
        self.assertEqual(failed["layered_memory"]["scenarios"], [])

    def test_correction_before_or_after_publish_cannot_restore_invalidated_body(self):
        for during_proposal in (False, True):
            with self.subTest(during_proposal=during_proposal):
                contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
                memory = self.confirm(contact, "双方共同参加过课程。", message)
                correction = lambda: self.backend.request(
                    f"/api/contacts/{contact}/memories/{memory['memory_id']}/correct",
                    {"text": "双方分别上过课程，尚未共同参加。"})
                proposer = HookProposal(correction if during_proposal else None)
                backend = self.controlled(proposer=proposer)
                ready = self.enable(backend, contact)
                if not during_proposal:
                    self.assertEqual(ready["status"], "ready")
                    status, result = correction()
                    self.assertEqual(status, 200, result)
                state = self._get(backend, f"/api/contacts/{contact}/layered-memory")["layered_memory"]
                self.assertEqual(state["scenarios"], [])
                self.assertEqual(state["status"], "stale")


class ControlledProposal:
    timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT

    def __init__(self):
        self.inputs = []

    def propose(self, *, memories, budget, deadline):
        deadline.check()
        self.inputs.append(memories)
        return {"scenarios": [{"topic_key": "shared-learning", "title": "共同学习经历",
            "hint": "共同课程与学习经历", "paragraphs": [{"text": "双方共同参加过课程。",
            "references": [{"memory_id": str(memories[0].memory_id), "revision": memories[0].revision}]}]}]}


class ControlledVerification:
    timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT

    def verify(self, *, memories, proposal, deadline):
        deadline.check()
        return True


class RejectVerification:
    timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT

    def verify(self, *, memories, proposal, deadline):
        deadline.check()
        return False


class HookProposal(ControlledProposal):
    def __init__(self, hook):
        super().__init__()
        self.hook = hook

    def propose(self, *, memories, budget, deadline):
        proposal = super().propose(memories=memories, budget=budget, deadline=deadline)
        if self.hook:
            self.hook()
        return proposal


class HookVerification:
    timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT

    def __init__(self, hook):
        self.hook = hook

    def verify(self, *, memories, proposal, deadline):
        deadline.check()
        self.hook()
        deadline.check()
        return True


class GatedProposal(ControlledProposal):
    def __init__(self, release):
        from threading import Event
        super().__init__()
        self.release, self.finished = release, Event()

    def propose(self, *, memories, budget, deadline):
        try:
            if not self.release.wait(deadline.remaining_seconds()):
                from notalone.application.organization_call import OrganizationCallTimeout
                raise OrganizationCallTimeout()
            return super().propose(memories=memories,budget=budget,deadline=deadline)
        finally:
            self.finished.set()


class EchoProposal(ControlledProposal):
    def propose(self, *, memories, budget, deadline):
        proposal = super().propose(memories=memories, budget=budget, deadline=deadline)
        proposal["scenarios"][0]["paragraphs"][0]["text"] = memories[0].text
        return proposal


class RecordingVerification:
    timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT

    def __init__(self):
        self.inputs = []

    def verify(self, *, memories, proposal, deadline):
        deadline.check()
        self.inputs.append((memories, proposal))
        return True


class DeadlineTransportAdapter:
    timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT

    def __init__(self, phase):
        from threading import Event
        self.phase = phase
        self.gate, self.started, self.finished = Event(), Event(), Event()

    def _transport(self, deadline):
        self.started.set()
        try:
            if not self.gate.wait(deadline.remaining_seconds()):
                from notalone.application.organization_call import OrganizationCallTimeout
                raise OrganizationCallTimeout()
        finally:
            self.finished.set()

    def propose(self, *, memories, budget, deadline):
        self._transport(deadline)
        return ControlledProposal().propose(memories=memories, budget=budget, deadline=deadline)

    def verify(self, *, memories, proposal, deadline):
        self._transport(deadline)
        return True
