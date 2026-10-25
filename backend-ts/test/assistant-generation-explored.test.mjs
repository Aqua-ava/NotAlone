import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pureTsFixture} from './pure-ts-runtime-fixture.mjs';
import {startReplyServiceHost,sendEvents,useTool} from './reply-service-runtime-support.mjs';
test('公开探索确认到TS准备/生成/重放及中断后的新执行身份',{timeout:60000},async t=>{
 const fixture=await pureTsFixture(t),owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),source=randomUUID(),message=randomUUID();
 await fixture.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成用户')",[owner]);await fixture.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await fixture.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[binding,owner,contact]);
 await fixture.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','合成资料',$4,1)",[source,owner,contact,'b'.repeat(64)]);
 await fixture.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content) VALUES($1,$2,$3,'contact','text','合成近况消息')",[message,owner,contact]);
 await fixture.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,$4,'source_document',$5,'line:1','{}')",[randomUUID(),message,owner,contact,source]);
 const host=await startReplyServiceHost(t,{name:fixture.client.database,user:fixture.client.user,close:async()=>{}},(_req,res,requests,events)=>{
  const reply=requests.at(-1).body.tools.some(tool=>tool.name==='ReplyRuntimeOutput');
  const text=requests.at(-1).body.messages[0].content[0].text,payload=JSON.parse(text.slice(0,text.lastIndexOf('}')+1)),id=payload.evidence[0].evidence_id;
  useTool(events,reply?'ReplyRuntimeOutput':'ExplorationOutput',reply?{used_skill_version_id:null,candidates:[{text:'明天见',basis:'合成消息',citation_ids:[id],risk_notes:[]}]}:{understanding:'询问近况',ambiguities:[],citation_ids:[id],options:[{intent:'了解近况',label:'关心',reason:'近期原话',citation_ids:[id],recommended:true,pause:false},{intent:'稍后联系',label:'稍后',reason:'由用户决定',citation_ids:[],recommended:false,pause:false}],question:null,current_step:'选择本次意愿',tradeoffs:[]});sendEvents(res,events);
 },{pluginPath:'test/assistant-generation-lifecycle-plugin.ts',environment:{NOTALONE_SYNTHETIC_OWNER:owner,NOTALONE_SYNTHETIC_CONTACT:contact,NOTALONE_SYNTHETIC_BINDING:binding}});
 const {session_id:session}=await host.request(`/api/contacts/${contact}/assistant-session/default`,{}),path=`/api/contacts/${contact}/assistant-sessions/${session}`;
 const open={operation_key:randomUUID(),content:{type:'purpose_exploration',purpose_hint:'了解近况',skill_mode:'disabled'}},task=await host.request(`${path}/explorations`,open);
 const command={input_version_id:task.input_version_id,suggestion_id:task.options[0].suggestion_id,generate:true},confirm=`${path}/explorations/${task.exploration_id}`;
 const ready=await host.request(`${confirm}/prepare-confirm`,command);assert.equal(ready.kind,'prepared');assert.equal(host.requests.length,1);
 const generated=await host.request(`${confirm}/confirm`,command);assert.equal(generated.kind,'generated');assert.equal(generated.turn.state,'completed');assert.equal(generated.turn.turn_id,ready.generation.turn_id);assert.equal(generated.turn.reply.candidates[0].text,'明天见');
 assert.deepEqual(await host.request(`${confirm}/confirm`,command),generated);assert.equal(host.requests.length,2);
 const second=await host.request(`${path}/explorations`,{...open,operation_key:randomUUID(),expected_input_version_id:generated.turn.input_version_id});
 const nextReady=await host.request(`${path}/explorations/${second.exploration_id}/prepare-confirm`,{input_version_id:second.input_version_id,suggestion_id:second.options[0].suggestion_id,generate:true});
 await host.request(`${path}/interrupt`,{request_key:nextReady.generation.request_key,input_version_id:nextReady.generation.input_version_id});
 const retry={original_turn_id:nextReady.generation.turn_id,original_input_version_id:nextReady.generation.input_version_id,request_key:randomUUID()};
 const retried=await host.request(`${path}/retry-interrupted/prepare`,retry),done=await host.request(`${path}/retry-interrupted`,retry);assert.equal(done.turn_id,retried.turn_id);assert.equal(done.state,'completed');assert.notEqual(done.input.content.suggestion.task_id,second.exploration_id);
});
