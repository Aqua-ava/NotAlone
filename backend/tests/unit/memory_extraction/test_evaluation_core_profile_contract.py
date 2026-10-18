"""核心六窗／四窗封闭合同；合成请求不认证模型质量。"""
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.memory_extraction.evaluation import build_window
from notalone.memory_extraction.cases.types import EvaluationCase, ExpectedDestination
from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget, EvaluationBudgetAbort
from notalone.memory_extraction.evaluation_offline import _frozen_config, _run_evaluation_batch
from notalone.memory_extraction.evaluation_records import EvaluationRecordStore, canonical_sha256
from tests.unit.memory_extraction import test_evaluation_provider_contract as provider_tests

PLAN = 'core-current-source-v1'
E_PROFILE = 'core-current-state-v1'
V_PROFILE = 'core-source-fidelity-v1'
ENDPOINT = 'https://api.deepseek.com/chat/completions'


def fixture(count=6):
    cases = tuple(EvaluationCase(name=f'core-{i}', dimension='synthetic',
        messages=(('self', '我到家了。'),), targets=(0,), expect=ExpectedDestination.PENDING) for i in range(count))
    windows = tuple(build_window(case) for case in cases)
    plan = tuple({'case_position': i, 'case_name': case.name, 'input_sha256': canonical_sha256(window)}
                 for i, (case, window) in enumerate(zip(cases, windows)))
    config = _frozen_config(plan, windows=windows, extraction_mode='grounded-v2', verification_mode='legacy-v4',
        extraction_prompt_profile=E_PROFILE, prompt_profile=V_PROFILE, max_retries=0, request_timeout_seconds=300.0)
    config.update(mode='deepseek_core_current_source', stage='fixed6' if count == 6 else 'heldout4',
        execution_plan=PLAN, reference_version=PLAN, base_url='https://api.deepseek.com', endpoint=ENDPOINT,
        request_model='deepseek-flash', request_contract_version=2, selected_case_positions=list(range(count)),
        response_identity_policy='first_valid_completion_observation_stop_on_change', fallback=False,
        deadline_utc="2027-01-01T00:00:00+00:00", reasoning_effort='max', gold_sha256='a'*64, source_hashes={'synthetic.py':'b'*64},
        tool_choice={'extraction':{'mode':'omitted','name':'GroundedMemoryLabels'},
                     'verification':{'mode':'omitted','name':'SourceVerificationOutput'}})
    return cases, windows, plan, config


class CoreProviderContractTest(unittest.TestCase):
    setUp = provider_tests.EvaluationProviderContractTest.setUp
    _contract = provider_tests.EvaluationProviderContractTest._contract

    def test_core_identity_is_closed_before_requests(self):
        options = dict(provider_profile='deepseek-flash-max', execution_plan=PLAN,
            extraction_mode='grounded-v2', extraction_prompt_profile=E_PROFILE, verification_tool_choice='omitted')
        self._contract(**options)
        for change in ({'execution_plan':'original'}, {'extraction_prompt_profile':'default'},
                {'extraction_prompt_profile':'unknown'}, {'provider_profile':'ecnu'},
                {'provider_profile':'deepseek-phase-split-v1'}, {'extraction_mode':'grounded-v4'},
                {'verification_tool_choice':'forced'}):
            with self.subTest(change=change), self.assertRaises(EvaluationBudgetAbort):
                self._contract(**{**options, **change})

    def test_declared_expected_request_cannot_redefine_core_prompts(self):
        import httpx
        from langchain_core.utils.function_calling import convert_to_openai_tool
        from notalone.memory_extraction.evaluation_extraction import extraction_contract
        from notalone.memory_extraction.verification_adapters import source_verification_contract
        _, windows, _, _ = fixture()
        contract = self._contract(provider_profile='deepseek-flash-max', execution_plan=PLAN,
            extraction_mode='grounded-v2', extraction_prompt_profile=E_PROFILE, verification_tool_choice='omitted')
        for factory, profile in ((lambda value: extraction_contract('grounded-v2',windows[0],prompt_profile=value),E_PROFILE),
                (lambda value: source_verification_contract('legacy-v4',prompt_profile=value),V_PROFILE)):
            prompt,schema=factory(profile)
            body=provider_tests._payload()
            body.pop('tool_choice')
            body.update(model='deepseek-flash',reasoning_effort='max',tools=[convert_to_openai_tool(schema)])
            body['messages'][0]['content']=prompt
            with contract.expect_request(body):
                contract.check_request(httpx.Request('POST',ENDPOINT,json=body))
                changed=deepcopy(body);changed['messages'][0]['content']+='合成漂移'
                with self.assertRaises(EvaluationBudgetAbort):
                    contract.check_request(httpx.Request('POST',ENDPOINT,json=changed))
            for changed_prompt in (factory('default')[0],prompt+'合成漂移'):
                changed=deepcopy(body);changed['messages'][0]['content']=changed_prompt
                with self.assertRaises(EvaluationBudgetAbort), contract.expect_request(changed):
                    self.fail('不可由调用方重新声明旧提示')


class CoreRecordsContractTest(unittest.TestCase):
    def test_actual_windows_and_recomputed_frozen_contract_reject_drift(self):
        for count in (6, 4):
            _, windows, plan, original = fixture(count)
            changes = ({}, {'stage':'other'}, {'stage':'heldout4' if count==6 else 'fixed6'},
                {'execution_plan':'original'}, {'reference_version':'legacy-v1'}, {'mode':'other'},
                {'extraction_prompt_profile':'default'}, {'verification_prompt_profile':'default'},
                {'extraction_mode':'grounded-v4'}, {'verification_mode':'nullable-proof-v1'},
                {'verification_prompt_sha256':'0'*64}, {'verification_schema_sha256':'0'*64},
                {'extraction_prompt_sha256':'0'*64}, {'extraction_schema_sha256':'0'*64},
                {'extraction_window_contracts':[{**row,'prompt_sha256':'0'*64} for row in original['extraction_window_contracts']]},
                {'gold_sha256':''}, {'source_hashes':{}}, {'stream':True}, {'thinking':{'type':'disabled'}},
                {'reasoning_effort':'none'}, {'temperature':True}, {'timeout':300}, {'max_retries':False},
                {'fallback':True}, {'selected_case_positions':list(range(count-1))}, {'request_model':'other'})
            for changed in changes:
                self._registration({**deepcopy(original), **changed}, plan, windows, count*2, reject=bool(changed))
            for actual, cap in ((None,count*2),(windows[:-1],count*2),(windows,count*2+1),
                    ((replace(windows[0],messages=(replace(windows[0].messages[0],text="合成漂移"),)),*windows[1:]),count*2)):
                self._registration(original, plan, actual, cap, reject=True)

    def _registration(self, config, plan, windows, cap, *, reject):
        with self.subTest(stage=config['stage'], cap=cap, reject=reject), tempfile.TemporaryDirectory() as temporary:
            home=Path(temporary).resolve(); output=home/'output'; output.mkdir(mode=0o700)
            with patch.object(Path,'home',return_value=home), patch.dict(os.environ,{'NOTALONE_DISABLE_DOTENV':'1'}):
                budget=EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=cap,
                    allowed_endpoints=(ENDPOINT,),config_sha256=canonical_sha256(config))
                try:
                    if reject:
                        with self.assertRaises(EvaluationBudgetAbort):
                            EvaluationRecordStore(budget=budget,frozen_config=config,plan=plan,actual_windows=windows)
                    else:
                        store=EvaluationRecordStore(budget=budget,frozen_config=config,plan=plan,actual_windows=windows)
                        self.assertEqual(store.execution_plan,PLAN)
                        self.assertEqual(store.gold_sha256,config['gold_sha256'])
                finally: budget.close()


class CoreBatchContractTest(unittest.TestCase):
    def test_six_and_four_actual_sdk_requests_bind_profiles_records_and_gold(self):
        import httpx
        import json
        import socket
        from notalone.memory_extraction.evaluation_extraction import extraction_contract
        from notalone.memory_extraction.verification_adapters import source_verification_contract
        for count in (6,4):
            cases, windows, plan, config = fixture(count)
            requests=[]
            def response(request):
                body=json.loads(request.content); requests.append(body)
                tool=body['tools'][0]['function']
                if tool['name']=='SourceVerificationOutput':
                    data=json.loads(body['messages'][1]['content'])
                    args={'results':[{'candidate_index':0,'verdict':'supported','issues':[],
                        'evidence':[{'message_id':data['candidates'][0]['source_message_ids'][0],'quote':'我到家了。'}]}]}
                else:
                    args={'units':{key:{'kind':'event','subject':'self','topic':'other','dependency':None,
                        'unresolved':False,'sensitivity':'none','confidence':0.9}
                        for key in tool['parameters']['properties']['units']['properties']}}
                return httpx.Response(200,request=request,json={'id':'synthetic-core','object':'chat.completion',
                    'created':1,'model':'deepseek-flash','choices':[{'index':0,'finish_reason':'tool_calls',
                    'message':{'role':'assistant','content':None,'tool_calls':[{'id':'synthetic-tool','type':'function',
                    'function':{'name':tool['name'],'arguments':json.dumps(args)}}]}}]})
            with self.subTest(count=count), tempfile.TemporaryDirectory() as temporary:
                home=Path(temporary).resolve(); output=home/'output';output.mkdir(mode=0o700)
                with patch.object(Path,'home',return_value=home), patch.dict(os.environ,{'NOTALONE_DISABLE_DOTENV':'1'}), \
                        patch.object(socket,'getaddrinfo',side_effect=AssertionError('不得访问真实网络')):
                    budget=EvaluationBudget.create(run_id=uuid4(),output_directory=output,request_limit=count*2,
                        allowed_endpoints=(ENDPOINT,),config_sha256=canonical_sha256(config))
                    try:
                        store=EvaluationRecordStore(budget=budget,frozen_config=config,plan=plan,actual_windows=windows)
                        bundles=[]
                        def audit(bundle):
                            bundles.append(bundle)
                            return {'decision':'safe','reason':'synthetic','basis':'只验证接线'}
                        options=dict(cases=cases,windows=windows,plan=plan,budget=budget,store=store,
                            base_url='https://api.deepseek.com',request_model='deepseek-flash',api_key='synthetic',
                            synthetic_transport=httpx.MockTransport(response),provider='DeepSeek',semantic_audit=audit,
                            gold_reference={'gold_sha256':config['gold_sha256']},request_timeout_seconds=300.0,
                            max_retries=0,verification_mode='legacy-v4',verification_tool_choice='omitted',
                            extraction_tool_choice='omitted',reasoning_effort='max',extraction_mode='grounded-v2',
                            execution_plan=PLAN,extraction_prompt_profile=E_PROFILE)
                        # 错配必须在读凭据或HTTP前失败，且不能耗预算。
                        for change in ({'execution_plan':'original'}, {'extraction_prompt_profile':'default'},
                                {'verification_mode':'nullable-proof-v1'}, {'verification_tool_choice':'forced'},
                                {'extraction_tool_choice':'forced'}, {'max_retries':1}, {'request_timeout_seconds':60.0},
                                {'reasoning_effort':None}, {'request_model':'other'}, {'semantic_audit':None},
                                {'gold_reference':{'gold_sha256':'0'*64}}, {'windows':windows[::-1]},
                                {'cases':cases[::-1]}, {'plan':plan[::-1]}):
                            with self.subTest(change=tuple(change)), self.assertRaises(EvaluationBudgetAbort):
                                _run_evaluation_batch(**{**options, **change,
                                    'credential_loader':lambda:self.fail('不得读凭据')})
                            self.assertEqual(budget.snapshot()['reserved_requests'],0)
                        result=_run_evaluation_batch(**options)
                        self.assertIsNone(result['stopped_code'])
                        self.assertIsNone(result['records_error_code'])
                        self.assertIsNone(result['receipt_error_code'])
                        self.assertEqual(len(requests),count*2)
                        self.assertEqual(len(bundles),count)
                        for i,body in enumerate(requests):
                            self.assertNotIn('tool_choice',body)
                            self.assertEqual(body['thinking'],{'type':'enabled'})
                            self.assertEqual(body['reasoning_effort'],'max')
                            prompt=(extraction_contract('grounded-v2',windows[i//2],prompt_profile=E_PROFILE)[0]
                                if i%2==0 else source_verification_contract('legacy-v4',prompt_profile=V_PROFILE)[0])
                            self.assertEqual(body['messages'][0]['content'],prompt)
                        for bundle in bundles:
                            self.assertEqual(bundle['execution_plan'],PLAN)
                            self.assertEqual(bundle['reference_version'],PLAN)
                            self.assertEqual(bundle['extraction_prompt_profile'],E_PROFILE)
                            self.assertEqual(bundle['verification_prompt_profile'],V_PROFILE)
                            self.assertEqual(bundle['gold_reference'],{'gold_sha256':config['gold_sha256']})
                        self.assertEqual(sum(e['kind']=='provider_request' for e in store.events()),count*2)
                    finally: budget.close()
                    self.assertEqual(budget.closed_receipt()['reserved_requests'],count*2)

    def test_real_contract_must_match_registration_before_credential(self):
        from datetime import datetime, timedelta, timezone
        import hashlib
        from notalone.memory_extraction.evaluation_provider_contract import ECNUEvaluationContract
        cases,windows,plan,config=fixture()
        with tempfile.TemporaryDirectory() as temporary:
            home=Path(temporary).resolve();output=home/'output';output.mkdir(mode=0o700)
            for name in ('source.py','other.py'):(home/name).write_text('# 合成冻结\n')
            digest=hashlib.sha256((home/'source.py').read_bytes()).hexdigest()
            deadline=datetime.now(timezone.utc)+timedelta(hours=1)
            config.update(source_hashes={'source.py':digest},deadline_utc=deadline.isoformat())
            with patch.object(Path,'home',return_value=home),patch.dict(os.environ,{'NOTALONE_DISABLE_DOTENV':'1'}):
                budget=EvaluationBudget.create(run_id=uuid4(),output_directory=output,request_limit=12,
                    allowed_endpoints=(ENDPOINT,),config_sha256=canonical_sha256(config))
                try:
                    store=EvaluationRecordStore(budget=budget,frozen_config=config,plan=plan,actual_windows=windows)
                    options=dict(deadline=deadline,repo_root=home,source_hashes=config['source_hashes'],
                        provider_profile='deepseek-flash-max',execution_plan=PLAN,extraction_mode='grounded-v2',
                        extraction_prompt_profile=E_PROFILE,verification_tool_choice='omitted')
                    for change in ({'execution_plan':'original','extraction_prompt_profile':'default'},
                            {'source_hashes':{'other.py':digest}}, {'deadline':deadline+timedelta(minutes=1)}):
                        contract=ECNUEvaluationContract(**{**options,**change})
                        with self.subTest(change=tuple(change)),self.assertRaises(EvaluationBudgetAbort):
                            _run_evaluation_batch(cases=cases,windows=windows,plan=plan,budget=budget,store=store,
                                base_url='https://api.deepseek.com',request_model='deepseek-flash',api_key='',
                                synthetic_transport=None,provider='DeepSeek',contract=contract,invocation_scope=lambda *args:None,
                                credential_loader=lambda:self.fail('错合同不得读凭据'),semantic_audit=lambda _:None,
                                gold_reference={'gold_sha256':config['gold_sha256']},request_timeout_seconds=300.0,max_retries=0,
                                verification_mode='legacy-v4',verification_tool_choice='omitted',extraction_tool_choice='omitted',
                                reasoning_effort='max',extraction_mode='grounded-v2',execution_plan=PLAN,extraction_prompt_profile=E_PROFILE)
                        self.assertEqual(budget.snapshot()['reserved_requests'],0)
                finally:budget.close()
