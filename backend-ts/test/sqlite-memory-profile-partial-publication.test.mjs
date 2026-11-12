import test from 'node:test';
import assert from 'node:assert/strict';
import {deletionFixture} from './fixtures/memory-documents/deletion-support.mjs';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {record} from './fixtures/memory-sqlite/support.mjs';
import {randomUUID} from 'node:crypto';

const tool=(name,value)=>({blocks:[{type:'tool-call',id:'synthetic-partial-profile',name,arguments:JSON.stringify(value)}]});

/** 仅替换合成模型回答；输入冻结、核验解析、SQLite发布与删除都走正式服务。 */
async function partialFixture(t,{reject=[13],entryCount=16,malformed,manualBody='这是一条单独的合成手工背景记忆。'}={}){
 const control={reject:new Set(reject),entryCount,entries:[],packets:[],malformed,sceneRevision:0,label:'合成画像',preferMemoryId:null,emptyExtraction:false};
 const f=await deletionFixture(t,{extractionResponse:async request=>control.emptyExtraction&&request.purpose==='extraction'?tool(request.tool.name,{scenes:[]}):undefined,documentResponse:async({request,payload})=>{
  const names=request.tools.map(x=>x.name);
  if(names.includes('ScenarioVerificationOutput'))return tool('ScenarioVerificationOutput',{results:payload.proposal.scenarios.flatMap((scene,scenario_index)=>scene.paragraphs.map((paragraph,paragraph_index)=>({scenario_index,paragraph_index,supported:true,evidence:paragraph.references.map(ref=>({memory_id:ref.memory_id,quote:payload.memories.find(m=>m.memory_id===ref.memory_id).text}))})))});
  if(names.includes('ProfileVerificationOutput')){
   await control.beforeVerification?.();
   control.entries=structuredClone(payload.proposal.entries);
   const results=payload.proposal.entries.map((entry,entry_index)=>({entry_index,supported:!control.reject.has(entry_index),evidence:control.reject.has(entry_index)?[]:entry.references.map(ref=>({memory_id:ref.memory_id,quote:payload.memories.find(m=>m.memory_id===ref.memory_id).verbatim_text}))}));
   if(control.malformed==='missing')results.pop();
   if(control.malformed==='duplicate')results[1].entry_index=results[0].entry_index;
   if(control.malformed==='quote')results[0].evidence[0].quote='这句合成引文不在任何记忆里。';
   if(control.reverseResults)results.reverse();
   const packet={results};control.packets.push(structuredClone(packet));return tool('ProfileVerificationOutput',packet);
  }
  if(payload.layer==='l2'&&control.sceneRevision){
   if(request.messages.length>1)return {blocks:[]};
   const m=payload.memories.find(x=>x.memory_id===control.sceneMemoryId)??payload.memories[0];
   return tool('write',{path:'garden.md',content:`<!-- META ${JSON.stringify({topic_key:'garden',title:'合成园艺',hint:'长期园艺偏好'})} -->\n\n${m.text}（合成场景第${control.sceneRevision}次更新。）\n<!-- SOURCES ${JSON.stringify([{memory_id:m.memory_id,revision:m.revision}])} -->`});
  }
  if(payload.layer==='l3'){
   if(request.messages.length>1)return tool('ProfileProposalComplete',{});
   const entries=control.entryFactory?.(payload)??Array.from({length:control.entryCount},(_,index)=>{
    const m=payload.memories.find(x=>x.memory_id===control.preferMemoryId)??payload.memories[index%payload.memories.length];
    return {text:`${control.label}第${String(index+1).padStart(2,'0')}条：${m.text}`,kind:'fact',section:'life_context',basis:'对应冻结的合成记忆。',temporal_status:'stable',uncertainty:'',references:[{memory_id:m.memory_id,revision:m.revision}]};
   });
   return tool('write',{path:'profile.md',content:'# 长期背景\n\n'+entries.map(({text,...meta})=>`<!-- ENTRY ${JSON.stringify(meta)} -->\n${text}`).join('\n\n')});
  }
 }});
 // 两个不同记忆版本交替引用，才能发现删除中间条目后尾部证据错位。
 const manual=await new SqliteMemoryManagement(f.storage,f.owner).decide({requestKey:'partial-profile-second-memory',action:'manual',scope:{scopeKind:'contact',contactId:f.contactId},body:manualBody});
 return {...f,control,manualMemoryId:manual.memoryId};
}

async function runFixture(f,key){
 const run=await f.extraction.start(key);await f.extraction.waitForIdle(run.runId);
 const task=(await f.extraction.read(run.runId)).tasks.find(x=>x.contactId===f.contactId);
 return {run,task,state:await f.documents.readTask(task.taskId),view:await f.documents.read({scopeKind:'contact',contactId:f.contactId})};
}

test('L3逐条核验16项中拒绝第14项，其他15项按原引证绑定发布',async t=>{
 const f=await partialFixture(t),result=await runFixture(f,'profile-partial-middle');
 const profile=result.view.documents.find(x=>x.kind==='profile');
 assert.equal(f.control.entries.length,16);assert.equal(f.control.packets.length,1);
 if(!profile)t.diagnostic(JSON.stringify(result.state.stages.map(({kind,status,errorCode})=>({kind,status,errorCode}))));
 assert.ok(profile,'一条不受支持不应阻止其余合法条目发布');
 assert.equal(profile.statements.length,15);
 assert.deepEqual(result.view.profileSelection,{accepted:15,rejected:1,retained:0});
 const expected=f.control.entries.filter((_,index)=>index!==13);
 assert.deepEqual(profile.statements.map(x=>x.text),expected.map(x=>x.text));
 for(const [index,statement] of profile.statements.entries()){
  assert.deepEqual(statement.references.map(r=>({memory_id:r.memory_id,revision:r.revision})),expected[index].references.map(r=>({memory_id:r.memory_id,revision:r.revision})));
 }
 assert.equal(result.state.outcome,'completed');
 const trace=await f.extraction.trace(result.task.taskId);
 const original=trace.events.filter(e=>e.kind==='document_output').flatMap(e=>(e.payload.blocks??[]).filter(b=>b.name==='ProfileVerificationOutput').map(b=>JSON.parse(b.arguments)));
 assert.equal(original.length,1);assert.deepEqual(original,f.control.packets,'发布筛选不得改写原始模型核验回执');
 assert.equal(original[0].results.length,16);assert.equal(original[0].results[13].supported,false);
 const knowledge=await f.storage.execute('fixture.documentKnowledge',{ownerId:f.owner,contactId:f.contactId,discussionId:randomUUID()});
 assert.ok(knowledge.some(x=>x.text.includes('合成画像第01条')),'正式回复资料读取也须接受这份部分通过的画像');
 assert.ok(knowledge.every(x=>!x.text.includes('合成画像第14条')),'被拒条目不得进入回复资料');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('核验结果合法逆序返回时仍按entry_index发布原提案顺序',async t=>{
 const f=await partialFixture(t,{reject:[],entryCount:3});f.control.reverseResults=true;
 const result=await runFixture(f,'profile-reverse-verification-results');
 assert.deepEqual(f.control.packets[0].results.map(x=>x.entry_index),[2,1,0]);
 const profile=result.view.documents.find(x=>x.kind==='profile');assert.ok(profile);
 assert.deepEqual(profile.statements.map(x=>x.text),f.control.entries.map(x=>x.text));
 assert.deepEqual(result.view.profileSelection,{accepted:3,rejected:0,retained:0});
 assert.equal(result.state.outcome,'completed');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('L3全部条目不受支持时按无新增收尾，只发布场景而不创建空画像',async t=>{
 const f=await partialFixture(t,{reject:Array.from({length:16},(_,i)=>i)}),result=await runFixture(f,'profile-all-rejected');
 assert.equal(f.control.packets.length,1);assert.equal(f.control.packets[0].results.filter(x=>x.supported).length,0);
 assert.equal(result.state.outcome,'completed','全部内容拒绝不得伪装成技术或任务故障');
 assert.deepEqual(result.view.documents.map(x=>x.kind),['scene']);
 assert.equal(result.view.publication.members.length,1);
 assert.deepEqual(result.view.profileSelection,{accepted:0,rejected:16,retained:0});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('已有有效L3的更新全部未获支持时保留旧画像，不删除或替换旧正文',async t=>{
 const f=await partialFixture(t,{reject:[],entryCount:1}),first=await runFixture(f,'profile-existing-first');
 const old=first.view.documents.find(x=>x.kind==='profile');assert.ok(old);
 f.control.reject=new Set([0]);f.control.label='未通过更新';f.control.sceneRevision=1;f.control.emptyExtraction=true;
 f.control.preferMemoryId=old.statements[0].references[0].memory_id;
 await new SqliteMemoryManagement(f.storage,f.owner).decide({requestKey:'partial-profile-new-manual-background',action:'manual',scope:{scopeKind:'contact',contactId:f.contactId},body:'合成新增的正式背景，用于推进文档记忆修订。'});
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('2',{text:'合成例行问候。',sentAt:'1700000001000'})],completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.service.synchronize(f.contactId);await f.contacts.setReading(false);
 const second=await runFixture(f,'profile-existing-rejected-update');
 assert.equal(f.control.packets.length,2,'第二轮必须实际抵达画像核验');
 assert.equal(f.control.packets.at(-1).results[0].supported,false);
 assert.equal(second.state.outcome,'completed');
 const current=second.view.documents.find(x=>x.kind==='profile');assert.deepEqual(current,old);
 assert.deepEqual(second.view.profileSelection,{accepted:0,rejected:1,retained:1});
 assert.notEqual(second.view.publication.id,first.view.publication.id,'新场景仍应形成新的完整发布集合');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('新条目通过但旧条目改写未通过时，只加入新条目并保留旧有效内容',async t=>{
 const f=await partialFixture(t,{reject:[],entryCount:1}),first=await runFixture(f,'profile-mixed-update-first');
 const old=first.view.documents.find(x=>x.kind==='profile');assert.ok(old);
 const added=await new SqliteMemoryManagement(f.storage,f.owner).decide({requestKey:'partial-profile-mixed-update-memory',action:'manual',scope:{scopeKind:'contact',contactId:f.contactId},body:'用户手工录入的另一条合成长期背景。'});
 const priorMemoryId=old.statements[0].references[0].memory_id;assert.ok(added.memoryId);
 f.control.reject=new Set([0]);f.control.sceneRevision=2;f.control.sceneMemoryId=added.memoryId;f.control.emptyExtraction=true;
 f.control.entryFactory=payload=>[
  {text:'未获支持的旧条目替换内容。',id:priorMemoryId},
  {text:'核验通过的新条目。',id:added.memoryId},
 ].map(({text,id})=>{const m=payload.memories.find(x=>x.memory_id===id);assert.ok(m);return {text,kind:'fact',section:'life_context',basis:'对应冻结的合成记忆。',temporal_status:'stable',uncertainty:'',references:[{memory_id:m.memory_id,revision:m.revision}]};});
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('2',{text:'另一条合成例行问候。',sentAt:'1700000002000'})],completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.service.synchronize(f.contactId);await f.contacts.setReading(false);
 const second=await runFixture(f,'profile-mixed-update-second');
 if(f.control.packets.length!==2)t.diagnostic(JSON.stringify(second.state.stages.map(({kind,status,errorCode})=>({kind,status,errorCode}))));
 assert.equal(f.control.packets.length,2);assert.deepEqual(f.control.packets.at(-1).results.map(x=>x.supported),[false,true]);
 assert.equal(second.state.outcome,'completed');
 const current=second.view.documents.find(x=>x.kind==='profile');assert.ok(current);
 assert.deepEqual(second.view.profileSelection,{accepted:1,rejected:1,retained:1});
 assert.deepEqual(new Set(current.statements.map(x=>x.text)),new Set([...old.statements.map(x=>x.text),'核验通过的新条目。']));
 assert.ok(!current.statements.some(x=>x.text==='未获支持的旧条目替换内容。'));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('同一L1支持两个事实时，新事实通过不得吞掉改写被拒的旧事实',async t=>{
 const f=await partialFixture(t,{reject:[],entryCount:1,manualBody:'合成联系人长期喜欢园艺，并且每周照料盆栽。'});
 const entry=(payload,text)=>{const m=payload.memories.find(x=>x.memory_id===f.manualMemoryId);assert.ok(m);return {text,kind:'fact',section:'interests',basis:'对应同一条冻结记忆中的明确事实。',temporal_status:'stable',uncertainty:'',references:[{memory_id:m.memory_id,revision:m.revision}]};};
 f.control.entryFactory=payload=>[entry(payload,'合成联系人长期喜欢园艺。')];
 const first=await runFixture(f,'profile-shared-source-first'),old=first.view.documents.find(x=>x.kind==='profile');assert.ok(old);
 await new SqliteMemoryManagement(f.storage,f.owner).decide({requestKey:'partial-profile-shared-source-trigger',action:'manual',scope:{scopeKind:'contact',contactId:f.contactId},body:'合成新增背景，用于触发下一轮主题整理。'});
 f.control.reject=new Set([0]);f.control.sceneRevision=3;f.control.sceneMemoryId=f.manualMemoryId;f.control.emptyExtraction=true;
 f.control.entryFactory=payload=>[entry(payload,'合成联系人长期讨厌园艺。'),entry(payload,'合成联系人每周照料盆栽。')];
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('2',{text:'同源反例的合成例行问候。',sentAt:'1700000003000'})],completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.service.synchronize(f.contactId);await f.contacts.setReading(false);
 const second=await runFixture(f,'profile-shared-source-second');
 assert.equal(f.control.packets.length,2);assert.deepEqual(f.control.packets.at(-1).results.map(x=>x.supported),[false,true]);
 assert.equal(second.state.outcome,'completed');
 const current=second.view.documents.find(x=>x.kind==='profile');assert.ok(current);
 assert.deepEqual(new Set(current.statements.map(x=>x.text)),new Set(['合成联系人长期喜欢园艺。','合成联系人每周照料盆栽。']),'同一来源身份不是两个语义条目互相替换的授权');
 assert.deepEqual(second.view.profileSelection,{accepted:1,rejected:1,retained:1});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('保留旧有效条目后超过L3预算时不删旧条目，也不放宽发布预算',async t=>{
 const f=await partialFixture(t,{reject:[],entryCount:16,manualBody:'合成联系人长期喜欢园艺，并且每周照料盆栽。'});
 const first=await runFixture(f,'profile-retained-budget-first'),old=first.view.documents.find(x=>x.kind==='profile');assert.equal(old?.statements.length,16);
 await new SqliteMemoryManagement(f.storage,f.owner).decide({requestKey:'partial-profile-retained-budget-trigger',action:'manual',scope:{scopeKind:'contact',contactId:f.contactId},body:'合成新增背景，仅用于推进整理修订。'});
 f.control.reject=new Set([0]);f.control.sceneRevision=4;f.control.sceneMemoryId=f.manualMemoryId;f.control.emptyExtraction=true;
 f.control.entryFactory=payload=>{const m=payload.memories.find(x=>x.memory_id===f.manualMemoryId);assert.ok(m);return ['合成联系人长期讨厌园艺。','合成联系人每周照料盆栽。'].map(text=>({text,kind:'fact',section:'interests',basis:'对应冻结的合成记忆。',temporal_status:'stable',uncertainty:'',references:[{memory_id:m.memory_id,revision:m.revision}]}));};
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('2',{text:'预算反例的合成例行问候。',sentAt:'1700000004000'})],completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.service.synchronize(f.contactId);await f.contacts.setReading(false);
 const second=await runFixture(f,'profile-retained-budget-second');
 assert.equal(f.control.packets.length,2);assert.deepEqual(f.control.packets.at(-1).results.map(x=>x.supported),[false,true]);
 assert.equal(second.state.outcome,'incomplete');
 assert.equal(second.state.stages.find(x=>x.kind==='profile').errorCode,'l3_profile_budget_exceeded');
 assert.deepEqual(second.view.documents.find(x=>x.kind==='profile'),old,'预算不足不得静默删除仍有效的旧内容以挤入新条目');
 assert.equal(second.view.publication.id,first.view.publication.id);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

for(const malformed of ['missing','duplicate','quote'])test(`L3逐条发布仍拒绝${malformed}核验协议，不以筛掉失败项掩盖坏包`,async t=>{
 const f=await partialFixture(t,{reject:[],entryCount:3,malformed}),result=await runFixture(f,`profile-malformed-${malformed}`);
 const stage=result.state.stages.find(x=>x.kind==='profile');
 assert.equal(stage.status,'failed');assert.ok(stage.errorCode);assert.notEqual(stage.errorCode,'document_profile_unverified');
 assert.equal(result.state.outcome,'incomplete');assert.equal(result.view.documents.filter(x=>x.kind==='profile').length,0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('部分通过发布的L3继续受正式来源删除闭包约束',async t=>{
 const f=await partialFixture(t),result=await runFixture(f,'profile-partial-delete-source');
 assert.equal(result.view.documents.find(x=>x.kind==='profile')?.statements.length,15);
 const plan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactId,sourceId:f.message.sourceRecordIds[0]}});
 assert.equal((await f.deletion.advance({ownerId:f.owner,operationId:plan.operationId})).state,'completed');
 assert.equal((await f.documents.read({scopeKind:'contact',contactId:f.contactId})).documents.filter(x=>x.kind==='profile').length,0);
 const erased=await f.storage.execute('fixture.documentErasure',{ownerId:f.owner,text:'合成画像第'});
 assert.equal(Number(erased.statements),0);assert.equal(Number(erased.events),0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('核验调用中撤销联系人授权，已通过子集也不能绕过当前发布资格',async t=>{
 const f=await partialFixture(t);
 const binding=f.saved.find(x=>x.contact_id===f.contactId);
 f.control.beforeVerification=()=>f.contacts.revoke(f.contactId,binding.binding_id,binding.selection_generation);
 const result=await runFixture(f,'profile-partial-revoke');
 assert.equal(f.control.packets.length,1,'必须实际在核验调用期间撤销授权');
 assert.notEqual(result.state.outcome,'completed');
 assert.equal(result.view.documents.filter(x=>x.kind==='profile').length,0);
 assert.equal((await f.extraction.readContact(f.contactId)).run,null);
 assert.equal((await f.documents.read({scopeKind:'contact',contactId:f.contactId})).documents.filter(x=>x.kind==='profile').length,0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
