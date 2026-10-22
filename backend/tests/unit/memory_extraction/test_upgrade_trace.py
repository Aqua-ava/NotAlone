"""升级预览复用完整追踪，预演不能冒称事实已经提交。"""

from datetime import datetime, timezone
from types import SimpleNamespace
import unittest
from uuid import uuid4
from contextlib import nullcontext
from unittest.mock import patch

from langchain_core.messages import AIMessage

from notalone.application.memory_upgrade import MemoryUpgradeTaskRunner
from notalone.memory import InMemoryMemoryStore
from notalone.memory_extraction.adapters import LangChainExtractionRuntime
from notalone.memory_extraction.models import ExtractionWindow, MessageRef, MessageSender
from notalone.memory_trace.adapters import InMemoryTraceStore
from notalone.memory_trace import TraceWriteError
from tests.support.ledger_adapters import InMemoryOutboundLedger
from notalone.scopes import ContactScope
from tests.input_budget_support import SyntheticBudgetModel


class UpgradeTraceTest(unittest.TestCase):
    def _runner(self, traces, *, facts=True, subjects=('contact',), invalid_output=False):
        scope = ContactScope(uuid4(), uuid4())
        message = MessageRef(uuid4(), '我平时喜欢合成红茶。', MessageSender.CONTACT,
                             datetime.now(timezone.utc), message_type='text', text_representation='text')
        memory = InMemoryMemoryStore()
        prepared = SimpleNamespace(batch_id=uuid4(), scope=scope, target_kind='contact',
            window=ExtractionWindow(scope.owner_id, scope.contact_id, (message,), (message.message_id,)),
            generation={'dependency_ids': []}, memory_port=memory, owner_memory_port=None)
        fact = {'text': '联系人喜欢合成红茶。', 'category': 'preference', 'subject': 'contact', 'topic': 'other',
            'source_message_ids': [str(message.message_id)], 'confidence': .95, 'risk_flags': [],
            'valid_at': None, 'invalid_at': None, 'speech_act': 'assertion', 'assertion_status': 'asserted',
            'figurative_type': 'literal', 'alternatives': [], 'interpretation_reason': '合成直接陈述。'}
        response=AIMessage(content='合成无效返回') if invalid_output else AIMessage(content='', tool_calls=[{
            'name': 'MemoryExtractionOutput', 'args': {'facts': [{**fact,'subject':subject}
                for subject in subjects] if facts else []}, 'id': 'synthetic-upgrade-trace',
        }])
        model = SyntheticBudgetModel(responses=[response])
        observed = {'saved': False, 'charged': 0}
        observed['ledger'] = InMemoryOutboundLedger()

        class Store:
            def capture(self, claim):
                return prepared
            def begin_trace(self, claim, payload):
                identifier = traces.begin(scope, run_id=prepared.batch_id, batch_key='synthetic-upgrade', payload=payload)
                observed['trace_id'] = identifier
                return identifier
            def charge(self, claim):
                observed['charged'] += 1
            def validate(self, claim):
                pass
            def bind_outcome(self, claim, result):
                return result
            def save_preview(self, claim, prepared, result, compared, decisions, *, trace_id, trace_payload):
                traces.complete(scope, trace_id, status='succeeded', payload=trace_payload)
                observed['saved'] = True
                observed['outcome'] = result
                return len(prepared.window.messages)

        runner = MemoryUpgradeTaskRunner(store=Store(), trace_store=traces,
            runtime_builder=lambda: {'extraction': LangChainExtractionRuntime(model=model), 'ledger': observed['ledger']})
        return runner, model, memory, scope, observed

    def _all_stage_runner(self, traces):
        from dataclasses import replace
        from notalone.memory import MemoryCandidate, MemoryCategory
        from notalone.memory_extraction.adjudication_adapters import LangChainAdjudicationRuntime
        from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
        from notalone.memory_extraction.dimensions import DimensionRelease, MemoryDimension
        from tests.unit.memory_extraction.dimension_helpers import synthetic_complete_evidence
        runner,model,memory,scope,observed=self._runner(traces)
        source=model.responses[0].tool_calls[0]['args']['facts'][0]['source_message_ids'][0]
        model.responses.extend([AIMessage(content='',tool_calls=[{'name':'SourceVerificationOutput','id':'synthetic-v',
            'args':{'results':[{'candidate_index':0,'verdict':'supported','issues':[],
                'evidence':[{'message_id':source,'quote':'我平时喜欢合成红茶。'}]}]}}]),AIMessage(content='合成无效裁决')])
        old=memory.create_candidate(MemoryCandidate(candidate_id=uuid4(),scope=scope,
            text='联系人喜欢合成绿茶。',category=MemoryCategory.PREFERENCE,source_ids=(uuid4(),)))
        memory.confirm(scope=scope,candidate_id=old.candidate_id)
        # 显式合成依据仅进入A故障分支；生产默认质量门保持原样。
        runner.store.bind_outcome=lambda claim,result:replace(result,accepted=tuple(
            synthetic_complete_evidence(fact,scope=scope) for fact in result.accepted))
        runner.dimension_release=DimensionRelease(tuple(MemoryDimension))
        runner.runtime_builder=lambda:{'extraction':LangChainExtractionRuntime(model=model),
            'verification':LangChainSourceVerificationRuntime(model=model,ledger=observed['ledger']),
            'adjudication':LangChainAdjudicationRuntime(model=model),'ledger':observed['ledger']}
        return runner,model,memory,scope,observed

    def test_local_binding_failure_in_each_stage_never_adds_an_outbound_call(self):
        from notalone.memory_extraction.errors import ExtractionRuntimeError
        original=SyntheticBudgetModel.bind_tools
        for previous_calls,title in enumerate(('MemoryExtractionOutput','SourceVerificationOutput','MemoryAdjudicationOutput')):
            with self.subTest(stage=title):
                traces=InMemoryTraceStore()
                runner,model,_,scope,observed=self._all_stage_runner(traces)
                def bind(current,tools,**options):
                    if tools[0]['title']==title:
                        raise RuntimeError('合成本地绑定失败')
                    return original(current,tools,**options)
                with patch.object(SyntheticBudgetModel,'bind_tools',bind):
                    with self.assertRaises(ExtractionRuntimeError):
                        runner.preview(object())
                self.assertFalse(observed['saved'])
                self.assertEqual(len(model.seen_model_payloads),previous_calls)
                self.assertEqual(len(observed['ledger'].list_by_owner(scope.owner_id)),previous_calls)
                self.assertEqual(observed['charged'],previous_calls+1,'预扣预算与实际调用台账分别报告')
                self.assertEqual(traces.get_batch(scope,observed['trace_id'])['status'],'model_failed')

    def test_entered_invoke_failure_in_each_stage_keeps_one_failed_outbound_attempt(self):
        from notalone.memory_extraction.errors import ExtractionRuntimeError
        from notalone.ledger.models import LedgerOutcome
        original=SyntheticBudgetModel._generate
        for previous_calls,title in enumerate(('MemoryExtractionOutput','SourceVerificationOutput','MemoryAdjudicationOutput')):
            with self.subTest(stage=title):
                traces=InMemoryTraceStore()
                runner,model,_,scope,observed=self._all_stage_runner(traces)
                def generate(current,messages,stop=None,run_manager=None,**options):
                    if options['tools'][0]['function']['name']==title:
                        current.record_model_payload(messages,options)
                        raise RuntimeError('合成调用已进入后失败')
                    return original(current,messages,stop=stop,run_manager=run_manager,**options)
                with patch.object(SyntheticBudgetModel,'_generate',generate):
                    with self.assertRaises(ExtractionRuntimeError):
                        runner.preview(object())
                entries=observed['ledger'].list_by_owner(scope.owner_id)
                self.assertEqual(len(model.seen_model_payloads),previous_calls+1)
                self.assertEqual(len(entries),previous_calls+1)
                self.assertEqual(sum(entry.outcome is LedgerOutcome.RUN_FAILED for entry in entries),1)
                self.assertFalse(observed['saved'])

    def test_filtering_owner_fact_keeps_contact_adoption_under_its_original_candidate(self):
        traces=InMemoryTraceStore()
        runner,_,_,scope,observed=self._runner(traces,subjects=('self','contact'))
        runner.preview(object())
        events=traces.get_batch(scope,observed['trace_id'])['events']
        contact=next(event['candidate_trace_id'] for event in events
                     if event['stage']=='candidate_raw' and event['payload']['fields']['subject']=='contact')
        writes=[event for event in events if event['stage']=='upgrade_preview_write_result']
        self.assertTrue(writes)
        self.assertEqual({event['candidate_trace_id'] for event in writes},{contact})
        self.assertEqual(tuple(str(item) for item in observed['outcome'].candidate_trace_ids),(contact,))

    def test_invalid_model_output_is_model_failure_rather_than_business_write_failure(self):
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError
        traces=InMemoryTraceStore()
        runner,model,_,scope,observed=self._runner(traces,invalid_output=True)
        with self.assertRaises(ExtractionInvalidOutputError):
            runner.preview(object())
        self.assertEqual(len(model.seen_model_payloads),1)
        self.assertFalse(observed['saved'])
        batch=traces.get_batch(scope,observed['trace_id'])
        self.assertEqual(batch['status'],'model_failed')
        self.assertEqual(batch['events'][-1]['payload']['failure_kind'],'invalid_output')

    def test_invalid_adjudication_after_e_and_v_keeps_candidate_failure_in_preview(self):
        from dataclasses import replace
        from notalone.memory import MemoryCandidate,MemoryCategory
        from notalone.memory_extraction.adjudication_adapters import LangChainAdjudicationRuntime
        from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
        from notalone.memory_extraction.dimensions import DimensionRelease,MemoryDimension
        from tests.unit.memory_extraction.dimension_helpers import synthetic_complete_evidence
        traces=InMemoryTraceStore()
        runner,model,memory,scope,observed=self._runner(traces)
        source=model.responses[0].tool_calls[0]['args']['facts'][0]['source_message_ids'][0]
        model.responses.extend([AIMessage(content='',tool_calls=[{'name':'SourceVerificationOutput','id':'synthetic-v',
            'args':{'results':[{'candidate_index':0,'verdict':'supported','issues':[],
                'evidence':[{'message_id':source,'quote':'我平时喜欢合成红茶。'}]}]}}]),AIMessage(content='合成无效裁决')])
        old=memory.create_candidate(MemoryCandidate(candidate_id=uuid4(),scope=scope,
            text='联系人喜欢合成绿茶。',category=MemoryCategory.PREFERENCE,source_ids=(uuid4(),)))
        memory.confirm(scope=scope,candidate_id=old.candidate_id)
        # 显式合成完整依据仅用于进入A故障分支，不签生产语义质量或放宽默认门。
        runner.store.bind_outcome=lambda claim,result:replace(result,accepted=tuple(
            synthetic_complete_evidence(fact,scope=scope) for fact in result.accepted))
        runner.dimension_release=DimensionRelease(tuple(MemoryDimension))
        runner.runtime_builder=lambda:{'extraction':LangChainExtractionRuntime(model=model),
            'verification':LangChainSourceVerificationRuntime(model=model,ledger=observed['ledger']),
            'adjudication':LangChainAdjudicationRuntime(model=model),'ledger':observed['ledger']}
        previous = memory.list_confirmed(scope)
        runner.preview(object())
        self.assertEqual(len(model.seen_model_payloads),3)
        self.assertTrue(observed['saved'])
        self.assertEqual(memory.list_confirmed(scope), previous)
        self.assertEqual(memory.list_pending_candidates(scope), ())
        batch=traces.get_batch(scope,observed['trace_id'])
        self.assertEqual(batch['status'],'succeeded')
        failure, = [event['payload'] for event in batch['events']
                    if event['stage'] == 'adjudication_failure']
        self.assertEqual((failure['status'], failure['reason']), ('rejected', 'invalid_item_contract'))
        comparison, = [event['payload']['comparison'] for event in batch['events']
                       if event['stage'] == 'upgrade_comparison']
        # 显式升级预览保留旧待确认合同，候选失败不会冒称业务写入或整批模型故障。
        self.assertEqual(comparison['stats']['pending'], 1)
        self.assertEqual([action['kind'] for action in comparison['actions']], ['pending'])
        writes = [event['payload'] for event in batch['events']
                  if event['stage'] == 'upgrade_preview_write_result']
        self.assertTrue(writes)
        self.assertEqual({write['commit_status'] for write in writes}, {'planned'})

    def test_approved_comparison_records_only_plans_before_actual_adoption(self):
        from notalone.application.memory_upgrade_trace import planned_upgrade_writes
        from notalone.application.memory_upgrade_preview import preview_upgrade
        from notalone.memory_extraction.adoption import MemoryAdoption
        from notalone.memory_trace import TraceSession
        from notalone.memory_extraction.flow import ExtractionOutcome
        from tests.unit.memory_extraction.dimension_helpers import synthetic_fact
        traces=InMemoryTraceStore();memory=InMemoryMemoryStore();scope=ContactScope(uuid4(),uuid4())
        trace_id=traces.begin(scope,run_id=uuid4(),batch_key='synthetic-approved',payload={'messages':[]})
        outcome=ExtractionOutcome(accepted=(synthetic_fact(source_message_ids=(uuid4(),)),),candidate_trace_ids=(uuid4(),))
        with TraceSession(traces,scope,trace_id):
            with planned_upgrade_writes():
                preview_upgrade(scope,outcome,memory_port=memory)
            self.assertEqual(memory.list_pending_candidates(scope),())
            MemoryAdoption(memory_port=memory).adopt(scope,outcome)
        events=traces.get_batch(scope,trace_id)['events']
        plans=[event for event in events if event['stage']=='upgrade_preview_write_result']
        committed=[event for event in events if event['stage']=='write_result']
        self.assertEqual(len(plans),1);self.assertEqual(len(committed),1)
        self.assertEqual(plans[0]['payload']['commit_status'],'planned')
        self.assertEqual(committed[0]['payload']['commit_status'],'committed')

    def test_apply_transaction_failure_retains_actual_trace_failure_stage(self):
        from notalone.persistence.memory_upgrade import PostgresMemoryUpgradeStore
        from notalone.memory_trace.context import record
        traces=InMemoryTraceStore();scope=ContactScope(uuid4(),uuid4())
        trace_id=traces.begin(scope,run_id=uuid4(),batch_key='synthetic-apply',payload={'messages':[]})
        store=PostgresMemoryUpgradeStore('synthetic-no-connection')
        store._connect=lambda:nullcontext(object())
        store._claimed=lambda *args:{'state':'apply_queued','trace_id':trace_id,'id':uuid4(),'message_ids':[]}
        store.begin_apply_trace=lambda claim:trace_id
        def fault(*args, **kwargs):
            record('write_result',{'commit_status':'committed'})
            raise TraceWriteError('write_result',trace_id)
        runner=MemoryUpgradeTaskRunner(store=store,trace_store=traces,runtime_builder=lambda:{})
        # 模拟事务内失败状态也随回滚消失；仅外层独立追踪可留下最终失败位置。
        transaction_trace=SimpleNamespace(append=traces.append,complete=traces.complete,
            record_call=traces.record_call,mark_failed=lambda *args,**kwargs:None)
        with patch('notalone.persistence.memory_upgrade_traces.transaction_trace_store',return_value=transaction_trace), \
             patch('notalone.persistence.memory_upgrade_apply.apply_batch',side_effect=fault):
            with self.assertRaises(TraceWriteError):
                runner.apply(SimpleNamespace(owner_id=scope.owner_id,contact_id=scope.contact_id))
        batch=traces.get_batch(scope,trace_id)
        self.assertEqual(batch['status'],'trace_failed')
        self.assertEqual(batch['failure_stage'],'write_result')

    def test_dependency_trace_write_failure_uses_the_trace_error_contract(self):
        import psycopg
        from notalone.persistence.memory_upgrade_traces import begin_upgrade_trace
        traces=InMemoryTraceStore();scope=ContactScope(uuid4(),uuid4())
        class FailedDependency:
            def execute(self,*args):
                raise psycopg.OperationalError('合成追踪依赖故障')
        row={'owner_id':scope.owner_id,'contact_id':scope.contact_id,'id':uuid4(),
             'dependency_ids':[uuid4()]}
        with patch('notalone.persistence.memory_upgrade_traces.transaction_trace_store',return_value=traces):
            with self.assertRaises(TraceWriteError) as raised:
                begin_upgrade_trace(FailedDependency(),'synthetic-no-connection',row,
                                    {'messages':[],'upgrade':{'phase':'preview'}})
        self.assertEqual(raised.exception.stage,'upgrade_dependencies')

    def test_actual_model_request_response_and_preview_are_traced_without_committed_facts(self):
        traces = InMemoryTraceStore()
        runner, model, memory, scope, observed = self._runner(traces)
        self.assertEqual(runner.preview(object()), 1)
        self.assertEqual(len(model.seen_model_payloads), 1)
        self.assertTrue(observed['saved'])
        self.assertEqual(len(observed['ledger'].list_by_owner(scope.owner_id)), 1)
        self.assertEqual(memory.list_confirmed(scope), ())
        self.assertEqual(memory.list_pending_candidates(scope), ())
        batch = traces.get_batch(scope, observed['trace_id'])
        stages = [event['stage'] for event in batch['events']]
        self.assertIn('model_request', stages)
        self.assertIn('model_response', stages)
        self.assertIn('upgrade_preview_write_result', stages)
        result = next(event['payload'] for event in batch['events'] if event['stage'] == 'upgrade_preview_write_result')
        self.assertEqual(result['commit_status'], 'planned')
        self.assertEqual(result['execution_mode'], 'preview_only')
        self.assertFalse(any(link['record_kind'] != 'message' and link['commit_status'] == 'committed' for link in batch['links']))

    def test_trace_request_failure_blocks_sdk_and_trace_response_failure_blocks_preview_save(self):
        for stage in ('model_request', 'model_response'):
            with self.subTest(stage=stage):
                class UnavailableTrace(InMemoryTraceStore):
                    def append(self, scope, trace_id, **event):
                        if event['stage'] == stage:
                            raise TraceWriteError(stage, trace_id)
                        return super().append(scope, trace_id, **event)
                traces = UnavailableTrace()
                runner, model, _, scope, observed = self._runner(traces)
                with self.assertRaises(TraceWriteError):
                    runner.preview(object())
                self.assertEqual(len(model.seen_model_payloads), 0 if stage == 'model_request' else 1)
                self.assertFalse(observed['saved'])
                self.assertEqual(len(observed['ledger'].list_by_owner(scope.owner_id)), 0 if stage == 'model_request' else 1)
                self.assertEqual(traces.get_batch(scope, observed['trace_id'])['status'], 'trace_failed')

    def test_zero_candidate_attempt_still_has_complete_trace_and_never_advances_watermark(self):
        traces = InMemoryTraceStore()
        runner, _, _, scope, observed = self._runner(traces, facts=False)
        runner.preview(object())
        batch = traces.get_batch(scope, observed['trace_id'])
        self.assertEqual(batch['status'], 'succeeded')
        end = next(event['payload'] for event in batch['events'] if event['stage'] == 'batch_end')
        self.assertEqual(end['watermark_commit'], 'not_advanced')
        self.assertEqual(end['execution_mode'], 'preview_only')
