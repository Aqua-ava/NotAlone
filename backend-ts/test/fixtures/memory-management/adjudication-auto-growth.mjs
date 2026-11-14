import assert from 'node:assert/strict';
import {fixture,owner,record,modelPort} from '../memory-sqlite/support.mjs';
import {supplier} from './supplier.mjs';
import {adjudicationSupplier} from './adjudication-support.mjs';
import {SqliteMemoryExtraction} from '../../../src/memory/sqlite/service.ts';
import {SqliteMemoryManagement} from '../../../src/memory/sqlite/management/service.ts';
import {SqliteMemoryAdjudication} from '../../../src/memory/sqlite/management/adjudication-service.ts';
import {ActiveHolders} from '../../../src/storage/sqlite/deletion/holders.ts';
import {sqliteActionTimeoutMs} from '../../../src/storage/sqlite/timeouts.ts';

/** 正常图文链的文字分支：每20条真实合成消息仅产一条fact，自动裁决逐轮冻结全部旧池。 */
export async function autoGrowthFixture(t,sizes){
 const f=await fixture(t,{registryModule:new URL('./adjudication-auto-growth-registry.mjs',import.meta.url).href});
 const contactId=f.saved[0].contact_id,scope={scopeKind:'contact',contactId},holders=new ActiveHolders(),management=new SqliteMemoryManagement(f.storage,owner);
 const records=[],normal=supplier(),respond=adjudicationSupplier();let extraction;
 const extractionPort=modelPort(()=>extraction.accounting,async(request,input)=>{
  if(request.purpose!=='extraction')return normal.respond(request,input);
  const payload=JSON.parse(request.user),result=await normal.respond({...request,user:JSON.stringify({...payload,messages:payload.messages.filter(message=>payload.target_message_ids.includes(message.message_id))})},input);
  const value=JSON.parse(result.blocks[0].arguments);for(const scene of value.scenes)scene.memories=scene.memories.slice(0,1);
  const blocks=[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify(value)}];await request.validateOutput(blocks);return {blocks};
 });
 extraction=new SqliteMemoryExtraction(f.storage,owner,extractionPort,holders);
 const adjudication=new SqliteMemoryAdjudication(f.storage,owner,modelPort(()=>extraction.accounting,respond),holders);await adjudication.initialize();
 t.after(async()=>{await adjudication.close();await extraction.close();});
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[...records],completedPartitions:['shard-a'],exhausted:true});
 console.log(JSON.stringify({syntheticGrowth:'ready',actionTimeoutMs:sqliteActionTimeoutMs,sizes}));
 const measured=[];let firstUncitedSource,lastCandidate;
 for(let parents=0;parents<=Math.max(...sizes);parents++){
  for(let index=0;index<20;index++){const n=records.length+1;records.push(record(String(n),{text:`我长期保留合成来源事项${n}。`,sentAt:String(1700000000000+n*1000)}));}
  await f.contacts.setReading(true);await f.service.synchronize(contactId);await f.contacts.setReading(false);
  const started=await extraction.start(`synthetic-auto-source-growth-${parents}`);await extraction.waitForIdle(started.runId);
  const run=await extraction.read(started.runId);assert.equal(run.candidates.length,1);
  await management.importRun(run.runId,contactId);
  lastCandidate=(await management.read(scope)).candidates[0];assert.ok(lastCandidate);
  if(!firstUncitedSource)firstUncitedSource=run.inputs.find(input=>input.role==='target'&&!lastCandidate.sources.some(source=>source.messageId===input.messageId));
  if(sizes.includes(parents)){
   const result=await f.storage.execute('fixture.measuredAdjudicationClaim',{ownerId:owner,candidateId:lastCandidate.id});
   assert.equal(result.parents,parents);measured.push({...result,messages:records.length});console.log(JSON.stringify({syntheticGrowth:'measured',...measured.at(-1)}));
  }
  if(parents<Math.max(...sizes)){
   await adjudication.publishRun(run.runId,contactId);
   assert.equal((await management.read(scope)).candidates.length,0,'每轮正式auto采纳后才建立下一层依赖');
  }
 }
 return {...f,owner,contactId,scope,holders,management,extraction,adjudication,measured,firstUncitedSource,lastCandidate,actionTimeoutMs:sqliteActionTimeoutMs};
}
