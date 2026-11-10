import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
const fields=['category','topic','scene_name','alternatives','interpretation_reason','valid_at','invalid_at','speech_act','assertion_status','figurative_type','event','conditions'];
const supported=()=>({verdict:'supported',evidence_indices:[0]});
function supplier(){
 const sources=new Map();
 return async request=>{
  const payload=JSON.parse(request.user);let response;
  if(request.purpose==='extraction'){
   for(const message of payload.messages)sources.set(message.message_id,message);
   response={scenes:[{scene_name:'合成本人资料',memories:payload.messages.map(message=>({text:message.text.replace(/^我/,'用户'),subject:'self',category:'common_fact',topic:'other',source_message_ids:[message.message_id],confidence:0.8,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'保留合成原句明确陈述。',event:null,conditions:null}))}]};
  }else response={results:payload.candidates.map((candidate,candidate_index)=>{
   const message=sources.get(candidate.source_message_ids[0]);
   return {candidate_index,verdict:'supported',issues:[],evidence:[{message_id:message.message_id,quote:message.text}],claim_check:{version:2,field_checks:Object.fromEntries(fields.map(field=>[field,supported()])),parts:[{candidate_span:{start:0,end:[...candidate.text].length},attribution:{...supported(),scope_subject:'self',actor_kind:'self',resolution:'explicit',subject_mentions:[{kind:'first_person',evidence_index:0,source_span:{start:0,end:1},candidate_span:{start:0,end:2}}]},arguments_and_relation:supported(),temporal_and_modality:supported()}]}};
  })};
  const blocks=[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify(response)}];await request.validateOutput(blocks);return {blocks};
 };
}
async function registered(t){
 const directory=await mkdtemp(join(tmpdir(),'notalone-owner-contract-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const module=join(directory,'registry.mjs');
 await writeFile(module,`import {registry as base} from ${JSON.stringify(new URL('./fixtures/sqlite-memory-deletion/registry.mjs',import.meta.url).href)};
import {finalizeOwnerContributions} from ${JSON.stringify(new URL('../src/memory/sqlite/owner-contribution.ts',import.meta.url).href)};
export const registry={...base,actions:[...base.actions,{name:'fixture.ownerFinalize',mode:'write',retryBusy:false,execute:finalizeOwnerContributions},{name:'fixture.ownerProof',mode:'read',retryBusy:false,execute(tx,i){
 const t=tx.get("SELECT id FROM processing_task WHERE owner_id=? AND run_id=? AND scope_kind='self'",[i.ownerId,i.runId]);if(!t)return {rows:[],events:0};
 const rows=tx.all("SELECT e.id,e.step_attempt_id AS attempt_id,e.payload,source.id AS source_id,source.payload AS original_payload,st.scope_kind AS source_scope,rt.scope_kind AS result_scope,st.run_id AS source_run,rt.run_id AS result_run FROM execution_input c JOIN execution_event e ON e.owner_id=c.owner_id AND e.id=c.event_id JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task rt ON rt.owner_id=s.owner_id AND rt.id=s.task_id JOIN execution_event source ON source.owner_id=c.owner_id AND source.id=c.producer_event_id JOIN step_attempt sa ON sa.owner_id=source.owner_id AND sa.id=source.step_attempt_id JOIN processing_step ss ON ss.owner_id=sa.owner_id AND ss.id=sa.step_id JOIN processing_task st ON st.owner_id=ss.owner_id AND st.id=ss.task_id WHERE c.owner_id=? AND rt.id=? AND c.producer_event_id IS NOT NULL AND c.role='verified_contribution' ORDER BY source.id",[i.ownerId,t.id]);
 const events=tx.get("SELECT count(*) AS n FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id WHERE s.owner_id=? AND s.task_id=?",[i.ownerId,t.id]).n;
 return {rows,events:Number(events),foreignKeys:tx.all('PRAGMA foreign_key_list(execution_input)')};
}}]};`);
 return pathToFileURL(module).href;
}
async function setup(t,{empty=false}={}){
 const registryModule=await registered(t);const f=await fixture(t,{registryModule});
 const contacts=f.saved.map(c=>c.contact_id);
 f.channel.page=async scope=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{sender:'owner',text:scope.token.contact_id===contacts[0]?'我长期住在高雄。':'我长期住在台南。'})],completedPartitions:['shard-a'],exhausted:true});
 for(const contactId of contacts)await f.service.synchronize(contactId);await f.contacts.setReading(false);
 let memory;const model=modelPort(()=>memory.accounting,empty?undefined:supplier());memory=new SqliteMemoryExtraction(f.storage,owner,model);t.after(()=>memory.close());
 const start=await memory.start(empty?'owner-empty':'owner-two-contributors');await memory.waitForIdle();return {...f,memory,model,start,contacts};
}
test('本人输出具有真实self任务producer与原贡献外键，幂等整理不追加模型调用',async t=>{
 const f=await setup(t);const run=await f.memory.read(f.start.runId);const selfTask=run.tasks.find(task=>task.scopeKind==='self');
 assert.equal(f.model.calls,4);assert.equal(run.candidates.length,2);assert.ok(run.candidates.every(candidate=>candidate.scopeKind==='self'));
 const trace=await f.memory.trace(selfTask.taskId);const outputs=trace.events.filter(event=>event.kind==='verified_output');
 assert.equal(outputs.length,2);assert.equal(trace.calls.length,0,'没有伪造本人模型发送');assert.ok(run.candidates.every(candidate=>outputs.some(event=>event.attemptId===candidate.attemptId&&event.eventId===candidate.id)));
 const proof=await f.storage.execute('fixture.ownerProof',{ownerId:owner,runId:run.runId});assert.equal(proof.rows.length,2);
 assert.ok(proof.rows.every(row=>row.result_scope==='self'&&row.source_scope==='contact'&&row.result_run===row.source_run&&row.payload===row.original_payload));
 const producerKey=proof.foreignKeys.find(key=>key.table==='execution_event'&&key.from==='producer_event_id'&&key.to==='id');assert.ok(producerKey,'原贡献是既有事件的真实外键');assert.ok(proof.foreignKeys.some(key=>key.id===producerKey.id&&key.from==='owner_id'&&key.to==='owner_id'),'关系外键包含owner隔离');
 const current=await f.storage.execute('fixture.ownerFinalize',{ownerId:owner,runId:run.runId});assert.equal(current.state,'awaiting_decision');assert.equal(current.attemptId,outputs[0].attemptId);assert.equal(current.outputCount,2);
 assert.equal(f.model.calls,4);assert.equal((await f.memory.trace(selfTask.taskId)).events.length,trace.events.length);assert.equal((await f.storage.execute('fixture.ownerProof',{ownerId:owner,runId:run.runId})).events,proof.events);
 const otherRun=await f.memory.start('later-empty-run');await f.memory.waitForIdle();assert.equal(otherRun.total,0);assert.equal(f.model.calls,4);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('本人无产出也有独立成功阶段记录，主题概览仍未完成',async t=>{
 const f=await setup(t,{empty:true});const run=await f.memory.read(f.start.runId);const task=run.tasks.find(task=>task.scopeKind==='self');const trace=await f.memory.trace(task.taskId);
 assert.equal(run.succeeded,2);assert.equal(task.state,'succeeded');assert.equal(run.candidates.length,0);assert.equal(trace.calls.length,0);assert.equal(trace.events.length,1);assert.equal(trace.events[0].kind,'stage_result');assert.equal(trace.events[0].payload.outcome,'no_new_memory');assert.equal(trace.events[0].payload.laterStages,'pending');assert.equal(run.laterStages,'pending');assert.notEqual(run.state,'completed');
});
test('单来源删除撤销本人在途资格并保留同步骤未参与来源的真实历史',async t=>{
 const f=await setup(t);const before=await f.memory.read(f.start.runId);const selfTask=before.tasks.find(task=>task.scopeKind==='self');assert.equal(before.candidates.length,2);
 const [contactId]=f.contacts;const source=(await f.service.read(contactId)).messages[0].sourceRecordIds[0];const deletion=new DeletionService(f.storage,f.memory.holders,new ManagedFiles(f.root));
 const plan=await deletion.plan({ownerId:owner,requestKey:'owner-real-contribution-delete',scope:{kind:'source',contactId,sourceId:source}});const done=await deletion.advance({ownerId:owner,operationId:plan.operationId});assert.equal(done.state,'completed',JSON.stringify(done.checks));
 await assert.rejects(f.memory.trace(selfTask.taskId),{code:'memory_extraction_not_found'});assert.equal((await f.memory.read(before.runId)).candidates.length,0);const preserved=(await f.storage.execute('fixture.ownerProof',{ownerId:owner,runId:before.runId})).rows;assert.equal(preserved.length,1);assert.equal(JSON.parse(preserved[0].payload).fact.text,'用户长期住在台南。');assert.equal(preserved[0].payload,preserved[0].original_payload);
 const other=(await f.memory.read(before.runId)).tasks.find(task=>task.contactId===f.contacts[1]);assert.equal(other.state,'succeeded');assert.ok((await f.memory.trace(other.taskId)).events.some(event=>event.kind==='verified_self_contribution'));
 assert.equal(f.model.calls,4);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
