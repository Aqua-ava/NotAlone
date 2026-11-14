import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {fixture,owner,record,modelPort} from '../memory-sqlite/support.mjs';
import {supplier} from '../memory-management/supplier.mjs';
import {SqliteMediaService} from '../../../src/media/sqlite/service.ts';
import {SqliteMemoryExtraction} from '../../../src/memory/sqlite/service.ts';
import {SqliteMemoryAdjudication} from '../../../src/memory/sqlite/management/adjudication-service.ts';
import {SqliteMemoryManagement} from '../../../src/memory/sqlite/management/service.ts';
import {SqliteMemoryDocuments} from '../../../src/memory/sqlite/documents/service.ts';
import {createBuiltinMemoryContentRegistry} from '../../../src/memory/content/builtins.ts';
import {ActiveHolders} from '../../../src/storage/sqlite/deletion/holders.ts';
import {DeletionService} from '../../../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../../../src/storage/sqlite/deletion/managed-files.ts';
import {fileMemoryContent} from './file-plugin.mjs';
import {visualMemoryContent} from './visual-plugin.mjs';

const fields=['category','topic','scene_name','alternatives','interpretation_reason','valid_at','invalid_at','speech_act','assertion_status','figurative_type','event','conditions'];
export const imageStatement='联系人有一个蓝色杯子。';
const evidence=source=>typeof source.text==='string'?{message_id:source.message_id,quote:source.text}:
 {message_id:source.message_id,quote:null,description:'实际附图中可见一个蓝色杯子。'};
const tool=(name,value)=>({blocks:[{type:'tool-call',name,arguments:JSON.stringify(value)}]});

/** 真实SQLite、受管PNG、普通任务与会计接线；仅外部语义选择使用合成供应商。 */
export async function unifiedChainFixture(t,{action='add',mergedText='联系人长期喜欢园艺，也有一个蓝色杯子。',fileContent=false,visualContent=false,preferredText='蓝色杯子'}={}){
 const f=await fixture(t,visualContent?{registryModule:new URL('./visual-registry.mjs',import.meta.url).href}:fileContent?{registryModule:new URL('./registry.mjs',import.meta.url).href}:{}),contactId=f.saved[0].contact_id,scope={scopeKind:'contact',contactId},records=[],holders=new ActiveHolders();
 let imageRevision=0;
 const adapter={version:'synthetic-unified-content-v1',supports:kind=>kind==='image'||visualContent&&kind==='video',async execute(context){
  const bytes=await sharp({create:{width:12,height:10,channels:3,background:{r:++imageRevision*30,g:20,b:230}}}).png().toBuffer();
  await context.save({role:context.kind==='video'?'video_playback':'image_display',bytes:(async function*(){yield bytes;})(),expectedBytes:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex'),
   validate:async()=>({format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:context.kind==='video'})});
  return {association:{protocol:'media-association-v1',profileId:'synthetic-unified-content-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-cup'}};
 }};
 const media=new SqliteMediaService({storage:f.storage,contacts:f.contacts,history:f.service,userData:f.root,adapters:[adapter],holders});await media.initialize();
 const content={registry:createBuiltinMemoryContentRegistry(),resources:{readImage:input=>media.readMemoryImage(input)}};
 if(fileContent)content.registry.register(fileMemoryContent);
 if(visualContent)content.registry.register(visualMemoryContent);
 f.channel.page=async(_scope,target)=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[...records],completedPartitions:['shard-a'],exhausted:true});
 const requests=[],documentRequests=[],failures=[],sourceMessages=new Map(),normal=supplier();let extraction;
 const extractionResponse=async(request,input)=>{
  requests.push(request);const body=JSON.parse(request.user);
  if(request.purpose==='extraction'){
   for(const message of body.messages)sourceMessages.set(message.message_id,message);
   const image=body.messages.find(message=>message.image_id&&body.target_message_ids.includes(message.message_id));
   if(!image)return normal.respond({...request,user:JSON.stringify({...body,messages:body.messages.filter(message=>body.target_message_ids.includes(message.message_id))})},input);
   const caption=body.messages.find(message=>message.text==='这是我家的蓝色杯子。');assert.ok(caption,'图文共同来源须包含实际说明文字');
   return tool(request.tool.name,{scenes:[{scene_name:'合成生活资料',memories:[{text:imageStatement,subject:'contact',category:'common_fact',topic:'other',source_message_ids:[caption.message_id,image.message_id],confidence:0.8,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'说明文字确定归属，图片支持物体外观。',event:null,conditions:null}]}]});
  }
  if(!request.images?.length)return normal.respond(request,input);
  return tool(request.tool.name,{results:body.candidates.map((candidate,candidate_index)=>{
   const refs=candidate.source_message_ids.map(id=>{const message=sourceMessages.get(id);return message.image_id?{kind:'image',message_id:id,quote:null,description:'实际附图中可见一个蓝色杯子。'}:{kind:'text',message_id:id,quote:message.text,description:null};});
   return {candidate_index,verdict:'supported',issues:[],evidence:refs,scope_subject:'contact',actor_kind:'contact',resolution:'explicit',checks:['attribution','body','temporal_and_modality',...fields].map(field=>({field,verdict:'supported',evidence_indices:refs.map((_,i)=>i),explanation:'固定合成图文共同支持这一条主张。'}))};
  })});
 };
 const adjudicationRequests=[];
 const adjudicationResponse=async(request,input)=>{
  adjudicationRequests.push({...request,contactId:input.scope.contact_id});const body=JSON.parse(request.user);
  if(request.purpose==='adjudication'){
   const candidate=body.new_memories[0],ids=body.existing_memories.map(memory=>memory.memory_id),selected=action==='merge'&&ids.length>=2?'merge':'add';
   return tool(request.tool.name,{decisions:[{candidate_index:0,action:selected,replaced_memory_id:null,merged_memory_ids:selected==='merge'?ids:[],merged_text:selected==='merge'?mergedText:null,duplicate_memory_id:null,
    relation:{kind:selected==='merge'?'supplement':'independent',related_memory_ids:ids,explanation:'本次真实附图和原文支持拟用关系。',evidence:candidate.source_texts.map(evidence),claim_changed:false,condition_changed:false}}]});
  }
  if(request.purpose==='relation_verification')return tool(request.tool.name,{results:body.map(item=>({candidate_index:item.candidate_index,supported:true,evidence:[...item.sources.candidate,...item.sources.prior.flatMap(memory=>memory.sources)].map(evidence),claim_changed:false,condition_changed:false}))});
  if(request.purpose==='merge_verification')return tool(request.tool.name,{supported:true,text:body.target_text,evidence:[...body.candidate_and_parents.sources.candidate,...body.candidate_and_parents.sources.prior.flatMap(memory=>memory.sources)].map(evidence)});
  throw new Error('合成裁决收到未登记用途');
 };
 const documentResponse=async request=>{
  documentRequests.push(request);const body=JSON.parse(request.messages[0].content[0].text),names=request.tools.map(item=>item.name);
  const memory=body.memories.find(item=>(item.text??item.verbatim_text).includes(preferredText))??body.memories[0];
  if(names.includes('ScenarioVerificationOutput'))return tool('ScenarioVerificationOutput',{results:body.proposal.scenarios.flatMap((scene,scenario_index)=>scene.paragraphs.map((_,paragraph_index)=>({scenario_index,paragraph_index,supported:true,evidence:[{memory_id:memory.memory_id,quote:memory.text}]})))});
  if(names.includes('ProfileVerificationOutput'))return tool('ProfileVerificationOutput',{results:body.proposal.entries.map((_,entry_index)=>({entry_index,supported:true,evidence:[{memory_id:memory.memory_id,quote:memory.verbatim_text}]}))});
  if(body.layer==='l2')return request.messages.length===1?tool('write',{path:'life.md',content:`<!-- META ${JSON.stringify({topic_key:'life',title:'合成生活资料',hint:'已核验的合成生活资料'})} -->\n\n${memory.text}\n<!-- SOURCES ${JSON.stringify([{memory_id:memory.memory_id,revision:memory.revision}])} -->`}):{blocks:[]};
  if(body.layer==='l3')return request.messages.length===1?tool('write',{path:'profile.md',content:`# 长期背景\n\n<!-- ENTRY ${JSON.stringify({kind:'fact',section:'interests',basis:'正式记忆直接记载。',temporal_status:'stable',uncertainty:'',references:[{memory_id:memory.memory_id,revision:memory.revision}]})} -->\n${memory.text}`}):tool('ProfileProposalComplete',{});
  throw new Error('合成文档收到未登记用途');
 };
 const observedStorage={execute:async(name,input)=>{try{return await f.storage.execute(name,input);}catch(error){failures.push({action:name,code:error.code??String(error)});throw error;}}};
 const adjudication=new SqliteMemoryAdjudication(observedStorage,owner,modelPort(()=>extraction.accounting,adjudicationResponse),holders,content);
 const documents=new SqliteMemoryDocuments(observedStorage,owner,modelPort(()=>extraction.accounting,documentResponse),holders);
 extraction=new SqliteMemoryExtraction(observedStorage,owner,modelPort(()=>extraction.accounting,extractionResponse),holders,async runId=>{await adjudication.publishRun(runId);await documents.publishRun(runId);},undefined,undefined,content);
 const management=new SqliteMemoryManagement(f.storage,owner);
 t.after(async()=>{await extraction.close();await adjudication.close();await documents.close();await media.close();await f.service.close();await f.contacts.close();});
 async function sync(next){records.push(...next);await f.contacts.setReading(true);await f.service.synchronize(contactId);return (await f.service.read(contactId)).messages;}
 async function run(){await f.contacts.setReading(false);const run=await extraction.start(randomUUID());await extraction.waitForIdle(run.runId);return extraction.read(run.runId);}
 async function addImage(){const messages=await sync([record('20',{text:'这是我家的蓝色杯子。'}),record('21',{kind:'image',text:null,originalType:'3'}),record('22',{kind:'voice',text:null,originalType:'34'}),record('23',{kind:'video',text:null,originalType:'43'}),record('24',{kind:'sticker',text:null,originalType:'47'})]);const message=messages.find(item=>item.kind==='image');const saved=await media.extract(contactId,message.id,{requestKey:randomUUID(),goal:'extract'});return {message,file:saved.files[0],messages};}
 return {...f,owner,contactId,scope,holders,media,extraction,adjudication,documents,management,deletion:new DeletionService(f.storage,holders,new ManagedFiles(f.root)),requests,adjudicationRequests,documentRequests,failures,sync,run,addImage,read:()=>management.read(scope)};
}
