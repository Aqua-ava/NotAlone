import assert from 'node:assert/strict';
import {fixture,owner,record,modelPort} from '../memory-sqlite/support.mjs';
import {supplier} from './supplier.mjs';
import {SqliteMemoryExtraction} from '../../../src/memory/sqlite/service.ts';
import {SqliteMemoryManagement} from '../../../src/memory/sqlite/management/service.ts';
import {SqliteMemoryAdjudication} from '../../../src/memory/sqlite/management/adjudication-service.ts';
import {ActiveHolders} from '../../../src/storage/sqlite/deletion/holders.ts';
import {readAllManagement} from './read-all.mjs';
export {owner};

/** 仅合成供应商作语义选择；输入、具名核验、许可预约、回执及正式决定沿真实合同。 */
export function adjudicationSupplier({action='add',select,mergedText='联系人保留全部合成长期资料。'}={}){
 return async(request)=>{
  const payload=JSON.parse(request.user);let value;
  if(request.purpose==='adjudication'){
   const candidate=payload.new_memories[0],prior=payload.existing_memories;
   const selected=select?select(prior,candidate):prior;
   const ids=selected.map(p=>p.memory_id),evidence=candidate.source_texts.map(s=>({message_id:s.message_id,quote:s.text}));
   const relation={kind:action==='update'?'state_change':action==='merge'?'supplement':'independent',related_memory_ids:action==='update'?ids.slice(0,1):ids,explanation:'逐字核对本轮合成来源。',evidence,claim_changed:action==='update',condition_changed:false};
   value={decisions:[{candidate_index:candidate.candidate_index,action,replaced_memory_id:action==='update'?ids[0]:null,merged_memory_ids:action==='merge'?ids:[],merged_text:action==='merge'?mergedText:null,duplicate_memory_id:null,relation}]};
  }else if(request.purpose==='relation_verification'){
   value={results:payload.map(item=>({candidate_index:item.candidate_index,supported:true,evidence:[...item.sources.candidate,...item.sources.prior.flatMap(p=>p.sources)].map(s=>({message_id:s.message_id,quote:s.text})),claim_changed:item.proposed_relation.claim_changed,condition_changed:item.proposed_relation.condition_changed}))};
  }else if(request.purpose==='merge_verification'){
   const item=payload.candidate_and_parents;
   value={supported:true,text:payload.target_text,evidence:[...item.sources.candidate,...item.sources.prior.flatMap(p=>p.sources)].map(s=>({message_id:s.message_id,quote:s.text}))};
  }else throw new Error(`合成裁决不接受用途 ${request.purpose}`);
  const blocks=[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify(value)}];await request.validateOutput(blocks);return {blocks};
 };
}

export async function adjudicationFixture(t,options={}){
 const f=await fixture(t,{registryModule:new URL('./adjudication-registry.mjs',import.meta.url).href});
 const contactId=f.saved[0].contact_id,scope={scopeKind:'contact',contactId},management=new SqliteMemoryManagement(f.storage,owner),records=[],calls=[],failures=[];
 let nextRecord=0,extraction,respond=options.respond??adjudicationSupplier();
 const normal=supplier();
 const extractionPort=modelPort(()=>extraction.accounting,async(request,input)=>{
  if(request.purpose!=='extraction')return normal.respond(request,input);
  const payload=JSON.parse(request.user);
  return normal.respond({...request,user:JSON.stringify({...payload,messages:payload.messages.filter(m=>payload.target_message_ids.includes(m.message_id))})},input);
 });
 extraction=new SqliteMemoryExtraction(f.storage,owner,extractionPort);t.after(()=>extraction.close());
 const port={...modelPort(()=>extraction.accounting,async(request,input)=>{calls.push({purpose:request.purpose,payload:JSON.parse(request.user),claim:{...input.claim}});return respond(request,input);}),close:async()=>{}};
 const observedStorage={execute:async(name,input)=>{try{return await f.storage.execute(name,input);}catch(error){failures.push({action:name,code:error.code??error.message});throw error;}}};
 const newRuntime=()=>{const runtime=new SqliteMemoryAdjudication(observedStorage,owner,port,new ActiveHolders());t.after(()=>runtime.close());return runtime;};
 const adjudication=newRuntime();await adjudication.initialize();
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[...records],completedPartitions:['shard-a'],exhausted:true});
 async function extract(texts,{publish=false}={}){
  for(const text of texts){const n=++nextRecord;records.push(record(String(n),{text,sentAt:String(1700000000000+n*1000)}));}
  await f.contacts.setReading(true);await f.service.synchronize(contactId);await f.contacts.setReading(false);
  const run=await extraction.start(`adjudication-normal-${nextRecord}`);await extraction.waitForIdle();
  const done=await extraction.read(run.runId);assert.ok(done.tasks.filter(task=>task.scopeKind==='contact'&&task.contactId===contactId).every(task=>task.state==='succeeded'),JSON.stringify(done.tasks));
  await management.importRun(run.runId);if(publish)await adjudication.publishRun(run.runId);return run.runId;
 }
 return {...f,owner,contactId,scope,management,extraction,adjudication,port,calls,failures,normal,extract,newRuntime,
  setRespond(next){respond=next;},read:()=>readAllManagement(management,scope),trace:()=>f.storage.execute('fixture.adjudicationTrace',{ownerId:owner})};
}
