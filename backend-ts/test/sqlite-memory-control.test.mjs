import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {supplier} from './fixtures/memory-management/supplier.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {documentFixture} from './fixtures/memory-documents/support.mjs';

const registryModule=new URL('./fixtures/memory-control/registry.mjs',import.meta.url).href;
const controlRegistry=new URL('./fixtures/memory-management/registry.mjs',import.meta.url).href;
const wait=(ms=20)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeoutMs=4000){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){const value=await check();if(value)return value;await wait(10);}
 throw Error('synthetic_control_timeout');
}
async function fixtureWithMessages(t,{a=[],b=[]}={}){
 const f=await fixture(t,{registryModule});
 const [ca,cb]=f.saved.map(row=>row.contact_id);
 f.channel.page=async scope=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,
  records:(scope.token.contact_id===ca?a:b).map((text,index)=>record(String(index+1),{text})),completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);
 for(const contactId of [ca,cb])await f.service.synchronize(contactId);
 return {...f,ca,cb};
}
/** 供应商外部边界替身；返回前可通过gate固定模型时序。 */
function extractionFixture(f){
 const external=supplier();
 const state={service:undefined,gate:null,entered:null,calls:0,callsByContact:new Map(),prepare:null,respond:external.respond};
 const base=modelPort(()=>state.service.accounting,(request,input)=>state.respond(request,input));
 const port={
  get calls(){return state.calls;},get entered(){return state.entered;},
  close:()=>base.close(),
  prepare:async(request,input)=>{if(state.prepare)return state.prepare(request,input);return base.prepare(request,input);},
  invoke:async(request,input)=>{state.calls++;state.callsByContact.set(input.scope.contact_id,(state.callsByContact.get(input.scope.contact_id)??0)+1);if(state.gate){const gate=state.gate;state.gate=null;if(state.entered)state.entered();await gate;}return base.invoke(request,input);},
 };
 const service=new SqliteMemoryExtraction(f.storage,owner,port);
 state.service=service;
 return {port,state,service,external};
}
const runRow=(f,runId)=>f.storage.execute('fixture.processingRun',{ownerId:owner,runId});
const taskRows=(f,runId)=>f.storage.execute('fixture.processingTasks',{ownerId:owner,runId});
const attempts=(f,taskId)=>f.storage.execute('fixture.attempts',{ownerId:owner,taskId});
const steps=(f,taskId)=>f.storage.execute('fixture.steps',{ownerId:owner,taskId});
const calls=(f,runId)=>f.storage.execute('fixture.modelCalls',{ownerId:owner,runId});
const contactTask=(rows,contactId)=>rows.find(row=>row.scope_kind==='contact'&&row.contact_id===contactId);

test('统一状态只呈现固定轮次/实际阶段/计数，不以历史失败或数量换算冒充完成',async t=>{
 const f=await fixtureWithMessages(t,{a:['我长期住在高雄。'],b:['我长期住在台南。']});
 const x=extractionFixture(f);t.after(()=>x.service.close());
 const run=await x.service.start('control-unified-status');await x.service.waitForIdle(run.runId);
 const view=await x.service.read(run.runId);
 assert.equal(view.total,2);assert.equal(view.succeeded,2);assert.equal(view.failed,0);assert.equal(view.unknown,0);
 assert.equal(view.pending,0);assert.equal(view.revoked,0);
 assert.equal(view.stage,'extraction_verification');assert.equal(view.laterStages,'pending');
 assert.equal(view.status,'blocked');assert.equal(view.statusReason,'later_stages_pending');
 assert.deepEqual(view.actions,[]);assert.equal(view.controlVersion,0);
 assert.equal(view.calls.succeeded,4);assert.equal(view.calls.unknown,0);
 assert.ok(!('percent' in view)&&!('percentage' in view),'不把消息/记忆/步骤数量加成百分比');
 // 幂等重放同一启动请求沿用固定轮次，不重复处理、不新增调用。
 const replay=await x.service.start('control-unified-status');assert.equal(replay.runId,run.runId);
 assert.equal(x.state.calls,4);
});

test('普通暂停不启动新小批，执行中合法小批提交后显示暂停，继续沿固定任务复用成功步骤',async t=>{
 const texts=Array.from({length:25},(_,index)=>`我第${index+1}条合成消息。`);
 const f=await fixtureWithMessages(t,{a:texts});
 const x=extractionFixture(f);t.after(async()=>{release?.();await x.service.close();});
 let release;const gate=new Promise(resolve=>release=resolve);
 let entered;const enteredPromise=new Promise(resolve=>entered=resolve);
 x.state.gate=gate;x.state.entered=entered;
 const run=await x.service.start('control-pause-batch');await enteredPromise;
 const running=await x.service.read(run.runId);
 assert.equal(running.status,'processing');assert.deepEqual(running.actions,['pause']);assert.equal(running.controlVersion,0);
 const paused=await x.service.pause(run.runId,running.controlVersion,randomUUID());
 assert.equal(paused.status,'paused');assert.equal(paused.controlVersion,1);assert.equal(paused.replayed,false);
 release();await x.service.waitForIdle(run.runId);
 let view=await x.service.read(run.runId);
 assert.equal(view.status,'paused');assert.deepEqual(view.actions,['continue']);
 assert.equal(view.succeeded,20);assert.equal(view.total,25);assert.equal(view.pending,5);
 assert.equal(x.state.calls,2,'暂停后不再启动第二批模型调用');
 await wait(80);assert.equal(x.state.calls,2);
 // 继续沿同一 run/task/固定输入推进，新增执行记录，不重做成功目标。
 const continued=await x.service.continue(run.runId,view.controlVersion,randomUUID());
 assert.equal(continued.status,'processing');assert.equal(continued.controlVersion,2);
 await x.service.waitForIdle(run.runId);
 view=await x.service.read(run.runId);
 assert.equal(view.succeeded,25);assert.equal(view.pending,0);assert.equal(x.state.calls,4);
 const contact=view.tasks.find(task=>task.scopeKind==='contact');
 const attemptsAfter=await attempts(f,contact.taskId);
 assert.equal(attemptsAfter.length,2,'继续新增执行记录而非复用旧attempt');
 assert.equal(new Set(attemptsAfter.map(row=>row.step_id)).size,2,'成功步骤与新步骤分别保留');
});

test('单人失败只让其受阻，共用模型故障暂停整轮并显示固定原因，失败不自动重试模型',async t=>{
 const f=await fixtureWithMessages(t,{a:['我住在高雄。','我偏好绿茶。'],b:['我住在台南。','我偏好红茶。']});
 const x=extractionFixture(f);t.after(()=>x.service.close());
 const normal=supplier(),negative=supplier({negative:true});
 let shared=null;
 const originalPrepare=x.port.prepare;
 x.state.respond=(request,input)=>input.scope.contact_id===f.ca?negative.respond(request,input):normal.respond(request,input);
 x.port.prepare=async(request,input)=>{if(shared)throw Object.assign(new Error('synthetic_shared'),{code:shared});return originalPrepare(request,input);};
 const run=await x.service.start('control-failures');await x.service.waitForIdle(run.runId);
 let view=await x.service.read(run.runId);
 assert.equal(view.status,'blocked');assert.equal(view.statusReason,'contact_failed');
 assert.deepEqual(view.actions,['continue']);
 let failed=view.tasks.find(task=>task.scopeKind==='contact'&&task.contactId===f.ca);
 let other=view.tasks.find(task=>task.scopeKind==='contact'&&task.contactId===f.cb);
 assert.equal(failed.state,'failed');assert.equal(other.state,'succeeded');assert.equal(view.unknown,0);
 const candidatesBefore=view.candidates.length,callsBefore=x.state.calls;
 const callsByContactBefore=x.state.callsByContact.get(f.ca)??0,callsByOtherBefore=x.state.callsByContact.get(f.cb)??0;
 view=await x.service.continue(run.runId,view.controlVersion,randomUUID());await x.service.waitForIdle(run.runId);
 view=await x.service.read(run.runId);
 other=view.tasks.find(task=>task.scopeKind==='contact'&&task.contactId===f.cb);
 assert.equal(other.state,'succeeded','成功联系人不得被继续重跑');
 assert.equal(view.candidates.length,candidatesBefore,'成功结果不重复生成');
 assert.equal(x.state.callsByContact.get(f.ca),callsByContactBefore+1,'只重试失败联系人');
 assert.equal(x.state.callsByContact.get(f.cb),callsByOtherBefore,'成功联系人不重跑');
 // 共用模型配置故障：整轮暂停，固定原因，等待手动继续，不自动重试。
 const callsBeforeShared=x.state.calls;
 shared='extraction_model_authentication_failed';
 await x.service.continue(run.runId,view.controlVersion,randomUUID());await x.service.waitForIdle(run.runId);
 view=await x.service.read(run.runId);
 assert.equal(view.status,'blocked');assert.equal(view.statusReason,'extraction_model_authentication_failed');
 assert.deepEqual(view.actions,['continue']);
 assert.equal(x.state.calls,callsBeforeShared,'共用故障没有新增模型调用');
});

test('未知回执不盲目重发；迟到已知回执恢复后才能继续并复用原调用',async t=>{
 const f=await fixtureWithMessages(t,{a:['我长期住在高雄。']});
 const x=extractionFixture(f);t.after(async()=>{release?.();await x.service.close();});
 let release;const gate=new Promise(resolve=>release=resolve);
 let entered;const enteredPromise=new Promise(resolve=>entered=resolve);
 x.state.respond=async()=>{entered();await gate;throw Object.assign(new Error('synthetic_timeout'),{code:'extraction_model_timeout'});};
 const run=await x.service.start('control-unknown');await enteredPromise;release();await x.service.waitForIdle(run.runId);
 let view=await x.service.read(run.runId);
 assert.equal(view.unknown,1);assert.equal(view.status,'blocked');assert.equal(view.statusReason,'model_receipt_unknown');
 assert.deepEqual(view.actions,[],'unknown未解时不提供继续');
 const callsAfterFailure=x.state.calls;assert.equal(callsAfterFailure,1);
 const continued=await x.service.continue(run.runId,view.controlVersion,randomUUID());
 await x.service.waitForIdle(run.runId);
 assert.equal(x.state.calls,callsAfterFailure,'继续不能无条件重发未知请求');
 const again=await x.service.read(run.runId);
 assert.equal(again.unknown,1,'继续不清除unknown');
 assert.equal(again.status,'blocked');assert.deepEqual(again.actions,[]);
 assert.equal(continued.status,'blocked');
 const trace=await x.service.trace(view.tasks.find(task=>task.scopeKind==='contact').taskId);
 assert.equal(trace.calls[0].state,'unknown');
});

test('退出中断后重开保持暂停/受阻与已完成结果，不自动模型调用；合法回执复用且不重发',async t=>{
 const f=await fixtureWithMessages(t,{a:['我长期住在高雄。']});
 const normal=extractionFixture(f);t.after(()=>normal.service.close());
 const first=await normal.service.start('control-before-restart');await normal.service.waitForIdle(first.runId);
 assert.equal((await normal.service.read(first.runId)).succeeded,1);
 // 新增固定目标后，在“两次调用都已成功、业务提交前”模拟进程中断。
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期住在高雄。'}),record('2',{text:'我现在长期住台南。'})],completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.service.synchronize(f.ca);
 const external=supplier();
 let entered;const enteredPromise=new Promise(resolve=>entered=resolve);let release;const gate=new Promise(resolve=>release=resolve);
 const base=modelPort(()=>service.accounting,external.respond);
 const port={prepare:base.prepare,close:base.close,invoke:base.invoke,get calls(){return base.calls;}};
 let interruptedAtFinish=false;
 const observed={execute:async(name,input)=>{if(name==='memoryExtraction.finish'&&!interruptedAtFinish){interruptedAtFinish=true;entered();await gate;}return f.storage.execute(name,input);}};
 const service=new SqliteMemoryExtraction(observed,owner,port);t.after(async()=>{release();await service.close();});
 const interrupted=await service.start('control-interrupted');await enteredPromise;
 const contact=await until(async()=>contactTask(await taskRows(f,interrupted.runId),f.ca));
 const running=await until(async()=>(await attempts(f,contact.id)).find(row=>row.state==='running'));
 await f.storage.execute('fixture.setRuntimeToken',{ownerId:owner,attemptId:running.id,token:'synthetic-old-runtime'});
 await f.storage.execute('memoryExtraction.recover',{ownerId:owner});
 let view=await service.read(interrupted.runId);
 assert.equal(view.status,'paused');assert.equal(view.statusReason,null);
 assert.deepEqual(view.actions,['continue'],'重开保持暂停并等待手动继续');
 const known=await calls(f,interrupted.runId);
 assert.equal(known.filter(row=>row.state==='unknown'||row.state==='sending').length,0,'已成功回执不伪造未知');
 assert.equal(known.filter(row=>row.state==='succeeded').length,2);
 // 重开不自动模型调用，也不把宿主重启当手动继续。
 const callsBeforeContinue=port.calls;await wait(50);
 assert.equal(port.calls,callsBeforeContinue);
 const preserved=await service.read(first.runId);
 assert.equal(preserved.succeeded,1,'已完成轮次结果保留');
 // 迟到的业务提交因旧租约失效被拒绝，不产生内容。
 release();await service.waitForIdle(interrupted.runId);
 assert.equal((await service.read(interrupted.runId)).candidates.length,0);
 view=await service.read(interrupted.runId);
 const after=await service.continue(interrupted.runId,view.controlVersion,randomUUID());
 assert.equal(after.status,'processing');
 await service.waitForIdle(interrupted.runId);
 const done=await service.read(interrupted.runId);
 assert.equal(done.succeeded,done.total,'合法回执安全恢复后完成原固定目标');
 assert.ok(done.candidates.length>=1);
 assert.equal(port.calls-callsBeforeContinue,0,'复用已有成功回执，不重发模型请求');
 assert.equal((await calls(f,interrupted.runId)).filter(row=>row.state==='unknown'||row.state==='sending').length,0);
});

test('取消勾选立即撤销该人提取与本人贡献资格，其他有效联系人继续且混合结果不能提交',async t=>{
 const f=await fixtureWithMessages(t,{a:['我住在高雄。'],b:['我住在台南。']});
 const x=extractionFixture(f);t.after(async()=>{release?.();await x.service.close();});
 const normal=supplier();
 let release;const gate=new Promise(resolve=>release=resolve);let entered;const enteredPromise=new Promise(resolve=>entered=resolve);
 x.state.respond=async(request,input)=>{if(input.scope.contact_id===f.ca){entered();await gate;}return normal.respond(request,input);};
 const run=await x.service.start('control-cancel');await enteredPromise;
 const binding=f.saved.find(row=>row.contact_id===f.ca);
 await f.contacts.revoke(f.ca,binding.binding_id,binding.selection_generation);
 release();await x.service.waitForIdle(run.runId);
 const view=await x.service.read(run.runId);
 const cancelled=view.tasks.find(task=>task.scopeKind==='contact'&&task.contactId===f.ca);
 const other=view.tasks.find(task=>task.scopeKind==='contact'&&task.contactId===f.cb);
 assert.equal(cancelled.state,'revoked','取消勾选立即撤销该联系人的提交资格');
 assert.equal(other.state,'succeeded','其他有效联系人继续完成');
 assert.equal(view.candidates.filter(candidate=>candidate.contactId===f.ca).length,0,'已取消联系人不产生候选');
 assert.ok(view.candidates.some(candidate=>candidate.contactId===f.cb));
 const management=new SqliteMemoryManagement(f.storage,owner);
 assert.deepEqual(await management.read({scopeKind:'contact',contactId:f.ca}),{candidates:[],memories:[]});
 // 本人混合贡献冻结包含被取消联系人时不直接提交，状态给出明确固定原因。
 assert.equal(view.status,'blocked');assert.equal(view.statusReason,'owner_contribution_pending');
 assert.deepEqual(view.actions,[]);
});

test('租约到期后可被接替，旧领取者的迟到回调不能覆盖新状态',async t=>{
 const f=await fixtureWithMessages(t,{a:['我住在高雄。']});
 const x=extractionFixture(f);t.after(async()=>{release?.();await x.service.close();});
 let release;const gate=new Promise(resolve=>release=resolve);let entered;const enteredPromise=new Promise(resolve=>entered=resolve);
 x.state.gate=gate;x.state.entered=entered;
 const run=await x.service.start('control-lease');await enteredPromise;
 const contact=contactTask(await taskRows(f,run.runId),f.ca);
 const [expired]=await attempts(f,contact.id);
 assert.equal(expired.state,'running');
 await f.storage.execute('fixture.expireAttempt',{ownerId:owner,attemptId:expired.id});
 const claimed=await f.storage.execute('memoryExtraction.claim',{ownerId:owner,runId:run.runId,taskId:contact.id});
 assert.ok(claimed,'过期租约在领取时被接替');
 assert.notEqual(claimed.attemptId,expired.id);
 const rows=await attempts(f,contact.id);
 assert.equal(rows.find(row=>row.id===expired.id).state,'aborted');
 const fresh=rows.find(row=>row.id===claimed.attemptId);
 assert.equal(fresh.state,'running');
 assert.equal(fresh.accepted_control_revision,rows.find(row=>row.id===expired.id).accepted_control_revision);
 const prepared=(await calls(f,run.runId)).filter(row=>row.state==='prepared');
 assert.equal(prepared.length,0,'未发出的准备中调用保守收尾为失败，不保留 prepared');
 await assert.rejects(f.storage.execute('memoryExtraction.event',{ownerId:owner,attemptId:expired.id,kind:'model_output',payload:{},inputNos:[1]}),
  error=>error instanceof StorageFailure&&error.code==='memory_extraction_attempt_stale');
 release();await x.service.waitForIdle(run.runId);
});

test('关闭读取总开关不阻断已保存文字处理，取消选择与独立暂停分别生效',async t=>{
 const f=await fixtureWithMessages(t,{a:['我住在高雄。'],b:['我住在台南。']});
 await f.contacts.setReading(false);
 assert.equal(await f.storage.execute('fixture.ownerReadEnabled',{ownerId:owner}),false);
 const binding=f.saved.find(row=>row.contact_id===f.cb);
 await f.contacts.revoke(f.cb,binding.binding_id,binding.selection_generation);
 const x=extractionFixture(f);t.after(async()=>{release?.();await x.service.close();});
 let release;const gate=new Promise(resolve=>release=resolve);let entered;const enteredPromise=new Promise(resolve=>entered=resolve);
 x.state.gate=gate;x.state.entered=entered;
 const run=await x.service.start('control-read-off');await enteredPromise;
 const running=await x.service.read(run.runId);
 assert.equal(running.total,1,'取消勾选联系人不进入本轮固定范围');
 const paused=await x.service.pause(run.runId,running.controlVersion,randomUUID());
 assert.equal(paused.status,'paused');
 release();await x.service.waitForIdle(run.runId);
 const view=await x.service.read(run.runId);
 assert.equal(view.status,'paused');
 assert.equal(view.succeeded,1,'总开关关闭仍处理已保存的有效文字');
 assert.equal(view.candidates.length,1);
 const continued=await x.service.continue(run.runId,view.controlVersion,randomUUID());
 assert.equal(continued.status,'processing');
 await x.service.waitForIdle(run.runId);
 assert.equal((await x.service.read(run.runId)).status,'blocked','独立暂停与取消选择分别生效，暂停继续后可收尾');
});

test('控制读取失败与版本CAS互斥，读查询不改变业务状态或预算',async t=>{
 const f=await fixtureWithMessages(t,{a:['我住在高雄。']});
 const x=extractionFixture(f);t.after(async()=>{release?.();await x.service.close();});
 await assert.rejects(x.service.read('00000000-0000-4000-8000-000000000099'),error=>error instanceof StorageFailure&&error.code==='memory_extraction_not_found');
 await assert.rejects(x.service.pause('00000000-0000-4000-8000-000000000099',0,randomUUID()),error=>error instanceof StorageFailure&&error.code==='memory_extraction_not_found');
 let release;const gate=new Promise(resolve=>release=resolve);let entered;const enteredPromise=new Promise(resolve=>entered=resolve);
 x.state.gate=gate;x.state.entered=entered;
 const run=await x.service.start('control-cas');await enteredPromise;
 const before=await x.service.read(run.runId);
 assert.equal(before.controlVersion,0);assert.equal(before.status,'processing');
 await assert.rejects(x.service.pause(run.runId,7,randomUUID()),error=>error instanceof StorageFailure&&error.code==='memory_extraction_control_conflict');
 const paused=await x.service.pause(run.runId,0,randomUUID());
 assert.equal(paused.controlVersion,1);assert.equal(paused.replayed,false);
 const replay=await x.service.pause(run.runId,1,randomUUID());
 assert.equal(replay.replayed,true,'同版本重复暂停幂等');
 release();await x.service.waitForIdle(run.runId);
 const resumed=await x.service.read(run.runId);
 assert.equal(resumed.status,'paused');
 const callsBefore=x.state.calls;
 await assert.rejects(x.service.continue(run.runId,0,randomUUID()),error=>error instanceof StorageFailure&&error.code==='memory_extraction_control_conflict');
 const continued=await x.service.continue(run.runId,1,randomUUID());
 assert.equal(continued.controlVersion,2);
 await x.service.waitForIdle(run.runId);
 const quiet=await x.service.read(run.runId);
 const quietAgain=await x.service.read(run.runId);
 assert.equal(quiet.controlVersion,2);assert.equal(quietAgain.controlVersion,2);
 assert.equal(x.state.calls,callsBefore,'恢复查询不发送模型请求');
});

test('05来源删除在途撤销提交资格，迟到结果不能恢复内容',async t=>{
 const f=await fixtureWithMessages(t,{a:['我住在高雄。']});
 const holders=new ActiveHolders();
 const external=supplier();
 let service,release;const gate=new Promise(resolve=>release=resolve);let entered;const enteredPromise=new Promise(resolve=>entered=resolve);
 const base=modelPort(()=>service.accounting,async(request,input)=>{if(entered){const signal=entered;entered=null;signal();await gate;}return external.respond(request,input);});
 const port={prepare:base.prepare,close:base.close,invoke:base.invoke,get calls(){return base.calls;}};
 service=new SqliteMemoryExtraction(f.storage,owner,port,holders);t.after(async()=>{release?.();await service.close();});
 const run=await service.start('control-delete');await enteredPromise;
 const inputs=await f.storage.execute('fixture.runInputs',{ownerId:owner,runId:run.runId});
 const sourceId=inputs.find(row=>row.role==='target').record_id;
 const deletion=new DeletionService(f.storage,holders,new ManagedFiles(f.root));
 const plan=await deletion.plan({ownerId:owner,requestKey:'control-delete-source',scope:{kind:'source',contactId:f.ca,sourceId}});
 const advancing=deletion.advance({ownerId:owner,operationId:plan.operationId});
 await wait(50);release();
 const done=await advancing;
 assert.equal(done.state,'completed',JSON.stringify(done.checks));
 const management=new SqliteMemoryManagement(f.storage,owner);
 assert.deepEqual(await management.read({scopeKind:'contact',contactId:f.ca}),{candidates:[],memories:[]},'删除后不因迟到结果恢复内容');
 await assert.rejects(service.read(run.runId),error=>error instanceof StorageFailure&&error.code==='memory_extraction_not_found','删除后旧轮次不再可读');
 await assert.rejects(service.continue(run.runId,0,randomUUID()),error=>error instanceof StorageFailure&&error.code==='memory_extraction_not_found');
});

test('整轮完成只由09完整发布判定，未结束阶段与已有候选都不冒充完成',async t=>{
 const observed=[];let fixtureState,runId;
 fixtureState=await documentFixture(t,{beforeCall:async()=>{if(runId)observed.push(await fixtureState.extraction.read(runId));}});
 runId=(await fixtureState.extraction.start('control-documents-complete')).runId;
 await fixtureState.extraction.waitForIdle(runId);
 const view=await fixtureState.extraction.read(runId);
 assert.equal(view.state,'completed');
 assert.equal(view.status,'completed');assert.equal(view.statusReason,null);assert.deepEqual(view.actions,[]);
 assert.equal(view.stage,'completed');assert.equal(view.laterStages,'completed');
 const during=observed.find(value=>value.stage==='document_scene'||value.stage==='document_profile');
 assert.ok(during,'应观察到真实文档阶段');
 assert.notEqual(during.status,'completed','仍有适用阶段未结束时不得显示整轮完成');
 assert.equal(during.laterStages,'pending');
 assert.ok(during.candidates.length>=1,'已有候选不等于整轮完成');
 await assert.rejects(fixtureState.extraction.pause(runId,view.controlVersion,randomUUID()),error=>error instanceof StorageFailure&&error.code==='memory_extraction_control_conflict');
 await assert.rejects(fixtureState.extraction.continue(runId,view.controlVersion,randomUUID()),error=>error instanceof StorageFailure&&error.code==='memory_extraction_control_conflict');
});

test('暂停期间取消勾选立即失效，继续不复活已撤销范围',async t=>{
 const f=await fixtureWithMessages(t,{a:['我住在高雄。']});
 const x=extractionFixture(f);t.after(async()=>{release?.();await x.service.close();});
 let release;const gate=new Promise(resolve=>release=resolve);let entered;const enteredPromise=new Promise(resolve=>entered=resolve);
 x.state.gate=gate;x.state.entered=entered;
 const run=await x.service.start('control-pause-cancel');await enteredPromise;
 const running=await x.service.read(run.runId);
 await x.service.pause(run.runId,running.controlVersion,randomUUID());
 release();await x.service.waitForIdle(run.runId);
 const paused=await x.service.read(run.runId);
 assert.equal(paused.status,'paused');
 const binding=f.saved.find(row=>row.contact_id===f.ca);
 await f.contacts.revoke(f.ca,binding.binding_id,binding.selection_generation);
 const revoked=await x.service.read(run.runId);
 assert.equal(revoked.tasks.find(task=>task.scopeKind==='contact').state,'revoked','暂停期间取消勾选立即撤销资格');
 assert.equal(revoked.status,'blocked');assert.equal(revoked.statusReason,'scope_revoked');
 assert.deepEqual(revoked.actions,[]);
 const callsBefore=x.state.calls;
 const continued=await x.service.continue(run.runId,revoked.controlVersion,randomUUID());
 await x.service.waitForIdle(run.runId);
 assert.equal(x.state.calls,callsBefore,'继续不复活已撤销范围，不新增模型调用');
 const after=await x.service.read(run.runId);
 assert.equal(after.tasks.find(task=>task.scopeKind==='contact').state,'revoked');
 assert.equal(after.status,'blocked');assert.equal(after.statusReason,'scope_revoked');
 assert.deepEqual(after.actions,[]);
 assert.notEqual(continued.status,'completed');
});

test('历史失败不冒充当前状态：修正后继续成功不再显示失败计数',async t=>{
 const f=await fixtureWithMessages(t,{a:['我长期住在高雄。']});
 const x=extractionFixture(f);t.after(()=>x.service.close());
 const normal=supplier();
 x.state.prepare=async()=>{throw Object.assign(new Error('synthetic_bad_request'),{code:'extraction_model_request_invalid'});};
 const run=await x.service.start('control-history-failure');await x.service.waitForIdle(run.runId);
 const failed=await x.service.read(run.runId);
 assert.equal(failed.failed,1);assert.equal(failed.succeeded,0);
 assert.equal(failed.status,'blocked');assert.equal(failed.statusReason,'contact_failed');
 assert.ok(failed.actions.includes('continue'));
 x.state.prepare=null;x.state.respond=(request,input)=>normal.respond(request,input);
 await x.service.continue(run.runId,failed.controlVersion,randomUUID());
 await x.service.waitForIdle(run.runId);
 const succeeded=await x.service.read(run.runId);
 assert.equal(succeeded.failed,0,'历史失败不再冒充当前失败');
 assert.equal(succeeded.succeeded,1);
 assert.equal(succeeded.status,'blocked');assert.equal(succeeded.statusReason,'later_stages_pending');
 assert.equal(succeeded.candidates.length,1);
});
