import test from 'node:test';
import assert from 'node:assert/strict';
import { HostStorage } from '../src/host-storage.ts';
import { SyncScopeService } from '../src/sync-scope.ts';
import { SyncIncrementalStore } from '../src/sync-incremental-store.ts';
import { SyncHistory } from '../src/sync-history.ts';
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

test('自动纳入仅在明确全部及开关开启，保留同名隔离、撤销排除和绑定起点',async t => {
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

test('ADR-100只向已接受的账号级全部私聊授权自动追加新私聊，并按owner和account隔离',{timeout:90000},async t=>{
  const f=await createStorageFixture();t.after(()=>f.close());
  const storage=await HostStorage.open(f.options);t.after(()=>storage.close());
  const addScope=async(account,{mode='all_private',decision=null}={})=>{
    const owner=(await f.client.query("INSERT INTO owner(display_name) VALUES('合成用户') RETURNING id")).rows[0].id;
    await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat',$2,'合成账号')",[owner,account]);
    await f.client.query('INSERT INTO front_sync_state(owner_id,enabled,enabled_at) VALUES($1,true,now())',[owner]);
    const scope=new SyncScopeService({storage,ownerId:owner,accountScope:account,clock:()=>new Date('2026-10-25T00:00:00Z')});
    t.after(()=>scope.close());
    await scope.setMode({mode,confirmed:true});
    if(decision==='accepted')await scope.decideHistory({decision:'accepted',confirmed:true});
    else if(decision)await f.client.query(`INSERT INTO wechat_history_sync_authorization
      (owner_id,channel,account_scope,version,decision,decided_at) VALUES($1,'wechat',$2,$3,$4,now())`,
      [owner,account,decision==='unknown'?2:1,decision==='declined'?'declined':'accepted']);
    return {owner,account,scope};
  };
  const accepted=await addScope('accepted-account',{decision:'accepted'});
  const declined=await addScope('declined-account',{decision:'declined'});
  const required=await addScope('required-account');
  const unknown=await addScope('unknown-account',{decision:'unknown'});
  const selected=await addScope('selected-account',{mode:'selected',decision:'accepted'});
  const cases=[
    {row:accepted,username:'accepted-private',created:1,auth:1},
    {row:declined,username:'declined-private',created:1,auth:0},
    {row:required,username:'required-private',created:1,auth:0},
    {row:unknown,username:'unknown-private',created:1,auth:0},
    {row:selected,username:'selected-private',created:0,auth:0},
  ];
  for(const item of cases){
    assert.equal((await item.row.scope.enroll([{username:item.username,display_name:'合成',chat_type:'private'}])).created,item.created);
    const counts=(await f.client.query(`SELECT
      (SELECT count(*)::int FROM conversation_binding WHERE owner_id=$1 AND account_scope=$2) AS bindings,
      (SELECT count(*)::int FROM wechat_binding_history_authorization WHERE owner_id=$1) AS history`,
      [item.row.owner,item.row.account])).rows[0];
    assert.equal(counts.bindings,item.created);
    assert.equal(counts.history,item.auth);
    assert.equal((await item.row.scope.historyBindings()).length,item.auth);
  }

  await f.client.query("INSERT INTO wechat_sync_exclusion(owner_id,channel,account_scope,locator_hash) VALUES($1,'wechat',$2,sha256(convert_to('excluded-private','UTF8')))",[accepted.owner,accepted.account]);
  const next=await accepted.scope.enroll([
    {username:'later-private',display_name:'后来新增',chat_type:'private'},
    {username:'excluded-private',display_name:'排除',chat_type:'private'},
    {username:'group-private',display_name:'群',chat_type:'group'},
  ]);
  assert.equal(next.created,1);
  assert.equal((await accepted.scope.enroll([{username:'later-private',display_name:'后来新增',chat_type:'private'}])).created,0);
  const concurrent=new SyncScopeService({storage,ownerId:accepted.owner,accountScope:accepted.account});
  t.after(()=>concurrent.close());
  const raced=await Promise.all([
    accepted.scope.enroll([{username:'concurrent-private',display_name:'并发',chat_type:'private'}]),
    concurrent.enroll([{username:'concurrent-private',display_name:'并发',chat_type:'private'}]),
  ]);
  assert.equal(raced.reduce((sum,item)=>sum+item.created,0),1);
  const acceptedRows=(await f.client.query(`SELECT b.conversation_locator,
    count(a.binding_id) OVER (PARTITION BY b.id)::int AS auth
    FROM conversation_binding b LEFT JOIN wechat_binding_history_authorization a
      ON a.owner_id=b.owner_id AND a.contact_id=b.contact_id AND a.binding_id=b.id
    WHERE b.owner_id=$1 ORDER BY b.conversation_locator`,[accepted.owner])).rows;
  assert.deepEqual(acceptedRows.map(row=>row.conversation_locator),['accepted-private','concurrent-private','later-private']);
  assert.ok(acceptedRows.every(row=>row.auth===1));
  const historyIds=await accepted.scope.historyBindings();assert.equal(historyIds.length,3);
  const store=new SyncIncrementalStore({storage,ownerId:accepted.owner,accountScope:accepted.account});
  const history=new SyncHistory({store,cli:{},accountScope:accepted.account});
  const bindings=await store.listBindings();await history.ensureStarted(bindings,()=>{});
  const coverages=await history.coverages(bindings,()=>{});
  assert.ok(coverages.length===3&&coverages.every(row=>row.phase==='syncing'));

  const rollback=await addScope('rollback-account',{decision:'accepted'});
  await f.client.query(`CREATE FUNCTION public.reject_runtime_history_rollback() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE locator text;
    BEGIN
      SELECT conversation_locator INTO locator FROM public.conversation_binding
      WHERE owner_id=NEW.owner_id AND contact_id=NEW.contact_id AND id=NEW.binding_id;
      IF locator='rollback-second' THEN RAISE EXCEPTION 'synthetic_runtime_history_rollback'; END IF;
      RETURN NEW;
    END $$`);
  await f.client.query(`CREATE TRIGGER reject_runtime_history_rollback BEFORE INSERT
    ON public.wechat_binding_history_authorization FOR EACH ROW EXECUTE FUNCTION public.reject_runtime_history_rollback()`);
  await assert.rejects(rollback.scope.enroll([
    {username:'rollback-first',display_name:'一',chat_type:'private'},
    {username:'rollback-second',display_name:'二',chat_type:'private'},
  ]),{code:'database_unavailable'});
  for(const table of ['contact','conversation_binding','wechat_observation_baseline','wechat_binding_history_authorization']){
    assert.equal((await f.client.query(`SELECT count(*)::int AS n FROM public.${table} WHERE owner_id=$1`,[rollback.owner])).rows[0].n,0,table);
  }
});
