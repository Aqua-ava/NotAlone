import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {startReplyServiceHost,sendEvents,useTool} from './reply-service-runtime-support.mjs';
import {parseReplyRequest,normalizeReplyInput} from '../src/reply/generation/reply-contract.ts';

function generationPayload(body){
 for(const message of body.messages??[]){
  const blocks=typeof message.content==='string'?[{text:message.content}]:message.content??[];
  for(const block of blocks){
   if(typeof block.text!=='string')continue;
   let value;try{value=JSON.parse(block.text.split('\n\n本轮候选数量上限')[0]);}catch{continue;}
   if(value?.fidelity_contract&&Array.isArray(value.evidence))return value;
  }
 }
 assert.fail('实际供应商请求缺少生成输入');
}

test('实际生成逐字保留草稿、用户要求、补充聊天及对应来源中的业务JSON',{timeout:60000},async t=>{
 const f=await createStorageFixture(),owner=randomUUID(),contact=randomUUID(),binding=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成正文本人')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成正文联系人')",[contact,owner]);
 await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id)VALUES($1,$2,$3)',[binding,owner,contact]);
 const scope={owner_id:owner,contact_id:contact,conversation_binding_id:binding,confirmation:'manual'};
 const raw='{ "order_id": "INV-42", "message_id": "business-message-7", "number": 9007199254740993, "message": "请原样核对编号" }';
 let payload;
 const host=await startReplyServiceHost(t,{name:f.client.database,user:f.client.user,close:()=>f.close()},(_req,res,requests,events)=>{
  payload=generationPayload(requests.at(-1).body);
  useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'请帮我核对这个编号。',basis:'按本次输入表达',citation_ids:[payload.evidence.find(e=>e.kind==='user_draft').evidence_id],risk_notes:[]}]});
  sendEvents(res,events);
 });
 await host.request('/configure-model',{physical_limit:4});
 const output=await host.request('/generate',{id:randomUUID(),scope,body:{contact_id:contact,idempotency_key:randomUUID(),skill_disabled:true,
  content:{type:'rewrite_draft',input_kind:'workspace',workspace_action:'express',draft_text:raw,user_instruction:raw,context_text:raw,include_relationship_context:true}}});
 assert.equal(output.candidates.length,1);
 for(const field of ['draft_text','user_instruction','context_text'])assert.equal(payload[field],raw,field);
 for(const kind of ['user_draft','user_current_chat'])assert.equal(payload.evidence.find(e=>e.kind===kind).text,raw,kind);
 assert.ok(payload.evidence.every(e=>/^c\d+$/.test(e.evidence_id)));
 for(const id of [owner,contact,binding])assert.equal(JSON.stringify(host.requests.at(-1).body).includes(id),false);
});

test('实际历史讨论DTO投影消息身份并逐字保留其中的用户JSON',{timeout:60000},async t=>{
 const f=await createStorageFixture();let handedOff=false;t.after(async()=>{if(!handedOff)await f.close();});
 const owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),session=randomUUID(),source=randomUUID(),message=randomUUID();
 const raw='{ "order_id": "INV-42", "number": 9007199254740993 }';
 await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成讨论本人')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成讨论联系人')",[contact,owner]);
 await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id)VALUES($1,$2,$3)',[binding,owner,contact]);
 await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'manual','合成讨论来源',$4,1)",[source,owner,contact,'a'.repeat(64)]);
 await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,'contact','text',$4,'2026-10-24T01:02:03Z')",[message,owner,contact,raw]);
 await f.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,$4,'source_document',$5,'synthetic:1','{}')",[randomUUID(),message,owner,contact,source]);
 await f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',[session,owner,contact]);
 const discussion={type:'response_exploration',target_message_id:message,correction:raw,requirements:raw,answer:raw,confirmed_intent:'',skill_mode:'disabled',skill_version_id:null};
 await f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,content,dependency_ids)VALUES($1,$2,$3,$4,$5,'response_exploration',$6,$7)",[randomUUID(),session,owner,contact,binding,discussion,[source,message]]);
 const body=parseReplyRequest({contact_id:contact,idempotency_key:randomUUID(),skill_disabled:true,content:{type:'rewrite_draft',input_kind:'workspace',workspace_action:'express',draft_text:'请帮我核对编号',include_relationship_context:true}});
 const turn=randomUUID(),input=randomUUID();
 await f.client.query('INSERT INTO assistant_session_turn(id,session_id,owner_id,contact_id,input_version_id,idempotency_key,conversation_binding_id,input_digest,input_payload)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[turn,session,owner,contact,input,body.idempotency_key,binding,createHash('sha256').update(binding+':'+normalizeReplyInput(body)).digest('hex'),{content:body.content}]);
 await f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,turn_id)VALUES($1,$2,$3,$4,$5,'generation',$6)",[input,session,owner,contact,binding,turn]);
 await f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[session,input]);
 let payload;
 const host=await startReplyServiceHost(t,{name:f.client.database,user:f.client.user,close:()=>f.close()},(_req,res,requests,events)=>{
  payload=generationPayload(requests.at(-1).body);
  useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'请帮我核对编号。',basis:'按本次意愿表达',citation_ids:[payload.evidence.find(e=>e.kind==='user_draft').evidence_id],risk_notes:[]}]});sendEvents(res,events);
 });handedOff=true;
 await host.request('/configure-model',{physical_limit:4});
 const output=await host.request('/generate',{id:randomUUID(),scope:{owner_id:owner,contact_id:contact,conversation_binding_id:binding,confirmation:'manual'},body});
 assert.equal(output.candidates.length,1);
 const projected=JSON.parse(payload.assistant_discussion.items.find(i=>i.kind==='discussion_input').text);
 assert.equal(projected.correction,raw);assert.equal(projected.requirements,raw);assert.equal(projected.answer,raw);
 assert.match(projected.target_message_id,/^[cr]\d+$/);
 for(const id of [owner,contact,binding,session,source,message])assert.equal(JSON.stringify(host.requests).includes(id),false);
});
