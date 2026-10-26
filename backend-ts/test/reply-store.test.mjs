import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresReplyStore } from '../src/reply/generation/reply-store.ts';
import { createStorageFixture } from './host-storage-fixture.mjs';

async function setup(t) {
  const f = await createStorageFixture(); t.after(() => f.close());
  const owner_id=randomUUID(), contact_id=randomUUID();
  await f.client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)',[owner_id,'合成本人']);
  await f.client.query('INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,$3)',[contact_id,owner_id,'合成联系人']);
  let now = Date.now();
  const guards={start:async()=>{},started:async()=>{},prepare:async()=>{},commit:async()=>{},replay:async()=>{}};
  const store = new PostgresReplyStore({transaction: async fn=>{await f.client.query('BEGIN');try {const result=await fn(f.client);await f.client.query('COMMIT');return result;}catch(e){await f.client.query('ROLLBACK');throw e;}}, guards, clock:()=>new Date(now)});
  const input={owner_id,contact_id,conversation_binding_id:randomUUID(),idempotency_key:randomUUID(),normalized_input:'{"content":"明天见"}',continued_from_candidate_id:null};
  return {f,store,input,guards,advance:ms=>{now+=ms;}};
}
test('同键领取在途不重跑，改输入冲突，租约过期后旧attempt不能提交',async t=>{
  const {store,input,advance}=await setup(t);
  const first=await store.start(input);
  assert.equal(first.state,'started');
  assert.equal((await store.start(input)).state,'in_progress');
  await assert.rejects(store.start({...input,normalized_input:'{"content":"后天见"}'}),{code:'reply_input_conflict'});
  advance(31000);
  const retry=await store.start(input);
  assert.equal(retry.request.request_id,first.request.request_id);
  assert.equal(retry.request.attempt,2);
  await assert.rejects(store.requireCurrent(first.request),{code:'reply_request_expired'});
  await store.requireCurrent(retry.request);
});
function context() { return {evidence:[{evidence_id:randomUUID(),kind:'user_purpose',text:'表达见面意愿',source_ids:[],selection_reason:'用户输入',status:'active'}],snapshot:{scope:{},input_budget:null},skill_library_revision:0}; }
function candidates(c) { const id=randomUUID();return [{candidate_id:id,text:'明天见。',basis:'依用户输入',citation_ids:[c.evidence[0].evidence_id],risk_notes:[],messages:[{message_id:id,text:'明天见。'}]}]; }
test('候选、引用和消息身份原样重放，错误引用与失效上下文不得留下半成品',async t=>{
  const {store,input,guards}=await setup(t);
  const {request}=await store.start(input), c=context(), items=candidates(c);
  await store.prepareContext(request,c);
  await assert.rejects(store.save(request,c,[{...items[0],citation_ids:[randomUUID()]}]),{code:'reply_candidates_rejected'});
  guards.commit=async()=>{throw new Error('来源已删除');};
  await assert.rejects(store.save(request,c,items),/来源已删除/);
  assert.equal((await store.read(request.request_id,input)).state,'running');
  guards.commit=async()=>{};
  const saved=await store.save(request,c,items);
  assert.deepEqual(saved.candidates,items);
  assert.deepEqual((await store.start(input)).result,saved);
  assert.deepEqual((await store.save(request,c,candidates(c))).candidates,items);
});
test('取消后旧结果不能覆盖新attempt，删除失效键不能复活，读取隔离联系人',async t=>{
  const {store,input,f}=await setup(t);const c=context(),items=candidates(c);
  const first=await store.start(input);await store.fail(first.request,'cancelled');
  const retry=await store.start(input);
  await assert.rejects(store.save(first.request,c,items),{code:'reply_request_expired'});
  await store.fail(first.request,'late_failure');
  await store.requireCurrent(retry.request);
  await assert.rejects(store.read(retry.request.request_id,{...input,contact_id:randomUUID()}),{code:'reply_not_found'});
  await f.client.query('INSERT INTO reply_invalidated_key(owner_id,contact_id,idempotency_key) VALUES($1,$2,$3)',[input.owner_id,input.contact_id,input.idempotency_key]);
  await f.client.query('DELETE FROM reply_request WHERE id=$1',[retry.request.request_id]);
  await assert.rejects(store.save(retry.request,c,items),{code:'reply_input_invalidated'});
  await assert.rejects(store.start(input),{code:'reply_input_invalidated'});
});
test('真正双连接同时领取只有一个started，完成重放保留原UUID',async t=>{
  const {store,input,f,guards}=await setup(t);
  const pg=await import('pg');const second=new pg.default.Client({host:'/tmp',database:f.client.database});await second.connect();
  try {
  const other=new PostgresReplyStore({guards,transaction:async fn=>{await second.query('BEGIN');try {const r=await fn(second);await second.query('COMMIT');return r;}catch(e){await second.query('ROLLBACK');throw e;}}});
  const starts=await Promise.all([store.start(input),other.start(input)]);
  assert.deepEqual(starts.map(s=>s.state).sort(),['in_progress','started']);
  assert.equal(starts[0].request.request_id,starts[1].request.request_id);
  } finally {await second.end();}
});
test('缺少资格端口拒绝构造，版本复验期间租约过期不可提交',async t=>{
  assert.throws(()=>new PostgresReplyStore({transaction:async()=>{},guards:{}}),{code:'reply_guards_unavailable'});
  const {store,input,guards,advance}=await setup(t);const c=context();const {request}=await store.start(input);
  guards.commit=async()=>advance(31000);
  await assert.rejects(store.save(request,c,candidates(c)),{code:'reply_request_expired'});
});
test('空风险说明与损坏Skill摘要拒绝，start后捕获失败回滚领取',async t=>{
  const {store,input,guards}=await setup(t);const c=context();
  guards.started=async()=>{throw new Error('续写版本已失效');};
  await assert.rejects(store.start(input),/续写版本已失效/);
  guards.started=async()=>{};
  const {request}=await store.start(input);assert.equal(request.attempt,1);
  await assert.rejects(store.save(request,c,[{...candidates(c)[0],risk_notes:[' ']}]),{code:'reply_candidates_rejected'});
  await assert.rejects(store.save(request,c,candidates(c),{skill_id:randomUUID()}),{code:'reply_candidates_rejected'});
});
test('已完成回复重放保留Skill执行视图与版本范围，不回读当前Skill',async t=>{
 const {store,input,f}=await setup(t),c=context(),{request}=await store.start(input);
 const use={skill_id:randomUUID(),version_id:randomUUID(),name:'合成策略',selection_method:'user',selection_reason:'用户本次选择',load_state:'loaded',resource_paths:['references/guide.md'],version_number:4,scope_kind:'contact',scope_contact_id:input.contact_id,scope_scene:null,execution_view:{policy_revision:3,method_ids:[randomUUID()],sha256:'a'.repeat(64)}};
 const saved=await store.save(request,c,candidates(c),use);
 assert.deepEqual(saved.used_skill,use);
 assert.deepEqual((await store.start(input)).result.used_skill,use);
 assert.deepEqual(saved.context_snapshot.skill_execution_view,use.execution_view);
 await f.client.query("UPDATE reply_request SET context_snapshot=jsonb_set(context_snapshot,'{skill_execution_view,policy_revision}','-1') WHERE id=$1",[request.request_id]);
 await assert.rejects(store.start(input),{code:'reply_candidates_rejected'});
});
test('上下文快照的超安全整数修订号在保存、读取和重放均无损',async t=>{
 const {store,input}=await setup(t),c=context(),{request}=await store.start(input);
 c.snapshot.expression_preferences=[{preference_id:randomUUID(),revision:9007199254740993n,text:'合成表达要求',scope:{contact_id:input.contact_id,reply_mode:null}}];
 const saved=await store.save(request,c,candidates(c));
 assert.deepEqual(saved.context_snapshot.expression_preferences,c.snapshot.expression_preferences);
 assert.deepEqual((await store.start(input)).result.context_snapshot.expression_preferences,c.snapshot.expression_preferences);
 assert.deepEqual((await store.read(request.request_id,input)).result.context_snapshot.expression_preferences,c.snapshot.expression_preferences);
});
test('提交资格复验期间到期取消使整个候选事务回滚',async t=>{
 const {store,input,f,guards}=await setup(t),c=context(),{request}=await store.start(input),controller=new AbortController();
 guards.commit=async()=>controller.abort(new Error('合成截止时间'));
 await assert.rejects(store.save(request,c,candidates(c),null,controller.signal),/合成截止时间/);
 assert.equal((await f.client.query('SELECT count(*)::int AS n FROM reply_candidate WHERE reply_request_id=$1',[request.request_id])).rows[0].n,0);
 assert.equal((await store.read(request.request_id,input)).state,'running');
});
