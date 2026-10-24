import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setup} from './reply-assistant-erasure-support.mjs';
import {ReplyAssistantGuards} from '../src/reply-assistant-guards.ts';
import * as source from '../src/reply-source-guards.ts';
import {PostgresReplyDiscussionContext,assistantDiscussionPayload,continuationReferencePayload} from '../src/reply-discussion-context.ts';
import {fingerprint} from '../src/reply-assistant-erasure.ts';
function service(x){let guards;const ports={...source,requireReplySourcesCurrent:(c,s,r,h)=>source.requireReplySourcesCurrent(c,s,r,h,(c,s,r)=>guards.requireReplyDiscussionById(c,s,r)),requireCurrentReplyMemory:async()=>{},requireSavedSkillPolicy:async()=>{},requireActiveBinding:async()=>x.binding,navigationDependencyIds:()=>[]};guards=new ReplyAssistantGuards(ports);return new PostgresReplyDiscussionContext({guards,ports});}
async function request(x,g){const r=(await x.f.client.query('SELECT * FROM reply_request WHERE id=$1',[g.request])).rows[0];return {...r,request_id:r.id};}
test('实际PG完整历史保留旧用户输入，当前输入不重复进入历史',async t=>{
 const x=await setup(t),old=await x.generation(),current=await x.generation(),s=service(x),r=await request(x,current);
 const discussion=await s.read(x.f.client,r),payload=assistantDiscussionPayload(discussion);
 assert.equal(payload.weight,'low');assert.equal(payload.items.length,1);assert.equal(payload.items[0].input_version_id,old.input);assert.equal(payload.items[0].is_sent,false);
 assert.equal(JSON.parse(payload.items[0].text).content.text,'合成输入');await s.validateCurrent(x.f.client,r,discussion);
});
async function candidate(x,g){const id=randomUUID(),group=[{message_id:randomUUID(),text:'合成原版'}];await x.f.client.query("UPDATE reply_request SET state='completed',context_snapshot='{}',skill_library_revision=0 WHERE id=$1",[g.request]);await x.f.client.query("UPDATE assistant_session_turn SET state='completed' WHERE id=$1",[g.turn]);await x.f.client.query("INSERT INTO reply_candidate(id,reply_request_id,owner_id,contact_id,conversation_binding_id,ordinal,candidate_text,basis,risk_notes,message_group)VALUES($1,$2,$3,$4,$5,0,'合成原版','合成依据','[]',$6)",[id,g.request,x.owner,x.contact,x.binding,JSON.stringify(group)]);return {id,group};}
async function original(x,g,c){await x.f.client.query('INSERT INTO assistant_candidate_version(id,owner_id,contact_id,session_id,turn_id,candidate_id,version_number)VALUES($1,$2,$3,$4,$5,$1,0)',[c.id,x.owner,x.contact,g.session,g.turn]);}
async function edit(x,g,c,parent,n){const id=randomUUID(),group=[{message_id:c.group[0].message_id,text:`合成编辑${n}`}];await x.f.client.query('INSERT INTO assistant_candidate_version(id,owner_id,contact_id,session_id,turn_id,candidate_id,version_number,parent_version_id,edit_key,message_group,requirements)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,x.owner,x.contact,g.session,g.turn,c.id,n,parent,randomUUID(),JSON.stringify(group),'更自然']);return {id,group};}
test('原版只读不补版本，完整编辑与选择逐字进入低权重模型投影',async t=>{
 const x=await setup(t),old=await x.generation(),c=await candidate(x,old),g=await x.generation(),s=service(x),r=await request(x,g);
 const initial=await s.read(x.f.client,r);assert.equal(initial.items.filter(i=>i.kind==='candidate_version').length,1);assert.equal((await x.f.client.query('SELECT 1 FROM assistant_candidate_version')).rowCount,0);
 await original(x,old,c);const v1=await edit(x,old,c,c.id,1),v2=await edit(x,old,c,v1.id,2);
 await x.f.client.query('INSERT INTO assistant_candidate_selection(id,owner_id,contact_id,session_id,selection_key,selection_number,candidate_id,version_id)VALUES($1,$2,$3,$4,$5,1,$6,$7)',[randomUUID(),x.owner,x.contact,x.session,randomUUID(),c.id,v1.id]);
 const d=await s.read(x.f.client,r),items=assistantDiscussionPayload(d).items.filter(i=>i.kind==='candidate_version');
 assert.equal(items.length,3);assert.deepEqual(items.map(i=>[i.version_number,i.is_default_display,i.is_explicitly_selected,i.is_sent]),[[0,false,false,false],[1,false,true,false],[2,true,false,false]]);
 const auth={continuation:{candidate_id:c.id,version_id:v1.id},continuation_reference:{candidate_id:c.id,version_id:v1.id,messages:v1.group}},scope={owner_id:x.owner,contact_id:x.contact};
 const selected=continuationReferencePayload(d,scope,c.id,{type:'reply_to_message'},auth);assert.deepEqual(selected.messages,v1.group);assert.equal(selected.weight,'low');
 const draft=continuationReferencePayload(d,scope,c.id,{type:'rewrite_draft',draft_text:'合成编辑1'},auth);assert.equal(draft.is_current_draft,true);assert.equal(Object.hasOwn(draft,'messages'),false);
 assert.throws(()=>continuationReferencePayload(d,scope,c.id,{type:'reply_to_message'},{...auth,continuation_reference:{...auth.continuation_reference,messages:c.group}}),{code:'reply_context_invalidated'});
 await edit(x,old,c,v2.id,3);await s.validateCurrent(x.f.client,r,d);
 await x.f.client.query("UPDATE assistant_candidate_version SET requirements='篡改要求' WHERE id=$1",[v1.id]);await assert.rejects(s.validateCurrent(x.f.client,r,d));
});
test('当前指针与绑定变化拒绝，异联系人不能读取讨论',async t=>{
 const x=await setup(t),g=await x.generation(),r=await request(x,g),s=service(x),d=await s.read(x.f.client,r);
 await assert.rejects(s.read(x.f.client,{...r,contact_id:randomUUID()}),{code:'reply_context_invalidated'});
 await assert.rejects(s.read(x.f.client,{...r,conversation_binding_id:randomUUID()}),{code:'reply_context_invalidated'});
 await x.generation();await assert.rejects(s.validateCurrent(x.f.client,r,d),{code:'reply_context_invalidated'});
});
test('失效历史不会进入新模型上下文，已捕获历史失效则拒绝提交',async t=>{
 const x=await setup(t),memory=randomUUID();await x.f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method)VALUES($1,$2,$3,'合成偏好','preference',$4,'manual')",[memory,x.owner,x.contact,[x.contact]]);
 const old=await x.generation([memory]),g=await x.generation(),r=await request(x,g),s=service(x),d=await s.read(x.f.client,r);assert.equal(d.items.length,1);
 await x.f.client.query("UPDATE confirmed_memory SET status='invalidated' WHERE id=$1",[memory]);
 assert.equal((await s.read(x.f.client,r)).items.length,0);await assert.rejects(s.validateCurrent(x.f.client,r,d),{code:'reply_context_invalidated'});
});
test('跨会话携入只采用真实选择版本及完整依赖，伪造指纹不进入模型',async t=>{
 const x=await setup(t),old=await x.generation(),c=await candidate(x,old);await original(x,old,c);const selection=randomUUID(),other=randomUUID(),carry=randomUUID();
 await x.f.client.query('INSERT INTO assistant_candidate_selection(id,owner_id,contact_id,session_id,selection_key,selection_number,candidate_id,version_id)VALUES($1,$2,$3,$4,$5,1,$6,$6)',[selection,x.owner,x.contact,x.session,randomUUID(),c.id]);
 await x.f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id,is_default)VALUES($1,$2,$3,false)',[other,x.owner,x.contact]);
 const origin={type:'candidate_carry',metadata_version:2,origin_owner_id:x.owner,origin_contact_id:x.contact,origin_binding_id:x.binding,origin_session_id:x.session,origin_input_version_id:old.input,origin_turn_id:old.turn,origin_reply_request_id:old.request,origin_candidate_id:c.id,origin_version_id:c.id,origin_selection_id:selection,payload_sha256:fingerprint(c.group)};
 await x.f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,content)VALUES($1,$2,$3,$4,$5,'candidate_carry',$6)",[carry,other,x.owner,x.contact,x.binding,JSON.stringify(origin)]);
 const g=await x.generation([],null,other),r=await request(x,g),s=service(x),d=await s.read(x.f.client,r);assert.equal(d.items.length,1);assert.equal(d.items[0].kind,'candidate_carry');assert.deepEqual(JSON.parse(d.items[0].text),{messages:c.group});await s.validateCurrent(x.f.client,r,d);
 await x.f.client.query('UPDATE assistant_session_input SET content=$2 WHERE id=$1',[carry,JSON.stringify({...origin,payload_sha256:'0'.repeat(64)})]);assert.equal((await s.read(x.f.client,r)).items.length,0);await assert.rejects(s.validateCurrent(x.f.client,r,d));
});
test('普通讨论完整保留且非整数JSON指纹兼容，无锚点仅兼容旧入口',async t=>{
 const x=await setup(t),id=randomUUID(),g=await x.generation(),r=await request(x,g),s=service(x),body='合成讨论'.repeat(1000);
 await x.f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,content)VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6::jsonb)",[id,x.session,x.owner,x.contact,x.binding,'{"type":"purpose_exploration","text":'+JSON.stringify(body)+',"synthetic_number":1.0}']);
 const d=await s.read(x.f.client,r);assert.equal(d.items.length,1);assert.equal(JSON.parse(d.items[0].text).text,body);assert.match(d.items[0].text,/"synthetic_number":1\.0/);await s.validateCurrent(x.f.client,r,d);
 await assert.rejects(s.validateCurrent(x.f.client,r,null),{code:'reply_context_invalidated'});
 const legacy={...r,request_id:randomUUID(),idempotency_key:randomUUID()};await x.f.client.query("INSERT INTO reply_request(id,owner_id,contact_id,conversation_binding_id,idempotency_key,normalized_input,state,attempt,lease_expires_at)VALUES($1,$2,$3,$4,$5,'synthetic','running',1,now()+interval '30 seconds')",[legacy.request_id,x.owner,x.contact,x.binding,legacy.idempotency_key]);assert.equal(await s.read(x.f.client,legacy),null);await s.validateCurrent(x.f.client,legacy,null);
 const tampered={...d,items:d.items.map(i=>({...i,text:'伪造历史'}))};await assert.rejects(s.validateCurrent(x.f.client,r,tampered),{code:'reply_context_invalidated'});
});
test('真实A准备在没有C请求时读取完整讨论与CAS，不创建占位回复',async t=>{
 const x=await setup(t),old=await x.generation(),g=await x.generation(),s=service(x);
 await x.f.client.query('UPDATE assistant_session_turn SET reply_request_id=NULL WHERE id=$1',[g.turn]);await x.f.client.query('DELETE FROM reply_request WHERE id=$1',[g.request]);
 const identity={owner_id:x.owner,contact_id:x.contact,conversation_binding_id:x.binding,idempotency_key:g.key},d=await s.readPreparation(x.f.client,identity);assert.equal(d.items[0].input_version_id,old.input);await s.validatePreparation(x.f.client,identity,d);
 assert.equal((await x.f.client.query('SELECT 1 FROM reply_request WHERE idempotency_key=$1',[g.key])).rowCount,0);
 await x.generation();await assert.rejects(s.validatePreparation(x.f.client,identity,d),{code:'reply_context_invalidated'});await assert.rejects(s.readPreparation(x.f.client,{...identity,idempotency_key:randomUUID()}),{code:'reply_context_invalidated'});
});
