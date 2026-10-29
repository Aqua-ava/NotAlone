import {fixture,modelPort,owner,record} from '../memory-sqlite/support.mjs';
import {supplier} from '../memory-management/supplier.mjs';
import {adjudicationSupplier} from '../memory-management/adjudication-support.mjs';
import {SqliteMemoryExtraction} from '../../../src/memory/sqlite/service.ts';
import {SqliteMemoryAdjudication} from '../../../src/memory/sqlite/management/adjudication-service.ts';
import {SqliteMemoryManagement} from '../../../src/memory/sqlite/management/service.ts';
import {SqliteMemoryDocuments} from '../../../src/memory/sqlite/documents/service.ts';
import {ActiveHolders} from '../../../src/storage/sqlite/deletion/holders.ts';

export async function documentFixture(t,{beforeCall}={}){
 const f=await fixture(t),contactId=f.saved[0].contact_id;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期喜欢合成园艺。'})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);await f.contacts.setReading(false);
 const holders=new ActiveHolders(),calls=[];let extraction;
 const respond=async(request,input)=>{
  const names=request.tools.map(item=>item.name),payload=JSON.parse(request.messages[0].content[0].text),memory=payload.memories[0];
  calls.push({names,claim:input.claim});await beforeCall?.({request,input,calls,contactId,fixture:f});
  const tool=(name,args)=>({blocks:[{type:'tool-call',id:`synthetic-${calls.length}`,name,arguments:JSON.stringify(args)}]});
  if(names.includes('ScenarioVerificationOutput'))return tool('ScenarioVerificationOutput',{results:payload.proposal.scenarios.flatMap((scene,si)=>scene.paragraphs.map((_,pi)=>({scenario_index:si,paragraph_index:pi,supported:true,evidence:[{memory_id:memory.memory_id,quote:memory.text}]})))});
  if(names.includes('ProfileVerificationOutput'))return tool('ProfileVerificationOutput',{results:payload.proposal.entries.map((_,entry_index)=>({entry_index,supported:true,evidence:[{memory_id:memory.memory_id,quote:memory.verbatim_text}]}))});
  if(payload.layer==='l2')return request.messages.length===1?tool('write',{path:'garden.md',content:`<!-- META ${JSON.stringify({topic_key:'garden',title:'合成园艺',hint:'长期园艺偏好'})} -->\n\n${memory.text}\n<!-- SOURCES ${JSON.stringify([{memory_id:memory.memory_id,revision:memory.revision}])} -->`}):{blocks:[]};
  if(payload.layer==='l3')return request.messages.length===1?tool('write',{path:'profile.md',content:`# 长期背景\n\n<!-- ENTRY ${JSON.stringify({kind:'fact',section:'interests',basis:'正式记忆直接记载。',temporal_status:'stable',uncertainty:'',references:[{memory_id:memory.memory_id,revision:memory.revision}]})} -->\n${memory.text}`}):tool('ProfileProposalComplete',{});
  throw new Error('unexpected synthetic document call');
 };
 const adjudication=new SqliteMemoryAdjudication(f.storage,owner,modelPort(()=>extraction.accounting,adjudicationSupplier()),holders);
 const documents=new SqliteMemoryDocuments(f.storage,owner,modelPort(()=>extraction.accounting,respond),holders);
 const extractionPort=modelPort(()=>extraction.accounting,supplier().respond);
 extraction=new SqliteMemoryExtraction(f.storage,owner,extractionPort,holders,async runId=>{await adjudication.publishRun(runId);await documents.publishRun(runId);});
 const management=new SqliteMemoryManagement(f.storage,owner);
 t.after(async()=>{await extraction.close();await adjudication.close();await documents.close();});
 return {...f,owner,contactId,holders,calls,extraction,adjudication,documents,management,get extractionCalls(){return extractionPort.calls;}};
}
