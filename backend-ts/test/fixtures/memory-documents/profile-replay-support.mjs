import {unknownFixture} from './unknown-support.mjs';
import {modelPort} from '../memory-sqlite/support.mjs';
import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';
import {ActiveHolders} from '../../../src/storage/sqlite/deletion/holders.ts';
import {SqliteMemoryDocuments} from '../../../src/memory/sqlite/documents/service.ts';

/** 真实存储链路保存旧版的“任一拒绝整份失败”；只在物理模型边界使用合成回复。 */
export async function profileReplayFixture(t,{retryFirstQuote=false,initialSceneCount=1,initialOldGuard=true}={}){
 let documents,oldGuard=initialOldGuard,fixture,mergeScenes=false;const calls=[],firstMemory=new Map(),verificationAttempts=new Map();
 fixture=await unknownFixture(t,{unknownScope:'none',registryModule:new URL('./profile-replay-registry.mjs',import.meta.url).href,beforeDocuments:async runId=>{
  if(!documents){
   const storage={execute:async(name,input)=>{if(name==='memoryDocuments.saveProfile'&&oldGuard)throw new StorageFailure('document_profile_unverified');return fixture.storage.execute(name,input);}};
   const port=modelPort(()=>fixture.extraction.accounting,async(request,input)=>{
    const payload=JSON.parse(request.messages[0].content[0].text),names=request.tools.map(tool=>tool.name),scope=input.scope.contact_id;
    const memory=payload.memories.find(item=>item.memory_id===firstMemory.get(scope))??payload.memories[0];firstMemory.set(scope,memory.memory_id);
    calls.push({id:input.attemptId,scope,stage:input.claim.step_name});
    const block=(name,args,index=0)=>({type:'tool-call',id:`synthetic-replay-${calls.length}-${index}`,name,arguments:JSON.stringify(args)}),tool=(name,args)=>({blocks:[block(name,args)]});
    if(names.includes('ScenarioVerificationOutput'))return tool('ScenarioVerificationOutput',{results:payload.proposal.scenarios.flatMap((scene,scenario_index)=>scene.paragraphs.map((_,paragraph_index)=>({scenario_index,paragraph_index,supported:true,evidence:[{memory_id:memory.memory_id,quote:memory.text}]})))});
    if(names.includes('ProfileVerificationOutput')){
     const attempt=(verificationAttempts.get(input.claim.step_id)??0)+1;verificationAttempts.set(input.claim.step_id,attempt);
     return tool('ProfileVerificationOutput',{results:payload.proposal.entries.map((entry,entry_index)=>({entry_index,supported:entry.kind!=='inference',evidence:entry.kind==='inference'?[]:[{memory_id:memory.memory_id,quote:retryFirstQuote&&attempt===1?'这句合成引文不在任何记忆里。':memory.verbatim_text}]}))});
    }
    if(payload.layer==='l2'){
     const content=(topic,replaces=[])=>`<!-- META ${JSON.stringify({topic_key:topic,title:'合成重放',hint:'合成资料',replaces})} -->\n\n${memory.text}\n<!-- SOURCES ${JSON.stringify([{memory_id:memory.memory_id,revision:memory.revision}])} -->`;
     if(mergeScenes&&payload.documents.length===2){
      if(request.messages.length===1)return {blocks:payload.documents.map((item,index)=>block('read',{path:item.path},index))};
      if(!request.messages.some(message=>message.role==='assistant'&&message.content?.some(item=>item.name==='write')))return {blocks:[block('write',{path:payload.documents[0].path,content:content('replay_merged',payload.documents.map(item=>item.version_id))}),block('write',{path:payload.documents[1].path,content:'[DELETED]'},1)]};
      return {blocks:[]};
     }
     return request.messages.length===1?{blocks:Array.from({length:initialSceneCount},(_,index)=>block('write',{path:`replay-${index}.md`,content:content(`replay_${index}`)},index))}:{blocks:[]};
    }
    if(payload.layer==='l3'){
     const ref=[{memory_id:memory.memory_id,revision:memory.revision}],entry=(kind,section,text,uncertainty)=>`<!-- ENTRY ${JSON.stringify({kind,section,basis:'合成基础记忆。',temporal_status:uncertainty?'uncertain':'stable',uncertainty,references:ref})} -->\n${text}`;
     return request.messages.length===1?tool('write',{path:'profile.md',content:'# 长期背景\n\n'+entry('fact','interests',memory.text,'')+'\n\n'+entry('inference','insights','联系人可能喜欢合成重放。','合成例故意无法支持。')}):tool('ProfileProposalComplete',{});
    }
    throw Error('unexpected synthetic profile replay request');
   });
   documents=new SqliteMemoryDocuments(storage,fixture.owner,port,new ActiveHolders());t.after(()=>documents.close());
  }
  await documents.publishRun(runId);
 }});
 await fixture.add(fixture.a,[fixture.record('1',{text:'我长期喜欢合成园艺。'})]);
 const run=await fixture.extraction.start('synthetic-old-profile-guard');await fixture.extraction.waitForIdle(run.runId);
 const task=(await fixture.extraction.read(run.runId)).tasks.find(item=>item.scopeKind==='contact'&&item.contactId===fixture.a);
 oldGuard=false;
 return {...fixture,documents,runId:run.runId,taskId:task.taskId,modelCalls:calls,setOldGuard:value=>{oldGuard=value;},setMergeScenes:value=>{mergeScenes=value;}};
}
