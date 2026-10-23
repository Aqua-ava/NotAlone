import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { authorizedHistoryBindings, grantBindingHistory } from '../src/sync-scope-history.ts';
import { BindingService } from '../src/binding-service.ts';
import { HostStorage } from '../src/host-storage.ts';
import { createStorageFixture } from './host-storage-fixture.mjs';

async function fixture(t) {
  const f = await createStorageFixture();
  const storage = await HostStorage.open(f.options);
  const owner = randomUUID(), foreignOwner = randomUUID(), foreign = randomUUID();
  await f.client.query('INSERT INTO public.owner(id,display_name) VALUES($1,$3),($2,$3)',[owner,foreignOwner,'合成本人']);
  await f.client.query('INSERT INTO public.contact(id,owner_id,display_name) VALUES($1,$2,$3)',[foreign,foreignOwner,'合成联系人']);
  await f.client.query("INSERT INTO public.owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic_account','合成本人')",[owner]);
  let sessions = ['synthetic_a','synthetic_b'].map(username => ({username,display_name:'同名合成',chat_type:'private',last_timestamp:42}));
  const options = {storage, ownerId:owner,channel:'wechat',accountScope:'synthetic_account',sessions:async()=>sessions,clock:()=>new Date('2026-10-23T00:00:00Z')};
  const service = new BindingService(options);
  t.after(async()=>{await service.close();await storage.close();await f.close();});
  return {...f,storage,owner,foreign,options,service,setSessions(value){sessions=value;}};
}

test('仅预览不建联，同名分离，批次绑定与baseline原子保存并保留UUID',async t=>{
  const f=await fixture(t);
  const candidates=await f.service.candidates();
  assert.deepEqual(candidates.map(row=>row.bound_contact_id),[null,null]);
  assert.equal((await f.service.list()).length,0);
  const rows=await f.service.confirm(candidates.map(row=>({locator:row.username,observed_display_name:row.display_name})));
  assert.equal(rows.length,2); assert.notEqual(rows[0].contact_id,rows[1].contact_id);
  const baselines=(await f.client.query('SELECT binding_id,baseline_at FROM public.wechat_observation_baseline ORDER BY binding_id')).rows;
  assert.deepEqual(baselines.map(row=>row.binding_id).sort(),rows.map(row=>row.binding_id).sort());
  assert.ok(baselines.every(row=>row.baseline_at.toISOString()==='2026-10-23T00:00:00.000Z'));
  assert.deepEqual(await f.service.confirm([{locator:'synthetic_a',contact_id:rows[0].contact_id,observed_display_name:'同名合成'}]),[]);
  await assert.rejects(f.service.confirm([{locator:'synthetic_a',observed_display_name:'同名合成'}]),{code:'cli_binding_selection_stale'});
  assert.deepEqual((await f.service.list()).map(row=>row.binding_id).sort(),rows.map(row=>row.binding_id).sort());
});

test('改名复验、群聊、重复标识和跨owner联系人拒绝，批次失败无部分写入',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.service.confirm([{locator:'synthetic_a',observed_display_name:'旧名字'}]),{code:'cli_binding_selection_stale'});
  await assert.rejects(f.service.confirm([{locator:'synthetic_a'},{locator:'synthetic_b',contact_id:f.foreign}]),{code:'cli_binding_not_found'});
  assert.equal((await f.service.list()).length,0);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM public.contact WHERE owner_id=$1',[f.owner])).rows[0].n,0);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM public.wechat_observation_baseline')).rows[0].n,0);
  f.setSessions([{username:'group@chatroom',display_name:'合成群',chat_type:'group'}]);
  await assert.rejects(f.service.confirm([{locator:'group@chatroom'}]),{code:'cli_binding_selection_stale'});
  f.setSessions([{username:'same',display_name:'甲',chat_type:'private'},{username:'same',display_name:'乙',chat_type:'private'}]);
  await assert.rejects(f.service.candidates(),{code:'cli_binding_selection_stale'});
});

test('撤销按完整owner/contact/account范围且幂等，原触发器保留排除摘要',async t=>{
  const f=await fixture(t); const [row]=await f.service.confirm([{locator:'synthetic_a'}]);
  await assert.rejects(f.service.revoke(f.foreign,row.binding_id),{code:'cli_binding_not_found'});
  const other=new BindingService({...f.options,accountScope:'other_account'});
  await assert.rejects(other.revoke(row.contact_id,row.binding_id),{code:'cli_binding_account_changed'}); await other.close();
  assert.equal((await f.service.revoke(row.contact_id,row.binding_id)).status,'revoked');
  assert.equal((await f.service.revoke(row.contact_id,row.binding_id)).status,'revoked');
  assert.equal((await f.service.list()).length,0); assert.equal((await f.service.list(true)).length,1);
  const excluded=(await f.client.query('SELECT encode(locator_hash,\'hex\') AS hash FROM public.wechat_sync_exclusion WHERE owner_id=$1',[f.owner])).rows;
  assert.equal(excluded.length,1); assert.equal(excluded[0].hash.length,64);
});

test('最后SQL后取消使整批回滚，关闭排空并拒绝新请求',async t=>{
  const f=await fixture(t); let service;
  const storage={businessTransaction:operation=>f.storage.businessTransaction(client=>operation(new Proxy(client,{get(target,key){
    if(key==='query') return async(...args)=>{const result=await target.query(...args);if(String(args[0]).startsWith('INSERT INTO public.wechat_observation_baseline'))service.invalidate();return result;};
    return Reflect.get(target,key);
  }})))};
  service=new BindingService({...f.options,storage});
  await assert.rejects(service.confirm([{locator:'synthetic_a'}]),{code:'cli_binding_cancelled'});
  assert.equal((await f.service.list()).length,0);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM public.contact WHERE owner_id=$1',[f.owner])).rows[0].n,0);
  await service.close(); await assert.rejects(service.confirm([]),{code:'cli_binding_cancelled'});
});

test('元数据在途关闭或请求取消不写入',async t=>{
  const f=await fixture(t); let release, entered;
  const ready=new Promise(resolve=>{entered=resolve;});
  const service=new BindingService({...f.options,sessions:()=>{entered();return new Promise(resolve=>{release=resolve;});}});
  const pending=service.confirm([{locator:'synthetic_a'}]);
  const rejected=assert.rejects(pending,{code:'cli_binding_cancelled'});
  await ready; const closed=service.close(); release([{username:'synthetic_a',display_name:'合成',chat_type:'private'}]);
  await rejected; await closed;
  const signal=AbortSignal.abort(); await assert.rejects(f.service.confirm([{locator:'synthetic_a'}],signal),{code:'cli_binding_cancelled'});
  assert.equal((await f.service.list()).length,0);
});


test('稳定渠道身份冲突不猜测合并，显式同身份确认保留原contact UUID',async t=>{
  const f=await fixture(t), contact=randomUUID();
  await f.client.query('INSERT INTO public.contact(owner_id,id,display_name) VALUES($1,$2,$3)',[f.owner,contact,'已有合成']);
  await f.client.query("INSERT INTO public.channel_identity(owner_id,contact_id,channel,external_id,observed_name) VALUES($1,$2,'wechat','synthetic_a','同名合成')",[f.owner,contact]);
  await assert.rejects(f.service.confirm([{locator:'synthetic_a'}]),{code:'cli_binding_conflict'});
  const [row]=await f.service.confirm([{locator:'synthetic_a',contact_id:contact}]);
  assert.equal(row.contact_id,contact);
});


test('并发重复确认串行复验，仅一个批次建立身份和baseline',async t=>{
  const f=await fixture(t);
  const outcomes=await Promise.allSettled([1,2].map(()=>f.service.confirm([{locator:'synthetic_a',observed_display_name:'同名合成'}])));
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(outcomes.find(result=>result.status==='rejected').reason.code,'cli_binding_selection_stale');
  assert.equal((await f.service.list()).length,1);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM public.wechat_observation_baseline')).rows[0].n,1);
});


test('CLI元数据返回后数据库撤销本人账号，确认和读取撤销均拒绝晚操作',async t=>{
  const f=await fixture(t); const [saved]=await f.service.confirm([{locator:'synthetic_a'}]);
  const service=new BindingService({...f.options,sessions:async()=>{
    await f.client.query("UPDATE public.owner_channel_identity SET status='revoked' WHERE owner_id=$1",[f.owner]);
    return [{username:'synthetic_b',display_name:'同名合成',chat_type:'private'}];
  }});
  await assert.rejects(service.confirm([{locator:'synthetic_b'}]),{code:'cli_binding_account_changed'});
  await assert.rejects(f.service.list(),{code:'cli_binding_account_changed'});
  await assert.rejects(f.service.revoke(saved.contact_id,saved.binding_id),{code:'cli_binding_account_changed'});
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM public.conversation_binding WHERE owner_id=$1',[f.owner])).rows[0].n,1);
  assert.equal((await f.client.query('SELECT status FROM public.conversation_binding WHERE id=$1',[saved.binding_id])).rows[0].status,'active');
  await service.close();
});

test('本人账号已更换且仍active时拒绝旧accountScope',async t=>{
  const f=await fixture(t);
  await f.client.query("UPDATE public.owner_channel_identity SET external_id='synthetic_changed' WHERE owner_id=$1",[f.owner]);
  await assert.rejects(f.service.confirm([{locator:'synthetic_a'}]),{code:'cli_binding_account_changed'});
  await assert.rejects(f.service.list(),{code:'cli_binding_account_changed'});
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM public.contact WHERE owner_id=$1',[f.owner])).rows[0].n,0);
});

test('绑定历史同意只覆盖本次所选，幂等已有绑定可授权且保留旧记录',async t=>{
  const f=await fixture(t);const rows=await f.service.confirm([{locator:'synthetic_a'},{locator:'synthetic_b'}]);
  const a=rows.find(row=>row.conversation_locator==='synthetic_a');
  await f.service.confirm([{locator:'synthetic_a',contact_id:a.contact_id}],undefined,()=>{},true);
  await f.service.confirm([{locator:'synthetic_a',contact_id:a.contact_id}],undefined,()=>{},true);
  const grants=(await f.client.query('SELECT binding_id FROM public.wechat_binding_history_authorization WHERE owner_id=$1',[f.owner])).rows;
  assert.deepEqual(grants.map(row=>row.binding_id),[a.binding_id]);
  await f.service.revoke(a.contact_id,a.binding_id);
  assert.equal((await f.client.query('SELECT count(*)::int n FROM public.wechat_binding_history_authorization WHERE owner_id=$1',[f.owner])).rows[0].n,1);
});

test('新绑定可显式授权；授权写入后取消回滚绑定及授权',async t=>{
  const f=await fixture(t);
  const [saved]=await f.service.confirm([{locator:'synthetic_a'}],undefined,()=>{},true);
  assert.equal((await f.client.query('SELECT binding_id FROM public.wechat_binding_history_authorization WHERE owner_id=$1',[f.owner])).rows[0].binding_id,saved.binding_id);
  let service;
  const storage={businessTransaction:operation=>f.storage.businessTransaction(client=>operation(new Proxy(client,{get(target,key){
    if(key==='query')return async(...args)=>{const result=await target.query(...args);if(String(args[0]).startsWith('INSERT INTO public.wechat_binding_history_authorization'))service.invalidate();return result;};
    return Reflect.get(target,key);
  }})))};
  service=new BindingService({...f.options,storage});
  await assert.rejects(service.confirm([{locator:'synthetic_b'}],undefined,()=>{},true),{code:'cli_binding_cancelled'});
  assert.equal((await f.service.list()).length,1);
  assert.equal((await f.client.query('SELECT count(*)::int n FROM public.wechat_binding_history_authorization WHERE owner_id=$1',[f.owner])).rows[0].n,1);
  await service.close();
});


test('撤销后明确重绑可授权历史，自动范围快照仍尊重排除且不复活旧绑定',async t=>{
  const f=await fixture(t);
  const scope={ownerId:f.owner,accountScope:'synthetic_account'};
  const [old]=await f.service.confirm([{locator:'synthetic_a'}],undefined,()=>{},true);
  await f.service.revoke(old.contact_id,old.binding_id);
  const excluded=(await f.client.query('SELECT * FROM public.wechat_sync_exclusion WHERE owner_id=$1',[f.owner])).rows;
  assert.deepEqual(await authorizedHistoryBindings(f.client,scope),[]);
  const [rebound]=await f.service.confirm([{locator:'synthetic_a',contact_id:old.contact_id}]);
  assert.notEqual(rebound.binding_id,old.binding_id);
  assert.equal(await grantBindingHistory(f.client,scope,undefined,new Date()),0);
  assert.deepEqual(await authorizedHistoryBindings(f.client,scope),[]);
  await f.service.confirm([{locator:'synthetic_a',contact_id:old.contact_id}],undefined,()=>{},true);
  assert.deepEqual(await authorizedHistoryBindings(f.client,scope),[rebound.binding_id]);
  assert.deepEqual((await f.client.query('SELECT binding_id FROM public.wechat_binding_history_authorization WHERE owner_id=$1 ORDER BY binding_id',[f.owner])).rows.map(r=>r.binding_id),[old.binding_id,rebound.binding_id].sort());
  assert.deepEqual((await f.client.query('SELECT * FROM public.wechat_sync_exclusion WHERE owner_id=$1',[f.owner])).rows,excluded);
  await f.service.revoke(rebound.contact_id,rebound.binding_id);
  assert.deepEqual(await authorizedHistoryBindings(f.client,scope),[]);
});
