import test from 'node:test';
import assert from 'node:assert/strict';
import {autoGrowthFixture} from './fixtures/memory-management/adjudication-auto-growth.mjs';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';

test('来源支持的自动记忆依赖图增长仍沿正式领取完整执行并保留来源删除边界',{timeout:300000},async t=>{
 const f=await autoGrowthFixture(t,[10,20]);
 assert.deepEqual(f.measured.map(result=>result.parents),[10,20]);
 assert.deepEqual(f.measured.map(result=>result.messages),[220,420]);
 assert.ok(f.measured.every(result=>result.executionInputs>0&&result.eventSources>0),'测量必须覆盖真实执行证据和来源索引写入');
 assert.equal((await f.management.read(f.scope)).memories.length,20);
 assert.ok((await f.management.read(f.scope)).memories.every(memory=>memory.current.adoptionMode==='auto'));
 assert.ok(f.firstUncitedSource&&!f.lastCandidate.sources.some(source=>source.recordId===f.firstUncitedSource.recordId));
 const deletion=new DeletionService(f.storage,f.holders,new ManagedFiles(f.root));
 const plan=await deletion.plan({ownerId:f.owner,requestKey:'synthetic-growth-delete-window-source',scope:{kind:'source',contactId:f.contactId,sourceId:f.firstUncitedSource.recordId}});
 let state;
 for(let index=0;index<20&&state?.state!=='completed';index++)state=await deletion.advance({ownerId:f.owner,operationId:plan.operationId});
 assert.equal(state.state,'completed');
 assert.equal((await f.management.read(f.scope,{candidateId:f.lastCandidate.id})).candidates.length,0,'未引用但属于冻结窗口的来源删除后，派生候选不能继续使用');
 assert.equal((await f.management.read(f.scope)).memories.filter(memory=>memory.current!==null).length,0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 t.diagnostic(JSON.stringify({syntheticAutoSourceGrowth:f.measured,actionTimeoutMs:f.actionTimeoutMs,measurement:'完整正式claim；保存点回滚不计入耗时；无真实模型'}));
});
