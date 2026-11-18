import {unknownFixture} from './unknown-support.mjs';
import {modelPort} from '../memory-sqlite/support.mjs';
import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';
import {ActiveHolders} from '../../../src/storage/sqlite/deletion/holders.ts';
import {SqliteMemoryDocuments} from '../../../src/memory/sqlite/documents/service.ts';

/**
 * 走正常阶段路径到“画像已保存、发布被中断”：真实存储链路完整执行场景与画像阶段，
 * 只在物理模型边界使用合成回复，并让首次 memoryDocuments.publish 以合成故障中断。
 */
export async function profilePublicationFixture(t,{initialSceneCount=1}={}){
 let documents,fixture,interruptPublish=true;const calls=[],firstMemory=new Map();
 fixture=await unknownFixture(t,{unknownScope:'none',registryModule:new URL('./profile-publication-registry.mjs',import.meta.url).href,beforeDocuments:async runId=>{
  if(!documents){
   const port=modelPort(()=>fixture.extraction.accounting,async(request,input)=>{
    const payload=JSON.parse(request.messages[0].content[0].text),names=request.tools.map(tool=>tool.name),scope=input.scope.contact_id;
    const memory=payload.memories.find(item=>item.memory_id===firstMemory.get(scope))??payload.memories[0];firstMemory.set(scope,memory.memory_id);
    calls.push({id:input.attemptId,scope,stage:input.claim.step_name});
    const block=(name,args,index=0)=>({type:'tool-call',id:`synthetic-replay-${calls.length}-${index}`,name,arguments:JSON.stringify(args)}),tool=(name,args)=>({blocks:[block(name,args)]});
    if(names.includes('ScenarioVerificationOutput'))return tool('ScenarioVerificationOutput',{results:payload.proposal.scenarios.flatMap((scene,scenario_index)=>scene.paragraphs.map((_,paragraph_index)=>({scenario_index,paragraph_index,supported:true,evidence:[{memory_id:memory.memory_id,quote:memory.text}]})))});
    if(names.includes('ProfileVerificationOutput')){
     return tool('ProfileVerificationOutput',{results:payload.proposal.entries.map((entry,entry_index)=>({entry_index,supported:entry.kind!=='inference',evidence:entry.kind==='inference'?[]:[{memory_id:memory.memory_id,quote:memory.verbatim_text}]}))});
    }
    if(payload.layer==='l2'){
     const content=(topic,replaces=[])=>`<!-- META ${JSON.stringify({topic_key:topic,title:'合成重放',hint:'合成资料',replaces})} -->\n\n${memory.text}\n<!-- SOURCES ${JSON.stringify([{memory_id:memory.memory_id,revision:memory.revision}])} -->`;
     return request.messages.length===1?{blocks:Array.from({length:initialSceneCount},(_,index)=>block('write',{path:`replay-${index}.md`,content:content(`replay_${index}`)},index))}:{blocks:[]};
    }
    if(payload.layer==='l3'){
     const ref=[{memory_id:memory.memory_id,revision:memory.revision}],entry=(kind,section,text,uncertainty)=>`<!-- ENTRY ${JSON.stringify({kind,section,basis:'合成基础记忆。',temporal_status:uncertainty?'uncertain':'stable',uncertainty,references:ref})} -->\n${text}`;
     return request.messages.length===1?tool('write',{path:'profile.md',content:'# 长期背景\n\n'+entry('fact','interests',memory.text,'')+'\n\n'+entry('inference','insights','联系人可能喜欢合成重放。','合成例故意无法支持。')}):tool('ProfileProposalComplete',{});
    }
    throw Error('unexpected synthetic profile replay request');
   });
   documents=new SqliteMemoryDocuments(fixture.storage,fixture.owner,port,new ActiveHolders());t.after(()=>documents.close());
  }
  await documents.publishRun(runId);
 }});
 // 画像已保存后，夹具自带的服务与此处的服务都会走到发布；统一在存储边界让发布以合成故障中断。
 const execute=fixture.storage.execute.bind(fixture.storage);
 fixture.storage.execute=async(name,input)=>{if(name==='memoryDocuments.publish'&&interruptPublish)throw new StorageFailure('synthetic_publish_interrupted');return execute(name,input);};
 await fixture.add(fixture.a,[fixture.record('1',{text:'我长期喜欢合成园艺。'})]);
 const run=await fixture.extraction.start('synthetic-profile-publication');await fixture.extraction.waitForIdle(run.runId);
 const task=(await fixture.extraction.read(run.runId)).tasks.find(item=>item.scopeKind==='contact'&&item.contactId===fixture.a);
 interruptPublish=false;
 return {...fixture,documents,runId:run.runId,taskId:task.taskId,modelCalls:calls};
}
