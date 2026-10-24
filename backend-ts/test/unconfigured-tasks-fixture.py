"""原合成导入／来源删除，真实在途租约及共享 metadata 资格。"""
from datetime import timedelta
import json
import os
from pathlib import Path
import sys
import threading
from unittest.mock import patch
from uuid import uuid4

import psycopg
from notalone.application.model_permit_client import SharedModelPriorityControl
from notalone.application.source_service import SourceService
from notalone.ingest.jsonl_reader import read_jsonl
from notalone.ingest.normalizer import normalize_document
from notalone.ingest.models import ExistingContactSelection, ImportConfirmationRequest
from notalone.memory_extraction.source_proof import bounded_runtime_rule_set_sha256
from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.persistence.postgres_repository import PostgresIngestRepository
from notalone.tasks.models import BackgroundTaskStepName

def diagnostic_exception(kind,error,traceback):
    if error.__context__ is not None:
        print('synthetic_exception_context',repr(error.__context__),file=sys.stderr)
    sys.__excepthook__(kind,error,traceback)
sys.excepthook=diagnostic_exception

config=json.loads(sys.stdin.read())
database=config['database'];directory=Path(config['directory'])
owner,contact=uuid4(),uuid4()
control=SharedModelPriorityControl(socket_path=config['socket'],token=config['token'])
os.environ['NOTALONE_MODEL_PERMIT_SOCKET']=config['socket']
os.environ['NOTALONE_MODEL_PERMIT_TOKEN']=config['token']
repository=PostgresBackgroundTaskRepository(database,unconfirmed_model_requests=control.unconfirmed_requests)
with psycopg.connect(database) as connection:
    connection.execute("INSERT INTO owner(id,display_name) VALUES(%s,'合成用户')",(owner,))
    connection.execute("INSERT INTO contact(owner_id,id,display_name) VALUES(%s,%s,'合成联系人')",(owner,contact))
    connection.execute("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES(%s,'wechat','wxid_synthetic_owner','合成用户')",(owner,))

def imported(number):
    file=directory/f'synthetic-{number}.jsonl'
    file.write_text(json.dumps({'id':{'local_id':number,'server_id_str':f'synthetic-{number}','talker':'wxid_synthetic_contact'},
        'create_time':1786500000,'is_from_me':False,'kind':'text','sender':'合成联系人','sender_wxid':'wxid_synthetic_contact',
        'text':f'纯合成独立来源{number}','time':'2026-08-12 10:00:00','time_iso':'2026-08-12T10:00:00+08:00'},ensure_ascii=False)+'\n'+json.dumps({
        'id':{'local_id':number*10,'server_id_str':f'synthetic-owner-{number}','talker':'wxid_synthetic_contact'},
        'create_time':1786500001,'is_from_me':True,'kind':'text','sender':'合成用户','sender_wxid':'wxid_synthetic_owner',
        'text':f'纯合成用户来源{number}','time':'2026-08-12 10:00:01','time_iso':'2026-08-12T10:00:01+08:00'},ensure_ascii=False)+'\n')
    return PostgresIngestRepository(database).import_document(owner_id=owner,document=normalize_document(read_jsonl(file)),
        confirmation=ImportConfirmationRequest(selection=ExistingContactSelection(contact_id=contact)))

target=imported(201);unrelated=imported(202)
# 通过原领取／完成接口重建以前合法保存的在途提取，不手写状态／claim／额度SQL。
for name in (BackgroundTaskStepName.PARSE,BackgroundTaskStepName.NORMALIZE):
    try:
        claim=repository.claim_next_step(owner_id=owner,contact_id=contact,task_id=unrelated.task_id,worker_id=uuid4(),
                                        lease_duration=timedelta(seconds=30),supported_steps=(name,))
    except Exception as error:
        print('synthetic_seed_context',repr(error.__context__),file=sys.stderr)
        raise
    assert claim is not None
    repository.complete_step(claim,processed_count=claim.message_count,total_count=claim.message_count)
claim=repository.claim_next_step(owner_id=owner,contact_id=contact,task_id=unrelated.task_id,worker_id=uuid4(),
    lease_duration=timedelta(milliseconds=1),supported_steps=(BackgroundTaskStepName.EXTRACT_MEMORY,),
    model_version='synthetic-model',rule_version='memory-extraction-v1',runtime_rule_set_sha256=bounded_runtime_rule_set_sha256())
assert claim is not None
before=repository.get_task(owner_id=owner,contact_id=contact,task_id=unrelated.task_id)
with psycopg.connect(database) as connection:
    assert connection.execute('SELECT lease_expires_at<=clock_timestamp() FROM background_task_step WHERE id=%s',(claim.step_id,)).fetchone()[0]
if config.get('phase') in ('controls','automatic','learning','organization'):
    from notalone.server.command import _build_task_host,_build_import_service
    from notalone.server.app import create_app
    from notalone.server.event_bus import EventBus
    from notalone.server.testing import InProcessClient
    host_options=dict(model_work_available=False)
    app_options=dict(model_work_available=False,unconfirmed_model_requests=control.unconfirmed_requests)
    host=_build_task_host(database,EventBus(),model_priority=control,**host_options)
    app=create_app(database_url=database,owner_id=owner,token='synthetic-app-token',task_host=host,import_service=_build_import_service(database),**app_options)
    try:
        with patch('httpx.Client.send',side_effect=AssertionError('无模型操作不得HTTP')) as sent,patch(
            'notalone.memory_extraction.recall.embed_texts',side_effect=AssertionError('无模型操作不得加载BGE')) as embedded:
            client=InProcessClient(app);headers={'Authorization':'Bearer synthetic-app-token'}
            if config['phase']=='automatic':
                from datetime import datetime,timezone
                from notalone.ingest.models import NormalizedMessage,WechatMessageMetadata
                from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
                from notalone.persistence.observation_store import PostgresObservationStore,ObservationMode
                locator='synthetic-observation-'+str(contact)
                binding=PostgresConversationBindingRepository(database).create_binding(owner_id=owner,contact_id=contact,
                    channel='wechat',account_scope='synthetic-account',conversation_locator=locator)
                batch=PostgresObservationStore(database).record_batch_with_messages(owner_id=owner,contact_id=contact,
                    binding_id=binding.binding_id,mode=ObservationMode.LIVE,cli_version='synthetic-test',conversation_locator=locator,
                    last_local_id=5,last_cursor='synthetic-5',record_count=5,messages=tuple(NormalizedMessage(
                        source_locator=f'cli:{i}',speaker='contact',message_type='text',text_content=f'纯合成新观察{i}',media_placeholder=None,
                        occurred_at=datetime(2026,10,1,tzinfo=timezone.utc),wechat_metadata=WechatMessageMetadata(external_local_id=i,
                            external_server_id=f'synthetic-observation-{i}',external_talker=locator,source_create_time=1790812800,
                            raw_payload_json='{"text":"纯合成新观察"}')) for i in range(1,6)))
                with psycopg.connect(database) as connection:
                    schedule=connection.execute('SELECT to_jsonb(s) FROM memory_extraction_schedule s').fetchall()
                host.start_scheduling(owner_id=owner)
                for message_id in batch.message_ids:
                    assert host.wake_observation(owner_id=owner,contact_id=contact,message_id=message_id)['status']=='deferred'
                with psycopg.connect(database) as connection:
                    assert connection.execute('SELECT to_jsonb(s) FROM memory_extraction_schedule s').fetchall()==schedule
                    assert connection.execute("SELECT count(*) FROM background_task WHERE task_type='observation'").fetchone()[0]==0
                    assert connection.execute('SELECT count(*) FROM memory_extraction_receipt WHERE task_id IS NOT NULL').fetchone()[0]==0
                print(json.dumps({'no_observation_task':True,'schedule_unchanged':True,'model_http':sent.call_count,'bge_calls':embedded.call_count},sort_keys=True))
                raise SystemExit(0)
            if config['phase']=='organization':
                import httpx
                from langchain_deepseek import ChatDeepSeek
                from notalone.application.memory_service import MemoryService,ManualMemoryEntry
                from notalone.application.layered_memory_service import LayeredMemoryService
                from notalone.application.model_priority import ModelWorkStopped
                from notalone.persistence.memory_store import PostgresMemoryStore
                from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
                from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
                from notalone.persistence.organization_quality import PostgresOrganizationQualityStore
                from notalone.memory.models import MemoryCategory
                from notalone.memory.layered import OrganizationBudget
                from notalone.memory.organization_quality import OrganizationQualityService,OrganizationQualityContract
                from notalone.memory.organization_quality_transport import OrganizationQualityHTTPTransport
                from notalone.memory.organization_sdk import DeepSeekOrganizationProposal,DeepSeekOrganizationVerification
                from notalone.scopes import ContactScope
                scope=ContactScope(owner,contact)
                manual=MemoryService(contact_memory=PostgresMemoryStore(database),owner_memory=PostgresOwnerMemoryStore(database))
                manual.add_manual_contact_memory(owner_id=owner,contact_id=contact,entry=ManualMemoryEntry('纯合成手录：先核实安排。',MemoryCategory.COMMON_FACT))
                budget=OrganizationBudget(max_model_calls=6,max_characters=24000)
                transport=OrganizationQualityHTTPTransport()
                with httpx.Client(transport=transport,trust_env=False) as http:
                    sdk=ChatDeepSeek(model='synthetic-model',api_key='synthetic-not-a-credential',base_url='http://127.0.0.1:9/v1',max_retries=0,timeout=3,http_client=http)
                    store=PostgresLayeredMemoryStore(database)
                    quality=OrganizationQualityService(PostgresOrganizationQualityStore(store),organization_contract=OrganizationQualityContract(
                        provider='deepseek',request_model='synthetic-model',verifier_provider='deepseek',verifier_model='synthetic-model',budget=budget))
                    service=LayeredMemoryService(store,proposer=DeepSeekOrganizationProposal(sdk,layer='l2',budget=budget,transport=transport),
                        verifier=DeepSeekOrganizationVerification(sdk,layer='l2',budget=budget,transport=transport),
                        profile_proposer=DeepSeekOrganizationProposal(sdk,layer='l3',budget=budget,transport=transport),
                        profile_verifier=DeepSeekOrganizationVerification(sdk,layer='l3',budget=budget,transport=transport),
                        quality=quality,budget=budget,model_priority=control,task_host=host,runtime_policy='verified_items')
                    service.organize(scope)
                    with psycopg.connect(database) as connection:
                        assert connection.execute('SELECT count(*) FROM layered_memory_job').fetchone()[0]==0
                    state,_,_,_=store.read(scope)
                    try:
                        service.command(scope,'refresh',state['settings_generation'])
                    except ModelWorkStopped:
                        pass
                    else:
                        raise AssertionError('refresh应在任何重排前明确拒绝')
                    after,_,_,_=store.read(scope)
                    assert after['settings_generation']==state['settings_generation']
                    # 原enqueue重建以前合法保存的job，仅检验用户暂停，不启动其Worker。
                    old,execute=store.enqueue(scope,budget,service._contract_for(scope),profile_required=True)
                    _,_,_,job=store.read(scope)
                    service.command(scope,'pause',state['settings_generation'],expected_work_revision=job['revision'])
                    assert store.read(scope)[3]['state']=='paused'
                    service.command(scope,'disable',state['settings_generation'])
                    assert store.read(scope)[0]['enabled'] is False
                print(json.dumps({'manual_preserved':True,'no_automatic_organization':True,'refresh_rejected_before_write':True,
                    'pause_allowed':True,'disable_allowed':True,'model_http':sent.call_count,'bge_calls':embedded.call_count},sort_keys=True))
                raise SystemExit(0)
            if config['phase']=='learning':
                from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
                from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore
                from notalone.persistence.assistant_session_inputs import PostgresAssistantSessionInputs
                from notalone.scopes import ContactScope
                scope=ContactScope(owner,contact)
                PostgresConversationBindingRepository(database).create_binding(owner_id=owner,contact_id=contact,channel='wechat',
                    account_scope='synthetic-account',conversation_locator='synthetic-learning-'+str(contact))
                session=PostgresAssistantSessionStore(database).default(scope)
                PostgresAssistantSessionInputs(database).record_discussion_input(scope,session,
                    {'type':'purpose_exploration','purpose_hint':'纯合成表达讨论','correction':'纯合成纠正：先澄清含义'})
                learning=app._skill_learning
                learning.configure(scope,enabled=True,operation_key=uuid4(),expected_revision=0)
                learning.list(scope)
                with psycopg.connect(database) as connection:
                    assert connection.execute("SELECT count(*) FROM background_task WHERE task_type='skill_learning'").fetchone()[0]==0,'读取或保存学习设置不应提前排队'
                response=client.request('POST',f'/api/contacts/{contact}/skill-learning',headers=headers,body=b'{"resume":true}')
                assert response.status_code==503,response.json()
                learning.configure(scope,enabled=False,operation_key=uuid4(),expected_revision=1)
                with psycopg.connect(database) as connection:
                    assert connection.execute('SELECT enabled,revision FROM skill_learning_scope').fetchall()==[(False,2)]
                    assert connection.execute("SELECT count(*) FROM background_task WHERE task_type='skill_learning'").fetchone()[0]==0
                print(json.dumps({'learning_settings_preserved':True,'no_learning_task':True,'resume_status':response.status_code,
                                  'model_http':sent.call_count,'bge_calls':embedded.call_count},sort_keys=True))
                raise SystemExit(0)
            commands=[(f'/api/contacts/{contact}/memory-processing/resume',{'task_id':str(unrelated.task_id),'action':'resume'}),
                      ('/api/tasks/retry',{'contact_id':str(contact),'task_id':str(unrelated.task_id)}),
                      ('/api/tasks/run',{'contact_id':str(contact),'task_id':str(unrelated.task_id),'extraction_runtime_mode':'bounded-runtime-v1'})]
            statuses=[]
            for path,payload in commands:
                response=client.request('POST',path,headers=headers,body=json.dumps(payload).encode())
                statuses.append(response.status_code)
                assert response.status_code==503,(path,response.status_code,response.json())
                assert repository.get_task(owner_id=owner,contact_id=contact,task_id=unrelated.task_id)==before
            pending=imported(203)
            assert repository.get_task(owner_id=owner,contact_id=contact,task_id=pending.task_id).status.value=='queued'
            response=client.request('POST','/api/imports/commit',headers=headers,body=json.dumps({'path':str(directory/'synthetic-203.jsonl'),'contact_id':str(contact)}).encode())
            assert response.status_code==200,response.json()
            assert response.json().get('processing_deferred') is True,response.json()
            assert response.json().get('deferred_reason')=='model_configuration_unavailable',response.json()
            print(json.dumps({'statuses':statuses,'model_task_unchanged':True,'import_still_queued':True,
                              'model_http':sent.call_count,'bge_calls':embedded.call_count},sort_keys=True))
    finally:
        app.shutdown_runtime()
    raise SystemExit(0)
from notalone.server.command import _build_task_host
from notalone.server.app import create_app
from notalone.server.event_bus import EventBus
from notalone.server.testing import InProcessClient
host_options=dict(model_work_available=False)
app_options=dict(model_work_available=False,unconfirmed_model_requests=control.unconfirmed_requests)
if config['phase']=='source-default':
    host_options={}
    app_options={'unconfirmed_model_requests':control.unconfirmed_requests}
host=_build_task_host(database,EventBus(),model_priority=control,**host_options)
app=create_app(database_url=database,owner_id=owner,token='synthetic-app-token',task_host=host,**app_options)
service=app._source_service
try:
    with patch('httpx.Client.send',side_effect=AssertionError('无模型操作不得HTTP')) as sent,patch(
        'notalone.memory_extraction.recall.embed_texts',side_effect=AssertionError('删除不得加载BGE')) as embedded:
        client=InProcessClient(app);headers={'Authorization':'Bearer synthetic-app-token'}
        path=f'/api/contacts/{contact}/sources'
        if config['phase']=='taskhost-delete':
            from notalone.persistence.source_tasks import PostgresSourceTasks
            deletion=PostgresSourceTasks(database).request_delete(owner,contact,target.source_document_id)
            host.wake(owner_id=owner,contact_id=contact,task_id=deletion)
            with host._lock:
                threads=tuple(host._threads.values())
            for thread in threads:
                thread.join(timeout=5)
                assert not thread.is_alive()
            result={'task_id':str(deletion)}
        else:
            response=client.request('DELETE',path+'/'+str(target.source_document_id),headers=headers)
            assert response.status_code==202,response.json()
            result=response.json()
        # 只用线程对象有界收尾；业务结果从实际公开HTTP重读。
        for thread in tuple(threading.enumerate()):
            if getattr(getattr(thread,'_target',None),'__self__',None) is service:
                thread.join(timeout=5)
                assert not thread.is_alive()
        source=next(item for item in client.get(path,headers=headers).json()['sources'] if item['source_id']==str(target.source_document_id))
        assert source['status']=='deleted',source
        deleted=repository.get_task(owner_id=owner,contact_id=contact,task_id=__import__('uuid').UUID(result['task_id']))
        after=repository.get_task(owner_id=owner,contact_id=contact,task_id=unrelated.task_id)
        assert (after==before)==(config['phase']!='source-default'),'能力范围必须限制或保留原租约恢复语义'
        assert sent.call_count==embedded.call_count==0
        print(json.dumps({'source_status':source['status'],'completed_steps':sum(s.status.value=='succeeded' for s in deleted.steps),
            'unrelated_model_unchanged':after==before,'model_http':sent.call_count,'bge_calls':embedded.call_count},sort_keys=True))
finally:
    app.shutdown_runtime()
