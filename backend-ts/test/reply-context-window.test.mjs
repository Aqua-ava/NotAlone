import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {PostgresReplyContext} from '../src/reply/context/reply-context.ts';
import {readContextMessages} from '../src/reply/context/reply-context-read.ts';
import {buildReplyPayload} from '../src/reply/generation/reply-payload.ts';
import {parseReplyRequest,normalizeReplyInput} from '../src/reply/generation/reply-contract.ts';
import {decodePreparedContext,encodePreparedContext} from '../src/reply/generation/reply-prepared-codec.ts';
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
test('50条单字中文完整保留，不因近期独立token或字节额度缩减',async t=>{
 const x=await fixture(t),ids=[];
 for(let i=0;i<50;i++)ids.push(await x.message('中',`2026-01-01T00:00:00.${String(i+1).padStart(6,'0')}Z`));
 const built=await x.build(),messages=projectedMessages(built);
 assert.equal(messages.length,50);assert.deepEqual(messages.map(e=>e.evidence_id),ids);
 assert.ok(Buffer.byteLength(JSON.stringify(messages),'utf8')>8000);assert.ok(messages.every(e=>e.text==='中'&&e.speaker_role==='contact'&&e.timing.source_time_complete));
 await new PostgresReplyContext(x.f.client,{overview:false}).validateCurrent(built.context);
});
test('长消息整条保留、最多50且显式旧目标优先，hidden固定ID仍全量复验',async t=>{
 const x=await fixture(t),old=await x.message('旧短消息','2026-01-01T00:00:00.000001Z'),text='中😀'.repeat(12000),target=await x.message(text,'2026-01-01T00:00:00.000002Z'),latest=await x.message('最新短消息','2026-01-01T00:00:00.000003Z');
 const initial=projectedMessages(await x.build());assert.deepEqual(initial.map(e=>e.evidence_id),[old,target,latest]);assert.equal(initial[1].text,text);
 for(let i=0;i<55;i++)await x.message('短',`2026-02-01T00:00:${String(i).padStart(2,'0')}Z`);
 const raw=await readContextMessages(x.f.client,{owner_id:x.scope.owner_id,contact_id:x.scope.contact_id});assert.equal(raw.length,50);assert.deepEqual(projectedMessages(await x.build()).map(e=>e.evidence_id),raw.toReversed().map(e=>e.evidence_id));
 const command=x.request({type:'reply_to_message',target_message_id:target,direction:'表示理解',direction_source:'direct_input'}),built=await x.build(command),messages=projectedMessages(built);
 assert.equal(messages.length,50);assert.equal(messages[0].evidence_id,target);assert.equal(messages[0].text,text);assert.equal(built.context.current_text,text);await new PostgresReplyContext(x.f.client,{overview:false}).validateCurrent(built.context);
 const ids=(await x.f.client.query('SELECT id FROM message WHERE owner_id=$1 AND contact_id=$2',[x.scope.owner_id,x.scope.contact_id])).rows.map(e=>e.id),full=await readContextMessages(x.f.client,{owner_id:x.scope.owner_id,contact_id:x.scope.contact_id},{ids,limit:ids.length}),frozen=(await x.build()).context;
 frozen.evidence=full;const before=structuredClone(frozen);await assert.rejects(new PostgresReplyContext(x.f.client,{overview:false}).validateCurrent(frozen),/50条/);assert.deepEqual(frozen,before);
 frozen.evidence=full.map(e=>({...e,model_visible:false}));await new PostgresReplyContext(x.f.client,{overview:false}).validateCurrent(frozen);await x.f.client.query("UPDATE message SET text_content='隐藏原根已改变' WHERE id=$1",[old]);await assert.rejects(new PostgresReplyContext(x.f.client,{overview:false}).validateCurrent(frozen));
});
test('旧v2/r15大段近期快照可恢复准备且不改原冻结，零HTTP和零回执',async t=>{
 const x=await fixture(t),{f,scope}=x,session=randomUUID(),turn=randomUUID(),version=randomUUID(),input=x.request();
 await f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',[session,scope.owner_id,scope.contact_id]);
 await f.client.query('INSERT INTO assistant_session_turn(id,session_id,owner_id,contact_id,input_version_id,idempotency_key,conversation_binding_id,input_digest,input_payload)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[turn,session,scope.owner_id,scope.contact_id,version,input.idempotency_key,scope.conversation_binding_id,createHash('sha256').update(scope.conversation_binding_id+':'+normalizeReplyInput(input)).digest('hex'),{content:input.content}]);
 await f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,turn_id)VALUES($1,$2,$3,$4,$5,'generation',$6)",[version,session,scope.owner_id,scope.contact_id,scope.conversation_binding_id,turn]);await f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[session,version]);
 const host=await startReplyServiceHost(t,{name:f.client.database,user:f.client.user,close:()=>f.close()});x.external();await host.request('/prepare',{id:randomUUID(),scope,body:input});
 const text='x '.repeat(9000),message=await x.message(text,'2026-01-01T00:00:00Z'),prior=(await f.client.query('SELECT prepared_context FROM assistant_session_turn WHERE id=$1',[turn])).rows[0].prepared_context,decoded=decodePreparedContext(prior,input,{owner_id:scope.owner_id,contact_id:scope.contact_id},scope.conversation_binding_id);
 const {freshness_sha256,...evidence}=(await readContextMessages(f.client,{owner_id:scope.owner_id,contact_id:scope.contact_id},{ids:[message]}))[0];decoded.evidence.push(evidence);const legacy=encodePreparedContext(decoded);
 await f.client.query('UPDATE assistant_session_turn SET prepared_context=$2,dependency_ids=ARRAY(SELECT DISTINCT unnest(dependency_ids||$3::uuid[])) WHERE id=$1',[turn,JSON.stringify(legacy),[message,...evidence.source_ids]]);
 const result=await host.request('/prepare',{id:randomUUID(),scope,body:input});assert.equal(result.receipt.turn_id,turn);assert.equal(host.requests.length,0);assert.equal((await f.client.query('SELECT count(*) AS count FROM model_call_receipt')).rows[0].count,'0');assert.deepEqual((await f.client.query('SELECT prepared_context FROM assistant_session_turn WHERE id=$1',[turn])).rows[0].prepared_context,legacy);
});
test('解除近期独立8k后完整请求预算仍在官方service出站前拒绝且零回执',async t=>{
 const x=await fixture(t);await x.message('中'.repeat(70000),'2026-01-01T00:00:00Z');const built=await x.build();assert.equal(projectedMessages(built)[0].text.length,70000);
 const host=await startReplyServiceHost(t,{name:x.f.client.database,user:x.f.client.user,close:()=>x.f.close()});x.external();await assert.rejects(host.request('/generate',{id:randomUUID(),scope:x.scope,body:x.request()}),/input_budget_exceeded/);assert.equal(host.requests.length,0);assert.equal((await x.f.client.query('SELECT count(*) AS count FROM model_call_receipt')).rows[0].count,'0');
});
