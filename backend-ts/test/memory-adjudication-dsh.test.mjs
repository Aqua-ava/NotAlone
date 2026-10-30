import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DshMemoryAdjudicationRuntime,parseAdjudications} from '../src/memory/adoption/adjudication-dsh.ts';

const scope={owner_id:randomUUID(),contact_id:randomUUID()},memory=randomUUID(),candidateMessage=randomUUID(),priorMessage=randomUUID();
const item={candidate_index:0,
 candidate:{text:'合成联系人改为周四散步',category:'preference',subject:'contact',topic:'health',source_message_ids:[candidateMessage],
  confidence:0.9,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',
  alternatives:[],interpretation_reason:'合成',requires_all_sources:false,source_dependency_mode:'any',_scene_name:'合成',event:null,conditions:null,
  timing:{source_started_at:'2026-10-02T00:00:00+00:00',source_ended_at:'2026-10-02T00:00:00+00:00',source_time_complete:true},
  dimension_evidence:{version:1,candidate_sha256:'a'.repeat(64)}},
 candidate_source_receipt:'candidate-receipt',candidate_source_texts:[{message_id:candidateMessage,text:'合成联系人改为周四散步',occurred_at:'2026-10-02T00:00:00+00:00'}],
 relation_source_receipt:'relation-receipt',
 similar:[{memory_id:memory,revision:1,text:'合成联系人喜欢周三散步',category:'preference',topic:'health',subject:'contact',adoption_method:'auto',
  source_message_ids:[priorMessage],source_texts:[{message_id:priorMessage,text:'合成联系人喜欢周三散步',occurred_at:'2026-10-01T00:00:00+00:00'}],
  statement_time:'2026-10-01T00:00:00+00:00',valid_at:null,invalid_at:null,event:null,conditions:null,source_receipt:'prior-receipt'}]};
const relation={kind:'state_change',related_memory_ids:[memory],explanation:'合成来源从周三改为周四',
 evidence:[{message_id:priorMessage,quote:'合成联系人喜欢周三散步'},{message_id:candidateMessage,quote:'合成联系人改为周四散步'}],
 claim_changed:true,condition_changed:false};
const decision={candidate_index:0,action:'update',replaced_memory_id:memory,merged_memory_ids:[],merged_text:null,duplicate_memory_id:null,relation};

test('每种裁决动作的目标字段互斥，矛盾结构不得伪装为合法决定',()=>{
 const parse=value=>parseAdjudications([{type:'tool-call',name:'BatchMemoryAdjudicationOutput',arguments:JSON.stringify({decisions:[value]})}]);
 const empty={...decision,replaced_memory_id:null,merged_memory_ids:[],merged_text:null,duplicate_memory_id:null};
 const legal=[{...empty,action:'add'},{...empty,action:'keep'},decision,{...empty,action:'noop',duplicate_memory_id:memory},
  {...empty,action:'merge',merged_memory_ids:[memory,randomUUID()],merged_text:'合并后的完整资料'}];
 for(const value of legal)assert.equal(parse(value)[0].action,value.action);
 for(const value of legal){
  const invalid=value.action==='update'?{...value,duplicate_memory_id:memory}:value.action==='merge'?{...value,replaced_memory_id:memory}:{...value,replaced_memory_id:memory};
  assert.throws(()=>parse(invalid),/adjudication_model_output_invalid/,value.action);
 }
 for(const invalid of [{...empty,action:'noop',duplicate_memory_id:memory,merged_memory_ids:[memory]},
  {...empty,action:'noop',duplicate_memory_id:memory,merged_text:'夹带正文'},
  {...decision,merged_text:'夹带正文'},
  {...empty,action:'merge',merged_memory_ids:[memory,memory],merged_text:'重复父资料'},
  {...empty,action:'merge',merged_memory_ids:[memory,randomUUID()],merged_text:'   '},
  {...empty,action:'noop'},
  {...empty,action:'update'}])assert.throws(()=>parse(invalid),/adjudication_model_output_invalid/);
});

test('DSH结构化裁决：批量、独立关系核验与合并核验各自独立调用并保留usage',async()=>{
 const prompts=[];let calls=0;
 const port={async call(input){
  calls++;prompts.push(input.user);
  assert.equal(input.request_key.startsWith(`${input.purpose}:`),true);
  assert.equal(input.user.includes('candidate-receipt'),false);
  assert.equal(input.user.includes('"dimension_evidence"'),false);
  const title=input.schema.title,args=title==='BatchMemoryAdjudicationOutput'?{decisions:[decision]}
   :title==='BatchMemoryRelationVerificationOutput'?{results:[{candidate_index:0,supported:true,evidence:relation.evidence,claim_changed:true,condition_changed:false}]}
   :{supported:true,text:'合成联系人喜欢周三散步，现在改为周四散步',evidence:relation.evidence};
  const blocks=[{type:'tool-call',name:title,arguments:JSON.stringify(args)}];
  await input.validateOutput(blocks);
  return {blocks,usage:{call_id:randomUUID(),model_name:'synthetic-dsh',input_tokens:calls,output_tokens:1,purpose:'adjudication'}};
 }};
 const runtime=new DshMemoryAdjudicationRuntime({port,batchKey:'synthetic-batch'});
 const signal=new AbortController().signal;
 const decisions=await runtime.adjudicate([item],signal);
 assert.equal(decisions[0].usage.purpose,'adjudication');assert.equal(decisions[0].replaced_memory_id,memory);
 const verified=await runtime.verifyRelations([item],decisions,signal);
 assert.deepEqual({supported:verified[0].supported,receipt:verified[0].source_receipt,usage:verified[0].usage.purpose},
  {supported:true,receipt:'relation-receipt',usage:'relation_verification'});
 const second={...item.similar[0],memory_id:randomUUID()},mergeItem={...item,similar:[...item.similar,second]};
 const merged=await runtime.verifyMerge(mergeItem,{...decision,action:'merge',replaced_memory_id:null,merged_memory_ids:[memory,second.memory_id],merged_text:'合成联系人喜欢周三散步，现在改为周四散步'},
  [candidateMessage,priorMessage],'merge-receipt',signal);
 assert.deepEqual({supported:merged.supported,receipt:merged.source_receipt,usage:merged.usage.purpose},
  {supported:true,receipt:'merge-receipt',usage:'merge_verification'});
 assert.equal(calls,3);assert.equal(prompts.length,3);
});

test('DSH结构化裁决：坏字段和错误候选索引在记账前被拒绝',async()=>{
 let calls=0;
 const malformed={async call(input){
  calls++;
  const blocks=[{type:'tool-call',name:input.schema.title,arguments:JSON.stringify({decisions:[{...decision,candidate_index:9,extra:true}]})}];
  await input.validateOutput(blocks);return {blocks};
 }};
 await assert.rejects(new DshMemoryAdjudicationRuntime({port:malformed,batchKey:'synthetic-batch'}).adjudicate([item],new AbortController().signal),
  /adjudication_model_output_invalid|extraction_arguments_invalid/);
 assert.equal(calls,1);
});
