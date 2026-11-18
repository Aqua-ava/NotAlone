import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,owner,record} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';

const registryModule=new URL('./fixtures/memory-management/citation-plan-registry.mjs',import.meta.url).href;

async function seeded(t,sourceCount=24){
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id,scope={scopeKind:'contact',contactId};
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:sourceCount},(_,i)=>record(String(i+1))),completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);
 const sources=await f.storage.execute('fixture.replySourceReferences',{ownerId:owner,contactId}),management=new SqliteMemoryManagement(f.storage,owner);
 return {f,contactId,scope,sources,management};
}

test('记忆引文按来源消息稳定排序，且与同一联系人的其他记忆互不混入',{timeout:60000},async t=>{
 const {f,scope,sources,management}=await seeded(t);
 const saved=[];
 // 三条记忆交错引用不同来源；写入顺序故意与消息顺序相反，排序只能来自读取。
 for(const [index,slice] of [[0,sources.slice(0,6)],[1,sources.slice(6,12)],[2,sources.slice(12,24)]]){
  const memory=await management.decide({requestKey:randomUUID(),action:'manual',scope,body:`合成带来源记忆${index}`});
  await f.storage.execute('fixture.attachReplySources',{ownerId:owner,memoryId:memory.memoryId,sources:[...slice].reverse()});
  saved.push({id:memory.memoryId,slice});
 }
 let page=await management.read(scope);while(page.page.preparing)page=await management.read(scope);
 assert.equal(page.memories.length,3);
 for(const {id,slice} of saved){
  const memory=page.memories.find(item=>item.id===id);assert.ok(memory?.current,'带来源记忆应可见');
  const ids=memory.current.sources.map(source=>source.messageId);
  assert.deepEqual(ids,[...ids].sort(),'引文必须按来源消息稳定排序');
  assert.deepEqual([...ids].sort(),slice.map(source=>source.message_id).sort(),'只含本记忆自己的来源');
 }
});

test('记忆版本与候选引文各自走已有的精确索引，不扫描整个所有者的引文',{timeout:60000},async t=>{
 const {f,sources,management,scope}=await seeded(t,6);
 const memory=await management.decide({requestKey:randomUUID(),action:'manual',scope,body:'合成带来源记忆'});
 await f.storage.execute('fixture.attachReplySources',{ownerId:owner,memoryId:memory.memoryId,sources});
 const byMemory=await f.storage.execute('fixture.citationPlan',{ownerId:owner,parent:{memoryId:memory.memoryId,versionNo:'1'}});
 assert.equal(byMemory.rows,sources.length);
 const memoryPlan=byMemory.plans.flat().join(' | ');
 assert.match(memoryPlan,/memory_citation_version \(owner_id=\? AND memory_id=\? AND version_no=\?\)/,memoryPlan);
 assert.doesNotMatch(memoryPlan,/memory_citation_message_timeline/,memoryPlan);
 const byCandidate=await f.storage.execute('fixture.citationPlan',{ownerId:owner,parent:{candidateId:randomUUID()}});
 const candidatePlan=byCandidate.plans.flat().join(' | ');
 assert.match(candidatePlan,/memory_citation_candidate \(owner_id=\? AND candidate_id=\?\)/,candidatePlan);
 assert.doesNotMatch(candidatePlan,/memory_citation_message_timeline/,candidatePlan);
});
