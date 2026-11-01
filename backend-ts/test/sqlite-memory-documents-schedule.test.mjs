import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryDocuments} from '../src/memory/sqlite/documents/service.ts';
import {modelPort} from './fixtures/memory-sqlite/support.mjs';
import {documentFixture} from './fixtures/memory-documents/support.mjs';

const registryModule=new URL('./fixtures/memory-documents/later-schedule-registry.mjs',import.meta.url).href;
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('合成服务生命周期等待超时')),5000);})]);}finally{clearTimeout(timer);}}
function restoredDocuments(t,f,storage=f.storage){
 let extraction;
 extraction=new SqliteMemoryExtraction(storage,f.owner,modelPort(()=>extraction.accounting,async()=>({blocks:[]})),f.holders);
 const documents=new SqliteMemoryDocuments(storage,f.owner,modelPort(()=>extraction.accounting,f.respond),f.holders);
 t.after(async()=>{await documents.close();await extraction.close();if(storage!==f.storage)await storage.close();});
 return {extraction,documents};
}
async function reopenDocuments(t,f){
 const databaseId=f.storage.status.databaseId;
 await f.extraction.close();await f.adjudication.close();await f.storage.close();
 const storage=await SqliteStorage.open({userData:f.root,intent:'open',expectedDatabaseId:databaseId,role:'test',registryModule});
 return {...restoredDocuments(t,f,storage),storage};
}

test('旧式完整双阶段出版会结清同版本的等待队列',async t=>{
 const f=await documentFixture(t,{registryModule});
 const run=await f.extraction.start('later-schedule-legacy-full-publication');await f.extraction.waitForIdle(run.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},schedule=await f.documents.readSchedule(scope),snapshot=await f.extraction.read(run.runId);
 assert.equal(schedule.scene.state,'succeeded','实际完成的完整双阶段出版应结清匹配版本的scene队列');
 assert.equal(snapshot.state,'completed');assert.equal(snapshot.laterStages,'completed');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('真实L1记忆可立即读取；L2合并窗口到期后单独发布，首次主题立即初始化L3',async t=>{
 const f=await documentFixture(t,{registryModule,laterScheduling:true});
 const run=await f.extraction.start('later-schedule-first-l1-change');await f.extraction.waitForIdle(run.runId);
 const l1=await f.management.read({scopeKind:'contact',contactId:f.contactId});assert.ok(l1.memories.some(memory=>memory.current.body==='联系人长期喜欢合成园艺。'));
 assert.equal((await f.documents.read({scopeKind:'contact',contactId:f.contactId})).publication,null,'等待整理窗口时先不发布概览');

 const scope={scopeKind:'contact',contactId:f.contactId},scheduled=await f.documents.readSchedule(scope),firstChangeAt=scheduled.scene.firstChangedAt;
 assert.equal(scheduled.scene.state,'scheduled');assert.equal(scheduled.scene.dueAt,firstChangeAt+60*60*1000);
 assert.equal(scheduled.scene.memoryRevision,'1');
 const contactView=await f.extraction.readContact(f.contactId),otherView=await f.extraction.readContact(f.saved[1].contact_id);
 assert.equal(contactView.run.status,'waiting');assert.equal(contactView.run.statusReason,'later_stages_scheduled');
 assert.equal(contactView.run.nextDueAt,scheduled.scene.dueAt);assert.equal(contactView.queue.later.pending,1);
 assert.equal(contactView.queue.later.nextDueAt,scheduled.scene.dueAt);
 assert.equal(otherView.run,null);assert.deepEqual(otherView.queue.later,{pending:0,nextDueAt:null,stage:null});
 const memory=l1.memories.find(item=>item.current.body==='联系人长期喜欢合成园艺。');
 await f.management.decide({requestKey:'later-schedule-coalesced-edit',action:'correct',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,body:'联系人长期喜欢水培园艺。'});
 const afterEdit=await f.documents.readSchedule(scope);assert.equal(afterEdit.scene.generation,scheduled.scene.generation);
 assert.equal(afterEdit.scene.memoryRevision,'2');assert.equal(afterEdit.scene.dueAt,scheduled.scene.dueAt,'后续正式修正合并但不重置第一条变更的窗口');
 const repeated=await f.documents.scheduleMemoryChange(scope,firstChangeAt+30*60*1000);
 assert.equal(repeated.scene.generation,scheduled.scene.generation,'同一正式记忆版本重复通知不创建新工作');
 assert.equal(repeated.scene.dueAt,scheduled.scene.dueAt,'合并窗口从首个变化计时，不因同一版本重复通知而后移');
 await f.documents.enrollRun(run.runId);

 const before=f.calls.length;assert.equal(await f.documents.nextDueAt(),scheduled.scene.dueAt);
 assert.deepEqual(await f.documents.runDueStages(scheduled.scene.dueAt-1),[]);
 assert.equal(f.calls.length,before);assert.equal((await f.documents.read(scope)).publication,null,'未到期不能提前调用文档模型');

 const completed=await f.documents.runDueStages(scheduled.scene.dueAt);assert.equal(completed.length,2,JSON.stringify(completed));
 assert.deepEqual([...new Set(f.calls.map(call=>call.claim.step_name))].sort(),['document_profile','document_scene']);
 const final=await f.documents.read(scope);
 assert.equal(final.publication.members.length,2);
 assert.deepEqual(final.documents.map(document=>document.kind).sort(),['profile','scene']);
 const settled=await f.documents.readSchedule(scope);
 assert.equal(settled.scene.state,'succeeded');assert.equal(settled.profile.state,'succeeded');
 assert.ok(settled.profile.lastSuccessAt>0&&settled.profile.lastSuccessAt<=scheduled.scene.dueAt);
 assert.equal(await f.documents.nextDueAt(),null);
 const ownCompleted=await f.extraction.readContact(f.contactId);
 assert.equal(ownCompleted.run.status,'completed');assert.equal(ownCompleted.run.laterStages,'completed');assert.equal(ownCompleted.queue.later.pending,0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('仅主题正文变化触发L3；再次生成受上次成功后24小时限制',async t=>{
 const f=await documentFixture(t,{registryModule,laterScheduling:true,sceneBody:memory=>memory.text.includes('阳台')?'主题正文乙。':'主题正文甲。'});
 const run=await f.extraction.start('later-schedule-profile-cadence');await f.extraction.waitForIdle(run.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},initial=await f.documents.readSchedule(scope);
 await f.documents.runDueStages(initial.scene.dueAt);
 const profileAfterFirst=await f.documents.readSchedule(scope),firstProfileGeneration=profileAfterFirst.profile.generation,firstSuccess=profileAfterFirst.profile.lastSuccessAt;
 assert.ok(firstSuccess>=initial.scene.dueAt);

 const correct=async(body,requestKey)=>{
  const current=await f.management.read(scope),memory=current.memories.find(item=>item.state==='active');
  await f.management.decide({requestKey,action:'correct',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,body});
 };
 await correct('联系人长期喜欢水培园艺。','later-schedule-same-scene-body');
 const sameScene=await f.documents.readSchedule(scope),callsBeforeSame=f.calls.length;
 const sameResult=await f.documents.runDueStages(sameScene.scene.dueAt);
 assert.equal(sameResult.length,1,'主题正文相同只执行L2');
 assert.equal(f.calls.length-callsBeforeSame,3,'L3不会因版本号或标题以外的变更重跑');
 const afterSame=await f.documents.readSchedule(scope);
 assert.equal(afterSame.profile.generation,firstProfileGeneration);assert.equal(afterSame.profile.lastSuccessAt,firstSuccess);
 assert.equal(await f.documents.nextDueAt(),null);

 await correct('联系人也会种阳台花卉。','later-schedule-changed-scene-body');
 const changedScene=await f.documents.readSchedule(scope),changedResult=await f.documents.runDueStages(changedScene.scene.dueAt);
 assert.equal(changedResult.length,1,'正文变化只发布L2并排队等待L3冷却结束');
 const cadence=await f.documents.readSchedule(scope),expectedProfileDue=firstSuccess+24*60*60*1000;
 assert.equal(cadence.profile.state,'scheduled');assert.equal(cadence.profile.dueAt,expectedProfileDue);
 assert.equal(await f.documents.nextDueAt(),expectedProfileDue);
 const profileResult=await f.documents.runDueStages(expectedProfileDue);
 assert.equal(profileResult.length,1);assert.equal(profileResult[0].stage,'document_profile');
 assert.equal((await f.documents.readSchedule(scope)).profile.lastSuccessAt,expectedProfileDue);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('排队窗口内的protect只推进版本号，不新建或延后L2；到期才冻结当前版本',async t=>{
 const f=await documentFixture(t,{registryModule,laterScheduling:true});
 const run=await f.extraction.start('later-schedule-metadata-revision');await f.extraction.waitForIdle(run.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},before=await f.documents.readSchedule(scope),due=before.scene.dueAt;
 const memory=(await f.management.read(scope)).memories.find(item=>item.state==='active');
 await f.management.decide({requestKey:'later-schedule-protect-during-window',action:'protect',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision});
 const afterProtect=await f.documents.readSchedule(scope);
 assert.equal(afterProtect.scene.generation,before.scene.generation);assert.equal(afterProtect.scene.dueAt,due,'元数据决定不能滑动首变窗口');
 assert.equal(afterProtect.scene.memoryRevision,before.scene.memoryRevision,'protect本身不登记新一代正式记忆');
 const result=await f.documents.runDueStages(due);assert.equal(result.length,2,JSON.stringify(result));
 const after=await f.documents.readSchedule(scope);
 assert.equal(after.scene.state,'succeeded');assert.equal(after.scene.dueAt,due);
 assert.equal(after.scene.memoryRevision,'2','到期创建L2时将递增后的当前修订冻结');assert.equal(after.scene.frozenMemoryRevision,'2');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('待更新画像被新L2合并后，正文相同也不会丢失L3积压',async t=>{
 const f=await documentFixture(t,{registryModule,laterScheduling:true,sceneBody:memory=>memory.text.includes('长期喜欢合成园艺')?'主题正文甲。':'主题正文乙。'});
 const run=await f.extraction.start('later-schedule-profile-backlog');await f.extraction.waitForIdle(run.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},initial=await f.documents.readSchedule(scope);
 await f.documents.runDueStages(initial.scene.dueAt);
 const first=await f.documents.readSchedule(scope),lastProfileSuccess=first.profile.lastSuccessAt;
 const correct=async(body,requestKey)=>{
  const current=await f.management.read(scope),memory=current.memories.find(item=>item.state==='active');
  await f.management.decide({requestKey,action:'correct',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,body});
 };
 await correct('联系人长期喜欢阳台园艺。','later-schedule-backlog-scene-b');
 const sceneB=await f.documents.readSchedule(scope);await f.documents.runDueStages(sceneB.scene.dueAt);
 const profileB=await f.documents.readSchedule(scope),profileDue=lastProfileSuccess+24*60*60*1000;
 assert.equal(profileB.profile.state,'scheduled');assert.equal(profileB.profile.dueAt,profileDue);

 await correct('联系人最近喜欢合成多肉。','later-schedule-backlog-memory-c');
 const sceneC=await f.documents.readSchedule(scope);await f.documents.runDueStages(sceneC.scene.dueAt);
 const stillQueued=await f.documents.readSchedule(scope);
 assert.equal(stillQueued.scene.state,'succeeded');assert.equal(stillQueued.profile.state,'scheduled','新主题正文仍为B，但待更新画像相对最近成功画像A仍是dirty');
 assert.equal(stillQueued.profile.dueAt,profileDue,'新L2保留上次成功画像后的固定24小时到期点');
 assert.equal(await f.documents.nextDueAt(),profileDue);
 const before=f.calls.filter(call=>call.claim.step_name==='document_profile').length;
 const completed=await f.documents.runDueStages(profileDue);
 assert.equal(completed.length,1);assert.equal(completed[0].stage,'document_profile');
 assert.equal(f.calls.filter(call=>call.claim.step_name==='document_profile').length,before+3,'到期时实际执行并核验L3');
 assert.equal((await f.documents.readSchedule(scope)).profile.lastSuccessAt,profileDue);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('文档外发结果unknown时持久锁定且绝不自动重发',async t=>{
 const f=await documentFixture(t,{registryModule,laterScheduling:true,beforeCall:({input})=>{
  if(input.claim.step_name==='document_scene')throw Object.assign(new Error('合成unknown'),{code:'document_call_unknown'});
 }});
 const run=await f.extraction.start('later-schedule-unknown-no-retry');await f.extraction.waitForIdle(run.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},scheduled=await f.documents.readSchedule(scope);
 const first=await f.documents.runDueStages(scheduled.scene.dueAt);
 assert.equal(first.length,1);assert.equal((await f.documents.readSchedule(scope)).scene.state,'unknown');
 assert.equal(await f.storage.execute('memoryDocuments.resumeRunSchedule',{ownerId:f.owner,runId:run.runId,now:scheduled.scene.dueAt+1}),false,'unknown调用不得因continue安排重发');
 const calls=f.calls.length;assert.ok(calls>0);
 assert.deepEqual(await f.documents.runDueStages(scheduled.scene.dueAt+24*60*60*1000),[]);
 assert.equal(f.calls.length,calls,'unknown调用不会在worker下次扫描时重发');
 assert.equal(await f.documents.nextDueAt(),null);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('迟到结算使完整调用链可判定后，仅用户继续才创建新代次',async t=>{
 let returnUnknown=true;
 const f=await documentFixture(t,{registryModule,laterScheduling:true,beforeCall:({input})=>{
  if(returnUnknown&&input.claim.step_name==='document_scene')throw Object.assign(new Error('合成unknown'),{code:'document_call_unknown'});
 }});
 const run=await f.extraction.start('later-schedule-late-known-receipt');await f.extraction.waitForIdle(run.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},initial=await f.documents.readSchedule(scope),generation=initial.scene.generation;
 await f.documents.runDueStages(initial.scene.dueAt);assert.equal((await f.documents.readSchedule(scope)).scene.state,'unknown');
 const receipt=f.receipts[0];assert.ok(receipt);assert.equal(receipt.outcome,'pending');
 const settled={...receipt,dispatch:'response_observed',outcome:'succeeded',latency_ms:1,usage:{input_tokens:10,output_tokens:1,cache_read_tokens:null,cache_write_tokens:null}};
 await f.extraction.accounting.recordReserved(settled);
 assert.equal((await f.documents.readSchedule(scope)).scene.state,'unknown','收到账本回执本身不自动重试stage');
 const callsBeforeContinue=f.calls.length;
 assert.deepEqual(await f.documents.runDueStages(initial.scene.dueAt+24*60*60*1000),[]);
 assert.equal(f.calls.length,callsBeforeContinue,'自动扫描仍锁定已结算的历史unknown');
 returnUnknown=false;
 const view=await f.extraction.read(run.runId);
 await f.extraction.continue(run.runId,view.controlVersion,randomUUID());await f.extraction.waitForIdle(run.runId);
 const retry=await f.documents.readSchedule(scope);
 assert.equal(retry.scene.state,'scheduled');assert.equal(retry.scene.generation,generation+1);
 const history=await f.storage.execute('fixture.laterScheduleHistory',{ownerId:f.owner,scopeKey:f.contactId});
 assert.equal(history[0].state,'superseded');assert.equal(history[0].error_code,'document_late_receipt_resolved');
 const completed=await f.documents.runDueStages(retry.scene.dueAt);assert.ok(completed.length>0);
 assert.equal((await f.documents.readSchedule(scope)).scene.state,'succeeded');
 assert.ok(f.calls.length>callsBeforeContinue,'用户继续后新代次才会调用模型');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('更新的L1轮次不会把同scope旧unknown投影成有到期时间的scheduled',async t=>{
 const f=await documentFixture(t,{registryModule,laterScheduling:true,beforeCall:({input})=>{
  if(input.claim.step_name==='document_scene')throw Object.assign(new Error('合成unknown'),{code:'document_call_unknown'});
 }});
 const first=await f.extraction.start('later-schedule-old-unknown');await f.extraction.waitForIdle(first.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},initial=await f.documents.readSchedule(scope);
 await f.documents.runDueStages(initial.scene.dueAt);assert.equal((await f.documents.readSchedule(scope)).scene.state,'unknown');
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[
  {partition:'shard-a',table:'table-instance-1',localId:'1',serverId:'0',sender:'contact',kind:'text',text:'我长期喜欢合成园艺。',originalType:'1',sentAt:'1700000000000',timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified'},
  {partition:'shard-a',table:'table-instance-1',localId:'2',serverId:'0',sender:'contact',kind:'text',text:'我也喜欢阳台园艺。',originalType:'1',sentAt:'1700000001000',timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified'},
 ],completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.service.synchronize(f.contactId);await f.contacts.setReading(false);
 const newer=await f.extraction.start('later-schedule-newer-l1');await f.extraction.waitForIdle(newer.runId);
 const current=await f.documents.readSchedule(scope);assert.ok(current.scene.generation>initial.scene.generation,'新L1采纳的新正式记忆建立更高代次');
 const projection=await f.extraction.read(newer.runId);
 assert.equal(projection.status,'blocked');assert.equal(projection.statusReason,'model_receipt_unknown');assert.equal(projection.nextDueAt,null);
 assert.equal(projection.laterStages,'pending','提取详情沿用二值阶段摘要，但控制状态必须保留同scope未知结果');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('已排队scope可暂停；恢复后再按原due执行',async t=>{
 const f=await documentFixture(t,{registryModule,laterScheduling:true});
 const run=await f.extraction.start('later-schedule-pause-resume');await f.extraction.waitForIdle(run.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},scheduled=await f.documents.readSchedule(scope),due=scheduled.scene.dueAt;
 assert.equal(await f.storage.execute('memoryDocuments.pauseRunSchedule',{ownerId:f.owner,runId:run.runId,paused:true}),true);
 assert.equal((await f.documents.queueSummary()).nextDueAt,null);
 assert.deepEqual(await f.documents.runDueStages(due),[]);assert.equal(f.calls.length,0);
 assert.equal(await f.storage.execute('memoryDocuments.pauseRunSchedule',{ownerId:f.owner,runId:run.runId,paused:false}),true);
 assert.equal(await f.documents.nextDueAt(),due);
 const resumed=await f.documents.runDueStages(due);assert.equal(resumed.length,2);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('continue只重排已知失败，保留旧失败行并立即调度新代次',async t=>{
 const f=await documentFixture(t,{registryModule,laterScheduling:true,documentModel:'unconfigured'});
 const run=await f.extraction.start('later-schedule-known-failure-retry');await f.extraction.waitForIdle(run.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},initial=await f.documents.readSchedule(scope);
 const failed=await f.documents.runDueStages(initial.scene.dueAt);
 assert.equal(failed.length,1);assert.equal((await f.documents.readSchedule(scope)).scene.state,'failed');
 const retryAt=initial.scene.dueAt+1000;
 assert.equal(await f.storage.execute('memoryDocuments.resumeRunSchedule',{ownerId:f.owner,runId:run.runId,now:retryAt}),true);
 const retry=await f.documents.readSchedule(scope),history=await f.storage.execute('fixture.laterScheduleHistory',{ownerId:f.owner,scopeKey:f.contactId});
 assert.equal(retry.scene.generation,initial.scene.generation+1);assert.equal(retry.scene.state,'scheduled');assert.equal(retry.scene.dueAt,retryAt);
 assert.equal(history[0].state,'superseded');assert.equal(history[0].error_code,'document_model_unconfigured');
 assert.equal(await f.documents.nextDueAt(),retryAt);
 const snapshot=await f.extraction.read(run.runId);assert.equal(snapshot.status,'waiting');assert.equal(snapshot.statusReason,'later_stages_scheduled');assert.equal(snapshot.nextDueAt,retryAt);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('pause发生在L2运行中时当前小批可收尾，后续L3等待继续',{timeout:30000},async t=>{
 const entered=deferred(),release=deferred(),enteredProfile=deferred(),releaseProfile=deferred(),f=await documentFixture(t,{registryModule,laterScheduling:true,beforeCall:async({input})=>{
  if(input.claim.step_name==='document_scene'){entered.resolve();await release.promise;}
  if(input.claim.step_name==='document_profile'){enteredProfile.resolve();await releaseProfile.promise;}
 }});
 try{
 const run=await f.extraction.start('later-schedule-pause-running-stage');await f.extraction.waitForIdle(run.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},scene=await f.documents.readSchedule(scope),work=f.documents.runDueStages(scene.scene.dueAt);
 await bounded(entered.promise);await bounded(f.extraction.pause(run.runId));
 const pausedState=await bounded(f.storage.execute('fixture.laterRunState',{ownerId:f.owner,runId:run.runId}));
 const contactRequirement=()=>bounded(f.storage.execute('fixture.laterRunState',{ownerId:f.owner,runId:run.runId})).then(state=>state.requirements.find(item=>item.scope_key===f.contactId));
 assert.equal(pausedState.run.state,'paused','L1控制要能暂停正在运行的后续阶段');assert.equal((await contactRequirement()).paused,1n,'正在运行的队列必须持久暂停');
 release.resolve();await bounded(work);
 const afterScene=await f.documents.readSchedule(scope);assert.equal(afterScene.scene.state,'succeeded');assert.equal(afterScene.profile.state,'scheduled');
 assert.equal(await f.documents.nextDueAt(),null,'当前scene可发布，但暂停期间不能开始后续profile');
 const pausedCalls=f.calls.filter(call=>call.claim.step_name==='document_profile').length;assert.equal(pausedCalls,0);
 const beforeContinue=await f.extraction.read(run.runId);
 await bounded(f.extraction.continue(run.runId,beforeContinue.controlVersion,randomUUID()));await bounded(f.extraction.waitForIdle(run.runId));
 assert.equal((await contactRequirement()).paused,0n);
 assert.equal(await f.documents.nextDueAt(),afterScene.profile.dueAt);
 const resumedWork=f.documents.runDueStages(afterScene.profile.dueAt);
 await bounded(enteredProfile.promise);await bounded(f.extraction.pause(run.runId));
 releaseProfile.resolve();const resumed=await bounded(resumedWork);assert.equal(resumed.length,1);assert.equal(resumed[0].stage,'document_profile');
 const final=await bounded(f.storage.execute('fixture.laterRunState',{ownerId:f.owner,runId:run.runId}));
 assert.equal(final.run.state,'paused','L3在途收尾不能悄悄解除父轮次暂停');assert.notEqual(final.run.pause_requested_at,null);
 assert.equal(final.requirements.find(item=>item.scope_key===f.contactId).outcome,'completed','已开始的L3小批可收尾并完成发布');
 assert.equal(f.calls.filter(call=>call.claim.step_name==='document_profile').length,pausedCalls+3);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 }finally{release.resolve();releaseProfile.resolve();}
});

test('正常关闭发生在dispatch前时，重启只重试安全中断的小批',{timeout:30000},async t=>{
 const entered=deferred(),f=await documentFixture(t,{registryModule,laterScheduling:true,documentPrepare:({input})=>new Promise((resolve,reject)=>{
  entered.resolve();const abort=()=>{const error=new Error('synthetic shutdown before dispatch');error.name='AbortError';reject(error);};
  if(input.signal.aborted)abort();else input.signal.addEventListener('abort',abort,{once:true});
 })});
 const run=await f.extraction.start('later-schedule-close-before-dispatch');await f.extraction.waitForIdle(run.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},scheduled=await f.documents.readSchedule(scope),work=f.documents.runDueStages(scheduled.scene.dueAt);
 await bounded(entered.promise);await bounded(f.documents.close());await bounded(work);
 assert.equal((await f.documents.readSchedule(scope)).scene.state,'running','服务退出不把确定未发送的job记成业务失败');
 assert.equal(f.calls.length,0,'准备阶段退出时没有provider dispatch');
 const restarted=await reopenDocuments(t,f);await restarted.documents.initialize();
 const recovered=await restarted.documents.readSchedule(scope);assert.equal(recovered.scene.state,'scheduled');
 const results=await restarted.documents.runDueStages(recovered.scene.dueAt);assert.ok(results.length>0);
 assert.equal((await restarted.documents.readSchedule(scope)).scene.state,'succeeded');
 assert.ok(f.calls.some(call=>call.claim.step_name==='document_scene'));
 assert.deepEqual(await restarted.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('正常关闭发生在stage保存后publish前时，重启发布已保存内容且不重调模型',{timeout:30000},async t=>{
 const saved=deferred(),release=deferred(),f=await documentFixture(t,{registryModule,laterScheduling:true});
 t.after(()=>release.resolve());
 const execute=f.storage.execute.bind(f.storage);
 f.storage.execute=(name,input,lease)=>{
  const result=execute(name,input,lease);
  if(name==='memoryDocuments.saveScene')return result.then(async value=>{saved.resolve();await release.promise;return value;});
  return result;
 };
 const run=await f.extraction.start('later-schedule-close-after-stage-save');await f.extraction.waitForIdle(run.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},scheduled=await f.documents.readSchedule(scope),work=f.documents.runDueStages(scheduled.scene.dueAt);
 await bounded(saved.promise);const callsBeforeClose=f.calls.length,closing=f.documents.close();release.resolve();await bounded(closing);await bounded(work);
 assert.equal((await f.documents.readSchedule(scope)).scene.state,'running');
 const restarted=restoredDocuments(t,f);await restarted.documents.initialize();
 assert.equal((await restarted.documents.readSchedule(scope)).scene.state,'succeeded');
 assert.ok((await restarted.documents.read(scope)).publication);
 assert.equal(f.calls.length,callsBeforeClose,'启动恢复直接发布数据库中已保存的stage结果');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
