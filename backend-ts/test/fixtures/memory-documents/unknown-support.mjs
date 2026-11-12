import {fixture,modelPort,owner,record} from '../memory-sqlite/support.mjs';
import {supplier} from '../memory-management/supplier.mjs';
import {adjudicationSupplier} from '../memory-management/adjudication-support.mjs';
import {SqliteMemoryExtraction} from '../../../src/memory/sqlite/service.ts';
import {SqliteMemoryAdjudication} from '../../../src/memory/sqlite/management/adjudication-service.ts';
import {SqliteMemoryDocuments} from '../../../src/memory/sqlite/documents/service.ts';
import {ActiveHolders} from '../../../src/storage/sqlite/deletion/holders.ts';
import {DeletionService} from '../../../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../../../src/storage/sqlite/deletion/managed-files.ts';
import {SqliteMemoryManagement} from '../../../src/memory/sqlite/management/service.ts';

/** 固定真实提取、核验、裁决、存储与Worker；仅模型物理边界替身。 */
export async function unknownFixture(t,{unknownScope='contact',unknownStage='document_scene',beforeCall,mutateExtraction,beforeDocuments,adjudicationRespond,registryModule=new URL('./unknown-registry.mjs',import.meta.url).href}={}) {
 const f=await fixture(t,{registryModule}),a=f.saved[0].contact_id,b=f.saved[1].contact_id,holders=new ActiveHolders(),calls=[],receipts=[];let extraction,unknownSent=false;
 const normal=supplier();
 const extractionPort=modelPort(()=>extraction.accounting,async(request,input)=>{
  if(request.purpose!=='extraction')return normal.respond(request,input);
  const payload=JSON.parse(request.user);
  const response=await normal.respond({...request,user:JSON.stringify({...payload,messages:payload.messages.filter(m=>payload.target_message_ids.includes(m.message_id))})},input);
  if(mutateExtraction){const body=JSON.parse(response.blocks[0].arguments);for(const scene of body.scenes)for(const fact of scene.memories)mutateExtraction(fact);response.blocks[0].arguments=JSON.stringify(body);await request.validateOutput(response.blocks);}
  return response;
 });
 const documentAccounting=()=>({...extraction.accounting,reserve:async(receipt,claim)=>{await extraction.accounting.reserve(receipt,claim);receipts.push(structuredClone(receipt));}});
 const documentPort=modelPort(documentAccounting,async(request,input)=>{
  const names=request.tools.map(item=>item.name),payload=JSON.parse(request.messages[0].content[0].text),memory=payload.memories[0];
  calls.push({scope:input.scope.contact_id,stage:input.claim.step_name,requestId:input.requestId,attemptId:input.attemptId});
  await beforeCall?.({request,input,calls});
  const expectedScope=unknownScope==='self'?null:a;
  if(unknownScope!=='none'&&!unknownSent&&input.scope.contact_id===expectedScope&&input.claim.step_name===unknownStage){unknownSent=true;throw new Error('合成物理调用已预约发送，回执未知');}
  const tool=(name,args)=>({blocks:[{type:'tool-call',id:`synthetic-${calls.length}`,name,arguments:JSON.stringify(args)}]});
  if(names.includes('ScenarioVerificationOutput'))return tool('ScenarioVerificationOutput',{results:payload.proposal.scenarios.flatMap((scene,si)=>scene.paragraphs.map((_,pi)=>({scenario_index:si,paragraph_index:pi,supported:true,evidence:[{memory_id:memory.memory_id,quote:memory.text}]})))});
  if(names.includes('ProfileVerificationOutput'))return tool('ProfileVerificationOutput',{results:payload.proposal.entries.map((_,entry_index)=>({entry_index,supported:true,evidence:[{memory_id:memory.memory_id,quote:memory.verbatim_text}]}))});
  if(payload.layer==='l2')return request.messages.length===1?tool('write',{path:'garden.md',content:`<!-- META ${JSON.stringify({topic_key:'garden',title:'合成园艺',hint:'合成资料'})} -->\n\n${memory.text}\n<!-- SOURCES ${JSON.stringify([{memory_id:memory.memory_id,revision:memory.revision}])} -->`}):{blocks:[]};
  if(payload.layer==='l3')return request.messages.length===1?tool('write',{path:'profile.md',content:`# 长期背景\n\n<!-- ENTRY ${JSON.stringify({kind:'fact',section:'interests',basis:'正式记忆直接记载。',temporal_status:'stable',uncertainty:'',references:[{memory_id:memory.memory_id,revision:memory.revision}]})} -->\n${memory.text}`}):tool('ProfileProposalComplete',{});
  throw new Error('unexpected synthetic document call');
 });
 const adjudication=new SqliteMemoryAdjudication(f.storage,owner,modelPort(()=>extraction.accounting,adjudicationRespond??adjudicationSupplier()),holders);
 const documents=new SqliteMemoryDocuments(f.storage,owner,documentPort,holders);
 extraction=new SqliteMemoryExtraction(f.storage,owner,extractionPort,holders,async runId=>{await adjudication.publishRun(runId);await beforeDocuments?.(runId);await documents.publishRun(runId);});
 t.after(async()=>{await extraction.close();await adjudication.close();await documents.close();});
 async function add(contactId,records){
  f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records,completedPartitions:['shard-a'],exhausted:true});
  await f.contacts.setReading(true);await f.service.synchronize(contactId);await f.contacts.setReading(false);
 }
 return {...f,owner,a,b,calls,receipts,documents,extraction,adjudication,add,record,management:new SqliteMemoryManagement(f.storage,owner),deletion:new DeletionService(f.storage,holders,new ManagedFiles(f.root))};
}
