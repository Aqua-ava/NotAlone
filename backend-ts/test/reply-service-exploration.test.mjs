import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {readFile} from 'node:fs/promises';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {normalizeReplyInput,parseReplyRequest} from '../src/reply-contract.ts';
import {startReplyServiceHost,sendEvents,useTool} from './reply-service-runtime-support.mjs';
import {decodePreparedContext} from '../src/reply-prepared-codec.ts';
async function setup(t,withMemory=false,sharedFixture){
 const f=sharedFixture??await createStorageFixture();const owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),session=randomUUID(),original=randomUUID(),turn=randomUUID(),current=randomUUID(),task=randomUUID(),selection=randomUUID(),source=randomUUID(),message=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成人')",[owner]);await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[binding,owner,contact]);
 await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','合成来源',$4,1)",[source,owner,contact,source.replaceAll('-','').repeat(2)]);
 await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text','合成探索原话','2026-01-01T01:02:03.123456Z')",[message,owner,contact]);await f.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,$4,'source_document',$5,'line:1','{}')",[randomUUID(),message,owner,contact,source]);
 const memory=randomUUID();if(withMemory)await f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method) VALUES($1,$2,$3,'喜欢清淡口味','preference','other',$4,'manual')",[memory,owner,contact,[message]]);
 if(withMemory)await f.client.query('UPDATE confirmed_memory SET event=$2,conditions=$3 WHERE id=$1',[memory,{version:1,stage:'planned',stage_evidence:[{message_id:message,char_start:0,char_end:2}],stage_verified:true,occurrence_start:null,occurrence_end:null,occurrence_evidence:[],occurrence_verified:false},{version:1,items:[{text:'有时间时',evidence:[{message_id:message,char_start:0,char_end:2}],source_supported:true}]}]);
 const root=new URL('../../',import.meta.url).pathname;
 const snapshots=JSON.parse(execFileSync(homedir()+'/miniconda3/envs/NotAlone/bin/python',['-c',`import json,sys
from uuid import UUID
from notalone.scopes import ContactScope
from notalone.persistence.retrieval import PostgresRetrieval
from notalone.reply.exploration_context import ExplorationEvidence
s=ContactScope(UUID(sys.argv[2]),UUID(sys.argv[3]));r=PostgresRetrieval('host=/tmp dbname='+sys.argv[1]);rows=r.search_messages(scope=s,target_message_id=UUID(sys.argv[4]),limit=1,timeout_ms=1000)
if sys.argv[5]=='yes': rows=(*rows,*r.search_confirmed_memories(scope=s,memory_ids=(UUID(sys.argv[6]),)))
print(json.dumps([ExplorationEvidence._snapshot(x).storage_payload for x in rows],ensure_ascii=False))`,f.client.database,owner,contact,message,withMemory?'yes':'no',memory],{env:{...process.env,PYTHONPATH:root+'/backend/src',NOTALONE_DISABLE_DOTENV:'1'},encoding:'utf8'}));assert.equal(snapshots.length,withMemory?2:1);
 const input=parseReplyRequest({contact_id:contact,idempotency_key:randomUUID(),content:{type:'initiate_conversation',purpose:'合成问候',purpose_source:'confirmed_suggestion'},skill_disabled:true,suggestion:{task_id:task,input_version:original,suggestion_id:selection}}),scope={owner_id:owner,contact_id:contact,conversation_binding_id:binding,confirmation:'manual'};
 const payload={type:'purpose_exploration',purpose_hint:'合成方向',correction:'',requirements:'',answer:'',confirmed_intent:'',skill_mode:'disabled',skill_version_id:null,skill_selection_complete:true};
 await f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id) VALUES($1,$2,$3)',[session,owner,contact]);
 await f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,content,dependency_ids) VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6,$7)",[original,session,owner,contact,binding,payload,[source,message]]);
 await f.client.query("INSERT INTO reply_exploration(id,owner_id,contact_id,session_id,input_version_id,operation_key,operation_digest,request_key,input_payload,result_payload,snapshots,intent_snapshots,source_ids,skill_library_revision,state,selected_intent,selection_id,selection_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,0,'selected','合成问候',$13,'confirmed_suggestion')",[task,owner,contact,session,original,randomUUID(),'a'.repeat(64),input.idempotency_key,payload,{question:null,ambiguities:[],options:[{suggestion_id:selection,intent:'合成问候',pause:false}]},JSON.stringify(snapshots),[source,message],selection]);
 await f.client.query('INSERT INTO assistant_session_turn(id,session_id,owner_id,contact_id,input_version_id,idempotency_key,conversation_binding_id,input_digest,input_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[turn,session,owner,contact,current,input.idempotency_key,binding,createHash('sha256').update(binding+':'+normalizeReplyInput(input)).digest('hex'),{content:{...input.content,suggestion:input.suggestion}}]);await f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,turn_id) VALUES($1,$2,$3,$4,$5,'generation',$6)",[current,session,owner,contact,binding,turn]);await f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[session,current]);

 return {f,input,scope,task,original,current,source,message,session,snapshots,turn};
}
async function recentMessages(x){const {f,scope}=x;
 for(let i=0;i<55;i++){const id=randomUUID();await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,'contact','text','近期合成消息',clock_timestamp())",[id,scope.owner_id,scope.contact_id]);await f.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,$4,'source_document',$5,$6,'{}')",[randomUUID(),id,scope.owner_id,scope.contact_id,x.source,'recent:'+i]);}
}
test('真实探索选择经官方零HTTP准备冻结原根，再生成；变更原根禁止出站',{timeout:60000},async t=>{
 const x=await setup(t),{f,scope,input}=x;let handedOff=false;t.after(async()=>{if(!handedOff)await f.close();});
 assert.equal((await f.client.query("SELECT to_regclass('public.model_call_receipt') IS NOT NULL AS migrated")).rows[0].migrated,true,'正式migrator必须建立110模型回执表');
 // 新消息使探索旧根退出实际生成窗口，验证capture而非碰巧被近期检索选中。
 await recentMessages(x);
 const host=await startReplyServiceHost(t,{name:f.client.database,user:f.client.user,close:()=>f.close()},(_req,res,requests,events)=>{
  const body=JSON.stringify(requests.at(-1).body);assert.ok(!body.includes(x.message),'隐藏原根不能出站');
  let evidence=[];const visit=v=>{if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object'){if(Array.isArray(v.evidence))evidence.push(...v.evidence);for(const[k,w]of Object.entries(v))if(k!=='evidence')visit(w);}else if(typeof v==='string'){try{visit(JSON.parse(v));}catch{const a=v.indexOf('{'),b=v.lastIndexOf('}');if(a>=0&&b>a)try{visit(JSON.parse(v.slice(a,b+1)));}catch{}}}};visit(requests.at(-1).body);assert.ok(evidence.length);
  useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'最近怎么样',basis:'本次确认意愿',citation_ids:[evidence[0].evidence_id],risk_notes:[]}]});sendEvents(res,events);
 });
 handedOff=true;
 await host.request('/prepare',{id:randomUUID(),scope,body:input});assert.equal(host.requests.length,0);
 const encoded=(await f.client.query('SELECT prepared_context FROM assistant_session_turn WHERE id=$1',[x.turn])).rows[0].prepared_context;assert.equal(encoded.version,2);const restored=decodePreparedContext(encoded,input,{owner_id:scope.owner_id,contact_id:scope.contact_id},scope.conversation_binding_id);assert.equal(restored.evidence.find(e=>e.evidence_id===x.message).model_visible,false);
 const result=await host.request('/generate',{id:randomUUID(),scope,body:input});assert.equal(result.candidates.length,1);assert.equal(host.requests.length,1);
 assert.deepEqual((await f.client.query('SELECT prepared_context FROM assistant_session_turn WHERE id=$1',[x.turn])).rows[0].prepared_context,encoded);
 const y=await setup(t,false,f);await recentMessages(y);await host.request('/prepare',{id:randomUUID(),scope:y.scope,body:y.input});assert.equal(host.requests.length,1);
 const secondEncoded=(await f.client.query('SELECT prepared_context FROM assistant_session_turn WHERE id=$1',[y.turn])).rows[0].prepared_context;assert.equal(decodePreparedContext(secondEncoded,y.input,{owner_id:y.scope.owner_id,contact_id:y.scope.contact_id},y.scope.conversation_binding_id).evidence.find(e=>e.evidence_id===y.message).model_visible,false);
 await f.client.query("UPDATE message SET text_content='原依据已改写' WHERE id=$1",[y.message]);await assert.rejects(host.request('/generate',{id:randomUUID(),scope:y.scope,body:y.input}));assert.equal(host.requests.length,1);
 await f.client.query("UPDATE message SET text_content='合成探索原话' WHERE id=$1",[y.message]);
 const retryState=(await f.client.query('SELECT state FROM reply_exploration WHERE id=$1',[y.task])).rows[0];assert.equal(retryState.state,'redacted');
 const baseline=JSON.parse(execFileSync(homedir()+'/miniconda3/envs/NotAlone/bin/python',['-c',`import json,sys,psycopg
from psycopg.rows import dict_row
from uuid import UUID
from notalone.scopes import ContactScope
from notalone.persistence.explored_generation import read_explored_generation
from notalone.reply.interface import GenerateReply,InitiateConversation,ConfirmedDirection,DirectionSource,SuggestionReference,NoSkill
p=json.loads(sys.argv[2]);s=ContactScope(UUID(p['owner']),UUID(p['contact']));ref=SuggestionReference(UUID(p['task']),UUID(p['original']),UUID(p['selection']))
command=GenerateReply(UUID(p['key']),s,UUID(p['binding']),InitiateConversation(ConfirmedDirection('合成问候',DirectionSource.CONFIRMED_SUGGESTION,ref)),skill=NoSkill())
with psycopg.connect('host=/tmp dbname='+sys.argv[1],row_factory=dict_row) as c:
 try:
  read_explored_generation(c,s,None,command,generation_required=True)
  print(json.dumps({'accepted':True}))
 except Exception as e:
  print(json.dumps({'accepted':False,'error':str(e),'type':type(e).__name__,'reason':getattr(e,'reason',None)},ensure_ascii=False))
`,f.client.database,JSON.stringify({owner:y.scope.owner_id,contact:y.scope.contact_id,binding:y.scope.conversation_binding_id,task:y.task,original:y.original,selection:y.input.suggestion.suggestion_id,key:y.input.idempotency_key})],{env:{...process.env,PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname,NOTALONE_DISABLE_DOTENV:'1'},encoding:'utf8'}));
 assert.equal(baseline.accepted,false);assert.equal(baseline.type,'AssistantSessionRejected');assert.equal(baseline.reason,'exploration_stale');await assert.rejects(host.request('/generate',{id:randomUUID(),scope:y.scope,body:y.input}),/exploration_stale/);assert.equal(host.requests.length,1);
});
