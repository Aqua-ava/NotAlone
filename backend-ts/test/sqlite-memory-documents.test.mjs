import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, modelPort, owner} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryAdjudication} from '../src/memory/sqlite/management/adjudication-service.ts';
import {SqliteMemoryDocuments} from '../src/memory/sqlite/documents/service.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';

test('正常处理无新记忆时仍在前置阶段后冻结零成员基线并记录不适用原因', async t => {
 const f=await fixture(t);
 await f.service.synchronize(f.saved[0].contact_id);
 await f.contacts.setReading(false);
 const holders=new ActiveHolders();
 let extraction;
 const adjudication=new SqliteMemoryAdjudication(f.storage,owner,undefined,holders);
 const documents=new SqliteMemoryDocuments(f.storage,owner,undefined,holders);
 extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting),holders,async runId=>{
  await adjudication.publishRun(runId);
  await documents.publishRun(runId);
 });
 t.after(async()=>{await extraction.close();await adjudication.close();await documents.close();});
 const run=await extraction.start('documents-empty-baseline');
 await extraction.waitForIdle();
 const task=(await extraction.read(run.runId)).tasks.find(item=>item.contactId===f.saved[0].contact_id);
 const state=await documents.readTask(task.taskId);
 assert.deepEqual(state.basis,{state:'frozen',memoryRevision:'0',documentRevision:'0',publicationId:null});
 assert.deepEqual(state.stages.map(({kind,status,reason})=>({kind,status,reason})),[
  {kind:'scene',status:'not_applicable',reason:'no_eligible_memories'},
  {kind:'profile',status:'not_applicable',reason:'no_eligible_memories'},
 ]);
 assert.equal(state.outcome,'completed');
 assert.equal((await extraction.read(run.runId)).state,'completed');
 const view=await documents.read({scopeKind:'contact',contactId:f.saved[0].contact_id});
 assert.equal(view.publication.members.length,0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('正常处理接续08新记忆，主题与长期背景验证后作为同一完整集合发布',async t=>{
 const {supplier}=await import('./fixtures/memory-management/supplier.mjs');
 const {adjudicationSupplier}=await import('./fixtures/memory-management/adjudication-support.mjs');
 const f=await fixture(t);f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[{
  partition:'shard-a',table:'table-instance-1',localId:'1',serverId:'0',sender:'contact',kind:'text',text:'我长期喜欢合成园艺。',originalType:'1',sentAt:'1700000000000',timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified',
 }],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(f.saved[0].contact_id);await f.contacts.setReading(false);
 const holders=new ActiveHolders(),seen=[];let extraction;
 const response=async request=>{
  const names=request.tools.map(item=>item.name),payload=JSON.parse(request.messages[0].content[0].text);
  const memory=payload.memories[0],tool=(name,args)=>({blocks:[{type:'tool-call',id:`synthetic-${seen.length}`,name,arguments:JSON.stringify(args)}]});
  seen.push(names);
  if(names.includes('ScenarioVerificationOutput'))return tool('ScenarioVerificationOutput',{results:payload.proposal.scenarios.flatMap((scene,si)=>scene.paragraphs.map((_,pi)=>({scenario_index:si,paragraph_index:pi,supported:true,evidence:[{memory_id:memory.memory_id,quote:memory.text}]})))});
  if(names.includes('ProfileVerificationOutput'))return tool('ProfileVerificationOutput',{results:payload.proposal.entries.map((_,entry_index)=>({entry_index,supported:true,evidence:[{memory_id:memory.memory_id,quote:memory.verbatim_text}]}))});
  if(payload.layer==='l2')return request.messages.length===1?tool('write',{path:'garden.md',content:`<!-- META ${JSON.stringify({topic_key:'garden',title:'合成园艺',hint:'长期园艺偏好'})} -->\n\n${memory.text}\n<!-- SOURCES ${JSON.stringify([{memory_id:memory.memory_id,revision:memory.revision}])} -->`}):{blocks:[]};
  if(payload.layer==='l3')return request.messages.length===1?tool('write',{path:'profile.md',content:`# 长期背景\n\n<!-- ENTRY ${JSON.stringify({kind:'fact',section:'interests',basis:'正式记忆直接记载。',temporal_status:'stable',uncertainty:'',references:[{memory_id:memory.memory_id,revision:memory.revision}]})} -->\n${memory.text}`}):tool('ProfileProposalComplete',{});
  throw new Error('unexpected synthetic document call');
 };
 const adjudication=new SqliteMemoryAdjudication(f.storage,owner,modelPort(()=>extraction.accounting,adjudicationSupplier()),holders);
 const documents=new SqliteMemoryDocuments(f.storage,owner,modelPort(()=>extraction.accounting,response),holders);
 extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,supplier().respond),holders,async runId=>{await adjudication.publishRun(runId);await documents.publishRun(runId);});
 t.after(async()=>{await extraction.close();await adjudication.close();await documents.close();});
 const run=await extraction.start('documents-real-memory');await extraction.waitForIdle();
 const task=(await extraction.read(run.runId)).tasks.find(item=>item.contactId===f.saved[0].contact_id);
 const state=await documents.readTask(task.taskId),view=await documents.read({scopeKind:'contact',contactId:f.saved[0].contact_id});
 assert.equal(state.basis.memoryRevision,'1');assert.equal(state.outcome,'completed');assert.equal((await extraction.read(run.runId)).laterStages,'completed');
 assert.deepEqual(state.stages.map(s=>s.status),['succeeded','succeeded']);
 assert.deepEqual(view.documents.map(d=>d.kind).sort(),['profile','scene']);
 assert.equal(view.publication.members.length,2);assert.ok(view.documents.every(d=>JSON.stringify(d).includes('联系人长期喜欢合成园艺。')));
 assert.ok(seen.some(names=>names.includes('ScenarioVerificationOutput'))&&seen.some(names=>names.includes('ProfileVerificationOutput')));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('冻结后人工改记忆使本轮冲突，不刷新原基线或重算',async t=>{
 const {documentFixture}=await import('./fixtures/memory-documents/support.mjs');let changed=false;
 const f=await documentFixture(t,{beforeCall:async({calls,contactId})=>{
  if(calls.length===1&&!changed){changed=true;await f.management.decide({requestKey:'concurrent-user-memory',action:'manual',scope:{scopeKind:'contact',contactId},body:'人工新增的并发合成资料。'});}
 }});
 const run=await f.extraction.start('documents-concurrent-memory');await f.extraction.waitForIdle();
 const task=(await f.extraction.read(run.runId)).tasks.find(item=>item.contactId===f.contactId);
 const state=await f.documents.readTask(task.taskId);assert.equal(state.basis.memoryRevision,'1');assert.equal(state.outcome,'incomplete');
 assert.equal(state.stages[0].status,'failed');assert.equal((await f.documents.read({scopeKind:'contact',contactId:f.contactId})).publication,null);
 await f.documents.publishRun(run.runId);assert.equal(f.calls.length,1);assert.equal((await f.documents.readTask(task.taskId)).basis.memoryRevision,'1');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('正常运行状态按实际主题和画像阶段显示进度',async t=>{
 const {documentFixture}=await import('./fixtures/memory-documents/support.mjs');
 const scene=Promise.withResolvers(),profile=Promise.withResolvers(),releaseScene=Promise.withResolvers(),releaseProfile=Promise.withResolvers();let heldScene=false,heldProfile=false;
 t.after(()=>{releaseScene.resolve();releaseProfile.resolve();});
 const f=await documentFixture(t,{beforeCall:async({request})=>{
  const data=JSON.parse(request.messages[0].content[0].text);
  if(data.layer==='l2'&&!heldScene){heldScene=true;scene.resolve();await releaseScene.promise;}
  if(data.layer==='l3'&&!heldProfile){heldProfile=true;profile.resolve();await releaseProfile.promise;}
 }});
 const run=await f.extraction.start('documents-stage-progress');await scene.promise;
 assert.equal((await f.extraction.read(run.runId)).stage,'document_scene');
 releaseScene.resolve();await profile.promise;
 assert.equal((await f.extraction.read(run.runId)).stage,'document_profile');
 releaseProfile.resolve();await f.extraction.waitForIdle(run.runId);
 assert.equal((await f.extraction.read(run.runId)).stage,'completed');
});

test('场景执行中普通暂停后不领取画像小批，继续后从画像边界完成发布',{timeout:20000},async t=>{
 const {documentFixture}=await import('./fixtures/memory-documents/support.mjs');
 const started=Promise.withResolvers();let runId,pauseOnce=false,paused=false;
 const f=await documentFixture(t,{beforeCall:async({request})=>{
  const data=JSON.parse(request.messages[0].content[0].text);
  if(data.layer==='l2'&&!pauseOnce){pauseOnce=true;await started.promise;await f.extraction.pause(runId);paused=true;}
 }});
 const run=await f.extraction.start('documents-pause-boundary');runId=run.runId;started.resolve();
 await f.extraction.waitForIdle(run.runId);
 assert.ok(paused,'测试必须在场景执行中实际请求暂停');
 const snapshot=await f.extraction.read(run.runId),task=snapshot.tasks.find(item=>item.contactId===f.contactId);
 assert.equal(snapshot.state,'paused');assert.notEqual(snapshot.state,'completed');
 const state=await f.documents.readTask(task.taskId);
 assert.equal(state.outcome,'incomplete');
 assert.deepEqual(state.stages.map(stage=>stage.kind),['scene'],'暂停后不得启动画像小批');
 assert.equal(state.stages[0].status,'succeeded');
 assert.equal(f.calls.filter(call=>call.claim.step_name==='document_profile').length,0);
 assert.equal((await f.documents.read({scopeKind:'contact',contactId:f.contactId})).publication,null);
 // 用户明确继续：从画像小批边界继续，最终仍发布同一完整集合
 await f.extraction.continue(run.runId);await f.extraction.waitForIdle(run.runId);
 const completed=await f.extraction.read(run.runId);assert.equal(completed.state,'completed');
 const final=await f.documents.readTask(task.taskId);
 assert.deepEqual(final.stages.map(stage=>stage.status),['succeeded','succeeded']);
 const view=await f.documents.read({scopeKind:'contact',contactId:f.contactId});
 assert.equal(view.publication.members.length,2);assert.equal(view.documents.length,2);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('正式SQLite profile中L1记忆立即进入回复，主题窗口未到期不调用文档模型',{timeout:30000},async t=>{
 const {watch}=await import('node:fs');const {readFile,writeFile,access}=await import('node:fs/promises');
 const {join,dirname,resolve}=await import('node:path');const {createServer}=await import('node:http');const {once}=await import('node:events');const {randomUUID}=await import('node:crypto');
 const {launchDsh}=await import('../src/launch.ts');const {documentProfileSupplier}=await import('./fixtures/memory-documents/profile-supplier.mjs');
 const cleanups=[];let host,provider,info;
 const f=await fixture({after:cleanup=>cleanups.push(cleanup)}),root=f.root,contactId=f.saved[0].contact_id;
 t.after(async()=>{
  if(host?.isRunning()){
   if(info)await fetch(`http://${info.address}/api/runtime/shutdown`,{method:'POST',headers:{Authorization:`Bearer ${info.token}`},signal:AbortSignal.timeout(2000)}).catch(()=>{});
   if(!await host.waitForExit(5000))await host.terminate();
  }
  if(provider){provider.closeAllConnections();await new Promise(done=>provider.close(done));}
  await f.service.close();await f.contacts.close();for(const cleanup of cleanups.reverse())await cleanup();await assert.rejects(access(root),{code:'ENOENT'});
 });
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[{partition:'shard-a',table:'table-instance-1',localId:'1',serverId:'0',sender:'contact',kind:'text',text:'我长期喜欢合成园艺。',originalType:'1',sentAt:'1700000000000',timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified'}],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);await f.contacts.setReading(false);const databaseId=f.storage.status.databaseId;
 await f.service.close();await f.contacts.close();await f.storage.close();
 const infoPath=join(root,'managed/sqlite-backend.info'),envFile=join(root,'synthetic.env'),audit=join(root,'synthetic-network.jsonl'),stderr=join(root,'synthetic-host.stderr'),wrapper=join(root,'synthetic-node');
 await writeFile(envFile,'NOTALONE_DEEPSEEK_API_KEY=synthetic-only\n',{mode:0o600,flag:'wx'});await writeFile(audit,'',{mode:0o600,flag:'wx'});await writeFile(stderr,'',{mode:0o600,flag:'wx'});
 const quote=value=>"'"+value.replaceAll("'","'\\''")+"'",guard=new URL('./fixtures/sqlite-memory-profile-network-guard.mjs',import.meta.url).pathname;
 await writeFile(wrapper,`#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(guard)} "$@" 2>> ${quote(stderr)}\n`,{mode:0o700,flag:'wx'});
 const supplier=documentProfileSupplier();provider=createServer(supplier.handler);provider.listen(0,'127.0.0.1');await once(provider,'listening');
 host=await launchDsh({nodeExecutable:wrapper,projectDirectory:resolve('..'),envFilePath:envFile,infoPath,businessHome:root,environment:{NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}`,NOTALONE_SYNTHETIC_NETWORK_AUDIT:audit},sqlite:{userData:root,expectedDatabaseId:databaseId,role:'test',capabilities:['contacts','history','discussions','memory']}},()=>true);
 const changed=(directory,probe,accept)=>new Promise((resolveValue,reject)=>{
  let ended=false,running=false,dirty=false;const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);watcher.close();error?reject(error):resolveValue(value);};
  const load=async()=>{if(ended)return;if(running){dirty=true;return;}running=true;try{const value=await probe();if(accept(value))finish(null,value);}catch(error){if(error.code!=='ENOENT')finish(error);}finally{running=false;if(dirty&&!ended){dirty=false;void load();}}};
  const watcher=watch(directory,()=>void load()),timer=setTimeout(()=>finish(new Error('合成正式宿主未在有界时间内就绪')),12000);void load();
 });
 info=await changed(dirname(infoPath),async()=>Object.fromEntries((await readFile(infoPath,'utf8')).trim().split('\n').map(line=>{const n=line.indexOf('=');return [line.slice(0,n),line.slice(n+1)];})),value=>Boolean(value.address&&value.token));
 const api=async(route,body,auth=true)=>{const response=await fetch(`http://${info.address}${route}`,{method:body===undefined?'GET':'POST',headers:auth?{Authorization:`Bearer ${info.token}`}:{},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(8000)});return {status:response.status,data:await response.json()};};
 assert.equal((await api('/api/memory-documents?scope_kind=self',undefined,false)).status,401);
 const started=await api('/api/memory-processing/runs',{request_key:randomUUID()});assert.equal(started.status,200,JSON.stringify(started.data));
 let run;try{run=await changed(join(root,'managed/sqlite/notalone.sqlite-wal'),()=>api(`/api/memory-processing/runs/${started.data.runId}`),value=>value.status!==200||value.data.status==='waiting'&&value.data.statusReason==='later_stages_scheduled');}
 catch(error){throw new Error(`${error.message}; ${JSON.stringify({supplier:supplier.errors,base:supplier.base.errors,documentCalls:supplier.documents.map(x=>x.names),stderr:(await readFile(stderr,'utf8')).slice(-1800)})}`);}
 assert.equal(run.status,200);assert.equal(run.data.state,'incomplete');assert.equal(run.data.succeeded,1);assert.ok(run.data.nextDueAt>Date.now());
 const view=await api(`/api/memory-documents?scope_kind=contact&contact_id=${contactId}`);assert.equal(view.status,200,JSON.stringify(view.data));assert.equal(view.data.publication,null);assert.deepEqual(view.data.documents,[]);assert.equal(supplier.documents.length,0);
 const session=await api(`/api/contacts/${contactId}/assistant-sessions`,{});assert.equal(session.status,200,JSON.stringify(session.data));
 const route=`/api/contacts/${contactId}/assistant-sessions/${session.data.session_id}/reply-candidates`;
 const generated=await api(route,{request_key:randomUUID(),text:'结合资料表达',confirmed_contact:true});assert.equal(generated.status,200,JSON.stringify(generated.data));
 const replies=await api(route);assert.equal(replies.status,200,JSON.stringify(replies.data));assert.ok(replies.data.requests[0].candidates[0].basis.some(b=>b.kind==='memory'));assert.ok(!replies.data.requests[0].candidates[0].basis.some(b=>b.kind==='document'));
 assert.equal(supplier.errors.length,0);assert.equal(supplier.base.errors.length,0);assert.ok(supplier.replies.length>0);
 const network=(await readFile(audit,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));assert.ok(network.length>0);assert.ok(network.every(item=>item.kind==='redirect'));
});
