import test from 'node:test';
import assert from 'node:assert/strict';
import {ports,batchFixture,historyClearFixture,until,contactId,batchId,runningView} from './fixtures/history-recertify-batch.mjs';

test('失败分类表覆盖规格 6.4 与实际后端可能返回的码，未知码保留为联系人级', ()=>{
 const rows={
  already_fixed:['history_recertify_not_required'],
  skip:['history_recertify_source_changed','history_recertify_deletion_pending','history_no_active_binding','history_recertify_stale','read_eligibility_stale',
   'history_recertify_page_limit','history_recertify_incomplete','history_recertify_already_running','history_recertify_source_unverified',
   'history_recertify_suppression_unmapped','history_recertify_terminal_alias_unmapped','history_recertify_legacy_proof_invalid'],
  transient:['history_source_continuity_unverified','history_source_not_available','history_native_unavailable','history_native_timeout',
   'history_snapshot_unavailable','history_delta_key_unavailable','history_support_changed','history_protocol_invalid','history_image_key_unavailable'],
  interrupt:['history_recertify_interrupted','history_recertify_cancelled','history_native_closed','history_recertify_scope_changed'],
  authorization:['read_not_authorized','history_recertify_not_authorized'],
  capability:['history_recertify_guard_required'],
  program:['history_recertify_request_conflict','history_recertify_not_found','history_request_invalid','history_recertify_unavailable'],
  unknown:['synthetic_unknown_failure','media_extraction_failed','history_recertify_stalled'],
 };
 for(const [action,codes] of Object.entries(rows))for(const code of codes)assert.equal(ports.classifyHistoryRecertifyFailure(code),action,`${code} 应为 ${action}`);
});

test('全部成功：一次确认后严格串行处理候选，请求键按批次序号生成，结束释放互斥', {timeout:20000}, async t=>{
 const f=await batchFixture(t,{contacts:[contactId(1),contactId(2),contactId(3)]});
 await f.controller.start({limit:null,confirmed:true});
 await until(()=>f.controller.getState().phase==='finished');
 const state=f.controller.getState();
 assert.equal(state.phase,'finished');assert.equal(state.total,3);assert.equal(state.completed,3);assert.deepEqual(state.failedByCode,{});
 assert.equal(state.alreadyFixed,0);assert.equal(state.stopRequested,false);assert.ok(state.finishedAt!==null);
 assert.equal(state.batchId,batchId);assert.equal(f.activity.batchRunning(),false);
 const posts=f.state.calls.filter(call=>call.method==='POST');
 assert.equal(posts.length,3);
 for(const [index,post] of posts.entries()){
  assert.match(post.path,new RegExp(`^/api/contacts/${contactId(index+1)}/history/recertify$`));
  assert.deepEqual(Object.keys(post.body),['request_key']);
  assert.match(post.body.request_key,new RegExp(`^batch-${batchId}-${String(index+1).padStart(3,'0')}-${contactId(index+1)}$`));
 }
 // 严格串行：每位结算后下一位才提交，序号按候选顺序。
 const settled=f.state.logs.filter(line=>line.event==='contact_settled');
 assert.deepEqual(settled.map(line=>[line.index,line.outcome]),[[1,'completed'],[2,'completed'],[3,'completed']]);
 // 每修完 5 位或结束时读取汇总覆盖；3 位在结束时读取一次。
 assert.equal(state.aggregateComplete,2);
 assert.equal(f.state.logs.filter(line=>line.event==='aggregate').length,1);
});

test('概述只聚合计数；limit 生效且不处理快照之外的联系人', {timeout:20000}, async t=>{
 const f=await batchFixture(t,{contacts:[contactId(1),contactId(2),contactId(3),contactId(4)]});
 await f.controller.refreshOverview();
 const overview=f.controller.getState().overview;
 assert.deepEqual(overview,{phase:'ready',total:4,withUnsavedImages:3,messageTotal:46,imageUnsavedTotal:6,fencedTotal:4,readEnabled:true,error:null});
 await f.controller.start({limit:2,confirmed:true});
 await until(()=>f.controller.getState().phase==='finished');
 const state=f.controller.getState();
 assert.equal(state.total,2);assert.equal(state.completed,2);assert.equal(state.limit,2);
 const contacted=f.state.calls.filter(call=>call.method==='POST').map(call=>call.path.split('/')[3]);
 assert.deepEqual(contacted,[contactId(1),contactId(2)]);
 assert.deepEqual(f.state.calls.filter(call=>call.path.includes(`contact_id=${contactId(3)}`)),[]);
});

test('重跑幂等：启动快照后已不再围栏的联系人计 alreadyFixed 并跳过', {timeout:20000}, async t=>{
 const f=await batchFixture(t,{contacts:[contactId(1),contactId(2)]});
 let removed=false;
 f.state.singleCandidateHook=id=>{
  if(id===contactId(1)&&!removed){removed=true;f.state.fenced.delete(contactId(1));}
 };
 await f.controller.start({limit:null,confirmed:true});
 await until(()=>f.controller.getState().phase==='finished');
 const state=f.controller.getState();
 assert.equal(state.alreadyFixed,1);assert.equal(state.completed,1);
 assert.equal(f.state.calls.filter(call=>call.method==='POST').map(call=>call.path.split('/')[3]).includes(contactId(1)),false);
});

test('失败按类别处理：已不需要、联系人级跳过与瞬时失败计数后继续', {timeout:20000}, async t=>{
 const contacts=[contactId(1),contactId(2),contactId(3),contactId(4),contactId(5),contactId(6)];
 const f=await batchFixture(t,{contacts,behaviors:{
  [contacts[0]]:()=>{throw new ports.BackendRequestFailure('response',409,'history_recertify_not_required');},
  [contacts[1]]:()=>{throw new ports.BackendRequestFailure('response',409,'history_recertify_source_changed');},
  [contacts[2]]:({failed,request})=>({generation:1,data:failed(request.body.request_key,'history_recertify_deletion_pending')}),
  [contacts[3]]:({failed,request})=>({generation:1,data:failed(request.body.request_key,'history_recertify_page_limit')}),
  [contacts[4]]:({failed,request})=>({generation:1,data:failed(request.body.request_key,'history_source_continuity_unverified')}),
 }});
 await f.controller.start({limit:null,confirmed:true});
 await until(()=>f.controller.getState().phase==='finished');
 const state=f.controller.getState();
 assert.equal(state.completed,1);assert.equal(state.alreadyFixed,1);
 assert.deepEqual(state.skippedByCode,{history_recertify_source_changed:1,history_recertify_deletion_pending:1,history_recertify_page_limit:1});
 assert.deepEqual(state.failedByCode,{history_source_continuity_unverified:1});
 // 最后一次仅是瞬时失败一次，未达连续 3 位熔断。
 assert.equal(state.phase,'finished');
});

test('同一瞬时码连续 3 位整体停止；不同码或完成会重置连续计数', {timeout:20000}, async t=>{
 const contacts=[contactId(1),contactId(2),contactId(3)];
 const f=await batchFixture(t,{contacts,behaviors:Object.fromEntries(contacts.map(id=>[id,({failed,request})=>({generation:1,data:failed(request.body.request_key,'history_source_continuity_unverified')})]))});
 await f.controller.start({limit:null,confirmed:true});
 await until(()=>f.controller.getState().phase==='interrupted');
 const interrupted=f.controller.getState();
 assert.equal(interrupted.interruptedReason,'history_source_continuity_unverified');
 assert.equal(interrupted.failedByCode.history_source_continuity_unverified,3);
 assert.equal(f.state.calls.filter(call=>call.method==='POST').length,3);

 const mixed=[contactId(1),contactId(2),contactId(3),contactId(4)];
 const m=await batchFixture(t,{contacts:mixed,behaviors:{
  [mixed[0]]:({failed,request})=>({generation:1,data:failed(request.body.request_key,'history_source_continuity_unverified')}),
  [mixed[1]]:({completed,request})=>({generation:1,data:completed(request.body.request_key)}),
  [mixed[2]]:({failed,request})=>({generation:1,data:failed(request.body.request_key,'history_source_continuity_unverified')}),
  [mixed[3]]:({failed,request})=>({generation:1,data:failed(request.body.request_key,'history_source_continuity_unverified')}),
 }});
 await m.controller.start({limit:null,confirmed:true});
 await until(()=>m.controller.getState().phase==='finished');
 assert.equal(m.controller.getState().phase,'finished');
 assert.equal(m.controller.getState().failedByCode.history_source_continuity_unverified,3);
});

test('未知码按联系人级失败计数并继续；连续 3 个未知码整体停止', {timeout:20000}, async t=>{
 const contacts=[contactId(1),contactId(2),contactId(3),contactId(4),contactId(5)];
 const f=await batchFixture(t,{contacts,behaviors:{
  [contacts[0]]:({failed,request})=>({generation:1,data:failed(request.body.request_key,'synthetic_unknown_a')}),
  [contacts[1]]:({completed,request})=>({generation:1,data:completed(request.body.request_key)}),
  [contacts[2]]:({failed,request})=>({generation:1,data:failed(request.body.request_key,'synthetic_unknown_b')}),
  [contacts[3]]:({failed,request})=>({generation:1,data:failed(request.body.request_key,'synthetic_unknown_c')}),
  [contacts[4]]:({failed,request})=>({generation:1,data:failed(request.body.request_key,'synthetic_unknown_d')}),
 }});
 await f.controller.start({limit:null,confirmed:true});
 await until(()=>f.controller.getState().phase==='interrupted');
 const state=f.controller.getState();
 assert.equal(state.interruptedReason,'synthetic_unknown_d');
 assert.equal(state.completed,1);
 assert.deepEqual(state.failedByCode,{synthetic_unknown_a:1,synthetic_unknown_b:1,synthetic_unknown_c:1,synthetic_unknown_d:1});
});

for(const code of ['history_recertify_interrupted','history_recertify_cancelled','history_native_closed','read_not_authorized','history_recertify_guard_required','history_recertify_request_conflict','history_recertify_not_authorized']){
 test(`全局性问题 ${code} 让批量整体中断且不继续下一位`, {timeout:20000}, async t=>{
  const contacts=[contactId(1),contactId(2),contactId(3)];
  const f=await batchFixture(t,{contacts,behaviors:{
   [contacts[0]]:({completed,request})=>({generation:1,data:completed(request.body.request_key)}),
   [contacts[1]]:({failed,request})=>({generation:1,data:failed(request.body.request_key,code,['history_recertify_interrupted','history_recertify_cancelled'].includes(code))}),
  }});
  await f.controller.start({limit:null,confirmed:true});
  await until(()=>f.controller.getState().phase==='interrupted');
  const state=f.controller.getState();
  assert.equal(state.phase,'interrupted');assert.equal(state.interruptedReason,code);assert.equal(state.completed,1);
  assert.equal(f.state.calls.filter(call=>call.method==='POST').length,2);
  assert.equal(f.activity.batchRunning(),false);
 });
}

test('批量运行中拒绝新批次；单个历史操作在批量期间被拒绝并说明原因', {timeout:20000}, async t=>{
 const contacts=[contactId(1),contactId(2)];
 // 让当前位停在 running，便于核对互斥。
 const f=await batchFixture(t,{contacts,behaviors:{
  [contacts[0]]:({request})=>({generation:1,data:runningView(contacts[0],request.body.request_key)}),
 }});
 await f.controller.start({limit:1,confirmed:true});
 await until(()=>f.controller.getState().phase==='running');
 await assert.rejects(f.controller.start({limit:1,confirmed:true}),/已有批量修复在进行/);
 assert.equal(f.activity.batchRunning(),true);
 const clearFixture=historyClearFixture(f.activity);
 await until(()=>clearFixture.controller.getState().phase==='ready');
 await assert.rejects(clearFixture.controller.clear(clearFixture.scope),/批量修复进行中/);
 await assert.rejects(clearFixture.controller.resync({...clearFixture.scope,requestKey:'resync-1',confirmed:true}),/批量修复进行中/);
 await assert.rejects(clearFixture.controller.recertify({...clearFixture.scope,requestKey:'recertify-1',confirmed:true}),/批量修复进行中/);
 f.controller.dispose();
});

test('单操作进行中或尚未连接时拒绝开始批量', {timeout:20000}, async t=>{
 const f=await batchFixture(t,{singleActive:()=>true});
 await assert.rejects(f.controller.start({limit:null,confirmed:true}),/单个修复或清空操作/);
 assert.equal(f.controller.getState().phase,'idle');
 assert.equal(f.activity.batchRunning(),false);

 const offline=await batchFixture(t);
 offline.state.setGeneration(undefined);
 await assert.rejects(offline.controller.start({limit:null,confirmed:true}),/尚未连接/);
 assert.equal(offline.activity.batchRunning(),false);
});

test('批量日志只含批次、序号、阶段、计数与原因码，不含联系人 ID 或请求键', {timeout:20000}, async t=>{
 const contacts=[contactId(1),contactId(2)];
 const f=await batchFixture(t,{contacts});
 await f.controller.start({limit:null,confirmed:true});
 await until(()=>f.controller.getState().phase==='finished');
 assert.ok(f.state.logs.length>=3);
 const allowed=new Set(['event','batch_id','total','limit','index','outcome','code','completed','failed_by_code','skipped_by_code','already_fixed','elapsed_ms','complete']);
 for(const line of f.state.logs){
  assert.equal(typeof line,'object');
  for(const key of Object.keys(line))assert.ok(allowed.has(key),`日志出现未登记字段 ${key}`);
  assert.equal(JSON.stringify(line).includes(batchId+'-'),false,'日志不能包含请求键');
  for(const id of contacts)assert.equal(JSON.stringify(line).includes(id),false,'日志不能包含联系人 ID');
 }
 assert.equal(f.state.logs.filter(line=>line.event==='batch_start').length,1);
 assert.equal(f.state.logs.filter(line=>line.event==='batch_finished').length,1);
});

test('批量标识为本地时间 14 位加 4 位随机十六进制，且满足请求键字符集', ()=>{
 const fixed=new Date(2026,10,6,1,2,3).getTime();
 const id=ports.createHistoryRecertifyBatchId(fixed);
 assert.match(id,/^\d{14}[a-f0-9]{4}$/);assert.ok(id.startsWith('20261106010203'));
 assert.notEqual(ports.createHistoryRecertifyBatchId(fixed),id);
});
