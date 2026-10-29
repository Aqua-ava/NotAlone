import {fixture,modelPort,owner,record} from '../memory-sqlite/support.mjs';
import {supplier} from '../memory-management/supplier.mjs';
import {adjudicationSupplier} from '../memory-management/adjudication-support.mjs';
import {SqliteMemoryExtraction} from '../../../src/memory/sqlite/service.ts';
import {SqliteMemoryAdjudication} from '../../../src/memory/sqlite/management/adjudication-service.ts';
import {SqliteMemoryDocuments} from '../../../src/memory/sqlite/documents/service.ts';
import {DeletionService} from '../../../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../../../src/storage/sqlite/deletion/managed-files.ts';
import {renderProfile} from '../../../src/memory/profiles/workspace.ts';
import {ActiveHolders} from '../../../src/storage/sqlite/deletion/holders.ts';
const registryModule=new URL('./deletion-registry.mjs',import.meta.url).href;
export async function deletionFixture(t,{beforeCall,twoContacts=false,twoCaptures=false,noMemory=false,ownerB=true,targetOnly=false,orderOwnerA=false,preferText}={}){
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id,otherContactId=f.saved[1].contact_id;
 f.channel.page=async scope=>{const other=scope.token.contact_id===otherContactId;const records=[record('1',{text:other?'我长期喜欢合成登山。':'我长期喜欢合成园艺。'})];if(twoContacts&&(!other||ownerB))records.push(record('2',{sender:'owner',text:other?'我长期偏好合成蓝茶。':'我长期偏好合成白茶。'}));return {target:f.target.descriptor,cursorIn:null,cursorOut:null,records,completedPartitions:['shard-a'],exhausted:true};};
 await f.service.synchronize(contactId);if(twoCaptures)await f.service.synchronize(contactId);if(twoContacts)await f.service.synchronize(otherContactId);await f.contacts.setReading(false);
 const otherMessages=twoContacts?(await f.service.read(otherContactId)).messages:[];
 const messages=(await f.service.read(contactId)).messages,message=messages.find(m=>m.text==='我长期喜欢合成园艺。'),ownerMessage=messages.find(m=>m.text==='我长期偏好合成白茶。'),holders=new ActiveHolders(),calls=[];let extraction;
 const respond=async(request,input)=>{
  const names=request.tools.map(x=>x.name),payload=JSON.parse(request.messages[0].content[0].text),memory=payload.memories.find(item=>preferText&&String(item.text??item.verbatim_text).includes(preferText))??payload.memories[0];calls.push({request,input});await beforeCall?.({request,input,calls});
  const tool=(name,args)=>({blocks:[{type:'tool-call',id:`deletion-${calls.length}`,name,arguments:JSON.stringify(args)}]});
  if(names.includes('ScenarioVerificationOutput'))return tool('ScenarioVerificationOutput',{results:payload.proposal.scenarios.flatMap((s,i)=>s.paragraphs.map((_,j)=>({scenario_index:i,paragraph_index:j,supported:true,evidence:[{memory_id:memory.memory_id,quote:memory.text}]})))});
  if(names.includes('ProfileVerificationOutput'))return tool('ProfileVerificationOutput',{results:payload.proposal.entries.map((entry,entry_index)=>{const source=payload.memories.find(m=>m.memory_id===entry.references[0].memory_id);return {entry_index,supported:true,evidence:[{memory_id:source.memory_id,quote:source.verbatim_text}]};})});
  if(payload.layer==='l2')return request.messages.length===1?tool('write',{path:'garden.md',content:`<!-- META ${JSON.stringify({topic_key:'garden',title:'合成园艺',hint:'长期园艺偏好'})} -->\n\n${memory.text}\n<!-- SOURCES ${JSON.stringify([{memory_id:memory.memory_id,revision:memory.revision}])} -->`}):{blocks:[]};
  if(payload.layer==='l3')return request.messages.length===1?tool('write',{path:'profile.md',content:payload.existing_profile?renderProfile(payload.existing_profile):`# 长期背景\n\n<!-- ENTRY ${JSON.stringify({kind:'fact',section:'interests',basis:'正式记忆直接记载。',temporal_status:'stable',uncertainty:'',references:[{memory_id:memory.memory_id,revision:memory.revision}]})} -->\n${memory.text}`}):tool('ProfileProposalComplete',{});
  throw Error('unexpected synthetic document call');
 };
 const adjudicationStorage=orderOwnerA?{execute:async(name,input)=>{
  const result=await f.storage.execute(name,input);if(name!=='memory.importRun')return result;
  const {SqliteMemoryManagement}=await import('../../../src/memory/sqlite/management/service.ts');
  const candidates=(await new SqliteMemoryManagement(f.storage,owner).read({scopeKind:'self',contactId:null})).candidates;
  const first=candidates.find(candidate=>candidate.state==='pending'&&candidate.body.includes('白茶'))?.id;
  return first?{...result,candidateIds:[...result.candidateIds].sort((a,b)=>(a===first?-1:0)-(b===first?-1:0))}:result;
 }}:f.storage;
 const adjudication=new SqliteMemoryAdjudication(adjudicationStorage,owner,modelPort(()=>extraction.accounting,adjudicationSupplier()),holders),documents=new SqliteMemoryDocuments(f.storage,owner,modelPort(()=>extraction.accounting,respond),holders);
 const extractor=supplier(),extractionRespond=targetOnly?async(request,input)=>{
  if(request.purpose!=='extraction')return extractor.respond(request,input);
  const payload=JSON.parse(request.user);return extractor.respond({...request,user:JSON.stringify({...payload,messages:payload.messages.filter(message=>payload.target_message_ids.includes(message.message_id))})},input);
 }:extractor.respond;
 extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,noMemory?undefined:extractionRespond),holders,async runId=>{await adjudication.publishRun(runId);await documents.publishRun(runId);});
 t.after(async()=>{await extraction.close();await adjudication.close();await documents.close();});
 return {...f,owner,contactId,otherContactId,otherMessages,message,ownerMessage,holders,calls,adjudication,documents,extraction,deletion:new DeletionService(f.storage,holders,new ManagedFiles(f.root))};
}
