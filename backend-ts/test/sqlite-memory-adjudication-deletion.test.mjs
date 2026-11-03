import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {supplier} from './fixtures/memory-management/supplier.mjs';
import {adjudicationSupplier} from './fixtures/memory-management/adjudication-support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteMemoryAdjudication} from '../src/memory/sqlite/management/adjudication-service.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';

const registryModule=new URL('./fixtures/memory-management/adjudication-deletion-registry.mjs',import.meta.url).href;
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
// 每个阶段只等待一次事件，超时直接失败，避免模型或删除死锁拖住测试。
async function bounded(promise,label){
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`等待${label}超时`)),5_000);})]);}
 finally{clearTimeout(timer);}
}

async function prepared(t,self){
 const f=await fixture(t,{registryModule}),[a,b]=f.saved.map(c=>c.contact_id),holders=new ActiveHolders();
 const management=new SqliteMemoryManagement(f.storage,owner),scope=self?{scopeKind:'self',contactId:null}:{scopeKind:'contact',contactId:a};
 const records=new Map([[a,[]],[b,[]]]),normal=supplier(),respond=adjudicationSupplier(),entered=deferred(),aborted=deferred(),release=deferred();
 let extraction,block=false,calls=0,late,invocation;
 const extractionPort=modelPort(()=>extraction.accounting,async(request,input)=>{
  if(request.purpose!=='extraction')return normal.respond(request,input);
  const payload=JSON.parse(request.user);
  return normal.respond({...request,user:JSON.stringify({...payload,messages:payload.messages.filter(m=>payload.target_message_ids.includes(m.message_id))})},input);
 });
 extraction=new SqliteMemoryExtraction(f.storage,owner,extractionPort,holders);
 const port=modelPort(()=>extraction.accounting,async(request,input)=>{
  calls++;
  if(!block)return respond(request,input);
  assert.equal(request.purpose,'adjudication');
  assert.equal(input.scope.contact_id,self?null:a);
  if(self)assert.equal(request.user.includes('合成蓝色'),false,'B只有本次完整任务授权依赖，没有混进实际候选或父资料模型输入');
  // 供应商进入此处前，modelPort已沿正式reserve动作写入sending及预算占用。
  invocation=input;late=await respond(request,input);entered.resolve();
  await new Promise(resolve=>{
   if(input.signal.aborted)resolve();else input.signal.addEventListener('abort',resolve,{once:true});
  });
  aborted.resolve();await release.promise;
  // 已发送但未收到回执；保留未知账本，迟到结构另沿正式output入口验证。
  throw new Error('合成供应商收到中止，已发送调用无确定回执');
 });
 const adjudication=new SqliteMemoryAdjudication(f.storage,owner,port,holders);await adjudication.initialize();
 t.after(async()=>{release.resolve();await adjudication.close();await extraction.close();});
 f.channel.page=async input=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[...records.get(input.token.contact_id)],completedPartitions:['shard-a'],exhausted:true});
 async function run(key,contactIds){
  await f.contacts.setReading(true);for(const contactId of contactIds)await f.service.synchronize(contactId);await f.contacts.setReading(false);
  const started=await extraction.start(key);await extraction.waitForIdle();
  const done=await extraction.read(started.runId);assert.ok(done.tasks.every(task=>task.state==='succeeded'||(task.scopeKind==='self'&&task.state==='awaiting_decision')),JSON.stringify(done.tasks));
  await management.importRun(started.runId);return done;
 }
 records.get(a).push(record('1',{sender:self?'owner':'contact',text:'我长期住在高雄。',sentAt:'1700000001000'}));
 const first=await run('deletion-adjudication-established-a',[a]);await adjudication.publishRun(first.runId);
 const original=(await management.read(scope)).memories[0];assert.ok(original?.current);assert.deepEqual(original.current.contributingContactIds,[a]);
 records.get(a).push(record('2',{sender:self?'owner':'contact',text:'我长期偏好绿茶。',sentAt:'1700000002000'}));
 if(self)records.get(b).push(record('1',{text:'我长期偏好合成蓝色。',sentAt:'1700000003000'}));
 const next=await run('deletion-adjudication-in-flight',self?[a,b]:[a]);
 const candidate=(await management.read(scope)).candidates.find(c=>c.state==='pending');assert.ok(candidate);
 assert.equal(candidate.verificationState,'verified');
 assert.deepEqual([...new Set(candidate.sources.map(s=>s.contactId))],[a]);
 assert.deepEqual(new Set(candidate.contributingContactIds),new Set(self?[a,b]:[a]));
 const source=self?next.inputs.find(i=>i.contactId===b&&i.role==='target'):candidate.sources[0];assert.ok(source);
 block=true;const publication=adjudication.publishRun(next.runId);await bounded(entered.promise,'真实裁决发送');
 const trace=await f.storage.execute('fixture.adjudicationTrace',{ownerId:owner}),call=trace.calls.find(c=>c.id===invocation.attemptId),step=trace.steps.find(s=>s.attempt_id===call?.step_attempt_id);
 assert.ok(call&&step);assert.equal(calls,1);assert.equal(call.state,'sending');assert.ok(call.reserved_budget_units>0n);assert.equal(call.settlement_state,'reserved');
 const address={ownerId:owner,callId:call.id,stepId:step.id,attemptId:call.step_attempt_id,candidateId:candidate.id};
 const inspect=()=>f.storage.execute('fixture.adjudicationDeletionState',address),before=await inspect();
 assert.ok(before.events.some(e=>e.kind==='adjudication_input'));assert.ok(before.items.length>0);assert.ok(before.items.every(i=>i.state==='sent'));
 return {...f,a,b,holders,management,scope,original,candidate,next,source,publication,aborted,release,late,call,step,address,inspect,before,calls:()=>calls,
  deletion:new DeletionService(f.storage,holders,new ManagedFiles(f.root))};
}

async function deleteWhileInFlight(f,self){
 const contactId=self?f.b:f.a;
 const plan=await f.deletion.plan({ownerId:owner,requestKey:`in-flight-${self?'mixed-self':'contact'}`,scope:{kind:'source',contactId,sourceId:f.source.recordId}});
 let deleted=false,published=false;
 const deleting=f.deletion.advance({ownerId:owner,operationId:plan.operationId}).then(value=>{deleted=true;return value;});
 void f.publication.then(()=>{published=true;});
 await bounded(f.aborted.promise,'来源删除触发模型中止');
 assert.equal(deleted,false,'删除必须等待供应商回调和裁决finally排空');assert.equal(published,false);
 {const cleared=await f.management.read(f.scope);assert.deepEqual({candidates:cleared.candidates,memories:cleared.memories},{candidates:[],memories:[]},'删除进行时立即撤下管理快照');}
 f.release.resolve();await bounded(f.publication,'已中止裁决排空');
 const done=await bounded(deleting,'来源删除完成');assert.equal(done.state,'completed',JSON.stringify(done.checks));
 const after=await f.inspect();
 assert.ok(!after.step||['revoked','unknown','failed'].includes(after.step.state),'未知台账可保留最小步骤身份，但不能保留成功或运行资格');
 assert.ok(!after.attempt||['aborted','unknown','failed'].includes(after.attempt.state));
 assert.ok(after.events.every(e=>e.kind==='adjudication_failure'&&Object.keys(JSON.parse(e.payload)).join()==='code'),'清掉basis、model input/output和结果正文，只允许无正文失败审计');
 assert.deepEqual(after.inputs,[],'未知台账不保留冻结正文及候选/版本/消息输入引用');
 if(self){
  assert.ok(after.candidate,'已完成07且实际只引用A的原稿属于合法存档');
  for(const key of ['proposed_body','event_id','produced_attempt_id'])assert.equal(after.candidate[key],f.before.candidate[key],'只撤销后续在途裁决资格，保留原稿及原生产者身份');
 }else assert.ok(!after.candidate||after.candidate.proposed_body===null,'真实来源已删除的候选不得保留正文');
 assert.equal(after.call.state,'unknown');assert.equal(after.call.settlement_state,'unknown');assert.equal(after.call.reserved_budget_units,f.before.call.reserved_budget_units);assert.equal(after.call.actual_budget_units,null);
 assert.ok(after.call.step_attempt_id===null||after.call.step_attempt_id===f.address.attemptId);assert.equal(after.call.receipt.input_budget,undefined,'保留回执摘要必须去掉含请求指纹的输入预算');
 assert.equal(after.operation.state,'sealed');assert.ok(after.operation.commit_forbidden_at!==null);assert.ok(after.operation.memory_step_id===null||after.operation.memory_step_id===f.step.id);assert.equal(after.operation.input_seal,'deleted');
 assert.deepEqual(after.items.map(i=>({item:i.item_id,effect:i.effect_kind,state:i.state})),f.before.items.map(i=>({item:i.item_id,effect:i.effect_kind,state:'unknown'})),'未知发送仍占用原逐消息效果身份');
 assert.deepEqual(after.scopes.map(i=>i.source_contact_id),f.before.scopes.map(i=>i.source_contact_id),'原来源范围台账不能被删除或换成其他联系人');
 // 模拟旧供应商迟到结构与完成回调；即使原blocks合法，也不能重建被删执行或发布。
 await assert.rejects(f.storage.execute('memoryAdjudication.output',{ownerId:owner,attemptId:f.address.attemptId,callId:f.call.id,blocks:f.late.blocks}),{code:'memory_adjudication_stale'});
 await assert.rejects(f.storage.execute('memoryAdjudication.finish',{ownerId:owner,attemptIds:[f.address.attemptId]}),{code:'memory_adjudication_stale'});
 if(self)await assert.rejects(f.storage.execute('memoryAdjudication.claim',{ownerId:owner,candidateId:f.candidate.id}),error=>['memory_candidate_stale','memory_extraction_output_not_eligible','memory_extraction_scope_stale','memory_source_stale','memory_extraction_source_stale'].includes(error.code),'原稿存档不能洗成新的处理授权再发布');
 assert.deepEqual(await f.inspect(),after);assert.equal(f.calls(),1);
 const view=await f.management.read(f.scope);
 const original=view.memories.find(m=>m.id===f.original.id);assert.ok(original?.current,'独立且仍有效的既有A资料必须保留');
 assert.equal(original.current.body,f.original.current.body);assert.equal(original.current.versionNo,'1');assert.equal(view.memories.filter(m=>m.current).length,1);
 assert.ok(view.candidates.every(c=>c.id!==f.candidate.id));assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
}

test('联系人裁决真实reserve进行中删来源会abort并等待排空，迟到输出不得发布且未知预约保持封存',async t=>{
 await deleteWhileInFlight(await prepared(t,false),false);
});

test('本人A+B任务实际候选仅引用A，删B及时abort并清在途闭包，独立既有A正式记忆保留',async t=>{
 await deleteWhileInFlight(await prepared(t,true),true);
});
