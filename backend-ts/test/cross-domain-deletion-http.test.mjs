import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,symlink,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {HostStorage} from '../src/host-storage.ts';
import {ContactContext} from '../src/contact-context.ts';
import {CrossDomainDeletionService,crossDomainDeletionRoute,serveCrossDomainDeletion} from '../src/cross-domain-deletion.ts';

async function fixture(t) {
  const f=await createStorageFixture();
  t.after(()=>f.close());
  const storage=await HostStorage.open({...f.options,environment:{NOTALONE_OWNER_ID:''}});
  const {owner_id:owner}=await storage.initializeOwner('合成用户');
  const contact=randomUUID();
  const source=randomUUID();
  await f.client.query("INSERT INTO contact(owner_id,id,display_name) VALUES($1,$2,'合成联系人')",[owner,contact]);
  await f.client.query(`INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
    VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,0)`,[source,owner,contact,'a'.repeat(64)]);
  const runtime=await HostStorage.open({...f.options,environment:{NOTALONE_OWNER_ID:owner}});
  t.after(()=>runtime.close());
  const deletions=new CrossDomainDeletionService({storage:runtime,skillsRoot:join(f.directory,'skills')});
  const contacts=new ContactContext(runtime);
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url??'','http://localhost');
    let result;
    try {
      if(crossDomainDeletionRoute(req.method??'',url.pathname)){await serveCrossDomainDeletion(req,res,deletions);return;}
      result={status:200,body:await contacts.handle(req.method??'',url)};
    } catch(error) {
      result={status:error.status??500,body:{error:error.code??'test_failure'}};
    }
    res.writeHead(result.status,{'Content-Type':'application/json'});
    res.end(JSON.stringify(result.body));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {f,owner,contact,source,deletions,origin:`http://127.0.0.1:${server.address().port}`};
}

test('来源删除通过公开HTTP返回可重读原任务且最终不可检索',async t=>{
  const x=await fixture(t);
  const response=await fetch(`${x.origin}/api/contacts/${x.contact}/sources/${x.source}`,{method:'DELETE'});
  assert.equal(response.status,202);
  const accepted=await response.json();
  assert.match(accepted.task_id,/^[0-9a-f-]{36}$/);
  const status=await fetch(`${x.origin}/api/deletions/${accepted.task_id}`);
  assert.equal(status.status,200);
  const operation=await status.json();
  assert.equal(operation.status,'succeeded',JSON.stringify(operation));
  const retried=await fetch(`${x.origin}/api/deletions/${accepted.task_id}/retry`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:'{"confirmed":true}',
  });
  assert.equal(retried.status,200);
  assert.deepEqual(await retried.json(),{operation_id:accepted.task_id,status:'succeeded'});
  const sources=await fetch(`${x.origin}/api/contacts/${x.contact}/sources`);
  const body=await sources.json();
  assert.equal(body.sources[0].status,'deleted');
  assert.equal(body.sources[0].task_status,'succeeded');
  assert.equal(body.sources[0].file_name,null);
});

test('来源删除幂等并贯通消息、记忆、处理副本与未完成导入',async t=>{
  const x=await fixture(t);
  const message=randomUUID(),candidate=randomUUID(),memory=randomUUID(),batch=randomUUID(),record=randomUUID(),task=randomUUID(),ledger=randomUUID();
  await x.f.client.query(`INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
    VALUES($1,$2,$3,'contact','text','合成聊天正文',now())`,[message,x.owner,x.contact]);
  await x.f.client.query(`INSERT INTO wechat_message_metadata(message_id,owner_id,contact_id,external_local_id,external_server_id,external_talker,source_create_time)
    VALUES($1,$2,$3,101,NULL,'synthetic',1001)`,[message,x.owner,x.contact]);
  await x.f.client.query(`INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
    VALUES($1,$2,$3,'source_document',$4,'message:101','{}')`,[message,x.owner,x.contact,x.source]);
  await x.f.client.query(`INSERT INTO memory_candidate(id,owner_id,contact_id,text_content,category,source_ids)
    VALUES($1,$2,$3,'合成候选','common_fact',$4::uuid[])`,[candidate,x.owner,x.contact,[message]]);
  await x.f.client.query(`INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method)
    VALUES($1,$2,$3,'合成关系资料','common_fact',$4::uuid[],'auto')`,[memory,x.owner,x.contact,[message]]);
  await x.f.client.query(`INSERT INTO source_processing_batch(batch_id,owner_id,contact_id,source_kind,source_id)
    VALUES($1,$2,$3,'source_document',$4)`,[batch,x.owner,x.contact,x.source]);
  await x.f.client.query(`INSERT INTO source_processing_record(record_id,batch_id,owner_id,contact_id,position,locator,message_id,outcome,payload)
    VALUES($1,$2,$3,$4,0,'locator',$5,'accepted','{"正文":"合成处理副本"}')`,[record,batch,x.owner,x.contact,message]);
  await x.f.client.query(`INSERT INTO background_task(id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count)
    VALUES($1,$2,$3,$4,'import','queued','parse',1)`,[task,x.owner,x.contact,x.source]);
  await x.f.client.query(`INSERT INTO background_task_step(task_id,step_name,step_order,status)
    VALUES($1,'parse',1,'pending'),($1,'normalize',2,'pending'),($1,'extract_memory',3,'pending'),($1,'index',4,'pending'),($1,'verify',5,'pending')`,[task]);
  await x.f.client.query(`INSERT INTO outbound_ledger_entry(id,owner_id,contact_id,provider,model_name,outcome,called_at)
    VALUES($1,$2,$3,'synthetic','synthetic-model','succeeded',now())`,[ledger,x.owner,x.contact]);
  const first=await fetch(`${x.origin}/api/contacts/${x.contact}/sources/${x.source}`,{method:'DELETE'});
  const accepted=await first.json();
  assert.equal(first.status,202);
  const operation=await (await fetch(`${x.origin}/api/deletions/${accepted.task_id}`)).json();
  assert.equal(operation.status,'succeeded',JSON.stringify(operation));
  const repeat=await fetch(`${x.origin}/api/contacts/${x.contact}/sources/${x.source}`,{method:'DELETE'});
  assert.deepEqual(await repeat.json(),accepted);
  const counts=await x.f.client.query(`SELECT
    (SELECT count(*)::int FROM message WHERE id=$1) AS messages,
    (SELECT count(*)::int FROM message_source_ref WHERE source_document_id=$2) AS refs,
    (SELECT count(*)::int FROM memory_candidate WHERE id=$3) AS candidates,
    (SELECT count(*)::int FROM confirmed_memory WHERE id=$4) AS memories,
    (SELECT payload IS NULL FROM source_processing_record WHERE record_id=$5) AS erased,
    (SELECT status FROM background_task WHERE id=$6) AS import_task,
    (SELECT count(*)::int FROM outbound_ledger_entry WHERE id=$7) AS ledger`,[message,x.source,candidate,memory,record,task,ledger]);
  assert.deepEqual(counts.rows[0],{messages:0,refs:0,candidates:0,memories:0,erased:true,import_task:'cancelled',ledger:1});
  const late=randomUUID();
  await x.f.client.query(`INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
    VALUES($1,$2,$3,'contact','text','迟到正文',now())`,[late,x.owner,x.contact]);
  await assert.rejects(x.f.client.query(`INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
    VALUES($1,$2,$3,'source_document',$4,'late','{}')`,[late,x.owner,x.contact,x.source]),/source_not_active/);
});

test('多来源消息只撤被删引用，独立资料与无关联系人保留',async t=>{
  const x=await fixture(t);
  const otherContact=randomUUID(),otherSource=randomUUID(),peerSource=randomUUID();
  const message=randomUUID(),keptMemory=randomUUID(),sourceOnlyCandidate=randomUUID();
  await x.f.client.query("INSERT INTO contact(owner_id,id,display_name) VALUES($1,$2,'无关联系人')",[x.owner,otherContact]);
  await x.f.client.query(`INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
    VALUES($1,$2,$3,'wechat_jsonl','other.jsonl',$4,1),($5,$2,$6,'wechat_jsonl','peer.jsonl',$7,1)`,
  [otherSource,x.owner,otherContact,'b'.repeat(64),peerSource,x.contact,'c'.repeat(64)]);
  await x.f.client.query(`INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
    VALUES($1,$2,$3,'contact','text','多来源正文',now())`,[message,x.owner,x.contact]);
  await x.f.client.query(`INSERT INTO wechat_message_metadata(message_id,owner_id,contact_id,external_local_id,external_server_id,external_talker,source_create_time)
    VALUES($1,$2,$3,202,NULL,'synthetic',2002)`,[message,x.owner,x.contact]);
  await x.f.client.query(`INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
    VALUES($1,$2,$3,'source_document',$4,'one','{}'),($1,$2,$3,'source_document',$5,'two','{}')`,
  [message,x.owner,x.contact,x.source,peerSource]);
  await x.f.client.query(`INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method)
    VALUES($1,$2,$3,'仍有一条有效来源','common_fact',$4::uuid[],'auto')`,[keptMemory,x.owner,x.contact,[message]]);
  await x.f.client.query(`INSERT INTO memory_candidate(id,owner_id,contact_id,text_content,category,source_ids)
    VALUES($1,$2,$3,'只依赖被删来源','common_fact',$4::uuid[])`,[sourceOnlyCandidate,x.owner,x.contact,[x.source]]);
  const accepted=await (await fetch(`${x.origin}/api/contacts/${x.contact}/sources/${x.source}`,{method:'DELETE'})).json();
  assert.equal((await (await fetch(`${x.origin}/api/deletions/${accepted.task_id}`)).json()).status,'succeeded');
  const rows=await x.f.client.query(`SELECT
    (SELECT count(*)::int FROM message WHERE id=$1) AS message,
    (SELECT count(*)::int FROM message_source_ref WHERE message_id=$1) AS refs,
    (SELECT count(*)::int FROM confirmed_memory WHERE id=$2) AS memory,
    (SELECT count(*)::int FROM memory_candidate WHERE id=$3) AS candidate,
    (SELECT count(*)::int FROM source_document WHERE id=$4) AS other_source,
    (SELECT count(*)::int FROM wechat_auto_read_suppression WHERE owner_id=$5 AND contact_id=$6 AND external_local_id=202) AS suppressed`,
  [message,keptMemory,sourceOnlyCandidate,otherSource,x.owner,x.contact]);
  assert.deepEqual(rows.rows[0],{message:1,refs:1,memory:1,candidate:0,other_source:1,suppressed:1});
});

test('本地微信观察按同一来源闭包删除且拒绝迟到引用',async t=>{
  const x=await fixture(t);
  const binding=randomUUID(),observation=randomUUID(),message=randomUUID(),candidate=randomUUID(),pending=randomUUID();
  await x.f.client.query(`INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator,status)
    VALUES($1,$2,$3,'wechat','synthetic','synthetic-observation','active')`,[binding,x.owner,x.contact]);
  await x.f.client.query(`INSERT INTO local_wechat_observation
    (id,owner_id,contact_id,binding_id,mode,cli_version,conversation_locator,last_local_id,last_cursor,record_count,event_count)
    VALUES($1,$2,$3,$4,'live','synthetic','synthetic-observation',303,'cursor-303',1,1)`,
  [observation,x.owner,x.contact,binding]);
  await x.f.client.query(`INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
    VALUES($1,$2,$3,'wechat_jsonl','collision.jsonl',$4,0)`,[observation,x.owner,x.contact,'f'.repeat(64)]);
  const ambiguous=await fetch(`${x.origin}/api/contacts/${x.contact}/sources/${observation}`,{method:'DELETE'});
  assert.equal(ambiguous.status,409);
  assert.deepEqual(await ambiguous.json(),{error:'source_kind_ambiguous'});
  await x.f.client.query('DELETE FROM source_document WHERE id=$1',[observation]);
  await x.f.client.query(`INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
    VALUES($1,$2,$3,'contact','text','合成观察正文',now())`,[message,x.owner,x.contact]);
  await x.f.client.query(`INSERT INTO wechat_message_metadata(message_id,owner_id,contact_id,external_local_id,external_server_id,external_talker,source_create_time)
    VALUES($1,$2,$3,303,NULL,'synthetic',3003)`,[message,x.owner,x.contact]);
  await x.f.client.query(`INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,observation_id,source_locator,raw_payload)
    VALUES($1,$2,$3,'local_wechat_observation',$4,'id:303','{}')`,[message,x.owner,x.contact,observation]);
  const subject=createHash('sha256').update(JSON.stringify([x.owner,'source','local_wechat_observation',x.contact,observation])).digest('hex');
  await x.f.client.query(`INSERT INTO cross_domain_deletion_operation
    (id,subject_sha256,scope_kind,source_kind,owner_id,contact_id,target_id)
    VALUES($1,$2,'source','local_wechat_observation',$3,$4,$5)`,
  [pending,subject,x.owner,x.contact,observation]);
  const lateDuringDeletion=randomUUID();
  await x.f.client.query(`INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
    VALUES($1,$2,$3,'contact','text','删除排队中迟到正文',now())`,[lateDuringDeletion,x.owner,x.contact]);
  await assert.rejects(x.f.client.query(`INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,observation_id,source_locator,raw_payload)
    VALUES($1,$2,$3,'local_wechat_observation',$4,'queued-late','{}')`,[lateDuringDeletion,x.owner,x.contact,observation]),/source_not_active/);
  await x.f.client.query('DELETE FROM cross_domain_deletion_operation WHERE id=$1',[pending]);
  await x.f.client.query(`INSERT INTO memory_candidate(id,owner_id,contact_id,text_content,category,source_ids)
    VALUES($1,$2,$3,'合成观察候选','common_fact',$4::uuid[])`,[candidate,x.owner,x.contact,[observation]]);
  const accepted=await (await fetch(`${x.origin}/api/contacts/${x.contact}/sources/${observation}`,{method:'DELETE'})).json();
  const result=await (await fetch(`${x.origin}/api/deletions/${accepted.task_id}`)).json();
  assert.equal(result.status,'succeeded',JSON.stringify(result));
  const repeat=await (await fetch(`${x.origin}/api/contacts/${x.contact}/sources/${observation}`,{method:'DELETE'})).json();
  assert.deepEqual(repeat,accepted);
  const rows=await x.f.client.query(`SELECT
    (SELECT count(*)::int FROM local_wechat_observation WHERE id=$1) AS observations,
    (SELECT count(*)::int FROM message WHERE id=$2) AS messages,
    (SELECT count(*)::int FROM memory_candidate WHERE id=$3) AS candidates,
    (SELECT count(*)::int FROM wechat_auto_read_suppression WHERE owner_id=$4 AND contact_id=$5 AND external_local_id=303) AS suppressed`,
  [observation,message,candidate,x.owner,x.contact]);
  assert.deepEqual(rows.rows[0],{observations:0,messages:0,candidates:0,suppressed:1});
  const late=randomUUID();
  await x.f.client.query(`INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
    VALUES($1,$2,$3,'contact','text','迟到观察正文',now())`,[late,x.owner,x.contact]);
  await assert.rejects(x.f.client.query(`INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,observation_id,source_locator,raw_payload)
    VALUES($1,$2,$3,'local_wechat_observation',$4,'late','{}')`,[late,x.owner,x.contact,observation]),/source_not_active/);
});

test('整联系人删除要求明确确认并清除该范围讨论、回复、任务和台账',async t=>{
  const x=await fixture(t);
  const otherContact=randomUUID(),otherSource=randomUUID();
  const reply=randomUUID(),session=randomUUID(),ledger=randomUUID(),preference=randomUUID();
  await x.f.client.query("INSERT INTO contact(owner_id,id,display_name) VALUES($1,$2,'保留联系人')",[x.owner,otherContact]);
  await x.f.client.query(`INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
    VALUES($1,$2,$3,'wechat_jsonl','keep.jsonl',$4,0)`,[otherSource,x.owner,otherContact,'d'.repeat(64)]);
  await x.f.client.query(`INSERT INTO reply_request(id,owner_id,contact_id,conversation_binding_id,idempotency_key,normalized_input,state,attempt,lease_expires_at)
    VALUES($1,$2,$3,$4,$5,'合成请求','running',1,now()+interval '1 minute')`,[reply,x.owner,x.contact,randomUUID(),randomUUID()]);
  await x.f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id) VALUES($1,$2,$3)',[session,x.owner,x.contact]);
  await x.f.client.query(`INSERT INTO outbound_ledger_entry(id,owner_id,contact_id,provider,model_name,outcome,called_at)
    VALUES($1,$2,$3,'synthetic','synthetic-model','succeeded',now())`,[ledger,x.owner,x.contact]);
  await x.f.client.query(`INSERT INTO expression_preference
    (id,owner_id,contact_id,text_content,confirmed_operation_key,origin_kind,source_ids)
    VALUES($1,$2,$3,'合成长期表达偏好',$4,'manual','{}')`,[preference,x.owner,x.contact,randomUUID()]);
  await x.f.client.query(`INSERT INTO media_request_tombstone(owner_id,contact_id,request_key_hash)
    VALUES($1,$2,$3)`,[x.owner,x.contact,'d'.repeat(64)]);
  const unconfirmed=await fetch(`${x.origin}/api/contacts/${x.contact}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(unconfirmed.status,400);
  assert.equal((await x.f.client.query('SELECT count(*)::int n FROM contact WHERE id=$1',[x.contact])).rows[0].n,1);
  const response=await fetch(`${x.origin}/api/contacts/${x.contact}`,{method:'DELETE',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({confirmed:true,confirm_contact_id:x.contact})});
  assert.equal(response.status,202);
  const accepted=await response.json();
  const operation=await (await fetch(`${x.origin}/api/deletions/${accepted.operation_id}`)).json();
  assert.equal(operation.status,'succeeded',JSON.stringify(operation));
  const rows=await x.f.client.query(`SELECT
    (SELECT count(*)::int FROM contact WHERE id=$1) AS deleted_contact,
    (SELECT count(*)::int FROM contact WHERE id=$2) AS kept_contact,
    (SELECT count(*)::int FROM reply_request WHERE id=$3) AS reply,
    (SELECT count(*)::int FROM assistant_session WHERE id=$4) AS discussion,
    (SELECT count(*)::int FROM outbound_ledger_entry WHERE id=$5) AS ledger,
    (SELECT count(*)::int FROM source_document WHERE id=$6) AS kept_source,
    (SELECT count(*)::int FROM media_request_tombstone WHERE owner_id=$7 AND contact_id=$1) AS media_tombstone,
    (SELECT count(*)::int FROM expression_preference
      WHERE id=$8 AND contact_id IS NULL AND status='deleted' AND text_content IS NULL) AS preference_tombstone`,
  [x.contact,otherContact,reply,session,ledger,otherSource,x.owner,preference]);
  assert.deepEqual(rows.rows[0],{deleted_contact:0,kept_contact:1,reply:0,discussion:0,ledger:0,
    kept_source:1,media_tombstone:0,preference_tombstone:1});
});

test('整联系人删除失效其他范围对候选版本和联系人身份的既有依赖',async t=>{
  const x=await fixture(t);
  const otherContact=randomUUID(),session=randomUUID(),request=randomUUID(),turn=randomUUID();
  const candidate=randomUUID(),version=candidate,dependent=randomUUID(),contactDependent=randomUUID(),binding=randomUUID();
  const editedVersion=randomUUID();
  await x.f.client.query("INSERT INTO contact(owner_id,id,display_name) VALUES($1,$2,'保留候选依赖联系人')",[x.owner,otherContact]);
  await x.f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id) VALUES($1,$2,$3)',[session,x.owner,x.contact]);
  await x.f.client.query(`INSERT INTO reply_request(id,owner_id,contact_id,conversation_binding_id,idempotency_key,
      normalized_input,state,attempt,lease_expires_at,context_snapshot,skill_library_revision)
    VALUES($1,$2,$3,$4,$5,'合成候选','completed',1,now(),'{}',0)`,[request,x.owner,x.contact,binding,randomUUID()]);
  await x.f.client.query('UPDATE reply_request SET state=\'completed\' WHERE id=$1',[request]);
  await x.f.client.query(`INSERT INTO assistant_session_turn
    (id,session_id,owner_id,contact_id,idempotency_key,conversation_binding_id,input_digest,input_payload,state,reply_request_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,'{}','completed',$8)`,
  [turn,session,x.owner,x.contact,randomUUID(),binding,'a'.repeat(64),request]);
  const messageGroup=[{message_id:randomUUID(),text:'合成候选正文'}];
  await x.f.client.query(`INSERT INTO reply_candidate
    (id,reply_request_id,owner_id,contact_id,conversation_binding_id,ordinal,candidate_text,basis,risk_notes,message_group)
    VALUES($1,$2,$3,$4,$5,0,'合成候选正文','合成依据','[]',$6)`,
  [candidate,request,x.owner,x.contact,binding,JSON.stringify(messageGroup)]);
  await x.f.client.query(`INSERT INTO assistant_candidate_version
    (id,owner_id,contact_id,session_id,turn_id,candidate_id,version_number)
    VALUES($1,$2,$3,$4,$5,$1,0)`,[version,x.owner,x.contact,session,turn]);
  await x.f.client.query(`INSERT INTO assistant_candidate_version
    (id,owner_id,contact_id,session_id,turn_id,candidate_id,version_number,parent_version_id,edit_key,message_group,requirements)
    VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,'合成编辑要求')`,
  [editedVersion,x.owner,x.contact,session,turn,candidate,version,randomUUID(),
    JSON.stringify([{message_id:messageGroup[0].message_id,text:'合成编辑正文'}])]);
  await x.f.client.query(`INSERT INTO reply_request
    (id,owner_id,contact_id,conversation_binding_id,idempotency_key,normalized_input,state,attempt,lease_expires_at,context_snapshot)
    VALUES($1,$2,$3,$4,$5,'合成下游依赖','running',1,now()+interval '1 minute',$6)`,
  [dependent,x.owner,otherContact,randomUUID(),randomUUID(),{navigation_dependency_ids:[editedVersion]}]);
  await x.f.client.query(`INSERT INTO reply_request
    (id,owner_id,contact_id,conversation_binding_id,idempotency_key,normalized_input,state,attempt,lease_expires_at,context_snapshot)
    VALUES($1,$2,$3,$4,$5,'合成联系人身份依赖','running',1,now()+interval '1 minute',$6)`,
  [contactDependent,x.owner,otherContact,randomUUID(),randomUUID(),{navigation_dependency_ids:[x.contact]}]);
  const response=await fetch(`${x.origin}/api/contacts/${x.contact}`,{method:'DELETE',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmed:true,confirm_contact_id:x.contact})});
  const accepted=await response.json();
  assert.equal((await (await fetch(`${x.origin}/api/deletions/${accepted.operation_id}`)).json()).status,'succeeded');
  assert.equal((await x.f.client.query(
    'SELECT count(*)::int n FROM reply_request WHERE id=ANY($1::uuid[])',
    [[dependent,contactDependent]],
  )).rows[0].n,0);
});

test('旧级联已删除联系人后，重复删除仍能清理媒体墓碑',async t=>{
  const x=await fixture(t);
  await x.f.client.query(`INSERT INTO media_request_tombstone(owner_id,contact_id,request_key_hash)
    VALUES($1,$2,$3)`,[x.owner,x.contact,'e'.repeat(64)]);
  await x.f.client.query('DELETE FROM public.contact WHERE owner_id=$1 AND id=$2',[x.owner,x.contact]);
  const response=await fetch(`${x.origin}/api/contacts/${x.contact}`,{method:'DELETE',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmed:true,confirm_contact_id:x.contact})});
  assert.equal(response.status,202);
  const accepted=await response.json();
  assert.equal((await (await fetch(`${x.origin}/api/deletions/${accepted.operation_id}`)).json()).status,'succeeded');
  assert.equal((await x.f.client.query(
    'SELECT count(*)::int n FROM media_request_tombstone WHERE owner_id=$1 AND contact_id=$2',
    [x.owner,x.contact],
  )).rows[0].n,0);
});

test('整账户删除需二次确认，并清理 owner 级资料和调用台账',async t=>{
  const x=await fixture(t);
  const ownerMemory=randomUUID(),ledger=randomUUID(),accountSource=randomUUID();
  await x.f.client.query(`INSERT INTO owner_memory(id,owner_id,text_content,category,source_ids,adoption_method)
    VALUES($1,$2,'合成本人资料','common_fact',$3::uuid[],'manual')`,[ownerMemory,x.owner,[x.owner]]);
  await x.f.client.query(`INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
    VALUES($1,$2,$3,'wechat_jsonl','account.jsonl',$4,0)`,[accountSource,x.owner,x.contact,'e'.repeat(64)]);
  await x.f.client.query(`INSERT INTO outbound_ledger_entry(id,owner_id,contact_id,provider,model_name,outcome,called_at)
    VALUES($1,$2,$3,'synthetic','synthetic-model','succeeded',now())`,[ledger,x.owner,x.contact]);
  await x.f.client.query(`INSERT INTO media_request_tombstone(owner_id,contact_id,request_key_hash)
    VALUES($1,$2,$3)`,[x.owner,x.contact,'f'.repeat(64)]);
  assert.equal((await fetch(`${x.origin}/api/account`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{}'})).status,400);
  assert.equal((await x.f.client.query('SELECT count(*)::int n FROM owner WHERE id=$1',[x.owner])).rows[0].n,1);
  const response=await fetch(`${x.origin}/api/account`,{method:'DELETE',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({confirmed:true,confirm_scope:'account'})});
  assert.equal(response.status,202);
  const accepted=await response.json();
  const operation=await (await fetch(`${x.origin}/api/deletions/${accepted.operation_id}`)).json();
  assert.equal(operation.status,'succeeded',JSON.stringify(operation));
  const repeat=await fetch(`${x.origin}/api/account`,{method:'DELETE',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({confirmed:true,confirm_scope:'account'})});
  assert.deepEqual(await repeat.json(),accepted);
  const rows=await x.f.client.query(`SELECT
    (SELECT count(*)::int FROM owner WHERE id=$1) AS owners,
    (SELECT count(*)::int FROM contact WHERE owner_id=$1) AS contacts,
    (SELECT count(*)::int FROM owner_memory WHERE id=$2) AS owner_memory,
    (SELECT count(*)::int FROM source_document WHERE id=$3) AS source,
    (SELECT count(*)::int FROM outbound_ledger_entry WHERE id=$4) AS ledger,
    (SELECT count(*)::int FROM media_request_tombstone WHERE owner_id=$1) AS media_tombstone`,
  [x.owner,ownerMemory,accountSource,ledger]);
  assert.deepEqual(rows.rows[0],{owners:0,contacts:0,owner_memory:0,source:0,ledger:0,media_tombstone:0});
});

test('讨论删除要求确认，成功后同范围会话不可读且来源保留',async t=>{
  const x=await fixture(t);
  const session=randomUUID();
  await x.f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id) VALUES($1,$2,$3)',[session,x.owner,x.contact]);
  const path=`${x.origin}/api/contacts/${x.contact}/assistant-sessions/${session}`;
  assert.equal((await fetch(path,{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{}'})).status,400);
  const response=await fetch(path,{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{"confirmed":true}'});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{session_id:session,state:'deleted'});
  const rows=await x.f.client.query(`SELECT
    (SELECT count(*)::int FROM assistant_session WHERE id=$1) AS discussions,
    (SELECT count(*)::int FROM source_document WHERE id=$2 AND status='active') AS sources`,
  [session,x.source]);
  assert.deepEqual(rows.rows[0],{discussions:0,sources:1});
});

test('讨论数据库已删但文件失败时，同一操作重试仍会清理残留而不会假报成功',async t=>{
  const x=await fixture(t);
  const session=randomUUID(),skill=randomUUID(),version=randomUUID();
  const root=join(x.f.directory,'skills');
  const poisoned=join(root,'.versions',x.owner,skill,version);
  await mkdir(join(root,'.versions',x.owner,skill),{recursive:true});
  await symlink('/tmp',poisoned);
  await x.f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id) VALUES($1,$2,$3)',[session,x.owner,x.contact]);
  await x.f.client.query('INSERT INTO reply_skill_file_cleanup(relative_path) VALUES($1)',[`.versions/${x.owner}/${skill}/${version}`]);
  const path=`${x.origin}/api/contacts/${x.contact}/assistant-sessions/${session}`;
  const first=await fetch(path,{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{"confirmed":true}'});
  assert.equal(first.status,503);
  assert.equal((await x.f.client.query('SELECT count(*)::int n FROM assistant_session WHERE id=$1',[session])).rows[0].n,0);
  assert.equal((await x.f.client.query(`SELECT status FROM cross_domain_deletion_operation
    WHERE scope_kind='discussion' AND contact_id=$1 AND target_id=$2`,[x.contact,session])).rows[0].status,'failed');
  await unlink(poisoned);await mkdir(poisoned);
  const retry=await fetch(path,{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{"confirmed":true}'});
  assert.equal(retry.status,200,await retry.clone().text());
  assert.equal((await x.f.client.query('SELECT count(*)::int n FROM reply_skill_file_cleanup WHERE relative_path=$1',
    [`.versions/${x.owner}/${skill}/${version}`])).rows[0].n,0);
  assert.equal(existsSync(poisoned),false);
  assert.equal((await x.f.client.query(`SELECT status FROM cross_domain_deletion_operation
    WHERE scope_kind='discussion' AND status='succeeded' ORDER BY finished_at DESC LIMIT 1`)).rows[0].status,'succeeded');
});

test('文件清理失败保持可见，修复后同一操作可重试完成',async t=>{
  const x=await fixture(t);
  const skill=randomUUID(),version=randomUUID();
  const root=join(x.f.directory,'skills');
  const poisoned=join(root,'.versions',x.owner,skill,version);
  await mkdir(join(root,'.versions',x.owner,skill),{recursive:true});
  await symlink('/tmp',poisoned);
  await x.f.client.query('INSERT INTO reply_skill_file_cleanup(relative_path) VALUES($1)',[`.versions/${x.owner}/${skill}/${version}`]);
  const response=await fetch(`${x.origin}/api/account`,{method:'DELETE',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({confirmed:true,confirm_scope:'account'})});
  const accepted=await response.json();
  let operation=await (await fetch(`${x.origin}/api/deletions/${accepted.operation_id}`)).json();
  assert.equal(operation.status,'failed');
  assert.equal(operation.error_code,'skill_file_cleanup_required');
  await unlink(poisoned);await mkdir(poisoned);
  const retry=await fetch(`${x.origin}/api/deletions/${accepted.operation_id}/retry`,{method:'POST',
    headers:{'Content-Type':'application/json'},body:'{"confirmed":true}'});
  assert.equal(retry.status,202);
  operation=await (await fetch(`${x.origin}/api/deletions/${accepted.operation_id}`)).json();
  assert.equal(operation.status,'succeeded',JSON.stringify(operation));
  assert.equal(existsSync(poisoned),false);
});

test('来源删除清理受管媒体文件后才标记完成',async t=>{
  const x=await fixture(t);
  const attempt=randomUUID(),resource=randomUUID();
  const root=join(x.f.directory,'media');
  const parts=[x.owner,x.contact,x.source,attempt].map(value=>value.replaceAll('-',''));
  const directory=join(root,...parts);
  await mkdir(directory,{recursive:true,mode:0o700});
  const artifact=join(directory,'artifact.data');
  await writeFile(artifact,'合成媒体');
  await x.f.client.query(`INSERT INTO media_attempt(resource_id,owner_id,contact_id,message_id,source_ref_id,source_document_id,
      request_key_hash,input_hash,target,variant,locator_hash,authorization_generation,attempt_id,cache_root,status,artifacts,lease_expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'file',NULL,NULL,'synthetic-generation',$9,$10,'ready','[]',now()+interval '1 minute')`,
  [resource,x.owner,x.contact,randomUUID(),randomUUID(),x.source,'a'.repeat(64),'b'.repeat(64),attempt,root]);
  const accepted=await (await fetch(`${x.origin}/api/contacts/${x.contact}/sources/${x.source}`,{method:'DELETE'})).json();
  assert.equal((await (await fetch(`${x.origin}/api/deletions/${accepted.task_id}`)).json()).status,'succeeded');
  assert.equal(existsSync(artifact),false);
  assert.equal((await x.f.client.query('SELECT count(*)::int n FROM media_attempt WHERE resource_id=$1',[resource])).rows[0].n,0);
  assert.equal((await x.f.client.query('SELECT count(*)::int n FROM media_request_tombstone WHERE owner_id=$1 AND contact_id=$2',[x.owner,x.contact])).rows[0].n,1);
});

test('过期租约由新服务实例接管且旧结果不能回填',async t=>{
  const x=await fixture(t);
  const operation=randomUUID(),task=operation;
  const subject=createHash('sha256').update(JSON.stringify([x.owner,'source','source_document',x.contact,x.source])).digest('hex');
  await x.f.client.query(`INSERT INTO cross_domain_deletion_operation
    (id,subject_sha256,scope_kind,source_kind,owner_id,contact_id,target_id,status,phase,lease_expires_at)
    VALUES($1,$2,'source','source_document',$3,$4,$5,'running','erase',now()-interval '1 minute')`,
  [operation,subject,x.owner,x.contact,x.source]);
  await x.f.client.query(`INSERT INTO background_task(id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count)
    VALUES($1,$2,$3,$4,'delete','running','delete_derived',0)`,[task,x.owner,x.contact,x.source]);
  await x.f.client.query(`INSERT INTO background_task_step(task_id,step_name,step_order,status)
    VALUES($1,'mark_deleted',1,'succeeded'),($1,'delete_derived',2,'running'),($1,'delete_index',3,'pending'),
      ($1,'clear_cache',4,'pending'),($1,'verify_not_retrievable',5,'pending')`,[task]);
  await x.f.client.query("UPDATE source_document SET status='delete_requested',deletion_operation_id=$2 WHERE id=$1",[x.source,operation]);
  const restartStorage=await HostStorage.open({...x.f.options,environment:{NOTALONE_OWNER_ID:x.owner}});
  t.after(()=>restartStorage.close());
  const restarted=new CrossDomainDeletionService({storage:restartStorage,
    skillsRoot:join(x.f.directory,'skills')});
  assert.equal(await restarted.recover(),1);
  const result=await (await fetch(`${x.origin}/api/deletions/${operation}`)).json();
  assert.equal(result.status,'succeeded');
  assert.equal((await x.f.client.query('SELECT count(*)::int n FROM source_document WHERE id=$1',[x.source])).rows[0].n,1);
});

test('重启恢复处理全部排队操作而不是只处理首批三十二项',async t=>{
  const x=await fixture(t);
  const operations=[];
  for(let index=0;index<33;index++){
    const operation=randomUUID();
    const subject=createHash('sha256').update(`${x.owner}:${x.source}:${index}`).digest('hex');
    operations.push(operation);
    await x.f.client.query(`INSERT INTO cross_domain_deletion_operation
      (id,subject_sha256,scope_kind,source_kind,owner_id,contact_id,target_id)
      VALUES($1,$2,'source','source_document',$3,$4,$5)`,
    [operation,subject,x.owner,x.contact,x.source]);
  }
  assert.equal(await x.deletions.recover(),33);
  assert.equal((await x.f.client.query(
    "SELECT count(*)::int n FROM cross_domain_deletion_operation WHERE id=ANY($1::uuid[]) AND status='queued'",
    [operations],
  )).rows[0].n,0);
});
