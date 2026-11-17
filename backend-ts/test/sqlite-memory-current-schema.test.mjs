import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record} from './fixtures/memory-sqlite/support.mjs';
import {createExtractionPolicyVersion} from '../src/memory/extraction/policy-version.ts';

const registryModule=new URL('./fixtures/memory-sqlite/compatibility-metrics-registry.mjs',import.meta.url).href;
async function prepared(t,count){
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id;
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,
  records:Array.from({length:count},(_,index)=>record(String(index+1))),completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);await f.contacts.setReading(false);
 const policy=await createExtractionPolicyVersion();
 const action=async(name,input)=>{
  const value=await f.storage.execute(name,{ownerId:owner,...input});
  const metrics=await f.storage.execute('compatibility.metrics',{});
  if(!process.env.NOTALONE_COMPATIBILITY_BASELINE)assert.equal(metrics.targetSchemaProbes,0,`${name} 不应在已升级结构中重新选择旧来源、排序或隔离表分支`);
  return {value,metrics};
 };
 return {f,contactId,policyConfig:policy.newTaskConfig(),action};
}

for(const count of [10,100])test(`当前结构在${count}条文字下保持固定输入、状态与恢复，同时减少重复查询`,async t=>{
 const {f,contactId,policyConfig,action}=await prepared(t,count),now=1700000000000;
 const scan=await action('memoryExtraction.scanSchedule',{contactIds:[contactId],now});
 assert.deepEqual(scan.value.contacts,[{contactId,incrementalDueAt:null,historyDue:true}]);
 const started=await action('memoryExtraction.start',{requestKey:`current-schema-${count}`,policyConfig,followupStages:true});
 const run=started.value;
 assert.equal(run.total,count);assert.equal(run.succeeded,0);assert.equal(run.state,'pending');
 assert.ok(run.inputs.every(input=>input.contactId===contactId));
 assert.deepEqual(run.inputs.map(input=>input.inputNo),Array.from({length:count},(_,index)=>index+1));
 const status=await action('memoryExtraction.read',{runId:run.runId});
 assert.equal(status.value.total,count);assert.deepEqual(status.value.inputs,run.inputs);
 assert.deepEqual(status.value.contentCounts,[{kind:'text',total:count,succeeded:0}]);
 if(!process.env.NOTALONE_COMPATIBILITY_BASELINE)assert.equal(status.metrics.frozenContentReads,count,'每个冻结输入在同一快照内只读取一次');
 const recovered=await action('memoryExtraction.recover',{});assert.equal(recovered.value,true);
 const after=await f.storage.execute('memoryExtraction.read',{ownerId:owner,runId:run.runId});
 assert.equal(after.state,'incomplete');assert.equal(after.total,count);assert.deepEqual(after.inputs,run.inputs);
 t.diagnostic(JSON.stringify({messages:count,scan:scan.metrics,start:started.metrics,status:status.metrics,recover:recovered.metrics}));
});

test('升级前文字冻结记录缺失时保留原文字语义，读取与恢复不丢失固定来源',async t=>{
 const {f,policyConfig,action}=await prepared(t,2);
 const {value:run}=await action('memoryExtraction.start',{requestKey:'legacy-text-without-content',policyConfig});
 await f.storage.execute('compatibility.removeFrozenText',{ownerId:owner,runId:run.runId});
 const {value:before}=await action('memoryExtraction.read',{runId:run.runId});
 assert.deepEqual(before.contentCounts,[{kind:'text',total:2,succeeded:0}]);assert.deepEqual(before.inputs,run.inputs);
 await action('memoryExtraction.recover',{});
 const {value:after}=await action('memoryExtraction.read',{runId:run.runId});
 assert.equal(after.state,'incomplete');assert.deepEqual(after.inputs,run.inputs);assert.deepEqual(after.contentCounts,before.contentCounts);
});
