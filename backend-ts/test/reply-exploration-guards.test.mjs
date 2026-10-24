import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {createReplyExploredContextValidator} from '../src/reply-exploration-guards.ts';
import {buildReplyPayload} from '../src/reply-payload.ts';
import {PostgresReplyContext} from '../src/reply-context.ts';
import {normalizeReplyInput,parseReplyRequest} from '../src/reply-contract.ts';
async function setup(t,withMemory=false){
 const f=await createStorageFixture();t.after(()=>f.close());const owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),session=randomUUID(),original=randomUUID(),turn=randomUUID(),current=randomUUID(),task=randomUUID(),selection=randomUUID(),source=randomUUID(),message=randomUUID();
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
 const transaction=async fn=>{await f.client.query('BEGIN');try{const r=await fn(f.client);await f.client.query('COMMIT');return r;}catch(e){await f.client.query('ROLLBACK');throw e;}};
 const validator=createReplyExploredContextValidator({scope,input,skillsRoot:f.directory+'/skills'}),context=await transaction(c=>new PostgresReplyContext(c).build({...scope,reply_request_id:randomUUID(),request:input,history_message_ids:[]}));
 return {f,input,scope,context,validator,transaction,task,original,current,source,message,session,snapshots,memory};
}
test('原Python探索消息fingerprint由TS实际来源复验，追加不可见原根且无C',async t=>{
 const x=await setup(t);assert.ok(!x.context.evidence.some(e=>e.evidence_id===x.message));await assert.rejects(x.transaction(c=>x.validator(c,x.context)));
 await x.transaction(c=>x.validator.captureExploredDependencies(c,x.context));const added=x.context.evidence.find(e=>e.evidence_id===x.message);assert.equal(added.model_visible,false);assert.equal(added.text,'合成探索原话');await x.transaction(c=>x.validator(c,x.context));assert.equal((await x.f.client.query('SELECT count(*)::int n FROM reply_request')).rows[0].n,0);
 await x.f.client.query("UPDATE message SET text_content='修改后的正文' WHERE id=$1",[x.message]);await assert.rejects(x.transaction(c=>x.validator(c,x.context)));
});
test('任务/输入/建议UUID、当前指针、已确认意愿和15分钟时效均复验',async t=>{
 const x=await setup(t);await x.transaction(c=>x.validator.captureExploredDependencies(c,x.context));
 for(const field of ['task_id','input_version','suggestion_id']){const altered={...x.input,suggestion:{...x.input.suggestion,[field]:randomUUID()}},guard=createReplyExploredContextValidator({scope:x.scope,input:altered,skillsRoot:x.f.directory+'/skills'});await assert.rejects(x.transaction(c=>guard(c,{...x.context,command:altered})));}
 await x.f.client.query('UPDATE assistant_session SET current_input_version_id=NULL WHERE id=$1',[x.session]);await assert.rejects(x.transaction(c=>x.validator(c,x.context)));await x.f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[x.session,x.current]);
 await x.f.client.query("UPDATE reply_exploration SET selected_intent='另一意愿' WHERE id=$1",[x.task]);await assert.rejects(x.transaction(c=>x.validator(c,x.context)));await x.f.client.query("UPDATE reply_exploration SET selected_intent='合成问候',root_created_at=clock_timestamp()-interval '15 minutes' WHERE id=$1",[x.task]);await assert.rejects(x.transaction(c=>x.validator(c,x.context)),/exploration_expired/);
});

test('不可见探索记忆无需概览导航，完整来源仍随改写/删除失效且不进入模型窗口',async t=>{
 const x=await setup(t,true);assert.ok(!x.context.evidence.some(e=>e.evidence_id===x.memory));
 await x.transaction(c=>x.validator.captureExploredDependencies(c,x.context));
 const hidden=x.context.evidence.find(e=>e.evidence_id===x.memory);assert.equal(hidden.model_visible,false);assert.equal(hidden.navigation,null);
 await x.transaction(c=>new PostgresReplyContext(c).validateCurrent(x.context));
 const payload=buildReplyPayload({request:x.input,context:x.context});assert.ok(!JSON.stringify(payload).includes(x.memory));assert.ok(!JSON.stringify(payload).includes(x.message));
 await x.f.client.query("UPDATE confirmed_memory SET text_content='新内容' WHERE id=$1",[x.memory]);
 await assert.rejects(x.transaction(c=>x.validator(c,x.context)));await assert.rejects(x.transaction(c=>new PostgresReplyContext(c).validateCurrent(x.context)));
 await x.f.client.query("UPDATE confirmed_memory SET text_content='喜欢清淡口味' WHERE id=$1",[x.memory]);await x.transaction(c=>x.validator(c,x.context));
 await x.f.client.query('DELETE FROM confirmed_memory WHERE id=$1',[x.memory]);
 await assert.rejects(x.transaction(c=>x.validator(c,x.context)));await assert.rejects(x.transaction(c=>new PostgresReplyContext(c).validateCurrent(x.context)));
});
