/** 官方profile回归：TS持有历史决定和账号范围，旧执行方缓存不得使公开报告倒退。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,appendFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

const project=resolve(process.env.NOTALONE_TEST_WECHAT_HISTORY_PROJECT??new URL('../../',import.meta.url).pathname);
const {createStorageFixture}=await import(pathToFileURL(join(project,'backend-ts/test/host-storage-fixture.mjs')));
const {start}=await import(pathToFileURL(join(project,'backend-ts/test/contact-context-support.mjs')));
const {createForegroundFixture}=await import(pathToFileURL(join(project,'backend-ts/test/foreground-location-fixture.mjs')));
async function readyStatus(app){
  const deadline=Date.now()+5000;let result;
  do{
    result=await app.request('/api/sync/status');
    if(result.status===200)return result;
    if(result.status!==503||result.data.error!=='sync_status_unavailable')break;
  }while(Date.now()<deadline);
  assert.equal(result.status,200,'业务首份状态必须在有界等待内就绪');
  return result;
}

test('官方profile：拒绝历史后立即启停、检查和查询统一返回TS权威决定与范围',{timeout:90000},async t=>{
  const f=await createStorageFixture();
  t.after(async()=>{for(const host of f.hosts??[])assert.equal(await host.terminate(),true);await f.close();});
  const owner=randomUUID();
  await f.client.query("INSERT INTO public.owner(id,display_name) VALUES($1,'合成用户')",[owner]);
  await f.client.query("INSERT INTO public.owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-account','合成账号')",[owner]);
  await f.client.query('INSERT INTO public.front_sync_state(owner_id,enabled) VALUES($1,false)',[owner]);
  const cli=join(f.directory,'synthetic-cli');
  await writeFile(cli,`#!/bin/sh
case "$1" in
status) printf '%s\\n' '{"ok":true,"data":{"status":{"account":{"identity_configured":true,"schema2_ready":true},"live_read_ok":true,"readiness":"ready","mode":{"strict_read_only":true},"account_debug":{"wxid":"synthetic-account"}}}}';;
--version) printf '%s\\n' '{"ok":true,"data":{"version":"synthetic-1"}}';;
sessions) printf '%s\\n' '{"ok":true,"data":{"sessions":[{"username":"friend-a","display_name":"合成联系人","chat_type":"private","last_timestamp":1}]}}';;
resolve-chat) printf '%s\\n' '{"ok":true,"data":{"candidates":[{"username":"friend-a","display_name":"合成联系人","chat_type":"private"}]}}';;
tail) case " $* " in *' --follow '*) exec /bin/sleep 3600;; esac
 printf '%s\\n' '{"ok":true,"data":{"events":[],"cursor":null,"freshness":{"message_source":"live_message_db"},"query":{"chat":"friend-a","has_more":false,"history":false}}}';;
*) exit 2;;
esac
`,{mode:0o700});
  await appendFile(f.envFilePath,`NOTALONE_OWNER_ID=${owner}\nNOTALONE_WECHAT_CLI=${cli}\n`);
  const app=await start(t,f,{},project);
  const initial=await readyStatus(app);
  assert.equal(initial.status,200);assert.equal(initial.data.cli_history_authorization_state,'required');
  const binding=await app.request('/api/sync/cli-bindings/confirm',{
    selections:[{locator:'friend-a',observed_display_name:'合成联系人'}],history_authorized:false});
  assert.equal(binding.status,200);
  const decline=await app.request('/api/sync/history-authorization',{decision:'declined',confirmed:true});
  assert.equal(decline.status,200);assert.equal(decline.data.cli_history_authorization_state,'declined');
  const dbBefore=(await f.client.query('SELECT decision,version FROM public.wechat_history_sync_authorization WHERE owner_id=$1',[owner])).rows;
  const observations=[];
  for(const [path,body] of [
    ['/api/sync/enable',{}],['/api/sync/status',undefined],['/api/sync/check',{}],
    ['/api/sync/priority',{contact_id:null}],['/api/sync/backfill/pause',{}],['/api/sync/backfill/retry',{}],
    ['/api/sync/disable',{}],['/api/sync/status',undefined],
  ]){
    const result=await app.request(path,body);
    observations.push({path,status:result.status,enabled:result.data.sync_enabled,scope:result.data.sync_scope,
      history:result.data.cli_history_authorization_state,version:result.data.cli_history_authorization_version,
      current_version:result.data.cli_history_authorization_current_version});
  }
  const invalid=await app.request('/api/sync/priority',{contact_id:'invalid'});
  assert.equal(invalid.status,400);assert.deepEqual(invalid.data,{error:'sync_priority_request_invalid'});
  const wrongMethod=await app.request('/api/sync/enable');
  assert.equal(wrongMethod.status,404);assert.deepEqual(wrongMethod.data,{error:'not_found'});
  const dbAfter=(await f.client.query('SELECT decision,version FROM public.wechat_history_sync_authorization WHERE owner_id=$1',[owner])).rows;
  const counts=(await f.client.query('SELECT (SELECT count(*)::int FROM public.message) messages,(SELECT count(*)::int FROM public.wechat_binding_history_authorization) history_authorizations')).rows[0];
  t.diagnostic(JSON.stringify({observations,dbBefore,dbAfter,counts}));
  assert.deepEqual(dbBefore,[{decision:'declined',version:1}]);assert.deepEqual(dbAfter,dbBefore);
  assert.deepEqual(counts,{messages:0,history_authorizations:0});
  for(const value of observations){
    assert.equal(value.status,200,value.path);
    assert.equal(value.history,'declined',`${value.path} 回执不能退回首次历史授权提示`);
    assert.equal(value.version,1,value.path);assert.equal(value.current_version,1,value.path);
    assert.equal(value.scope,'selected',value.path);
  }
  assert.equal(observations[0].enabled,true);assert.equal(observations.at(-1).enabled,false);
  const mode=await app.request('/api/sync/scope',{mode:'all_private',confirmed:true});
  assert.equal(mode.status,200);
  const scopeStatus=await app.request('/api/sync/status');
  assert.equal(scopeStatus.status,200);assert.equal(scopeStatus.data.sync_scope,'all_private');
  assert.equal(scopeStatus.data.cli_history_authorization_state,'declined');
  assert.deepEqual(scopeStatus.data.health,initial.data.health,'权威字段装配保留执行方健康报告');
});

test('官方profile：权威报告读取期间下游断连，完整旧控制回执排空后释放前台权限门',{timeout:90000},async t=>{
  const f=await createForegroundFixture(t);
  assert.equal((await readyStatus(f.app)).status,200);
  assert.equal((await f.app.request('/api/sync/history-authorization',{decision:'declined',confirmed:true})).status,200);
  await f.client.query('BEGIN');
  await f.client.query('LOCK TABLE public.wechat_history_sync_authorization IN ACCESS EXCLUSIVE MODE');
  const cancelled=new AbortController();
  const pending=fetch(`http://${f.app.connection.address}/api/sync/disable`,{method:'POST',
    headers:{Authorization:`Bearer ${f.app.connection.token}`,'Content-Type':'application/json'},body:'{}',signal:cancelled.signal}).catch(()=>null);
  try{
    let blocked=false;const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      await f.client.query('SELECT pg_stat_clear_snapshot()');
      const result=await f.client.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()");
      if(result.rows.some(row=>row.query.includes('wechat_history_sync_authorization'))){blocked=true;break;}
    }
    assert.equal(blocked,true,'等待确实发生在TS权威历史状态读取');
    const during=await f.app.request('/api/sync/foreground/observe',{});
    assert.equal(during.status,409);assert.equal(during.data.error,'runtime_stopped');
    cancelled.abort();await pending;
    await f.client.query('COMMIT');
    const enabled=await f.app.request('/api/sync/enable',{});
    assert.equal(enabled.status,200);assert.equal(enabled.data.cli_history_authorization_state,'declined');
    const observed=await f.app.request('/api/sync/foreground/observe',{});
    assert.equal(observed.status,200);assert.equal(observed.data.contact_id,f.contact);
  }finally{cancelled.abort();await pending;await f.client.query('ROLLBACK');}
});
