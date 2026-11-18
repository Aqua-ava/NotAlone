import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteMemoryDocuments} from '../src/memory/sqlite/documents/service.ts';
import {SqliteMemoryAdjudication} from '../src/memory/sqlite/management/adjudication-service.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';

const deferred=()=>Promise.withResolvers();
// 存储闸门只验证宿主执行器的接纳、范围互斥和排空；真实来源及 SQLite 恢复另有集成覆盖。
const executors=[
 {name:'文档',action:'memoryDocuments.tasks',empty:[],closed:'document_service_closed',busy:'document_run_busy',
  create:(storage,port)=>new SqliteMemoryDocuments(storage,'synthetic-owner',port,new ActiveHolders())},
 {name:'裁决',action:'memory.importRun',empty:{candidateIds:[]},closed:'memory_adjudication_closed',busy:'memory_adjudication_run_busy',
  create:(storage,port)=>new SqliteMemoryAdjudication(storage,'synthetic-owner',port,new ActiveHolders())},
];

for(const entry of executors){
 test(`${entry.name}以同一在途登记复用范围并在关闭时等待全部轮次`,{timeout:3000},async()=>{
  const gates=new Map([['run-a',deferred()],['run-b',deferred()]]),events=[];
  const storage={execute:async(name,input)=>{
   assert.equal(name,entry.action);await gates.get(input.runId).promise;events.push(input.runId);return entry.empty;
  }};
  const service=entry.create(storage,{close:async()=>{events.push('closed');}});
  const first=service.publishRun('run-a','contact-a'),second=service.publishRun('run-b','contact-b');
  assert.equal(service.publishRun('run-a','contact-a'),first);
  await assert.rejects(service.publishRun('run-a','contact-b'),{code:entry.busy});
  await assert.rejects(service.publishRun('run-a','contact-a',{retryKnownFailures:true}),{code:entry.busy});
  const closing=service.close();assert.equal(service.close(),closing);
  await assert.rejects(service.publishRun('run-c','contact-a'),{code:entry.closed});
  gates.get('run-a').resolve();await first;
  assert.deepEqual(events,['run-a'],'另一轮未排空前不能释放模型端口');
  gates.get('run-b').resolve();await Promise.all([second,closing]);
  assert.deepEqual(events,['run-a','run-b','closed']);
 });

 test(`${entry.name}失败清除原登记，资源关闭失败可重试但不恢复接纳`,{timeout:3000},async()=>{
  let calls=0,closes=0;
  const service=entry.create({execute:async(name)=>{
   assert.equal(name,entry.action);if(++calls===1)throw Error('synthetic_preparation_failed');return entry.empty;
  }},{close:async()=>{if(++closes===1)throw Error('synthetic_close_failed');}});
  await assert.rejects(service.publishRun('run-a','contact-a'),/synthetic_preparation_failed/);
  await service.publishRun('run-a','contact-a');assert.equal(calls,2);
  await assert.rejects(service.close(),/synthetic_close_failed/);
  await assert.rejects(service.publishRun('run-a','contact-a'),{code:entry.closed});
  await service.close();await service.close();assert.equal(closes,2);
 });
}
