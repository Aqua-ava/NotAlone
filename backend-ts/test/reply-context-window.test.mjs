import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {PostgresReplyContext} from '../src/reply-context.ts';
import {readContextMessages,measureReplyMessageWindow,requireReplyMessageWindowBudget} from '../src/reply-context-read.ts';
import {buildReplyPayload} from '../src/reply-payload.ts';
import {parseReplyRequest,normalizeReplyInput} from '../src/reply-contract.ts';
import {decodePreparedContext,encodePreparedContext} from '../src/reply-prepared-codec.ts';
import {startReplyServiceHost} from './reply-service-runtime-support.mjs';
async function fixture(t){
 const f=await createStorageFixture();let external=false;t.after(async()=>{if(!external)await f.close();});
 const owner=randomUUID(),contact=randomUUID(),source=randomUUID(),binding=randomUUID(),scope={owner_id:owner,contact_id:contact,conversation_binding_id:binding,confirmation:'manual'};
 await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成用户')",[owner]);await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contact,owner]);await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id)VALUES($1,$2,$3)',[binding,owner,contact]);await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'manual','合成来源',$4,1)",[source,owner,contact,'a'.repeat(64)]);
 async function message(text,time){const id=randomUUID();await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,'contact','text',$4,$5)",[id,owner,contact,text,time]);await f.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,$4,'source_document',$5,$6,'{}')",[randomUUID(),id,owner,contact,source,id]);return id;}
 const request=content=>parseReplyRequest({contact_id:contact,idempotency_key:randomUUID(),content:content??{type:'initiate_conversation',purpose:'合成问候',purpose_source:'direct_input'},skill_disabled:true});
 const build=async input=>{const command=input??request();return {command,context:await new PostgresReplyContext(f.client,{overview:false}).build({...scope,reply_request_id:randomUUID(),request:command})};};
 return {f,scope,message,request,build,external:()=>{external=true;}};
}
const projectedMessages=({command,context})=>buildReplyPayload({request:command,context}).evidence.filter(e=>e.kind==='message');
test('近期整条中文Unicode窗口独立不超8000估算字节，固定ID复验不裁切',async t=>{
 const x=await fixture(t),ids=[];for(let i=0;i<5;i++)ids.push(await x.message('中文😀'.repeat(400),`2026-01-01T00:00:0${i}Z`));
 const built=await x.build(),projected=projectedMessages(built);assert.ok(Buffer.byteLength(JSON.stringify(projected),'utf8')<=8000);assert.equal(projected.length,1);assert.equal(projected[0].evidence_id,ids.at(-1));assert.equal(projected[0].text,'中文😀'.repeat(400));
 assert.equal((await readContextMessages(x.f.client,{owner_id:x.scope.owner_id,contact_id:x.scope.contact_id},{ids,limit:ids.length})).length,5);await new PostgresReplyContext(x.f.client,{overview:false}).validateCurrent(built.context);
});
test('遇较新超长整条即停止，不跳到更旧短消息；最近顺序保留微秒与50条上限',async t=>{
 const x=await fixture(t),old=await x.message('旧短消息','2026-01-01T00:00:00.000001Z'),large=await x.message('中'.repeat(3000),'2026-01-01T00:00:00.000002Z'),latest=await x.message('最新短消息','2026-01-01T00:00:00.000003Z');
 const result=projectedMessages(await x.build());assert.deepEqual(result.map(e=>e.evidence_id),[latest]);assert.ok(!result.some(e=>e.evidence_id===old||e.evidence_id===large));
 for(let i=0;i<55;i++)await x.message('短',`2026-02-01T00:00:${String(i).padStart(2,'0')}Z`);
 const raw=await readContextMessages(x.f.client,{owner_id:x.scope.owner_id,contact_id:x.scope.contact_id});assert.equal(raw.length,50);const bounded=projectedMessages(await x.build());assert.ok(bounded.length<=50);assert.ok(Buffer.byteLength(JSON.stringify(bounded))<=8000);assert.equal(bounded.at(-1).evidence_id,raw[0].evidence_id);
 t.diagnostic(`合成50条单字短消息：新窗口选取${bounded.length}条，实际投影${Buffer.byteLength(JSON.stringify(bounded))}估算字节`);
 const ids=(await x.f.client.query('SELECT id FROM message WHERE owner_id=$1 AND contact_id=$2',[x.scope.owner_id,x.scope.contact_id])).rows.map(r=>r.id),full=await readContextMessages(x.f.client,{owner_id:x.scope.owner_id,contact_id:x.scope.contact_id},{ids,limit:ids.length}),frozen=(await x.build()).context;assert.ok(full.length>50);frozen.evidence=full.map(e=>({...e,model_visible:false}));await new PostgresReplyContext(x.f.client,{overview:false}).validateCurrent(frozen);await x.f.client.query("UPDATE message SET text_content='最旧隐藏原根改变' WHERE id=$1",[old]);await assert.rejects(new PostgresReplyContext(x.f.client,{overview:false}).validateCurrent(frozen));
});
test('显式目标纳入同一窗口预算，超长目标明确拒绝且官方service零HTTP',async t=>{
 const x=await fixture(t),target=await x.message('中😀'.repeat(2000),'2026-01-01T00:00:00Z');
 const request=x.request({type:'reply_to_message',target_message_id:target,direction:'表示理解',direction_source:'direct_input'});await assert.rejects(x.build(request),/reply_context_unavailable/);
 assert.equal((await x.f.client.query("SELECT to_regclass('public.model_call_receipt') IS NOT NULL AS migrated")).rows[0].migrated,true,'正式migrator必须建立110模型回执表');
 const host=await startReplyServiceHost(t,{name:x.f.client.database,user:x.f.client.user,close:()=>x.f.close()});x.external();await assert.rejects(host.request('/generate',{id:randomUUID(),scope:x.scope,body:request}),/reply_context_unavailable/);assert.equal(host.requests.length,0);
});

test('目标整条8000边界与旧冻结分离：hidden全ID复验，可见超限拒绝且不裁原对象',async t=>{
 const x=await fixture(t),target=await x.message('a','2026-01-01T00:00:00Z');
 const targetInput=x.request({type:'reply_to_message',target_message_id:target,direction:'表示理解',direction_source:'direct_input'});
 const row=(await readContextMessages(x.f.client,{owner_id:x.scope.owner_id,contact_id:x.scope.contact_id},{ids:[target],target}))[0],length=8001-measureReplyMessageWindow([row]).input_tokens;
 await x.f.client.query('UPDATE message SET text_content=$2 WHERE id=$1',[target,'a'.repeat(length)]);
 const exact=await x.build(targetInput);assert.equal(Buffer.byteLength(JSON.stringify(projectedMessages(exact))),8000);
 await x.f.client.query('UPDATE message SET text_content=$2 WHERE id=$1',[target,'a'.repeat(length+1)]);await assert.rejects(x.build(targetInput));
 const fresh=(await readContextMessages(x.f.client,{owner_id:x.scope.owner_id,contact_id:x.scope.contact_id},{ids:[target],target}))[0],frozen={...exact.context,current_text:fresh.text,evidence:[fresh]};const before=structuredClone(frozen);
 await assert.rejects(new PostgresReplyContext(x.f.client,{overview:false}).validateCurrent(frozen),/预算/);assert.deepEqual(frozen,before);
 frozen.command=x.request();frozen.current_text='合成问候';
 for(const reason of ['同一联系人范围内的近期消息。','待回复消息。','旧标签未知时保守计入']){frozen.evidence[0].selection_reason=reason;assert.throws(()=>requireReplyMessageWindowBudget(frozen),/预算/);}
 frozen.evidence[0].selection_reason='本轮时间顺序查询返回的联系人历史消息。';assert.throws(()=>requireReplyMessageWindowBudget(frozen),/预算/);frozen.tool_calls=[{tool_name:'conversation_query',status:'succeeded',evidence_ids:[target],latency_ms:0}];assert.doesNotThrow(()=>requireReplyMessageWindowBudget(frozen));frozen.tool_calls=[];
 frozen.evidence[0].model_visible=false;await new PostgresReplyContext(x.f.client,{overview:false}).validateCurrent(frozen);
 await x.f.client.query("UPDATE message SET text_content='已改变' WHERE id=$1",[target]);await assert.rejects(new PostgresReplyContext(x.f.client,{overview:false}).validateCurrent(frozen));
});

test('旧v2/r15超限可见近期快照完整保留，真实service拒绝且零HTTP',async t=>{
 const x=await fixture(t),{f,scope}=x,message=await x.message('中文😀'.repeat(2000),'2026-01-01T00:00:00Z'),session=randomUUID(),turn=randomUUID(),version=randomUUID(),input=x.request();
 await f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',[session,scope.owner_id,scope.contact_id]);
 await f.client.query('INSERT INTO assistant_session_turn(id,session_id,owner_id,contact_id,input_version_id,idempotency_key,conversation_binding_id,input_digest,input_payload)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[turn,session,scope.owner_id,scope.contact_id,version,input.idempotency_key,scope.conversation_binding_id,createHash('sha256').update(scope.conversation_binding_id+':'+normalizeReplyInput(input)).digest('hex'),{content:input.content}]);
 await f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,turn_id)VALUES($1,$2,$3,$4,$5,'generation',$6)",[version,session,scope.owner_id,scope.contact_id,scope.conversation_binding_id,turn]);await f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[session,version]);
 assert.equal((await f.client.query("SELECT to_regclass('public.model_call_receipt') IS NOT NULL AS migrated")).rows[0].migrated,true,'正式migrator必须建立110模型回执表');
 const host=await startReplyServiceHost(t,{name:f.client.database,user:f.client.user,close:()=>f.close()});x.external();await host.request('/prepare',{id:randomUUID(),scope,body:input});assert.equal(host.requests.length,0);
 const prior=(await f.client.query('SELECT prepared_context FROM assistant_session_turn WHERE id=$1',[turn])).rows[0].prepared_context,dataScope={owner_id:scope.owner_id,contact_id:scope.contact_id},decoded=decodePreparedContext(prior,input,dataScope,scope.conversation_binding_id);
 // 合成旧合法格式：旧近期窗口未执行8k限制，保留实际当前来源及完整正文，不改真实资料绕过资格。
 const {freshness_sha256,...evidence}=(await readContextMessages(f.client,dataScope,{ids:[message]}))[0];assert.equal(evidence.selection_reason,'同一联系人范围内的近期消息。');decoded.evidence.push(evidence);const legacy=encodePreparedContext(decoded);
 await f.client.query('UPDATE assistant_session_turn SET prepared_context=$2,dependency_ids=ARRAY(SELECT DISTINCT unnest(dependency_ids||$3::uuid[])) WHERE id=$1',[turn,JSON.stringify(legacy),[message,...evidence.source_ids]]);
 await assert.rejects(host.request('/generate',{id:randomUUID(),scope,body:input}),/reply_context_unavailable/);assert.equal(host.requests.length,0);assert.deepEqual((await f.client.query('SELECT prepared_context FROM assistant_session_turn WHERE id=$1',[turn])).rows[0].prepared_context,legacy);
});
