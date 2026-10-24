import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {ReplyPreparedContexts} from '../src/reply-prepared-context.ts';
import {createReplyGenerationGuards,isLegacyEmptyPreferences} from '../src/reply-generation-guards.ts';
import {PostgresSkillPort} from '../src/skill-port.ts';
import {SkillFiles} from '../src/skill-files.ts';
import {createReplySkillGuards} from '../src/reply-skill-guards.ts';
import {normalizeReplyInput} from '../src/reply-contract.ts';
import {stringifyJson} from '../src/host-json.ts';
import {ReplyPreparation} from '../src/reply-preparation.ts';
import {PostgresReplyStore} from '../src/reply-store.ts';
import {requireReplyScope} from '../src/reply-scope.ts';
async function setup(t,history=false){
 const f=await createStorageFixture();t.after(()=>f.close());const owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),session=randomUUID(),turn=randomUUID(),version=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成人')",[owner]);await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[binding,owner,contact]);
 const transaction=async fn=>{await f.client.query('BEGIN');try{const result=await fn(f.client);await f.client.query('COMMIT');return result;}catch(e){await f.client.query('ROLLBACK');throw e;}};
 const command={contact_id:contact,idempotency_key:randomUUID(),content:{type:'rewrite_draft',input_kind:history?'workspace':'draft',...(history?{workspace_action:'express'}:{}),draft_text:'明天见',include_relationship_context:history},continued_from_candidate_id:null,skill_version_id:null,suggestion:null,allow_incomplete_history:false,skill_disabled:true,scene:null},scope={owner_id:owner,contact_id:contact,conversation_binding_id:binding,confirmation:'manual'},identity={...scope,idempotency_key:command.idempotency_key};
 await f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id) VALUES($1,$2,$3)',[session,owner,contact]);
 await f.client.query('INSERT INTO assistant_session_turn(id,session_id,owner_id,contact_id,input_version_id,idempotency_key,conversation_binding_id,input_digest,input_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[turn,session,owner,contact,version,command.idempotency_key,binding,createHash('sha256').update(binding+':'+normalizeReplyInput(command)).digest('hex'),JSON.stringify({content:command.content})]);
 await f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,turn_id) VALUES($1,$2,$3,$4,$5,'generation',$6)",[version,session,owner,contact,binding,turn]);await f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[session,version]);
 const skillPort=new PostgresSkillPort({read:transaction},f.directory+'/skills'),controller=createReplyGenerationGuards({scope,input:command,skillPort,savedSkill:createReplySkillGuards({files:new SkillFiles(f.directory+'/skills')})});
 return {f,command,identity,scope,turn,transaction,controller,adapter:new ReplyPreparedContexts({command,discussion:controller.discussion,assistant:controller.assistant})};
}
test('真实无C准备v2/r15可由旧Python读取，恢复保留证据/偏好与历史边界',async t=>{
 const x=await setup(t),pref=randomUUID();await x.f.client.query("INSERT INTO expression_preference(id,owner_id,text_content,confirmed_operation_key,origin_kind) VALUES($1,$2,'合成简短表达',$3,'manual')",[pref,x.scope.owner_id,randomUUID()]);
 const state=await x.transaction(c=>x.adapter.build(c,x.identity,[])),encoded=x.adapter.encode(state);
 assert.equal((await x.f.client.query('SELECT count(*)::int n FROM reply_request')).rows[0].n,0);assert.equal(state.discussion.items.length,0);assert.ok(x.adapter.dependencies(state).includes(pref));
 const root=new URL('../../',import.meta.url).pathname;
 const roundtrip=execFileSync(homedir()+'/miniconda3/envs/NotAlone/bin/python',['-c',`import json,sys
from uuid import UUID
from dataclasses import replace
from tests.unit.reply.test_input_budget_runtime import prepared_context
from notalone.reply.prepared_context_codec import encode_context,decode_context
from notalone.scopes import ContactScope
v=json.load(sys.stdin);p=v['payload'];i=v['identity'];command=replace(prepared_context().command,scope=ContactScope(UUID(i['owner_id']),UUID(i['contact_id'])),conversation_binding_id=UUID(i['conversation_binding_id']),idempotency_key=UUID(i['idempotency_key']))
print(json.dumps(encode_context(decode_context(p,command)),ensure_ascii=False))`],{input:stringifyJson({payload:encoded,identity:x.identity}),env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:root+'/backend/src:'+root+'/backend'},encoding:'utf8'});
 assert.deepEqual(JSON.parse(roundtrip),JSON.parse(stringifyJson(encoded)));
 const restored=await x.transaction(c=>x.adapter.restore(c,x.identity,encoded));assert.deepEqual(x.adapter.encode(restored),encoded);assert.deepEqual(restored.context.evidence,state.context.evidence);
 const legacy=structuredClone(encoded);legacy.context.expression_preferences=[];legacy.context.expression_preference_revision=null;
 const legacyState=await x.transaction(c=>x.adapter.restore(c,x.identity,legacy));assert.ok(isLegacyEmptyPreferences(legacyState.preferences));assert.equal(x.adapter.encode(legacyState).context.expression_preference_revision,null);
 await x.f.client.query("UPDATE expression_preference SET text_content='变化后表达',revision=revision+1 WHERE id=$1",[pref]);await assert.rejects(x.transaction(c=>x.adapter.restore(c,x.identity,encoded)));
});
test('A输入失效不得恢复，超过500冻结消息拒绝',async t=>{
 const x=await setup(t),state=await x.transaction(c=>x.adapter.build(c,x.identity,[]));
 await assert.rejects(x.transaction(c=>x.adapter.build(c,x.identity,Array.from({length:501},()=>randomUUID()))));
 await x.f.client.query('UPDATE assistant_session SET current_input_version_id=NULL WHERE owner_id=$1',[x.scope.owner_id]);await assert.rejects(x.transaction(c=>x.adapter.restore(c,x.identity,x.adapter.encode(state))));
});
test('生成自动消费原A冻结材料，新C只重绑定request且坏cache不降级重建',async t=>{
 const x=await setup(t),state=await x.transaction(c=>x.adapter.build(c,x.identity,[])),encoded=x.adapter.encode(state);
 await x.f.client.query('UPDATE assistant_session_turn SET prepared_context=$2 WHERE id=$1',[x.turn,stringifyJson(encoded)]);
 const store=new PostgresReplyStore({transaction:x.transaction,guards:x.controller.guards}),started=await store.start({...x.scope,idempotency_key:x.command.idempotency_key,normalized_input:normalizeReplyInput(x.command),continued_from_candidate_id:null});
 const request=started.request,service=new ReplyPreparation({transaction:x.transaction,controller:x.controller,requireCurrent:async c=>{await requireReplyScope(c,x.scope,x.command);await store.requireCurrentInTransaction(c,request);}});
 const restored=await x.transaction(c=>service.prepare(c,{request,command:x.command,skillRevision:'0'}));
 assert.equal(restored.context.reply_request_id,request.request_id);assert.notEqual(restored.context.reply_request_id,state.context.reply_request_id);assert.deepEqual(restored.context.evidence,state.context.evidence);
 await store.prepareContext(request,restored.storeContext);const id=randomUUID();await store.save(request,service.finalize(restored),[{candidate_id:id,text:'明天见',basis:'本次原句',citation_ids:[state.context.evidence[0].evidence_id],risk_notes:[],messages:[{message_id:id,text:'明天见'}]}]);
 assert.deepEqual((await x.f.client.query('SELECT prepared_context FROM assistant_session_turn WHERE id=$1',[x.turn])).rows[0].prepared_context,JSON.parse(stringifyJson(encoded)));
 const malformed=structuredClone(encoded);malformed.schema_revision=14;await x.f.client.query('UPDATE assistant_session_turn SET prepared_context=$2 WHERE id=$1',[x.turn,stringifyJson(malformed)]);
 await assert.rejects(x.transaction(c=>x.adapter.restore(c,x.identity,malformed)),/重新准备/);
});
test('恢复仅重绑定冻结消息资格指纹，不纳入新消息且正文变化拒绝',async t=>{
 const x=await setup(t,true),source=randomUUID(),message=randomUUID();
 await x.f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','合成资料',$4,1)",[source,x.scope.owner_id,x.scope.contact_id,source.replaceAll('-','').repeat(2)]);
 const add=async(id,text,index)=>{await x.f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text',$4,'2026-01-01T01:02:03.123456Z')",[id,x.scope.owner_id,x.scope.contact_id,text]);await x.f.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,$4,'source_document',$5,$6,'{}')",[randomUUID(),id,x.scope.owner_id,x.scope.contact_id,source,'line:'+index]);};
 await add(message,'合成冻结原话',1);
 const state=await x.transaction(c=>x.adapter.build(c,x.identity,[message])),encoded=x.adapter.encode(state);assert.ok(state.context.evidence.some(e=>e.evidence_id===message));assert.ok(!stringifyJson(encoded).includes('freshness_sha256'));
 await add(randomUUID(),'新到消息不得重选',2);
 const restored=await x.transaction(c=>x.adapter.restore(c,x.identity,encoded));assert.deepEqual(restored.context.evidence,state.context.evidence);assert.deepEqual(restored.context.history_message_ids,[message]);
 await x.f.client.query("UPDATE message SET text_content='被修订原话' WHERE id=$1",[message]);await assert.rejects(x.transaction(c=>x.adapter.restore(c,x.identity,encoded)),/固定证据/);
});
