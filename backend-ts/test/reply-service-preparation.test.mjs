import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {startReplyServiceHost,sendEvents,useTool} from './reply-service-runtime-support.mjs';
import {normalizeReplyInput} from '../src/reply-contract.ts';
import {decodePreparedContext} from '../src/reply-prepared-codec.ts';
function evidenceFrom(body){const result=[];const visit=v=>{if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object'){if(Array.isArray(v.evidence))result.push(...v.evidence);for(const [k,x]of Object.entries(v))if(k!=='evidence')visit(x);}else if(typeof v==='string'){try{visit(JSON.parse(v));}catch{const a=v.indexOf('{'),b=v.lastIndexOf('}');if(a>=0&&b>a)try{visit(JSON.parse(v.slice(a,b+1)));}catch{}}}};visit(body);assert.ok(result.length);return result;}
test('官方service真实A准备冻结后生成，无C预检、恢复与失效拒绝',{timeout:60000},async t=>{
 const f=await createStorageFixture();assert.equal((await f.client.query("SELECT to_regclass('public.model_call_receipt') IS NOT NULL AS migrated")).rows[0].migrated,true,'正式migrator必须建立110模型回执表');
 const owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),source=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成本人')",[owner]);await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contact,owner]);await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id)VALUES($1,$2,$3)',[binding,owner,contact]);
 await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'manual','合成资料',$4,2)",[source,owner,contact,source.replaceAll('-','').repeat(2)]);
 const scope={owner_id:owner,contact_id:contact,conversation_binding_id:binding,confirmation:'manual'};
 const addMessage=async text=>{const id=randomUUID();await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,'contact','text',$4,now())",[id,owner,contact,text]);await f.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,$4,'source_document',$5,$6,'{}')",[randomUUID(),id,owner,contact,source,id]);return id;};
 const session=randomUUID();const seed=async()=>{const turn=randomUUID(),version=randomUUID(),body={contact_id:contact,idempotency_key:randomUUID(),content:{type:'rewrite_draft',input_kind:'workspace',workspace_action:'express',draft_text:'明天见',include_relationship_context:true},continued_from_candidate_id:null,skill_version_id:null,suggestion:null,allow_incomplete_history:false,skill_disabled:true,scene:null};await f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[session,owner,contact]);await f.client.query('INSERT INTO assistant_session_turn(id,session_id,owner_id,contact_id,input_version_id,idempotency_key,conversation_binding_id,input_digest,input_payload)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[turn,session,owner,contact,version,body.idempotency_key,binding,createHash('sha256').update(binding+':'+normalizeReplyInput(body)).digest('hex'),JSON.stringify({content:body.content})]);await f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,turn_id)VALUES($1,$2,$3,$4,$5,'generation',$6)",[version,session,owner,contact,binding,turn]);await f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[session,version]);return {body,session,turn,version};};
 const cache=async x=>(await f.client.query('SELECT prepared_context FROM assistant_session_turn WHERE id=$1',[x.turn])).rows[0].prepared_context;
 let modelEvidence=[];const host=await startReplyServiceHost(t,{name:f.client.database,user:f.client.user,close:()=>f.close()},(_req,res,requests,events)=>{modelEvidence=evidenceFrom(requests.at(-1).body);useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'明天见',basis:'本次原句',citation_ids:[modelEvidence[0].evidence_id],risk_notes:[]}]});sendEvents(res,events);});
 await t.test('实际预检零HTTP并冻结证据，重复不覆盖，生成不采纳新到事实',async()=>{
  const original=await addMessage('冻结前的合成事实'),x=await seed(),prepared=await host.request('/prepare',{id:randomUUID(),scope,body:x.body});assert.equal(prepared.receipt.turn_id,x.turn);assert.ok(prepared.input_budget);assert.equal(host.requests.length,0);assert.equal((await f.client.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,0);
  assert.equal((await f.client.query('SELECT count(*)::int n FROM reply_request')).rows[0].n,0);assert.equal((await f.client.query('SELECT count(*)::int n FROM reply_attempt')).rows[0].n,0);const frozen=await cache(x);assert.equal(frozen.version,2);assert.equal(frozen.schema_revision,15);
  const state=decodePreparedContext(frozen,x.body,{owner_id:owner,contact_id:contact},binding),late=await addMessage('准备以后新增不得进入模型的事实');
  await host.request('/prepare',{id:randomUUID(),scope,body:x.body});assert.deepEqual(await cache(x),frozen);assert.equal(host.requests.length,0);
  const result=await host.request('/generate',{id:randomUUID(),scope,body:x.body});assert.equal(result.candidates.length,1);assert.equal(host.requests.length,1);const ids=modelEvidence.map(e=>e.evidence_id);assert.ok(ids.includes(original));assert.ok(!ids.includes(late));assert.deepEqual(new Set(ids),new Set(state.evidence.filter(e=>e.model_visible).map(e=>e.evidence_id)));assert.deepEqual(await cache(x),frozen);
 });
 await t.test('损坏准备与当前输入改版在模型出站前拒绝',async()=>{
  const x=await seed(),before=host.requests.length;await f.client.query('UPDATE assistant_session_turn SET prepared_context=$2 WHERE id=$1',[x.turn,JSON.stringify({version:2,schema_revision:15,context:{}})]);await assert.rejects(host.request('/prepare',{id:randomUUID(),scope,body:x.body}));assert.equal(host.requests.length,before);
  await f.client.query('UPDATE assistant_session_turn SET prepared_context=NULL WHERE id=$1',[x.turn]);await f.client.query('UPDATE assistant_session SET current_input_version_id=NULL WHERE id=$1',[x.session]);await assert.rejects(host.request('/prepare',{id:randomUUID(),scope,body:x.body}));assert.equal(await cache(x),null);assert.equal(host.requests.length,before);
 });
 await t.test('真实预检stream中取消回滚准备且不出站',async()=>{
  const x=await seed(),id=randomUUID(),before=host.requests.length;await host.request('/arm-preflight',{});
  const pending=host.request('/prepare',{id,scope,body:x.body}),rejected=assert.rejects(pending);
  try{await host.request('/wait-preflight');await host.request('/cancel',{id});}finally{await host.request('/release-preflight',{});}
  await rejected;assert.equal(await cache(x),null);assert.equal(host.requests.length,before);assert.equal((await f.client.query('SELECT count(*)::int n FROM reply_request WHERE idempotency_key=$1',[x.body.idempotency_key])).rows[0].n,0);
 });

});
