import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { HostStorage } from '../src/platform/database/host-storage.ts';
import { createWechatScopeApi, isWechatScopeRoute, wechatScopeBodyLimit } from '../src/sync/wechat-scope-api.ts';
import { createStorageFixture } from './host-storage-fixture.mjs';

async function fixture(t, {connected = true, owner = true, slow = false} = {}) {
  const f = await createStorageFixture();
  let storage, api;
  t.after(async () => {await api?.close();await storage?.close();await f.close();});
  storage = await HostStorage.open(f.options);
  let id;
  if (owner) id = (await storage.initializeOwner('合成用户')).owner_id;
  if (connected && owner) await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-account','合成账号')",[id]);
  const executable = join(f.directory,'synthetic-cli');
  await writeFile(executable,`#!${process.execPath}\nconst status={status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:'synthetic-account'}}};const sessions={sessions:[{username:'friend-a',display_name:'合成同名',chat_type:'private',last_timestamp:123,summary:'SECRET_SUMMARY'},{username:'friend-b',display_name:'合成同名',chat_type:'private',last_timestamp:456,summary:'SECRET_SUMMARY'}]};${slow ? 'setTimeout(()=>{},30000);' : "console.log(JSON.stringify({ok:true,data:process.argv[2]==='status'?status:sessions}));"}`);
  await chmod(executable,0o700);
  let statusCalls = 0;
  api = await createWechatScopeApi({storage,executable,environment:{},readSyncStatus:async () => {statusCalls++;return {sync_scope:'stale',cli_history_authorization_state:'stale',backfill:{pending:3}};}});
  return {...f,storage,api,id,statusCalls:()=>statusCalls,internal:{owner_id:id,channel:'wechat',account_scope:'synthetic-account'}};
}

test('路由、绑定批次预算与没有owner/account的失败关闭',async t=>{
  assert.equal(isWechatScopeRoute('/api/sync/cli-bindings/confirm'),true);
  assert.equal(isWechatScopeRoute('/api/sync/status'),false);
  assert.equal(wechatScopeBodyLimit('/api/sync/cli-bindings/confirm'),1024*1024);
  const f=await fixture(t,{owner:false,connected:false});
  assert.equal((await f.api.handle('GET','/api/setup/wechat')).body.state,'needs_owner');
  assert.deepEqual(await f.api.handle('GET','/api/sync/cli-bindings'),{status:503,body:{error:'sync_unavailable'}});
  assert.equal((await f.api.handle('POST','/api/setup/wechat/detect',{unexpected:true})).status,400);
  assert.equal((await f.api.handle('POST','/api/setup/wechat/confirm',{candidate_token:'a',confirmed:true,mode:'bad'})).status,400);
  assert.equal((await f.api.handle('PUT','/api/sync/scope',{})).status,404);
});

test('首次确认默认所选与无历史授权，固定账号要求重启',async t=>{
  const f=await fixture(t,{connected:false});
  const detected=await f.api.handle('POST','/api/setup/wechat/detect',{});
  assert.equal(detected.body.state,'ready');
  const confirmed=await f.api.handle('POST','/api/setup/wechat/confirm',{candidate_token:detected.body.candidate_token,confirmed:true});
  assert.equal(confirmed.body.state,'restart_required');
  assert.equal((await f.client.query('SELECT mode FROM wechat_sync_scope')).rows[0].mode,'selected');
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM wechat_history_sync_authorization')).rows[0].n,0);
  assert.equal((await f.api.handle('GET','/api/sync/cli-bindings')).status,503);
});

test('内部探测先检查范围且不回调legacy；公开范围返回即时状态',async t=>{
  const f=await fixture(t);
  assert.equal((await f.api.handle('POST','/api/runtime/wechat-scope/state',{...f.internal,account_scope:'wrong'})).status,409);
  assert.equal((await f.api.handle('POST','/api/runtime/wechat-scope/state',{...f.internal,extra:true})).status,400);
  assert.deepEqual((await f.api.handle('POST','/api/runtime/wechat-scope/discover',f.internal)).body,{created:0,conflicts:[]});
  assert.equal(f.statusCalls(),0);
  assert.deepEqual((await f.api.handle('POST','/api/runtime/wechat-scope/state',f.internal)).body,{mode:'selected',granted_at:null,enabled:false});
  const changed=await f.api.handle('POST','/api/sync/scope',{confirmed:true,mode:'all_private'});
  assert.equal(changed.status,200);assert.equal(changed.body.sync_scope,'all_private');assert.equal(changed.body.cli_history_authorization_state,'required');
  assert.deepEqual(changed.body.backfill,{pending:3});
  await f.client.query('INSERT INTO front_sync_state(owner_id,enabled,enabled_at) VALUES($1,true,now())',[f.id]);
  assert.equal((await f.api.handle('POST','/api/runtime/wechat-scope/discover',f.internal)).body.created,2);
  assert.equal(f.statusCalls(),1);
  const history=await f.api.handle('POST','/api/sync/history-authorization',{confirmed:true,decision:'accepted'});
  assert.equal(history.body.cli_history_authorization_state,'accepted');
  const qualified=await f.api.handle('POST','/api/runtime/wechat-scope/history-bindings',f.internal);
  assert.equal(qualified.status,200);assert.equal(qualified.body.binding_ids.length,2);
  assert.equal(f.statusCalls(),2);
  assert.deepEqual((await f.api.handle('POST','/api/runtime/wechat-scope/history-state',f.internal)).body,{state:'accepted',version:1,current_version:1});
  assert.equal(f.statusCalls(),2);
});

test('列表仅元数据、绑定同名隔离、幂等、撤销与严格请求',async t=>{
  const f=await fixture(t);
  const candidates=await f.api.handle('GET','/api/sync/cli-sessions');
  assert.equal(candidates.status,200);assert.equal(candidates.body.sessions.length,2);
  assert.equal(JSON.stringify(candidates).includes('SECRET_SUMMARY'),false);
  assert.ok(candidates.body.sessions.every(r=>r.bound_contact_id===null));
  assert.equal((await f.api.handle('POST','/api/sync/cli-bindings/confirm',{selections:[{locator:'friend-a',summary:'bad'}]})).status,400);
  assert.equal((await f.api.handle('POST','/api/sync/cli-bindings/confirm',{selections:[{locator:'friend-a'},{locator:'friend-b'}]})).status,200);
  const rows=(await f.api.handle('GET','/api/sync/cli-bindings')).body.bindings;
  assert.equal(new Set(rows.map(r=>r.contact_id)).size,2);assert.equal('owner_id' in rows[0],false);
  assert.equal((await f.api.handle('POST','/api/sync/cli-bindings/confirm',{selections:[{locator:'friend-a'}]})).status,200);
  const rejected=await f.api.handle('POST','/api/sync/cli-bindings/confirm',{selections:[{locator:'missing'}]});
  assert.deepEqual(rejected,{status:409,body:{error:'cli_binding_rejected',reason:'selection_stale'}});
  assert.equal((await f.api.handle('POST','/api/sync/cli-bindings/revoke',{contact_id:rows[0].contact_id,binding_id:rows[0].binding_id})).body.status,'revoked');
  const after=(await f.api.handle('GET','/api/sync/cli-bindings')).body;
  assert.equal(after.bindings.length,1);assert.equal(after.revoked_bindings.length,1);
});

test('取消和close终止在途CLI，关闭后所有路径拒绝',async t=>{
  const f=await fixture(t,{slow:true});
  const controller=new AbortController();
  const work=f.api.handle('GET','/api/sync/cli-sessions',{},undefined,controller.signal);
  setTimeout(()=>controller.abort(),100);
  assert.equal((await work).status,503);
  const second=f.api.handle('GET','/api/sync/cli-sessions');
  await f.api.close();assert.equal((await second).status,503);
  assert.equal((await f.api.handle('GET','/api/setup/wechat')).status,503);
});

test('事务提交前失效时回滚绑定，错误不泄漏细节',async t=>{
  const f=await fixture(t);
  let wroteBaseline=false;
  const transact=f.storage.businessTransaction.bind(f.storage);
  f.storage.businessTransaction=operation=>transact(client=>operation(new Proxy(client,{get(target,key){
    if(key!=='query')return Reflect.get(target,key);
    return async (...args)=>{const result=await target.query(...args);if(String(args[0]).startsWith('INSERT INTO public.wechat_observation_baseline'))wroteBaseline=true;return result;};
  }})));
  const result=await f.api.handle('POST','/api/sync/cli-bindings/confirm',{selections:[{locator:'friend-a'}]},()=>{
    if(wroteBaseline)throw new Error('PRIVATE_DETAIL');
  });
  assert.equal(wroteBaseline,true);
  assert.equal(result.status,500);assert.equal(JSON.stringify(result).includes('PRIVATE_DETAIL'),false);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM conversation_binding')).rows[0].n,0);
});


test('已撤销账号返回可见conflict且不阻断整个宿主启动',async t=>{
  const f=await fixture(t);
  await f.api.close();
  await f.client.query("UPDATE owner_channel_identity SET status='revoked' WHERE owner_id=$1",[f.id]);
  const restarted=await createWechatScopeApi({storage:f.storage,executable:'/nonexistent-synthetic-cli',environment:{},readSyncStatus:async()=>{throw new Error('must not call');}});
  t.after(()=>restarted.close());
  assert.equal((await restarted.handle('GET','/api/setup/wechat')).body.state,'conflict');
  assert.equal((await restarted.handle('GET','/api/sync/cli-bindings')).status,503);
  assert.equal((await restarted.handle('POST','/api/setup/wechat/detect',' '.repeat(1024*1024+1))).status,413);
});


test('selected新增绑定必须显式历史同意，不借用既有账号accepted',async t=>{
  const f=await fixture(t);
  assert.equal((await f.api.handle('POST','/api/sync/cli-bindings/confirm',{selections:[],history_authorized:'yes'})).status,400);
  assert.equal((await f.api.handle('POST','/api/sync/cli-bindings/confirm',{selections:[{locator:'friend-a'}],history_authorized:true})).status,200);
  assert.equal((await f.api.handle('POST','/api/runtime/wechat-scope/history-bindings',f.internal)).body.binding_ids.length,1);
  assert.equal((await f.api.handle('POST','/api/sync/cli-bindings/confirm',{selections:[{locator:'friend-b'}]})).status,200);
  assert.equal((await f.api.handle('POST','/api/runtime/wechat-scope/history-bindings',f.internal)).body.binding_ids.length,1);
});

test('首连明确全部和历史同意仅快照当前列表',async t=>{
  const f=await fixture(t,{connected:false});
  const detected=await f.api.handle('POST','/api/setup/wechat/detect',{});
  const result=await f.api.handle('POST','/api/setup/wechat/confirm',{candidate_token:detected.body.candidate_token,confirmed:true,mode:'all_private',history_authorized:true});
  assert.equal(result.status,200);assert.equal(result.body.state,'restart_required');
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM conversation_binding')).rows[0].n,2);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM wechat_binding_history_authorization')).rows[0].n,2);
});

test('授权原始JSON拒绝重复键、空正文及坏UTF8，不把后值解释成确认',async t=>{
  const f=await fixture(t,{connected:false});
  for(const body of ['', '{"confirmed":false,"confirmed":true}', '{"confirmed":false,"confi\\u0072med":true}', Buffer.from([0xff])]) {
    const r=await f.api.handle('POST','/api/setup/wechat/confirm',body);
    assert.equal(r.status,400);
  }
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM owner_channel_identity')).rows[0].n,0);
});
