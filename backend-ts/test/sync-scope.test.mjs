import test from 'node:test';
import assert from 'node:assert/strict';
import { HostStorage } from '../src/host-storage.ts';
import { SyncScopeService } from '../src/sync-scope.ts';
import { createStorageFixture } from './host-storage-fixture.mjs';

test('范围默认仅所选，确认全部不改变总开关且重复确认保留起点', async t => {
  const f = await createStorageFixture(); t.after(() => f.close());
  const storage = await HostStorage.open(f.options); t.after(() => storage.close());
  const {owner_id:owner} = await storage.initializeOwner('合成用户');
  await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-account','合成账号')",[owner]);
  const scope = new SyncScopeService({storage,ownerId:owner,accountScope:'synthetic-account'});
  assert.equal((await scope.read()).mode,'selected');
  await assert.rejects(scope.setMode({mode:'all_private',confirmed:false}),{code:'invalid_sync_scope'});
  const first = await scope.setMode({mode:'all_private',confirmed:true});
  const again = await scope.setMode({mode:'all_private',confirmed:true});
  assert.equal(first.granted_at,again.granted_at);
  assert.equal(first.enabled,false);
  assert.equal((await scope.setMode({mode:'selected',confirmed:true})).mode,'selected');
});

test('历史资格必须独立确认，取消晚写回滚，未知未来版本不授予', async t => {
  const f = await createStorageFixture(); t.after(() => f.close());
  const storage = await HostStorage.open(f.options); t.after(() => storage.close());
  const {owner_id:owner} = await storage.initializeOwner('合成用户');
  await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-account','合成账号')",[owner]);
  const scope = new SyncScopeService({storage,ownerId:owner,accountScope:'synthetic-account'});
  await scope.setMode({mode:'all_private',confirmed:true});
  assert.deepEqual(await scope.historyAuthorization(),{state:'required',version:null,current_version:1});
  assert.equal((await scope.decideHistory({decision:'declined',confirmed:true})).state,'declined');
  assert.equal((await scope.decideHistory({decision:'accepted',confirmed:true})).state,'accepted');
  assert.equal((await scope.decideHistory({decision:'declined',confirmed:true})).state,'accepted');
  let calls=0;
  await assert.rejects(scope.setMode({mode:'selected',confirmed:true},()=>{if(++calls===2)throw new Error('cancelled');}));
  assert.equal((await scope.read()).mode,'all_private');
  await f.client.query("UPDATE wechat_history_sync_authorization SET version=2 WHERE owner_id=$1",[owner]);
  assert.equal((await scope.historyAuthorization()).state,'required');
  scope.close();
  await assert.rejects(scope.read(),{code:'runtime_stopping'});
});

test('自动纳入仅在明确全部及开关开启，保留同名隔离、撤销排除和新绑定baseline',async t => {
  const f=await createStorageFixture();t.after(()=>f.close());
  const storage=await HostStorage.open(f.options);t.after(()=>storage.close());
  const {owner_id:owner}=await storage.initializeOwner('合成用户');
  await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-account','合成账号')",[owner]);
  const scope=new SyncScopeService({storage,ownerId:owner,accountScope:'synthetic-account',clock:()=>new Date('2026-10-23T10:00:00Z')});
  const sessions=[{username:'friend-a',display_name:'同名',chat_type:'private'},{username:'friend-b',display_name:'同名',chat_type:'private'},{username:'group',display_name:'群',chat_type:'group'}];
  assert.equal((await scope.enroll(sessions)).created,0);
  await scope.setMode({mode:'all_private',confirmed:true});
  assert.equal((await scope.enroll(sessions)).created,0);
  await f.client.query('INSERT INTO front_sync_state(owner_id,enabled,enabled_at) VALUES($1,true,now())',[owner]);
  assert.equal((await scope.enroll(sessions)).created,2);
  assert.equal((await scope.enroll(sessions)).created,0);
  const rows=(await f.client.query('SELECT contact_id,id FROM conversation_binding WHERE owner_id=$1',[owner])).rows;
  assert.equal(new Set(rows.map(r=>r.contact_id)).size,2);
  const baseline=(await f.client.query('SELECT baseline_at FROM wechat_observation_baseline WHERE owner_id=$1',[owner])).rows;
  assert.ok(baseline.every(r=>r.baseline_at.toISOString()==='2026-10-23T10:00:00.000Z'));
  await f.client.query("UPDATE conversation_binding SET status='revoked',revoked_at=now() WHERE id=$1",[rows[0].id]);
  await scope.setMode({mode:'all_private',confirmed:true});
  assert.equal((await scope.enroll(sessions)).created,0);
});

test('删除排除跨重启保留；唯一稳定身份复用，跨owner不复用，账号撤销拒绝',async t => {
  const f=await createStorageFixture();t.after(()=>f.close());
  const storage=await HostStorage.open(f.options);t.after(()=>storage.close());
  const {owner_id:owner}=await storage.initializeOwner('合成用户');
  await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-account','合成账号')",[owner]);
  await f.client.query('INSERT INTO front_sync_state(owner_id,enabled,enabled_at) VALUES($1,true,now())',[owner]);
  const contact=(await f.client.query("INSERT INTO contact(owner_id,display_name) VALUES($1,'原联系人') RETURNING id",[owner])).rows[0].id;
  await f.client.query("INSERT INTO channel_identity(owner_id,contact_id,channel,external_id,observed_name) VALUES($1,$2,'wechat','friend-a','原名')",[owner,contact]);
  const other=(await f.client.query("INSERT INTO owner(display_name) VALUES('其他合成本人') RETURNING id")).rows[0].id;
  const foreign=(await f.client.query("INSERT INTO contact(owner_id,display_name) VALUES($1,'其他联系人') RETURNING id",[other])).rows[0].id;
  await f.client.query("INSERT INTO channel_identity(owner_id,contact_id,channel,external_id,observed_name) VALUES($1,$2,'wechat','friend-b','同名')",[other,foreign]);
  const options={storage,ownerId:owner,accountScope:'synthetic-account'};
  const scope=new SyncScopeService(options);
  await scope.setMode({mode:'all_private',confirmed:true});
  const sessions=[{username:'friend-a',display_name:'新展示名',chat_type:'private'},{username:'friend-b',display_name:'同名',chat_type:'private'}];
  assert.equal((await scope.enroll(sessions)).created,2);
  const bindings=(await f.client.query('SELECT contact_id,conversation_locator FROM conversation_binding WHERE owner_id=$1',[owner])).rows;
  assert.equal(bindings.find(r=>r.conversation_locator==='friend-a').contact_id,contact);
  assert.notEqual(bindings.find(r=>r.conversation_locator==='friend-b').contact_id,foreign);
  await f.client.query('DELETE FROM contact WHERE owner_id=$1 AND id=$2',[owner,contact]);
  scope.close();
  const reopened=new SyncScopeService(options);
  assert.equal((await reopened.enroll(sessions)).created,0);
  await f.client.query("UPDATE owner_channel_identity SET status='revoked' WHERE owner_id=$1",[owner]);
  await assert.rejects(reopened.enroll(sessions),{code:'wechat_identity_conflict'});
});

test('旧账号accepted重复确认不扩张到后来绑定，只有本次明确快照可读历史',async t=>{
  const f=await createStorageFixture();t.after(()=>f.close());
  const storage=await HostStorage.open(f.options);t.after(()=>storage.close());
  const {owner_id:owner}=await storage.initializeOwner('合成用户');
  await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-account','合成账号')",[owner]);
  await f.client.query('INSERT INTO front_sync_state(owner_id,enabled,enabled_at) VALUES($1,true,now())',[owner]);
  const scope=new SyncScopeService({storage,ownerId:owner,accountScope:'synthetic-account'});
  await scope.setMode({mode:'all_private',confirmed:true});
  await scope.enroll([{username:'first',display_name:'先确认',chat_type:'private'}]);
  await scope.decideHistory({decision:'accepted',confirmed:true});
  const first=await scope.historyBindings();assert.equal(first.length,1);
  await scope.enroll([{username:'later',display_name:'后来新增',chat_type:'private'}]);
  await scope.decideHistory({decision:'accepted',confirmed:true});
  assert.deepEqual(await scope.historyBindings(),first);
  await scope.setMode({mode:'selected',confirmed:true});
  await scope.setMode({mode:'all_private',confirmed:true});
  assert.deepEqual(await scope.historyBindings(),first);
});
