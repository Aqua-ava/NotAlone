import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {setup} from './reply-assistant-erasure-support.mjs';
import {normalizeReplyInput} from '../src/reply/generation/reply-contract.ts';
import {createReplyGenerationGuards} from '../src/reply/generation/reply-generation-guards.ts';
import {PostgresSkillPort} from '../src/skills/skill-port.ts';
import {SkillFiles} from '../src/skills/skill-files.ts';
import {createReplySkillGuards} from '../src/reply/generation/reply-skill-guards.ts';
import {ReplyPreparedContexts} from '../src/reply/generation/reply-prepared-context.ts';
import {prepareAssistantReply} from '../src/reply/generation/reply-preflight-prepared.ts';
import {PostgresReplyStore} from '../src/reply/generation/reply-store.ts';
import {preparedStoreContext} from '../src/reply/generation/reply-preparation.ts';
async function fixture(t){const x=await setup(t),g=await x.generation();await x.f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id)VALUES($1,$2,$3)',[x.binding,x.owner,x.contact]);const input={contact_id:x.contact,idempotency_key:g.key,content:{type:'rewrite_draft',input_kind:'draft',draft_text:'合成固定草稿',include_relationship_context:false},continued_from_candidate_id:null,skill_version_id:null,suggestion:null,allow_incomplete_history:false,skill_disabled:true,scene:null},scope={owner_id:x.owner,contact_id:x.contact,conversation_binding_id:x.binding,confirmation:'manual'};
 await x.f.client.query('UPDATE assistant_session_turn SET reply_request_id=NULL,prepared_context=NULL,input_payload=$2,input_digest=$3 WHERE id=$1',[g.turn,JSON.stringify({content:input.content}),createHash('sha256').update(x.binding+':'+normalizeReplyInput(input)).digest('hex')]);await x.f.client.query('DELETE FROM reply_request WHERE id=$1',[g.request]);
 const transaction=async fn=>{await x.f.client.query('BEGIN');try{const v=await fn(x.f.client);await x.f.client.query('COMMIT');return v;}catch(e){await x.f.client.query('ROLLBACK');throw e;}},skillPort=new PostgresSkillPort({read:transaction},`${x.f.directory}/skills`),savedSkill=createReplySkillGuards({files:new SkillFiles(`${x.f.directory}/skills`)}),controller=createReplyGenerationGuards({scope,input,skillPort,savedSkill}),prepared=new ReplyPreparedContexts({command:input,assistant:controller.assistant,discussion:controller.discussion});
 return {...x,g,controller,options:{transaction,scope,input,assistant:controller.assistant,prepared,fitBudget:async(state,{frozen})=>({state,budget:{frozen}})}};
}
test('真实A准备v2/r15首次保存及恢复幂等，全程无C和attempt',async t=>{
 const x=await fixture(t),first=await prepareAssistantReply(x.options,new AbortController().signal);assert.equal(first.replayed,false);const saved=(await x.f.client.query('SELECT prepared_context FROM assistant_session_turn WHERE id=$1',[x.g.turn])).rows[0].prepared_context;assert.equal(saved.version,2);assert.equal(saved.schema_revision,15);
 const second=await prepareAssistantReply(x.options,new AbortController().signal);assert.equal(second.replayed,true);assert.equal(second.budget.frozen,true);assert.deepEqual((await x.f.client.query('SELECT prepared_context FROM assistant_session_turn WHERE id=$1',[x.g.turn])).rows[0].prepared_context,saved);
 assert.equal((await x.f.client.query('SELECT 1 FROM reply_request')).rowCount,0);assert.equal((await x.f.client.query('SELECT 1 FROM reply_attempt')).rowCount,0);
});
test('预检后取消与输入改变均不写准备副本，损坏格式不重建',async t=>{
 const x=await fixture(t),controller=new AbortController();await assert.rejects(prepareAssistantReply({...x.options,fitBudget:async state=>{controller.abort();return {state,budget:{}};}},controller.signal));assert.equal((await x.f.client.query('SELECT prepared_context FROM assistant_session_turn WHERE id=$1',[x.g.turn])).rows[0].prepared_context,null);
 await assert.rejects(prepareAssistantReply({...x.options,fitBudget:async state=>{await x.f.client.query('UPDATE assistant_session SET current_input_version_id=NULL WHERE id=$1',[x.session]);return {state,budget:{}};}},new AbortController().signal),{code:'reply_context_invalidated'});
 await x.f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[x.session,x.g.input]);await x.f.client.query("UPDATE assistant_session_turn SET prepared_context='{"+'"version":2,"schema_revision":14,"context":{}'+"}' WHERE id=$1",[x.g.turn]);await assert.rejects(prepareAssistantReply(x.options,new AbortController().signal),{code:'reply_preparation_format_invalid'});
 await x.f.client.query('UPDATE assistant_session_turn SET state=$2,prepared_context=$3 WHERE id=$1',[x.g.turn,'failed',JSON.stringify({version:2,schema_revision:15,context:{}})]);await assert.rejects(prepareAssistantReply(x.options,new AbortController().signal),{code:'reply_preparation_format_invalid'});
});
test('严格旧codec的null空偏好恢复保留null，裸伪造不能绕过当前偏好',async t=>{
 const x=await fixture(t);await prepareAssistantReply(x.options,new AbortController().signal);
 const encoded=(await x.f.client.query('SELECT prepared_context FROM assistant_session_turn WHERE id=$1',[x.g.turn])).rows[0].prepared_context;encoded.context.expression_preference_revision=null;encoded.context.expression_preferences=[];
 await x.f.client.query('UPDATE assistant_session_turn SET prepared_context=$2 WHERE id=$1',[x.g.turn,JSON.stringify(encoded)]);
 await x.f.client.query("INSERT INTO expression_preference(id,owner_id,text_content,confirmed_operation_key,origin_kind)VALUES($1,$2,'后来新增偏好',$3,'manual')",[randomUUID(),x.owner,randomUUID()]);await x.f.client.query('INSERT INTO expression_preference_state(owner_id,revision)VALUES($1,9)',[x.owner]);
 const store=new PostgresReplyStore({transaction:x.options.transaction,guards:x.controller.guards}),started=await store.start({...x.options.scope,idempotency_key:x.g.key,normalized_input:normalizeReplyInput(x.options.input),continued_from_candidate_id:null}),request=started.request;
 const identity={...x.options.scope,idempotency_key:x.g.key},state=await x.options.transaction(c=>x.options.prepared.restore(c,identity,encoded,request.request_id));assert.equal(state.preferences.revision,null);
 assert.throws(()=>x.controller.bindPrepared({...state,preferences:{revision:null,preferences:[]}}),{code:'reply_context_invalidated'});x.controller.bindPrepared(state);
 const context=preparedStoreContext({...state,request,command:x.options.input,contextOptions:x.options.prepared.contextOptions});await store.prepareContext(request,context);
 const id=randomUUID();await store.save(request,context,[{candidate_id:id,text:'合成候选',basis:'原草稿',citation_ids:[state.context.evidence[0].evidence_id],risk_notes:[],messages:[{message_id:id,text:'合成候选'}]}]);
 assert.equal((await x.f.client.query('SELECT expression_preference_revision FROM reply_request WHERE id=$1',[request.request_id])).rows[0].expression_preference_revision,null);assert.equal((await x.f.client.query('SELECT 1 FROM reply_expression_preference_use')).rowCount,0);assert.equal((await store.read(request.request_id,x.options.scope)).result.context_snapshot.expression_preference_revision,null);
});
