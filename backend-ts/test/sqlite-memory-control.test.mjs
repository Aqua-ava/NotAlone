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
import {fixture as clearFixture,identity as clearIdentity,record as clearRecord} from './sqlite-clear-support.mjs';

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

test('用户只启动所选联系人的已保存历史，保留20条小批且同键重放不重新执行',async t=>{
 const f=await fixtureWithMessages(t,{a:Array.from({length:25},(_,i)=>`合成历史${i+1}`),b:['乙的合成历史']});
 let memory;const port=modelPort(()=>memory.accounting);memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const key=randomUUID(),before=await memory.readContact(f.ca);assert.equal(before.run,null);assert.equal(port.calls,0);
 const start=await memory.startHistory(f.ca,key);assert.equal(start.contactId,f.ca);assert.equal(start.run.total,25);
 assert.ok(start.run.inputs.every(input=>input.contactId===f.ca));assert.equal(start.run.tasks.length,1);
 await memory.waitForIdle(start.run.runId);
 const done=await memory.readContact(f.ca);assert.equal(done.run.succeeded,25);assert.equal(port.calls,2,'正常20条提取小批仍由正式执行链处理');
 assert.equal((await memory.readContact(f.cb)).run,null,'乙的历史没有被甲的启动请求处理');
 const replay=await memory.startHistory(f.ca,key);assert.equal(replay.run.runId,start.run.runId);await memory.waitForIdle();assert.equal(port.calls,2);
 await assert.rejects(memory.startHistory(f.cb,key),error=>error.code==='memory_extraction_request_scope_mismatch');
});

test('历史初始化并发同键幂等，不同键不能重复建轮，运行中新文字不扩张固定输入',async t=>{
 const f=await fixture(t,{registryModule}),[a,b]=f.saved.map(binding=>binding.contact_id);
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true,resumeCursor:'tail-1'});
 await f.service.synchronize(a);await f.service.synchronize(b);
 const entered=Promise.withResolvers(),gate=Promise.withResolvers();let first=true,memory;
 const port=modelPort(()=>memory.accounting,async(request)=>{if(first){first=false;entered.resolve();await gate.promise;}return {blocks:[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify({scenes:[]})}]};});
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(async()=>{gate.resolve();await memory.close();});
 const key=randomUUID(),starts=await Promise.all([memory.startHistory(a,key),memory.startHistory(a,key)]);assert.equal(starts[0].run.runId,starts[1].run.runId);
 await entered.promise;
 const before=port.calls;await assert.rejects(memory.startHistory(a,randomUUID()),error=>error.code==='memory_extraction_contact_busy');assert.equal(port.calls,before);
 const coverage=await f.service.coverage(a),token=await f.contacts.eligibility(a);
 await f.storage.execute('history.acceptIncrementalPage',{token,goalId:coverage.incremental.goalId,captureId:randomUUID(),page:{target:f.target.descriptor,cursorIn:'tail-1',cursorOut:'tail-2',caughtUp:true,records:[record('2')]},at:Date.now(),runtimeToken:f.storage.status.runtimeId});
 assert.equal((await memory.readContact(a)).run.total,1,'运行中新到文字不能改变已冻结历史范围');
 gate.resolve();await memory.waitForIdle(starts[0].run.runId);assert.equal((await memory.readContact(a)).run.succeeded,1);assert.equal(port.calls,1);
 assert.equal((await memory.readContact(a)).queue.pending,1,'新到文字保留为后续增量资料');
 assert.equal((await memory.readContact(b)).run,null);
});

test('空历史、跨owner、撤销授权和来源失证不建新轮，也不影响无关联系人',async t=>{
 const f=await fixture(t,{registryModule}),[a,b]=f.saved.map(binding=>binding.contact_id);let memory;
 const port=modelPort(()=>memory.accounting);memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 await assert.rejects(memory.startHistory(a,randomUUID()),error=>error.code==='memory_extraction_no_pending_history');assert.equal((await memory.readContact(a)).run,null);
 const foreign=new SqliteMemoryExtraction(f.storage,randomUUID(),port);t.after(()=>foreign.close());
 await assert.rejects(foreign.startHistory(a,randomUUID()),error=>error.code==='memory_extraction_not_found');
 await f.service.synchronize(a);await f.service.synchronize(b);
 const token=await f.contacts.eligibility(a);await f.storage.execute('history.markContinuityLost',{token});
 await assert.rejects(memory.startHistory(a,randomUUID()),error=>error.code==='history_source_not_available');assert.equal((await memory.readContact(a)).run,null);
 const other=await memory.startHistory(b,randomUUID());await memory.waitForIdle(other.run.runId);assert.equal((await memory.readContact(b)).run.succeeded,1);
 const binding=f.saved.find(binding=>binding.contact_id===b);await f.contacts.revoke(b,binding.binding_id,binding.selection_generation);
 await assert.rejects(memory.startHistory(b,randomUUID()),error=>error.code==='memory_extraction_scope_stale');assert.equal(port.calls,1);
});

for(const kind of ['technical','paused','unknown'])test(`历史初始化保留${kind}保护，新键不重试旧调用，同键只读重放`,async t=>{
 const f=await fixtureWithMessages(t,{a:['我长期住在高雄。'],b:['乙的合成历史']});
 const entered=Promise.withResolvers(),gate=Promise.withResolvers();let memory;
 const port=modelPort(()=>memory.accounting,async(request,input)=>{
  if(input.scope.contact_id===f.ca&&kind==='unknown')throw new Error('合成未知调用');
  if(input.scope.contact_id===f.ca&&kind==='paused'){entered.resolve();await gate.promise;}
  return {blocks:[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify({scenes:[]})}]};
 });
 const originalPrepare=port.prepare.bind(port);
 // 技术失败（非共用配置）用于生成真实受阻历史，区别于已改为逐条跳过完成的内容拒绝。
 port.prepare=async(request,input)=>{if(kind==='technical'&&input.scope.contact_id===f.ca)throw Object.assign(new Error('synthetic_purpose'),{code:'extraction_model_purpose_invalid'});return originalPrepare(request,input);};
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(async()=>{gate.resolve();await memory.close();});
 const key=randomUUID(),start=await memory.startHistory(f.ca,key);
 if(kind==='paused'){await entered.promise;const current=await memory.read(start.run.runId);await memory.pause(start.run.runId,current.controlVersion,randomUUID());}
 else await memory.waitForIdle(start.run.runId);
 const callsBefore=port.calls;
 await assert.rejects(memory.startHistory(f.ca,randomUUID()),error=>error.code==='memory_extraction_history_blocked');
 const replay=await memory.startHistory(f.ca,key);assert.equal(replay.run.runId,start.run.runId);assert.equal(port.calls,callsBefore);
 if(kind==='paused')gate.resolve();await memory.waitForIdle(start.run.runId);
 const other=await memory.startHistory(f.cb,randomUUID());await memory.waitForIdle(other.run.runId);
 assert.equal((await memory.readContact(f.cb)).run.succeeded,1,'甲的失败或未知结果不把乙并入同一轮，也不阻止乙初始化');
});

test('来源删除围栏阻止历史初始化，删除后同键墓碑不能恢复原文字或任务',async t=>{
 const f=await fixtureWithMessages(t,{a:['甲的合成历史'],b:['乙的合成历史']}),holders=new ActiveHolders();let memory;
 const port=modelPort(()=>memory.accounting);memory=new SqliteMemoryExtraction(f.storage,owner,port,holders);t.after(()=>memory.close());
 const key=randomUUID(),view=await memory.startHistory(f.ca,key);await memory.waitForIdle(view.run.runId);
 const sourceId=view.run.inputs.find(input=>input.role==='target').recordId;
 const deletion=new DeletionService(f.storage,holders,new ManagedFiles(f.root));
 const plan=await deletion.plan({ownerId:owner,requestKey:'history-init-source-delete',scope:{kind:'source',contactId:f.ca,sourceId}});
 await assert.rejects(memory.startHistory(f.cb,randomUUID()),error=>error.code==='memory_extraction_scope_stale');
 const result=await deletion.advance({ownerId:owner,operationId:plan.operationId});assert.equal(result.state,'completed');
 await assert.rejects(memory.startHistory(f.ca,key),error=>error.code==='memory_extraction_request_deleted');
 assert.equal(port.calls,1);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('联系人处理快照隔离同轮不同内容结果、本人任务和调用',async t=>{
 const f=await fixtureWithMessages(t,{a:['我长期住在高雄。'],b:['我长期住在台南。']});
 const x=extractionFixture(f);t.after(()=>x.service.close());
 const rejected=supplier({negative:true}),accepted=supplier();
 x.state.respond=(request,input)=>(input.scope.contact_id===f.ca?rejected:accepted).respond(request,input);
 const run=await x.service.start('control-contact-isolation');await x.service.waitForIdle(run.runId);
 const callsBefore=x.state.calls;
 const a=await x.service.readContact(f.ca),b=await x.service.readContact(f.cb);
 assert.equal(a.contactId,f.ca);assert.equal(b.contactId,f.cb);
 assert.equal(a.run.runId,run.runId);assert.equal(b.run.runId,run.runId);
 assert.equal(a.run.total,1);assert.equal(a.run.succeeded,1);assert.equal(a.run.failed,0);
 assert.equal(a.run.tasks[0].state,'succeeded');assert.equal(a.run.tasks[0].errorCode,null);
 assert.deepEqual(a.run.candidates,[],'内容拒绝只影响本条候选，不产生记忆');
 assert.equal(b.run.total,1);assert.equal(b.run.succeeded,1);assert.equal(b.run.failed,0);
 assert.equal(b.run.candidates.length,1);
 assert.equal(a.run.statusReason,'later_stages_pending');assert.equal(b.run.statusReason,'later_stages_pending','另一联系人的内容结果不能污染本联系人投影');
 for(const [view,contactId] of [[a,f.ca],[b,f.cb]]){
  assert.equal(view.run.tasks.length,1);assert.equal(view.run.tasks[0].scopeKind,'contact');
  assert.equal(view.run.tasks[0].contactId,contactId);assert.ok(view.run.inputs.every(input=>input.contactId===contactId));
  assert.ok(view.run.candidates.every(candidate=>candidate.contactId===contactId));
  assert.equal(view.run.calls.succeeded,2);assert.deepEqual(view.run.actions,[],'单联系人只读投影不能提供整轮控制动作');
 }
 assert.equal(x.state.calls,callsBefore,'查询状态不能调用模型');
});

test('没有当前联系人处理记录时返回空；各联系人保留自己的最近轮次',async t=>{
 const f=await fixture(t,{registryModule}),[a,b]=f.saved.map(binding=>binding.contact_id);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期喜欢合成园艺。'})],completedPartitions:['shard-a'],exhausted:true});
 const x=extractionFixture(f);t.after(()=>x.service.close());
 assert.deepEqual(await x.service.readContact(b),{contactId:b,run:null,queue:{pending:0,nextDueAt:null,blockedContacts:0,content:[],history:{pending:0},later:{pending:0,nextDueAt:null,stage:null}}});
 await f.service.synchronize(a);const first=await x.service.start('contact-first-a');await x.service.waitForIdle(first.runId);
 assert.equal((await x.service.readContact(b)).run,null,'甲的记录不成为乙的最近记录');
 await f.service.synchronize(b);const second=await x.service.start('contact-second-b');await x.service.waitForIdle(second.runId);
 assert.notEqual(first.runId,second.runId);
 assert.equal((await x.service.readContact(a)).run.runId,first.runId);assert.equal((await x.service.readContact(b)).run.runId,second.runId);
 await assert.rejects(x.service.readContact('not-a-contact'),error=>error.code==='memory_extraction_input_invalid');
 await assert.rejects(x.service.readContact(randomUUID()),error=>error.code==='memory_extraction_not_found');
 const foreign=new SqliteMemoryExtraction(f.storage,randomUUID(),x.port);t.after(()=>foreign.close());
 await assert.rejects(foreign.readContact(a),error=>error.code==='memory_extraction_not_found');
 const binding=f.saved.find(binding=>binding.contact_id===a);
 await f.contacts.revoke(a,binding.binding_id,binding.selection_generation);
 const revoked=await x.service.readContact(a);
 assert.equal(revoked.run,null,'撤销后当前视图不恢复旧轮次或正文');
 const archive=await x.service.read(first.runId);assert.equal(archive.tasks[0].state,'revoked');assert.equal(archive.revoked,1);
 assert.deepEqual(archive.candidates,[],'撤销范围后不显示旧候选正文');
 assert.ok((await x.service.readContact(b)).run.tasks.every(task=>task.state!=='revoked'));
});

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
 // 暂停/继续期间后到的新消息留到下一次明确启动，不并入旧固定轮次。
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:26},(_,index)=>record(String(index+1),{text:`我第${index+1}条合成消息。`})),completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.service.synchronize(f.ca);
 const afterNew=await x.service.read(run.runId);
 assert.equal(afterNew.total,25,'新消息不并入已启动的固定轮次');
 assert.equal(afterNew.succeeded,25);
 const next=await x.service.start('control-pause-batch-next');await x.service.waitForIdle(next.runId);
 const nextView=await x.service.read(next.runId);
 assert.equal(nextView.total,1);assert.equal(nextView.succeeded,1,'新消息留到下一次明确启动时处理');
});

test('单人技术失败只让其受阻，共用模型故障暂停整轮并显示固定原因，失败不自动重试模型',async t=>{
 const f=await fixtureWithMessages(t,{a:['我住在高雄。','我偏好绿茶。'],b:['我住在台南。','我偏好红茶。']});
 const x=extractionFixture(f);t.after(()=>x.service.close());
 const normal=supplier();
 let shared=null,perContactFault=true;
 const prepareByContact=new Map();
 const originalPrepare=x.port.prepare;
 // 单人技术失败（非共用配置）：只让该联系人失败，其他联系人继续；内容逐条拒绝不再上升到失败。
 // 真实供应商的配置类故障是共用的，调用阶段失败会落为未知回执；这里用 prepare 阶段的非共用码作为合成代理，
 // 只为覆盖“失败联系人单独重试、成功联系人不重跑”的控制与投影路径。
 x.state.respond=normal.respond;
 x.port.prepare=async(request,input)=>{
  const contactId=input.scope.contact_id;prepareByContact.set(contactId,(prepareByContact.get(contactId)??0)+1);
  if(shared)throw Object.assign(new Error('synthetic_shared'),{code:shared});
  if(perContactFault&&contactId===f.ca)throw Object.assign(new Error('synthetic_purpose'),{code:'extraction_model_purpose_invalid'});
  return originalPrepare(request,input);
 };
 const run=await x.service.start('control-failures');await x.service.waitForIdle(run.runId);
 let view=await x.service.read(run.runId);
 assert.equal(view.status,'blocked');assert.equal(view.statusReason,'contact_failed');
 assert.deepEqual(view.actions,['continue']);
 let failed=view.tasks.find(task=>task.scopeKind==='contact'&&task.contactId===f.ca);
 let other=view.tasks.find(task=>task.scopeKind==='contact'&&task.contactId===f.cb);
 assert.equal(failed.state,'failed');assert.equal(other.state,'succeeded');assert.equal(view.unknown,0);
 const candidatesBefore=view.candidates.length,callsBefore=x.state.calls;
 const caPreparedBefore=prepareByContact.get(f.ca)??0,cbPreparedBefore=prepareByContact.get(f.cb)??0;
 view=await x.service.continue(run.runId,view.controlVersion,randomUUID());await x.service.waitForIdle(run.runId);
 view=await x.service.read(run.runId);
 other=view.tasks.find(task=>task.scopeKind==='contact'&&task.contactId===f.cb);
 assert.equal(other.state,'succeeded','成功联系人不得被继续重跑');
 assert.equal(view.candidates.length,candidatesBefore,'成功结果不重复生成');
 assert.equal(prepareByContact.get(f.ca),caPreparedBefore+1,'只重试失败联系人');
 assert.equal(prepareByContact.get(f.cb),cbPreparedBefore,'成功联系人不重跑');
 // 共用模型配置故障：整轮暂停，固定原因，等待手动继续，不自动重试。
 const callsBeforeShared=x.state.calls;
 shared='extraction_model_authentication_failed';
 await x.service.continue(run.runId,view.controlVersion,randomUUID());await x.service.waitForIdle(run.runId);
 view=await x.service.read(run.runId);
 assert.equal(view.status,'blocked');assert.equal(view.statusReason,'extraction_model_authentication_failed');
 assert.equal(view.sharedFaultCode,'extraction_model_authentication_failed');
 assert.deepEqual(view.actions,['continue']);
 assert.equal(x.state.calls,callsBeforeShared,'共用故障没有新增模型调用');
 const blockedContact=await x.service.readContact(f.ca);
 assert.equal(blockedContact.run.status,'blocked');
 assert.equal(blockedContact.run.statusReason,'extraction_model_authentication_failed');
 assert.deepEqual(blockedContact.run.actions,[],'混合轮次不能从单联系人卡片恢复整轮');

});

test('单联系人历史认证失败可从联系人卡片恢复，成功小批不重做',async t=>{
 const f=await fixtureWithMessages(t,{a:Array.from({length:21},(_,i)=>`合成偏好${i}`),b:['其他联系人的资料']});
 let memory;const port=modelPort(()=>memory.accounting);memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const original=port.prepare.bind(port);let failed=false;
 port.prepare=async(request,input)=>{if(port.calls>=1&&!failed){failed=true;throw Object.assign(new Error('synthetic_auth'),{code:'extraction_model_authentication_failed'});}return original(request,input);};
 const started=await memory.startHistory(f.ca,randomUUID());await memory.waitForIdle(started.run.runId);
 const blocked=await memory.readContact(f.ca);
 assert.equal(blocked.run.statusReason,'extraction_model_authentication_failed');
 assert.deepEqual(blocked.run.actions,['continue']);
 assert.equal(blocked.run.succeeded,20);
 const before=port.calls;
 await memory.continue(blocked.run.runId,blocked.run.controlVersion,randomUUID());await memory.waitForIdle(started.run.runId);
 const recovered=await memory.readContact(f.ca);
 assert.equal(recovered.run.succeeded,21);assert.equal(port.calls,before+1);
 assert.equal((await memory.readContact(f.cb)).run,null);
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

test('退出中断后保留安全恢复资格与已完成结果；合法回执复用且不重发',async t=>{
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
 const readEligibilityBefore=await f.contacts.eligibility(f.ca),pageCallsBefore=f.channel.page;
 const interrupted=await service.start('control-interrupted');await enteredPromise;
 const contact=await until(async()=>contactTask(await taskRows(f,interrupted.runId),f.ca));
 const running=await until(async()=>(await attempts(f,contact.id)).find(row=>row.state==='running'));
 await f.storage.execute('fixture.setRuntimeToken',{ownerId:owner,attemptId:running.id,token:'synthetic-old-runtime'});
 await f.storage.execute('memoryExtraction.recover',{ownerId:owner});
 let view=await service.read(interrupted.runId);
 assert.equal(view.status,'blocked');
 assert.deepEqual(view.actions,['continue'],'安全中断保留原轮恢复资格，不伪造用户暂停');
 const known=await calls(f,interrupted.runId);
 assert.equal(known.filter(row=>row.state==='unknown'||row.state==='sending').length,0,'已成功回执不伪造未知');
 assert.equal(known.filter(row=>row.state==='succeeded').length,2);
 // 存储恢复只保留资格；由正常宿主的有限恢复调度领取，读取本身不调用模型。
 const callsBeforeContinue=port.calls;await wait(50);
 assert.equal(port.calls,callsBeforeContinue);
 const preserved=await service.read(first.runId);
 assert.equal(preserved.succeeded,1,'已完成轮次结果保留');
 const readEligibilityAfter=await f.contacts.eligibility(f.ca);
 assert.equal(String(readEligibilityAfter.selection_generation),String(readEligibilityBefore.selection_generation));
 assert.equal(String(readEligibilityAfter.data_generation),String(readEligibilityBefore.data_generation));
 assert.equal(readEligibilityAfter.owner_id,readEligibilityBefore.owner_id);
 assert.equal(f.channel.page,pageCallsBefore,'记忆恢复不触发微信读取');
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
 {const cleared=await management.read({scopeKind:'contact',contactId:f.ca});assert.deepEqual({candidates:cleared.candidates,memories:cleared.memories},{candidates:[],memories:[]});}
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
 {const cleared=await management.read({scopeKind:'contact',contactId:f.ca});assert.deepEqual({candidates:cleared.candidates,memories:cleared.memories},{candidates:[],memories:[]},'删除后不因迟到结果恢复内容');}
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

test('清空聊天后旧模型结果与重试晚到不恢复内容，新消息按新资格留到下一次启动',async t=>{
 const f=await clearFixture(t,{registryModule});
 const contact=f.contactA;
 f.state.pageRecords=[clearRecord('shard-a','1',{text:'我长期住在高雄。'})];
 f.state.boundaryMembers=[clearIdentity('shard-a','1')];
 await f.current.history.synchronize(contact);
 assert.equal((await f.current.history.read(contact)).messages.length,1);
 const external=supplier();
 let service,release;const gate=new Promise(resolve=>release=resolve);let entered;const enteredPromise=new Promise(resolve=>entered=resolve);
 const base=modelPort(()=>service.accounting,async(request,input)=>{entered();await gate;return external.respond(request,input);});
 const port={prepare:base.prepare,close:base.close,invoke:base.invoke,get calls(){return base.calls;}};
 service=new SqliteMemoryExtraction(f.current.storage,owner,port,f.current.holders);
 t.after(async()=>{release();await service.close();});
 const run=await service.start('control-clear-late');await enteredPromise;
 const clearing=f.current.clear.clear(contact);
 await wait(80);release();
 const status=await clearing;
 assert.equal(status.completed,true,JSON.stringify(status));
 assert.equal((await f.current.history.read(contact)).messages.length,0,'清空删除已保存聊天');
 const management=new SqliteMemoryManagement(f.current.storage,owner);
 {const cleared=await management.read({scopeKind:'contact',contactId:contact});assert.deepEqual({candidates:cleared.candidates,memories:cleared.memories},{candidates:[],memories:[]},'旧模型晚到不恢复内容');}
 await assert.rejects(service.read(run.runId),error=>error instanceof StorageFailure&&error.code==='memory_extraction_not_found','清空后旧轮次不可读');
 await assert.rejects(management.importRun(run.runId),error=>error instanceof StorageFailure&&error.code==='memory_run_not_found','旧轮次重试晚到不能恢复内容');
 // 清空后新消息按新资格同步，且只在用户明确启动时处理。
 f.state.pageRecords=[clearRecord('shard-a','2',{text:'我现在长期住在台南。'})];
 const coverage=await f.current.history.synchronize(contact);
 const restored=await f.current.history.read(contact);
 assert.equal(restored.messages.length,1);
 assert.equal(restored.messages[0].text,'我现在长期住在台南。');
 const callsBeforeNext=base.calls;
 const next=await service.start('control-clear-new');await service.waitForIdle(next.runId);
 const view=await service.read(next.runId);
 assert.equal(view.total,1);assert.equal(view.succeeded,1);
 assert.equal(view.candidates.length,1);
 assert.equal(base.calls-callsBeforeNext,2,'只有新消息的提取与核验调用');
});

test('没有可处理固定目标时不伪装范围失效或完成',async t=>{
 const f=await fixtureWithMessages(t,{a:[]});
 const x=extractionFixture(f);t.after(()=>x.service.close());
 const run=await x.service.start('control-no-inputs');await x.service.waitForIdle(run.runId);
 const view=await x.service.read(run.runId);
 assert.equal(view.total,0);
 assert.equal(view.status,'blocked');assert.equal(view.statusReason,'no_pending_inputs');
 assert.deepEqual(view.actions,[]);assert.notEqual(view.status,'completed');
 assert.equal(x.state.calls,0);
});

test('在途已发送不是未知回执：发送中保持处理中，可暂停且不显示受阻',async t=>{
 const f=await fixtureWithMessages(t,{a:['我长期住在高雄。']});
 const x=extractionFixture(f);t.after(async()=>{release?.();await x.service.close();});
 const external=supplier();
 let release;const gate=new Promise(resolve=>release=resolve);let entered;const enteredPromise=new Promise(resolve=>entered=resolve);
 x.state.respond=async(request,input)=>{entered();await gate;return external.respond(request,input);};
 const run=await x.service.start('control-sending');await enteredPromise;
 const sending=await x.service.read(run.runId);
 assert.equal(sending.calls.sending,1);
 assert.equal(sending.status,'processing');assert.equal(sending.statusReason,null);
 assert.deepEqual(sending.actions,['pause']);
 release();await x.service.waitForIdle(run.runId);
 assert.equal((await x.service.read(run.runId)).succeeded,1);
});

test('发送中崩溃重开显示未知回执且不提供继续、不自动提交',async t=>{
 const f=await fixtureWithMessages(t,{a:['我长期住在高雄。']});
 const external=supplier();
 let service,release;const gate=new Promise(resolve=>release=resolve);let entered;const enteredPromise=new Promise(resolve=>entered=resolve);
 const base=modelPort(()=>service.accounting,async(request,input)=>{entered();await gate;return external.respond(request,input);});
 const port={prepare:base.prepare,close:base.close,invoke:base.invoke,get calls(){return base.calls;}};
 service=new SqliteMemoryExtraction(f.storage,owner,port);t.after(async()=>{release();await service.close();});
 const run=await service.start('control-sending-crash');await enteredPromise;
 const contact=contactTask(await taskRows(f,run.runId),f.ca);
 const running=await until(async()=>(await attempts(f,contact.id)).find(row=>row.state==='running'));
 await f.storage.execute('fixture.setRuntimeToken',{ownerId:owner,attemptId:running.id,token:'synthetic-crashed-runtime'});
 await f.storage.execute('memoryExtraction.recover',{ownerId:owner});
 const view=await service.read(run.runId);
 assert.equal(view.status,'blocked');assert.equal(view.statusReason,'model_receipt_unknown');
 assert.deepEqual(view.actions,[],'发送中崩溃不能提供继续');
 assert.equal(view.unknown,1);
 const callsNow=await calls(f,run.runId);
 assert.equal(callsNow.filter(row=>row.state==='unknown').length,1,'发送中崩溃保守记为未知');
 // 迟到但可验证的回执只结算账本；旧租约不能提交业务，但可安全继续并复用该回执。
 release();await service.waitForIdle(run.runId);
 const after=await service.read(run.runId);
 assert.equal(after.statusReason,'interrupted_known_receipts');
 assert.deepEqual(after.actions,['continue']);
 assert.equal(after.candidates.length,0,'崩溃旧租约不能提交业务');
 const callsBeforeContinue=base.calls;
 await service.continue(run.runId,after.controlVersion,randomUUID());
 await service.waitForIdle(run.runId);
 const done=await service.read(run.runId);
 assert.equal(done.succeeded,done.total,'可验证回执安全恢复后完成固定目标');
 // 崩溃前响应载荷未归档（回执已结算但 model_output 事件未落库），恢复时允许各补一次提取与核验；不重放未知回执。
 assert.equal(base.calls-callsBeforeContinue,2);
 assert.equal((await calls(f,run.runId)).filter(row=>row.state==='unknown'||row.state==='sending').length,0);
});

test('09真实文档阶段共用故障经noteFailure投影固定原因且不提供错误动作',async t=>{
 const f=await documentFixture(t,{documentModel:'unconfigured'});
 const run=await f.extraction.start('control-document-shared-real');await f.extraction.waitForIdle(run.runId);
 const view=await f.extraction.read(run.runId);
 // 真实路径：09 文档服务在模型未配置时由 port 抛 document_model_unconfigured，经 stages.noteFailure 写入任务 error_code。
 const task=view.tasks.find(item=>item.scopeKind==='contact');
 assert.equal(task.errorCode,'document_model_unconfigured','真实noteFailure写入了固定原因');
 const document=await f.documents.readTask(task.taskId);
 assert.notEqual(document.outcome,'completed');
 assert.equal(view.sharedFaultCode,'document_model_unconfigured');
 assert.equal(view.status,'blocked');assert.equal(view.statusReason,'document_model_unconfigured');
 assert.equal(view.unknown,0,'文档共用故障不是未知回执');
 assert.deepEqual(view.actions,[],'文档共用故障不提供重发/继续类动作');
 assert.notEqual(view.status,'completed');
});


test('源码策略变化后恢复只迁移原轮未完成目标，旧结果与新到消息不重发',async t=>{
 const f=await fixtureWithMessages(t,{a:Array.from({length:21},(_,i)=>`合成偏好${i}`),b:['其他联系人的资料']});
 let memory;const port=modelPort(()=>memory.accounting);memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const original=port.prepare.bind(port);let failed=false;
 port.prepare=async(request,input)=>{if(port.calls>=1&&!failed){failed=true;throw Object.assign(new Error('synthetic_auth'),{code:'extraction_model_authentication_failed'});}return original(request,input);};
 const started=await memory.startHistory(f.ca,randomUUID());await memory.waitForIdle(started.run.runId);
 await f.storage.execute('fixture.stalePolicy',{ownerId:owner,runId:started.run.runId});
 const blocked=await memory.readContact(f.ca),before=port.calls;
 assert.equal(blocked.run.succeeded,20);
 const originalInputs=await f.storage.execute('fixture.runInputs',{ownerId:owner,runId:blocked.run.runId});
 f.channel.page=async scope=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:22},(_,i)=>record(String(i+1),{text:`合成偏好${i}`})),completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(f.ca);
 assert.equal((await f.storage.execute('fixture.messages',{ownerId:owner,contactId:f.ca})).length,22);
 const reply=await memory.continue(blocked.run.runId,blocked.run.controlVersion,randomUUID());
 assert.equal(reply.runId,blocked.run.runId,'保留原控制回执合同');
 const next=await memory.readContact(f.ca);assert.notEqual(next.run.runId,blocked.run.runId);
 await memory.waitForIdle(next.run.runId);
 const done=await memory.readContact(f.ca);assert.equal(done.run.total,1);assert.equal(done.run.succeeded,1);assert.equal(port.calls,before+1);
 const copied=await f.storage.execute('fixture.runInputs',{ownerId:owner,runId:done.run.runId});
 for(const row of copied)assert.ok(originalInputs.some(old=>old.message_id===row.message_id&&old.record_id===row.record_id&&old.accepted_interpretation_revision===row.accepted_interpretation_revision));
 const old=await runRow(f,blocked.run.runId);assert.equal(JSON.parse(old.policy_config).source_stamp,'a'.repeat(64));
 assert.deepEqual((await memory.read(blocked.run.runId)).actions,[]);
 const replay=await memory.continue(blocked.run.runId,blocked.run.controlVersion,randomUUID());
 assert.equal(replay.runId,blocked.run.runId);await memory.waitForIdle();assert.equal(port.calls,before+1);
 assert.equal((await memory.readContact(f.cb)).run,null);
});


test('策略升级不能重发未知回执，也不能用旧恢复请求重启失败后继轮',async t=>{
 const f=await fixtureWithMessages(t,{a:['合成原始消息']});
 const x=extractionFixture(f);t.after(()=>x.service.close());
 x.state.respond=async()=>{throw Object.assign(new Error('synthetic_timeout'),{code:'extraction_model_timeout'});};
 const first=await x.service.startHistory(f.ca,randomUUID());await x.service.waitForIdle(first.run.runId);
 await f.storage.execute('fixture.stalePolicy',{ownerId:owner,runId:first.run.runId});
 const before=await x.service.readContact(f.ca),count=x.state.calls;
 assert.equal(before.run.unknown,1);
 await assert.rejects(x.service.continue(first.run.runId,before.run.controlVersion,randomUUID()),e=>e.code==='memory_extraction_receipt_unknown');
 assert.equal(x.state.calls,count);assert.equal((await x.service.readContact(f.ca)).run.runId,first.run.runId);
});

test('策略恢复新轮失败后重放旧控制请求不再次调用模型',async t=>{
 const f=await fixtureWithMessages(t,{a:['合成原始消息']});
 const x=extractionFixture(f);t.after(()=>x.service.close());
 let preparations=0;x.state.prepare=async()=>{preparations++;throw Object.assign(new Error('synthetic_auth'),{code:'extraction_model_authentication_failed'});};
 const first=await x.service.startHistory(f.ca,randomUUID());await x.service.waitForIdle(first.run.runId);
 await f.storage.execute('fixture.stalePolicy',{ownerId:owner,runId:first.run.runId});
 const before=await x.service.readContact(f.ca);
 await x.service.continue(first.run.runId,before.run.controlVersion,randomUUID());const next=await x.service.readContact(f.ca);await x.service.waitForIdle(next.run.runId);
 assert.notEqual(next.run.runId,first.run.runId);const count=preparations;
 await x.service.continue(first.run.runId,before.run.controlVersion,randomUUID());await x.service.waitForIdle();
 assert.equal(preparations,count);
});


test('策略升级恢复保留原授权代次，撤销后不能借新轮恢复读取',async t=>{
 const f=await fixtureWithMessages(t,{a:['合成原始消息']});
 const x=extractionFixture(f);t.after(()=>x.service.close());
 x.state.prepare=async()=>{throw Object.assign(new Error('synthetic_auth'),{code:'extraction_model_authentication_failed'});};
 const first=await x.service.startHistory(f.ca,randomUUID());await x.service.waitForIdle(first.run.runId);
 await f.storage.execute('fixture.stalePolicy',{ownerId:owner,runId:first.run.runId});
 const before=await x.service.readContact(f.ca),binding=f.saved.find(row=>row.contact_id===f.ca);
 await f.contacts.revoke(f.ca,binding.binding_id,binding.selection_generation);
 await assert.rejects(x.service.continue(first.run.runId,before.run.controlVersion,randomUUID()),e=>e.code==='memory_extraction_scope_stale');
 assert.equal(x.state.calls,0);assert.equal((await x.service.readContact(f.ca)).run,null);assert.equal((await x.service.read(first.run.runId)).runId,first.run.runId);
});


test('策略后继轮完整成功后旧失败轮不阻止新历史目标启动',async t=>{
 const f=await documentFixture(t,{registryModule});
 const original=f.extractionPort.prepare;let failed=false;
 f.extractionPort.prepare=async(...args)=>{if(!failed){failed=true;throw Object.assign(new Error('synthetic_auth'),{code:'extraction_model_authentication_failed'});}return original(...args);};
 const first=await f.extraction.startHistory(f.contactId,randomUUID());await f.extraction.waitForIdle(first.run.runId);
 await f.storage.execute('fixture.stalePolicy',{ownerId:owner,runId:first.run.runId});
 const blocked=await f.extraction.readContact(f.contactId);
 await f.extraction.continue(first.run.runId,blocked.run.controlVersion,randomUUID());
 const successor=await f.extraction.readContact(f.contactId);await f.extraction.waitForIdle(successor.run.runId);
 assert.equal((await f.extraction.readContact(f.contactId)).run.status,'completed');
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期喜欢合成园艺。'}),record('2',{text:'我长期喜欢合成音乐。'})],completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.service.synchronize(f.contactId);
 const next=await f.extraction.startHistory(f.contactId,randomUUID());
 assert.notEqual(next.run.runId,first.run.runId);assert.notEqual(next.run.runId,successor.run.runId);
 assert.equal(next.run.total,1);
 await f.extraction.waitForIdle(next.run.runId);
 assert.equal((await f.extraction.readContact(f.contactId)).run.succeeded,1);
});
