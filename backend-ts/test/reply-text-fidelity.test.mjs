import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {startReplyServiceHost,sendEvents,useTool} from './reply-service-runtime-support.mjs';

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
