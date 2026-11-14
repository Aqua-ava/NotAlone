import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import * as adjudicationModule from '../src/memory/adoption/adjudication-dsh.ts';
const {DshMemoryAdjudicationRuntime,parseAdjudications}=adjudicationModule;

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
  {...empty,action:'merge',merged_memory_ids:[memory],merged_text:'一条旧资料与新补充合并后的完整资料'},
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
 const prompts=[],requests=[];let calls=0;
 const port={async call(input){
  calls++;prompts.push(input.user);requests.push(input);
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
 const [adjudication,verification,merge]=requests;
 assert.deepEqual(new Set(adjudication.schema.properties.decisions.items.properties.action.enum),new Set(['add','noop','update','merge']),'新模型只选择四种产品动作；keep只保留历史解析兼容');
 assert.equal(JSON.parse(verification.user)[0].proposed_action,'update','关系核验必须同时看到动作，不能只支持关系却漏掉组合矛盾');
 assert.deepEqual(JSON.parse(verification.user)[0].proposed_targets,{replaced_memory_id:memory,merged_memory_ids:[],duplicate_memory_id:null},'独立核验须得到兼容表要求的目标，不能因缺少目标上下文误拒合法动作');
 for(const request of [adjudication,verification]){
  assert.match(request.system,/add[^\n]*store/);
  assert.match(request.system,/noop[^\n]*skip/);
  assert.match(request.system,/update/);assert.match(request.system,/merge/);
  assert.match(request.system,/来源/);assert.match(request.system,/时间|阶段/);assert.match(request.system,/条件/);
 }
 const policy={compatibilityVersion:2,adjudication:{system:adjudication.system,schema:adjudication.schema},
  relation_verification:{system:verification.system,schema:verification.schema},merge_verification:{system:merge.system,schema:merge.schema}};
 assert.equal(adjudicationModule.adjudicationPolicyRevision,createHash('sha256').update(JSON.stringify(policy)).digest('hex'),'策略版本必须绑定实际使用的全部提示词、工具schema及兼容规则版本');
});

test('关系核验收到完整更新动作、目标与新旧条件，保留有据的主张和条件变化',async()=>{
 const updatedText='合成联系人现在只在晴天周四散步',priorText='合成联系人之前无论天气都周三散步';
 const conditionalItem={...item,candidate:{...item.candidate,text:updatedText,conditions:{version:1,items:[{text:'只在晴天',source_supported:true}]}},
  candidate_source_texts:[{...item.candidate_source_texts[0],text:updatedText}],
  similar:[{...item.similar[0],text:priorText,conditions:{version:1,items:[{text:'无论天气',source_supported:true}]},source_texts:[{...item.similar[0].source_texts[0],text:priorText}]}]};
 const conditionalRelation={...relation,condition_changed:true,evidence:[{message_id:priorMessage,quote:priorText},{message_id:candidateMessage,quote:updatedText}]};
 const runtime=new DshMemoryAdjudicationRuntime({batchKey:'synthetic-condition-change',port:{async call(input){
  assert.equal(input.purpose,'relation_verification');
  const proposed=JSON.parse(input.user)[0];assert.equal(proposed.proposed_action,'update');assert.equal(proposed.proposed_relation.kind,'state_change');
  assert.deepEqual(proposed.proposed_targets,{replaced_memory_id:memory,merged_memory_ids:[],duplicate_memory_id:null});
  assert.equal(proposed.proposed_relation.claim_changed,true);assert.equal(proposed.proposed_relation.condition_changed,true);
  assert.deepEqual(proposed.candidate.conditions,conditionalItem.candidate.conditions);
  assert.deepEqual(proposed.sources.prior[0].conditions,conditionalItem.similar[0].conditions);
  const blocks=[{type:'tool-call',name:input.schema.title,arguments:JSON.stringify({results:[{candidate_index:0,supported:true,evidence:conditionalRelation.evidence,claim_changed:true,condition_changed:true}]})}];
  input.validateOutput(blocks);return {blocks};
 }}});
 const result=await runtime.verifyRelations([conditionalItem],[{...decision,relation:conditionalRelation}],AbortSignal.timeout(1000));
 assert.equal(result[0].supported,true);assert.equal(result[0].claim_changed,true);assert.equal(result[0].condition_changed,true,'来源支持的变化不能为旧兼容表降成false');
});

test('新记忆与一条旧记忆合并时只核验所选目标及双方来源',async()=>{
 const ignored={...item.similar[0],memory_id:randomUUID(),text:'另一条不参与合并的旧资料'};
 const runtime=new DshMemoryAdjudicationRuntime({batchKey:'synthetic-single-parent',port:{async call(input){
  assert.equal(input.purpose,'merge_verification');
  const payload=JSON.parse(input.user);assert.equal(payload.candidate_and_parents.sources.prior.length,1);
  assert.equal(payload.candidate_and_parents.sources.prior[0].memory_id,memory);
  const blocks=[{type:'tool-call',name:input.schema.title,arguments:JSON.stringify({supported:true,text:'合成联系人以前周三散步，现在改为周四散步',evidence:relation.evidence})}];
  input.validateOutput(blocks);return {blocks};
 }}});
 const result=await runtime.verifyMerge({...item,similar:[...item.similar,ignored]},
  {...decision,action:'merge',replaced_memory_id:null,merged_memory_ids:[memory],merged_text:'合成联系人以前周三散步，现在改为周四散步'},
  [candidateMessage,priorMessage],'single-parent-receipt',AbortSignal.timeout(1000));
 assert.equal(result.supported,true);assert.equal(result.source_receipt,'single-parent-receipt');assert.deepEqual(result.source_message_ids,[candidateMessage,priorMessage]);
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

test('端口抛出的稳定错误码保留原因，无稳定码的异常才归为调用失败',async()=>{
 const run=error=>new DshMemoryAdjudicationRuntime({batchKey:'cause',port:{call:async()=>{throw error;}}}).adjudicate([item],AbortSignal.timeout(1000));
 await assert.rejects(run(Object.assign(new Error('占位冲突'),{code:'memory_adjudication_receipt_unknown'})),e=>e.code==='memory_adjudication_receipt_unknown'&&e.cause.code==='memory_adjudication_receipt_unknown');
 await assert.rejects(run(new Error('网络断开')),{code:'adjudication_model_call_failed'});
 await assert.rejects(run(Object.assign(new Error('含空格'),{code:'Some Message With Spaces'})),{code:'adjudication_model_call_failed'});
});
