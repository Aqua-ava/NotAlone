import test from 'node:test';
import assert from 'node:assert/strict';
import {AssistantGenerationLifecycle} from '../src/assistant-generation-lifecycle.ts';
test('公开助手无效声明使用原HTTP错误合同，并在数据库和模型之前拒绝',async()=>{
 const forbidden=async()=>{throw Error('无效声明触达了副作用边界');};
 const lifecycle=new AssistantGenerationLifecycle({transaction:forbidden,skillsRoot:'synthetic-unused',replyService:{prepare:forbidden,generate:forbidden}});
 const scope={owner_id:'00000000-0000-4000-8000-000000000001',contact_id:'00000000-0000-4000-8000-000000000002',conversation_binding_id:'00000000-0000-4000-8000-000000000003',confirmation:'manual'},path=`/api/contacts/${scope.contact_id}/assistant-sessions/00000000-0000-4000-8000-000000000004`;
 for(const [action,body,error] of [
  ['replies/prepare',{contact_id:scope.contact_id,idempotency_key:'invalid',content:{type:'rewrite_draft',draft_text:'合成草稿'}},'assistant_session_request_invalid'],
  ['continue',{idempotency_key:'invalid',expected_input_version_id:scope.contact_id,instruction:'继续',displayed_group:{session_id:scope.owner_id,candidate_group_id:scope.contact_id,candidates:[]}},'assistant_continuation_request_invalid'],
  ['interrupt',{request_key:'invalid',input_version_id:scope.contact_id},'assistant_session_request_invalid'],
 ]){const result=await lifecycle.handle({method:'POST',path:`${path}/${action}`,body,scope,signal:new AbortController().signal});assert.equal(result.status,400);assert.deepEqual(result.payload,{error});}
 await lifecycle.drain();
});
test('异步准备将省略字段与公开默认值视为同一输入，采用声明仍保留原文',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;}),forbidden=async()=>{throw Error('不应执行模型');};
 const lifecycle=new AssistantGenerationLifecycle({transaction:async()=>{await gate;throw Error('合成数据库中止');},skillsRoot:'synthetic-unused',replyService:{prepare:forbidden,generate:forbidden}});
 const scope={owner_id:'00000000-0000-4000-8000-000000000001',contact_id:'00000000-0000-4000-8000-000000000002',conversation_binding_id:'00000000-0000-4000-8000-000000000003',confirmation:'manual'},path=`/api/contacts/${scope.contact_id}/assistant-sessions/00000000-0000-4000-8000-000000000004/replies/prepare`;
 const input={contact_id:scope.contact_id,idempotency_key:'00000000-0000-4000-8000-000000000005',content:{type:'rewrite_draft',draft_text:'合成草稿'},skill_disabled:true};
 try{
  const send=body=>lifecycle.handle({method:'POST',path,body,scope,signal:new AbortController().signal,respondAsync:true});
  const first=await send(input),same=await send({...input,content:{...input.content,input_kind:'draft',include_relationship_context:false,user_instruction:null,excluded_message_ids:[]}});assert.equal(first.status,202);assert.deepEqual(same,first);
  const adoption={...input,idempotency_key:'00000000-0000-4000-8000-000000000006',expected_input_version_id:'00000000-0000-4000-8000-000000000007',adopt_new_message_id:'00000000-0000-4000-8000-000000000008',content:{type:'rewrite_draft',input_kind:'workspace',workspace_action:'express',draft_text:'合成草稿',include_relationship_context:true}};
  assert.equal((await send(adoption)).status,202);assert.equal((await send({...adoption,content:{...adoption.content,user_instruction:null}})).status,409);
 }finally{release();await lifecycle.drain();}
});
