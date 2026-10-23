"""公开准备路径触发同宿主TS概览；仅合成资料，准备阶段不得调用模型。"""
import json
import os
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from urllib.request import urlopen
import psycopg
from psycopg.rows import dict_row
from uuid import UUID
from notalone.persistence.memory_overview import PostgresRelationshipOverviewStore
from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.scopes import ContactScope
from unittest.mock import patch

from notalone.application.model_priority import ModelPriorityControl
from notalone.server.app import create_app
from notalone.server.reply_wiring import build_reply_service
from notalone.server.contact_context_handoff import ContactContextHandoff
from tests.input_budget_support import synthetic_budget_kwargs
from tests.integration.server.core_business_flow_support import HttpBackend
from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture

url,address,internal_token=sys.argv[1:]
name=url.split('dbname=')[1]
assert name.startswith('notalone_ts_host_') and name.endswith('_test')
for key in ('NOTALONE_TEST_DATABASE_URL','NOTALONE_DATABASE_URL'):
    os.environ[key]=url
os.environ['NOTALONE_EXPECTED_TEST_DATABASE']=name

class Fixture(OverviewReplyHttpFixture,unittest.TestCase):
    def _backend(self,owner_id,**kwargs):
        if owner_id is None or not hasattr(self,'reply_model'):
            return super()._backend(owner_id,**kwargs)
        self.policy=ContactContextHandoff()
        priority=ModelPriorityControl()
        with patch('notalone.server.reply_wiring.build_deepseek_model',return_value=self.reply_model):
            service=build_reply_service(database_url=self.database_url,owner_id=owner_id,model_priority=priority,
                contact_context=self.policy,**synthetic_budget_kwargs(self.reply_model,capacity=100000))
        backend=HttpBackend(create_app(database_url=self.database_url,owner_id=owner_id,token='synthetic-proxy-token',
            reply_service=service,contact_context=self.policy,runtime_shutdown=priority.stop),owner_id)
        self.addCleanup(backend.close)
        return backend

Fixture.setUpClass()
f=Fixture()
try:
    f.setUp()
    contact,source,message=f.import_contact('对方参加合成课程。')
    f.manual_contact(contact,'对方参加合成课程。')
    f.activate_replies(contact)
    path=f.reply_path(contact)
    assert f.backend.request('/api/runtime/contact-context/configure',{'address':address,'token':internal_token})[0]==200
    assert f.backend.request('/api/runtime/contact-context/stop',{})[1]=={'state':'stopped','active_requests':0}
    with ThreadPoolExecutor(max_workers=2) as executor:
        preparing=executor.submit(f.backend.request,path+'/replies/prepare',f.rewrite_body(contact,'想聊聊合成课程。'))
        try:
            with urlopen('http://'+address+'/test/entered',timeout=5) as response:
                assert response.status==200
            # 代理请求由TS排空；Python不持有本地writer许可或控制锁。
            stopping=executor.submit(f.backend.request,'/api/runtime/contact-context/stop',{})
            assert stopping.result(timeout=3)==(200,{'state':'stopped','active_requests':0})
            checking=executor.submit(f.backend.request,'/api/runtime/contact-context/status')
            assert checking.result(timeout=3)==(200,{'state':'stopped','active_requests':0})
            assert not preparing.done()
        finally:
            with urlopen('http://'+address+'/test/release',timeout=3) as response:
                assert response.status==200
        status,result=preparing.result(timeout=10)
    assert status==200,(status,result)
    assert f.reply_model.seen_calls==[]
    store=PostgresRelationshipOverviewStore(url,contact_context=f.policy)
    scope=ContactScope(f.owner_id,UUID(contact))
    with psycopg.connect(url,row_factory=dict_row) as connection:
        previous=connection.execute("SELECT projection_revision FROM public.relationship_overview_projection WHERE owner_id=%s AND contact_id=%s",(f.owner_id,contact)).fetchone()['projection_revision']
        connection.execute("UPDATE public.confirmed_memory SET text_content='对方更新了合成课程信息。',revision=revision+1 WHERE owner_id=%s AND contact_id=%s",(f.owner_id,contact))
    with psycopg.connect(url,row_factory=dict_row) as connection:
        lock_contact_scope(connection,owner_id=f.owner_id,contact_id=UUID(contact))
        lock_owner_scope(connection,owner_id=f.owner_id)
        fresh=store.read_contact_in_transaction(connection,scope)
        saved=connection.execute("SELECT projection_revision FROM public.relationship_overview_projection WHERE owner_id=%s AND contact_id=%s",(f.owner_id,contact)).fetchone()
        assert fresh.projection_revision!=previous
        assert saved is None, 'TS拥有时Python事务复验不得重建已撤下投影'
    assert f.backend.request('/api/runtime/contact-context/start',{})[0]==200
    fallback=store.read_contact(scope)
    assert fallback.projection_revision==fresh.projection_revision
    with psycopg.connect(url,row_factory=dict_row) as connection:
        saved=connection.execute("SELECT projection_revision FROM public.relationship_overview_projection WHERE owner_id=%s AND contact_id=%s",(f.owner_id,contact)).fetchone()['projection_revision']
        assert saved==fresh.projection_revision
    assert f.backend.request('/api/runtime/contact-context/configure',{'address':'127.0.0.1:1','token':internal_token})[0]==200
    assert f.backend.request('/api/runtime/contact-context/stop',{})[0]==200
    with f.assertRaises(Exception):
        store.read_contact(scope)
    unavailable_body=f.rewrite_body(contact,'TS不可用时不能自动回退。')
    failed,_=f.backend.request(path+'/replies/prepare',unavailable_body)
    # 原准备流程允许带明确概览失败标记继续；不借此自动恢复旧读取。
    assert failed==200, failed
    with psycopg.connect(url,row_factory=dict_row) as connection:
        prepared=connection.execute("SELECT prepared_context FROM public.assistant_session_turn WHERE idempotency_key=%s",(unavailable_body['idempotency_key'],)).fetchone()['prepared_context']
        assert prepared['context']['overview_read_failed'] is True, prepared.keys()
    assert f.reply_model.seen_calls==[]
    print(json.dumps({'prepared':True,'concurrent_stop':True,'owner':str(f.owner_id),'contact':contact,'model_calls':0,'transaction_read_only':True,'explicit_fallback':True,'automatic_fallback':False}))
finally:
    f._cleanups=[item for item in f._cleanups if getattr(item[0],'__name__','')!='_remove_owner']
    f.doCleanups()
