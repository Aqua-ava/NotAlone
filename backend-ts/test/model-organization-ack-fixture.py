"""纯合成手录→原整理服务/Worker；所有模型HTTP仅到本机loopback。"""
from __future__ import annotations
import json
import os
import sys
from uuid import UUID, uuid4
import psycopg
import httpx
from langchain_deepseek import ChatDeepSeek
from notalone.application.memory_service import MemoryService, ManualMemoryEntry
from notalone.application.model_permit_client import SharedModelPriorityControl
from notalone.application.layered_memory_service import LayeredMemoryService
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
from notalone.persistence.organization_quality import PostgresOrganizationQualityStore
from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.memory.models import MemoryCategory
from notalone.memory.layered import OrganizationBudget
from notalone.memory.organization_quality import OrganizationQualityService, OrganizationQualityContract
from notalone.memory.organization_quality_transport import OrganizationQualityHTTPTransport
from notalone.memory.organization_sdk import DeepSeekOrganizationProposal, DeepSeekOrganizationVerification
from notalone.tasks.worker import BackgroundTaskWorker
from notalone.scopes import OwnerScope, ContactScope

config=json.loads(sys.stdin.readline())
owner=UUID(config['owner_id'])
contact=UUID(config['contact_id']) if config['scope_kind']=='contact' else None
scope=ContactScope(owner,contact) if contact is not None else OwnerScope(owner)
database=config['database_url']
if config.get('mode')=='legacy':
    from notalone.application.model_priority import ModelPriorityControl
    control=ModelPriorityControl()
else:
    os.environ['NOTALONE_MODEL_PERMIT_SOCKET']=config['socket_path']
    control=SharedModelPriorityControl(socket_path=config['socket_path'],token=config['token'])
def unconfirmed_requests():
    return [str(v) for v in control.unconfirmed_requests(owner,contact)] if isinstance(control,SharedModelPriorityControl) else []
phase=config.get('phase','initial')
diagnostic_errors=[]
manual=MemoryService(contact_memory=PostgresMemoryStore(database),owner_memory=PostgresOwnerMemoryStore(database))

def add_memory(label):
    entry=ManualMemoryEntry('纯合成'+label+'资料：偏好先核实安排再讨论。',MemoryCategory.COMMON_FACT)
    if contact is None:
        return manual.add_manual_owner_memory(owner_id=owner,entry=entry,contact_id=None)
    return manual.add_manual_contact_memory(owner_id=owner,contact_id=contact,entry=entry)

budget=OrganizationBudget(max_model_calls=6,max_characters=24000)
transport=OrganizationQualityHTTPTransport()
http=httpx.Client(transport=transport)
sdk=ChatDeepSeek(model='synthetic-model',api_key='synthetic-not-a-credential',base_url=config['base_url'],max_retries=0,timeout=3,http_client=http)
assert sdk.max_retries==0
store=PostgresLayeredMemoryStore(database)
quality=OrganizationQualityService(PostgresOrganizationQualityStore(store),organization_contract=OrganizationQualityContract(
    provider='deepseek',request_model='synthetic-model',verifier_provider='deepseek',verifier_model='synthetic-model',budget=budget))
# 原服务要求实际四阶段Adapter；空L2提案不产生L3输入，不伪建job/work。
service=LayeredMemoryService(store,proposer=DeepSeekOrganizationProposal(sdk,layer='l2',budget=budget,transport=transport),
    verifier=DeepSeekOrganizationVerification(sdk,layer='l2',budget=budget,transport=transport),
    profile_proposer=DeepSeekOrganizationProposal(sdk,layer='l3',budget=budget,transport=transport),
    profile_verifier=DeepSeekOrganizationVerification(sdk,layer='l3',budget=budget,transport=transport),
    quality=quality,budget=budget,model_priority=control,runtime_policy='verified_items')
# 仅对照seam：丢ACK后真实重发同一结果元数据，不重发SDK/HTTP。
if config.get('mode')=='reconfirm':
    from notalone.application.model_transport_accounting import PhysicalModelCall, PhysicalModelAccountingAbort
    original_record=PhysicalModelCall._record
    attempted_reconfirmation=set()
    def record_with_explicit_result_reconfirmation(self,fields):
        try:
            return original_record(self,fields)
        except PhysicalModelAccountingAbort:
            key=str(self.association.attempt_id)
            if fields.get('outcome') not in ('succeeded','failed') or key in attempted_reconfirmation:
                raise
            attempted_reconfirmation.add(key)
            original_record(self,{'dispatch':fields['dispatch'],'outcome':'unknown'})
            return original_record(self,fields)
    PhysicalModelCall._record=record_with_explicit_result_reconfirmation
repository=PostgresBackgroundTaskRepository(database,unconfirmed_model_requests=control.unconfirmed_requests if isinstance(control,SharedModelPriorityControl) else None)
worker=BackgroundTaskWorker(repository=repository,organization_runner=service,model_priority=control)
try:
    if phase=='initial':
        add_memory('初次手录')
        store.command(scope,'enable',0,quality_available=True)
    elif phase=='new_input':
        add_memory('真实新增手录')
    elif phase=='new_settings':
        with psycopg.connect(database) as connection:
            generation=connection.execute('SELECT settings_generation FROM layered_memory_state WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s',(owner,contact)).fetchone()[0]
        store.command(scope,'disable',generation,quality_available=True)
        store.command(scope,'enable',generation+1,quality_available=True)
    if phase in ('initial','new_input','new_settings','same_inputs'):
        task,execute=store.enqueue(scope,budget,service._contract_for(scope),profile_required=True)
        if not execute:
            print(json.dumps({'task_id':str(task),'execute':False,'worker_outcome':'not_enqueued',
                'unconfirmed_requests':unconfirmed_requests(),'diagnostic_errors':diagnostic_errors}))
            sys.exit(0)
    else:
        task,execute=UUID(config['task_id']),True
    result=worker.run_once(owner_id=owner,contact_id=contact,task_id=task,worker_id=uuid4())
    print(json.dumps({'task_id':str(task),'execute':execute,'worker_outcome':result.outcome.value,
        'unconfirmed_requests':unconfirmed_requests(),'diagnostic_errors':diagnostic_errors}))
finally:
    http.close()
