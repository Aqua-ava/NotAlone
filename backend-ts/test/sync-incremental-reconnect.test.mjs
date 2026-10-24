/** 当前官方profile：以真实宿主heartbeat验证自动重连，不用check清除退避。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {setTimeout as delay} from 'node:timers/promises';
import {createReconnectFixture,waitForReconnectProbe,pathExists,processAlive} from './sync-incremental-reconnect-fixture.mjs';

test('官方profile：全局流code7后自然退避重连，metadata cursor接续且重复消息不重建', {timeout:90000},async t=>{
  const f=await createReconnectFixture(t);
  const runtime=await f.request('/api/runtime/status');assert.equal(runtime.status,200);
  assert.equal(runtime.data.runtime,'dsh');assert.equal(runtime.data.ownership.wechatIncremental,'typescript');
  assert.deepEqual(runtime.data.reply,{runtime:'typescript',state:'unconfigured',reason:'reply_model_unconfigured'});
  const initial=await f.request('/api/sync/status');assert.equal(initial.status,200);assert.equal(initial.data.sync_scope,'selected');
  const confirmed=await f.request('/api/sync/cli-bindings/confirm',{selections:[{locator:'friend-a'}],history_authorized:false});
  assert.equal(confirmed.status,200,JSON.stringify(confirmed));
  const bindings=(await f.request('/api/sync/cli-bindings')).data.bindings;assert.equal(bindings.length,1);const binding=bindings[0];
  const before=await f.authority();assert.equal(before.wechat_binding_history_authorization.length,0);
  const baseline=(await f.client.query('SELECT baseline_at FROM public.wechat_observation_baseline WHERE binding_id=$1',[binding.binding_id])).rows[0].baseline_at;
  await f.setMessageTime(Math.max(Math.ceil(Date.now()/1000),Math.ceil(baseline.getTime()/1000)));
  assert.equal((await f.request('/api/sync/enable',{})).status,200);
  let firstSaved=false,degraded=false;
  await waitForReconnectProbe(async()=>{
    const current=await f.request('/api/sync/status');assert.equal(current.status,200);
    const entries=await f.commands(),starts=entries.filter(e=>e.kind==='stream_start');
    const count=(await f.client.query('SELECT count(*)::int n FROM public.message')).rows[0].n;
    firstSaved ||= starts.length===1&&count===1;
    degraded ||= current.data.cli_failure_code==='cli_follow_failed'&&current.data.cli_sync_mode==='bounded_polling'&&!current.data.cli_stream_active;
    return starts.length===2&&entries.filter(e=>e.kind==='body'&&e.generation===2).length>=2&&count===2&&current.data.cli_sync_phase==='active'&&current.data.cli_stream_active;
  },'自然heartbeat重建流、恢复消息并再次接收重复页');
  const entries=await f.commands(),starts=entries.filter(e=>e.kind==='stream_start'),exits=entries.filter(e=>e.kind==='stream_exit');
  assert.equal(starts.length,2);assert.equal(exits.length,1);assert.equal(exits[0].code,7);
  assert.notEqual(starts[0].pid,starts[1].pid);assert.ok(starts[1].at-exits[0].at>=3000);
  assert.ok(firstSaved,'重连前必须先保存原稳定消息');assert.ok(degraded,'必须实际观察流故障与轮询回退');
  const cursorIndex=starts[1].args.indexOf('--cursor');assert.ok(cursorIndex>=0);
  assert.equal(starts[1].args[cursorIndex+1],'global-1-outside','第二流必须接续已消费的metadata cursor，而非正文cursor');
  assert.equal(f.requests.filter(r=>r.path==='/api/sync/enable').length,1);
  assert.ok(!f.requests.some(r=>/\/(?:check|retry|follow-[a-z-]+)$/.test(r.path)));
  assert.deepEqual(await f.authority(),before,'自然重连保留原账号、范围、排除项、绑定与baseline');
  const messages=(await f.client.query(`SELECT m.id,m.owner_id,m.contact_id,w.external_local_id,w.external_talker,w.source_create_time
    FROM public.message m JOIN public.wechat_message_metadata w ON w.message_id=m.id AND w.owner_id=m.owner_id AND w.contact_id=m.contact_id ORDER BY w.external_local_id`)).rows;
  assert.equal(messages.length,2);assert.deepEqual(messages.map(m=>m.external_local_id),['2','3']);
  assert.ok(messages.every(m=>m.owner_id===f.owner&&m.contact_id===binding.contact_id&&m.external_talker==='friend-a'&&Number(m.source_create_time)*1000>=baseline.getTime()));
  for(const message of messages){
    const sources=(await f.client.query(`SELECT r.id,r.source_kind,o.binding_id,o.mode FROM public.message_source_ref r JOIN public.local_wechat_observation o ON o.id=r.observation_id AND o.owner_id=r.owner_id AND o.contact_id=r.contact_id WHERE r.message_id=$1 AND r.owner_id=$2 AND r.contact_id=$3`,[message.id,f.owner,binding.contact_id])).rows;
    assert.ok(sources.length>0);assert.ok(sources.every(s=>s.source_kind==='local_wechat_observation'&&s.binding_id===binding.binding_id&&s.mode==='cli_background'));
    const receipt=(await f.client.query(`SELECT count(*)::int n FROM public.source_processing_record r JOIN public.source_processing_batch b ON b.batch_id=r.batch_id WHERE b.source_id IN (SELECT id FROM public.local_wechat_observation WHERE owner_id=$1 AND contact_id=$2) AND r.outcome='message_created' AND r.payload->'persistence'->>'message_id'=$3 AND r.payload->'persistence'->>'source_ref_id' IS NOT NULL AND r.payload->>'model_read_status'='not_claimed'`,[f.owner,binding.contact_id,message.id])).rows[0];assert.equal(receipt.n,1);
  }
  const reused=(await f.client.query("SELECT count(*)::int n FROM public.source_processing_record WHERE outcome='message_reused'")).rows[0].n;assert.ok(reused>=2);
  const extraction=(await f.client.query('SELECT message_id,task_id FROM public.memory_extraction_receipt')).rows;
  assert.equal(extraction.length,2);assert.ok(extraction.every(r=>r.task_id===null));assert.deepEqual(new Set(extraction.map(r=>r.message_id)),new Set(messages.map(m=>m.id)));
  for(const table of ['background_task','background_task_step','model_call_receipt','model_call_learning_claim','outbound_ledger_entry','reply_request','reply_attempt'])assert.equal((await f.client.query('SELECT count(*)::int n FROM public.'+table)).rows[0].n,0,table);
  const body=entries.filter(e=>e.kind==='body');assert.ok(body.filter(e=>e.generation===2).length>=2);
  assert.ok(body.every(e=>e.args[1]==='friend-a'&&e.parent===runtime.data.pid));
  assert.ok(!entries.some(e=>e.kind==='scope_violation'||e.kind==='unexpected_command'||e.args.includes('--history')));
  assert.equal((await f.request('/api/sync/disable',{})).status,200);
  const commandCount=(await f.commands()).filter(e=>e.kind==='command').length;
  // 跨过真实3秒heartbeat；观察状态不触发新的周期或读取。
  await delay(3500);assert.equal((await f.request('/api/sync/status')).status,200);
  assert.equal((await f.commands()).filter(e=>e.kind==='command').length,commandCount);
  const shutdown=await f.request('/api/runtime/shutdown',{});assert.equal(shutdown.status,200);assert.equal(shutdown.data.state,'stopped');assert.equal(await f.host.waitForExit(12000),true);
  assert.equal(processAlive(f.host.pid),false);
  if(Number.isSafeInteger(runtime.data.legacyPid))assert.equal(processAlive(runtime.data.legacyPid),false);
  assert.ok((await f.commands()).every(e=>!processAlive(e.pid)));
  for(const path of [f.infoPath,f.infoPath+'.dsh-lock',f.profileHome])assert.equal(await pathExists(path),false);
  await f.close();
  t.diagnostic(JSON.stringify({stream_generations:2,exit_to_restart_ms:starts[1].at-exits[0].at,metadata_cursor:'global-1-outside',message_count:2,created_receipts:2,reused_receipts:reused,history_queries:0,outside_body_queries:0,disabled_no_new_commands:true,normal_shutdown:true,database_and_fixture_removed:true}));
});


test('官方profile：排空断言失败仍回收本轮测试库和目录，失败不会被清理吞掉', {timeout:60000},async t=>{
  let closeFailure;
  const f=await createReconnectFixture({after(close){
    t.after(async()=>{
      if(closeFailure)await assert.rejects(close(),error=>error===closeFailure);
      else await close();
    });
  }});
  const database=(await f.client.query('SELECT current_database() AS name')).rows[0].name;
  const extra=new pg.Client({host:'/tmp',database});
  const extraErrors=[];extra.on('error',error=>extraErrors.push({code:error.code,message:error.message}));
  try{
    await extra.connect();
    await assert.rejects(f.close(),error=>{
      closeFailure=error;
      assert.equal(error.code,'ERR_ASSERTION');assert.equal(error.actual,1);assert.equal(error.expected,0);
      assert.match(error.message,/宿主必须先关闭本测试库的所有业务连接/);return true;
    });
    await assert.rejects(f.close(),error=>error===closeFailure,'重复close必须保留同一个原断言失败');
    assert.equal(processAlive(f.host.pid),false);
    for(const path of [f.infoPath,f.infoPath+'.dsh-lock',f.profileHome,f.directory])assert.equal(await pathExists(path),false);
    const admin=new pg.Client({host:'/tmp',database:'postgres'});
    try{await admin.connect();assert.equal((await admin.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1',[database])).rows[0].n,0);}
    finally{await admin.end();}
    await assert.rejects(f.client.query('SELECT 1'),/Client was closed/);
    assert.ok(extraErrors.every(error=>error.code==='57P01'||(error.code===undefined&&error.message==='Connection terminated unexpectedly')),JSON.stringify(extraErrors));
    t.diagnostic(JSON.stringify({expected_active_assertion:1,original_failure_preserved:true,cached_failure_preserved:true,owned_host_stopped:true,database_and_fixture_removed:true}));
  }finally{await extra.end();await f.client.end();}
});
