import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { launchDsh } from '../src/launch.ts';
import { createStorageFixture } from './host-storage-fixture.mjs';

async function start(t, fixture, environment = {}) {
  const infoPath = join(fixture.directory, 'backend.info');
  const host = await launchDsh({nodeExecutable:process.execPath,projectDirectory:resolve('..'),envFilePath:fixture.envFilePath,infoPath,businessHome:fixture.directory,pythonExecutable:process.env.NOTALONE_TEST_PYTHON || join(homedir(),'miniconda3/envs/NotAlone/bin/python'),environment:{NOTALONE_MANAGED_USER_DATA:fixture.directory,...environment}},()=>true);
  (fixture.hosts ??= []).push(host);
  let connection;
  for (let i=0;i<150 && host.isRunning();i++) {
    try { const data=await readFile(infoPath,'utf8');connection=Object.fromEntries(data.trim().split('\n').map(line=>line.split('='))); break; } catch {}
    await delay(100);
  }
  assert.ok(connection,'真实DSH后台必须发布认证握手');
  return {host,connection, async request(path,body,token=connection.token) {const response=await fetch(`http://${connection.address}${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body&&JSON.stringify(body)});return {status:response.status,data:await response.json()};}};
}

test('真实DSH宿主认证健康、空库首用及关闭',async t=>{
  const fixture=await createStorageFixture();
  t.after(async()=>{for(const host of fixture.hosts??[])assert.equal(await host.terminate(),true);await fixture.close();});
  const app=await start(t,fixture);
  assert.equal((await app.request('/api/runtime/status',undefined,'invalid')).status,401);
  const health=await app.request('/api/runtime/status');
  assert.equal(health.data.runtime,'dsh');
  assert.equal(health.data.state,'running');
  assert.equal(health.data.pid,app.host.pid);
  assert.equal((await app.request('/api/setup/status')).data.owner_configured,false);
  const owner=await app.request('/api/setup/initialize',{display_name:'合成本人',create_only:true});
  assert.equal(owner.status,200);
  assert.equal(owner.data.created,true);
  assert.equal((await app.request('/api/setup/initialize',{display_name:'重复本人',create_only:true})).status,409);
  assert.equal((await app.request('/api/runtime/shutdown',{})).data.state,'stopped');
  assert.equal(await app.host.waitForExit(7000),true);
});

test('未迁移业务保留唯一旧后台执行且随DSH退出',async t=>{
  const fixture=await createStorageFixture();t.after(async()=>{for(const host of fixture.hosts??[])assert.equal(await host.terminate(),true);await fixture.close();});
  const app=await start(t,fixture);
  const health=await app.request('/api/runtime/status');
  assert.equal(health.data.ownership.setup,'typescript');
  assert.equal(health.data.ownership.contacts,'python');
  assert.ok(Number.isInteger(health.data.legacyPid));
  const contacts=await app.request('/api/contacts');
  assert.notEqual(contacts.status,404);
  await app.request('/api/runtime/shutdown',{});
  assert.equal(await app.host.waitForExit(7000),true);
  assert.throws(()=>process.kill(health.data.legacyPid,0));
});

test('真实DSH宿主公开导入只接受既有联系人，事务提交后如实保留待处理任务',async t=>{
  const fixture=await createStorageFixture();t.after(async()=>{for(const host of fixture.hosts??[])assert.equal(await host.terminate(),true);await fixture.close();});
  const owner=randomUUID(),contact=randomUUID();
  await fixture.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
  await fixture.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','wxid_synthetic_owner','合成本人')",[owner]);
  await fixture.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
  await fixture.client.query("INSERT INTO channel_identity(owner_id,contact_id,channel,external_id,observed_name) VALUES($1,$2,'wechat','wxid_synthetic_contact','合成联系人')",[owner,contact]);
  const cli=join(fixture.directory,'synthetic-cli');
  await writeFile(cli,`#!${process.execPath}
const args=process.argv.slice(2),emit=data=>console.log(JSON.stringify({ok:true,data}));
if(args[0]==='--version')emit({version:'synthetic-host-1'});
else if(args[0]==='status')emit({status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:'wxid_synthetic_owner'}}});
else process.exit(2);
`,{mode:0o700});
  await writeFile(fixture.envFilePath,`${await readFile(fixture.envFilePath,'utf8')}NOTALONE_OWNER_ID=${owner}\nNOTALONE_REPLY_RUNTIME=typescript\nNOTALONE_EXTRACTION_RUNTIME=typescript\nNOTALONE_WECHAT_CLI=${cli}\n`,{mode:0o600});
  const filePath=join(fixture.directory,'synthetic-host-import.jsonl');
  const rows=[
    {id:{local_id:1,server_id_str:'server-1',talker:'wxid_synthetic_contact'},create_time:1792461600,is_from_me:false,
      kind:'text',sender:'合成联系人',sender_wxid:'wxid_synthetic_contact',text:'合成消息一',time:'2026-10-20 10:00:00',time_iso:'2026-10-20T10:00:00+08:00'},
    {id:{local_id:2,server_id_str:'server-2',talker:'wxid_synthetic_contact'},create_time:1792461660,is_from_me:true,
      kind:'text',sender:'合成本人',sender_wxid:'wxid_synthetic_owner',text:'合成消息二',time:'2026-10-20 10:01:00',time_iso:'2026-10-20T10:01:00+08:00'},
  ];
  await writeFile(filePath,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const app=await start(t,fixture);
  const ownership=(await app.request('/api/runtime/status')).data.ownership;
  assert.equal(ownership.imports,'typescript');
  assert.equal(ownership.taskApi,'typescript');
  assert.equal(ownership.tasks,'typescript','任务领取和完成归唯一TS Worker');
  assert.equal((await app.request('/api/imports/preview?unexpected=1',{})).status,400);
  const preview=await app.request('/api/imports/preview',{path:filePath,contact_id:contact});
  assert.equal(preview.status,200);assert.equal(preview.data.record_count,2);
  const committed=await app.request('/api/imports/commit',{path:filePath,contact_id:contact,expected_content_sha256:preview.data.content_sha256});
  assert.equal(committed.status,200);assert.equal(committed.data.imported_count,2);
  assert.equal(committed.data.processing_deferred,true);
  assert.equal(committed.data.deferred_reason,'model_configuration_unavailable');
  assert.deepEqual((await fixture.client.query("SELECT status,current_step FROM background_task")).rows,[{status:'queued',current_step:'parse'}]);
  assert.equal((await fixture.client.query('SELECT count(*)::int AS count FROM message')).rows[0].count,2);
  assert.equal((await fixture.client.query('SELECT count(*)::int AS count FROM model_call_receipt')).rows[0].count,0);
  const taskId=committed.data.task_id,sourceId=(await fixture.client.query('SELECT id FROM source_document')).rows[0].id;
  const status=await app.request(`/api/tasks/status?contact_id=${contact}&task_id=${taskId}`);
  assert.equal(status.status,200);
  assert.deepEqual({id:status.data.task_id,type:status.data.task_type,state:status.data.status,step:status.data.step,
    count:status.data.message_count,retries:status.data.retry_count},
  {id:taskId,type:'import',state:'queued',step:'parse',count:2,retries:0});
  assert.deepEqual(status.data.steps.map(step=>step.name),['parse','normalize','extract_memory','index','verify']);
  assert.deepEqual(status.data.steps.map(step=>step.status),['pending','pending','pending','pending','pending']);
  const wrong=await app.request(`/api/tasks/status?contact_id=${randomUUID()}&task_id=${taskId}`);
  assert.deepEqual(wrong,{status:404,data:{error:'task_not_found'}});

  const run=await app.request('/api/tasks/run',{contact_id:contact,task_id:taskId});
  assert.deepEqual(run,{status:503,data:{error:'model_configuration_unavailable'}});
  assert.deepEqual((await fixture.client.query("SELECT status,current_step,retry_count FROM background_task WHERE id=$1",[taskId])).rows,
    [{status:'queued',current_step:'parse',retry_count:0}]);

  await fixture.client.query("UPDATE source_document SET status='delete_requested' WHERE id=$1",[sourceId]);
  assert.deepEqual(await app.request('/api/tasks/run',{contact_id:contact,task_id:taskId}),
    {status:409,data:{error:'task_retry_conflict'}});
  await fixture.client.query("UPDATE source_document SET status='active' WHERE id=$1",[sourceId]);
  await fixture.client.query("UPDATE background_task SET status='failed',current_step='extract_memory',last_error_code='memory_extraction_failed' WHERE id=$1",[taskId]);
  await fixture.client.query("UPDATE background_task_step SET status='failed',last_error_code='memory_extraction_failed' WHERE task_id=$1 AND step_name='extract_memory'",[taskId]);
  const failedBefore=(await fixture.client.query("SELECT status,current_step,retry_count,last_error_code FROM background_task WHERE id=$1",[taskId])).rows[0];
  assert.deepEqual(await app.request('/api/tasks/retry',{contact_id:contact,task_id:taskId}),
    {status:503,data:{error:'model_configuration_unavailable'}});
  assert.deepEqual((await fixture.client.query("SELECT status,current_step,retry_count,last_error_code FROM background_task WHERE id=$1",[taskId])).rows[0],
    failedBefore,'模型不可用时不得把失败任务重排');
  assert.equal((await fixture.client.query('SELECT count(*)::int AS count FROM model_call_receipt')).rows[0].count,0);
  const inFlight=Array.from({length:4},()=>app.request('/api/tasks/run',{contact_id:contact,task_id:taskId})
    .catch(error=>error));
  const shutdown=await app.request('/api/runtime/shutdown',{});
  assert.equal(shutdown.status,200);
  for(const response of await Promise.all(inFlight)){
    assert.equal(response instanceof Error,false,'宿主关闭不得截断在途任务控制响应');
    assert.ok([200,503].includes(response.status));
  }
  assert.equal(await app.host.waitForExit(7000),true);
});

test('已配置owner与凭据原地恢复，重启不重放迁移',async t=>{
  const fixture=await createStorageFixture();t.after(async()=>{for(const host of fixture.hosts??[])assert.equal(await host.terminate(),true);await fixture.close();});
  const first=await start(t,fixture);
  const owner=(await first.request('/api/setup/initialize',{display_name:'保留本人',create_only:true})).data.owner_id;
  const credentials = await first.request('/api/setup/credentials',{provider:'deepseek',api_key:'synthetic-key'});
  assert.equal(credentials.status,200);
  assert.equal(credentials.data.restart_required,true);
  assert.equal((await first.request('/api/setup/status')).data.runtime_configuration_pending,true);
  assert.doesNotMatch(JSON.stringify(credentials),/synthetic-key/);
  const before=(await fixture.client.query('SELECT name,checksum FROM notalone_schema_migration ORDER BY name')).rows;
  await first.request('/api/runtime/shutdown',{});await first.host.waitForExit(7000);
  const second=await start(t,fixture);
  const status=await second.request('/api/setup/status');
  assert.equal(status.data.runtime_owner_configured,true);
  assert.equal(status.data.credentials_configured,true);
  assert.equal(status.data.runtime_configuration_pending,false);
  assert.deepEqual((await fixture.client.query('SELECT id FROM owner')).rows,[{id:owner}]);
  assert.deepEqual((await fixture.client.query('SELECT name,checksum FROM notalone_schema_migration ORDER BY name')).rows,before);
  assert.doesNotMatch(JSON.stringify(status),/synthetic-key/);
  await second.request('/api/runtime/shutdown',{});await second.host.waitForExit(7000);
});

test('迁移期Python不再提供已移交的首用写入入口',async t=>{
  const fixture=await createStorageFixture();t.after(async()=>{for(const host of fixture.hosts??[])assert.equal(await host.terminate(),true);await fixture.close();});
  const app=await start(t,fixture);
  const lock=JSON.parse(await readFile(join(fixture.directory,'backend.info.dsh-lock'),'utf8'));
  const old=Object.fromEntries((await readFile(join(lock.home,'legacy.info'),'utf8')).trim().split('\n').map(line=>line.split('=')));
  const response=await fetch(`http://${old.address}/api/setup/initialize`,{method:'POST',headers:{Authorization:`Bearer ${old.token}`,'Content-Type':'application/json'},body:JSON.stringify({display_name:'不能从旧入口创建',create_only:true})});
  assert.equal(response.status,503);
  assert.equal((await app.request('/api/setup/status')).data.owner_configured,false);
});

test('未知数据库版本不发布业务握手且保留原库和配置',async t=>{
  const fixture=await createStorageFixture();t.after(async()=>{for(const host of fixture.hosts??[])assert.equal(await host.terminate(),true);await fixture.close();});
  await fixture.client.query("INSERT INTO notalone_schema_migration(name,checksum) VALUES('113_unknown.sql','unknown')");
  const before=await readFile(fixture.envFilePath,'utf8');
  const host=await launchDsh({nodeExecutable:process.execPath,projectDirectory:resolve('..'),envFilePath:fixture.envFilePath,infoPath:join(fixture.directory,'backend.info'),businessHome:fixture.directory,pythonExecutable:join(homedir(),'miniconda3/envs/NotAlone/bin/python'),environment:{}},()=>true);
  t.after(()=>host.terminate());
  assert.equal(await host.waitForExit(7000),true);
  await assert.rejects(readFile(join(fixture.directory,'backend.info'),'utf8'));
  assert.equal(await readFile(fixture.envFilePath,'utf8'),before);
  assert.equal((await fixture.client.query('SELECT count(*)::int AS n FROM notalone_schema_migration')).rows[0].n,113);
});

test('非法历史执行方配置失败关闭且不发布业务握手',async t=>{
  const fixture=await createStorageFixture();
  t.after(async()=>{for(const host of fixture.hosts??[])await host.terminate();await fixture.close();});
  const infoPath=join(fixture.directory,'backend.info');
  const host=await launchDsh({nodeExecutable:process.execPath,projectDirectory:resolve('..'),envFilePath:fixture.envFilePath,
    infoPath,businessHome:fixture.directory,pythonExecutable:process.env.NOTALONE_TEST_PYTHON||join(homedir(),'miniconda3/envs/NotAlone/bin/python'),
    environment:{NOTALONE_HISTORY_RUNTIME:'typo'}},()=>true);
  (fixture.hosts??=[]).push(host);
  assert.equal(await host.waitForExit(7000),true);
  await assert.rejects(readFile(infoPath,'utf8'));
});

test('旧业务执行器不存在时启动有界失败并允许修复后重试',async t=>{
  const fixture=await createStorageFixture();t.after(async()=>{for(const host of fixture.hosts??[])assert.equal(await host.terminate(),true);await fixture.close();});
  const host=await launchDsh({nodeExecutable:process.execPath,projectDirectory:resolve('..'),envFilePath:fixture.envFilePath,infoPath:join(fixture.directory,'backend.info'),businessHome:fixture.directory,pythonExecutable:join(fixture.directory,'missing-python'),environment:{}},()=>true);
  t.after(()=>host.terminate());
  assert.equal(await host.waitForExit(7000),true);
  const repaired=await start(t,fixture);
  assert.equal((await repaired.request('/api/runtime/status')).data.state,'running');
});

test('HTTP明确恢复唯一已有本人，多本人配置缺失不猜选',async t=>{
  const {randomUUID}=await import('node:crypto');
  const fixture=await createStorageFixture();t.after(async()=>{for(const host of fixture.hosts??[])assert.equal(await host.terminate(),true);await fixture.close();});
  const original=randomUUID();await fixture.client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)',[original,'已有合成本人']);
  const app=await start(t,fixture);
  assert.equal((await app.request('/api/setup/status')).data.recoverable_owner,true);
  assert.equal((await app.request('/api/setup/recover-owner',{})).status,400);
  const recovered=await app.request('/api/setup/recover-owner',{confirm_existing_owner:true});
  assert.deepEqual(recovered.data,{owner_id:original,created:false});
  await app.request('/api/runtime/shutdown',{});await app.host.waitForExit(7000);
  const restored=await start(t,fixture);
  assert.equal((await restored.request('/api/setup/status')).data.runtime_owner_configured,true);
  await restored.request('/api/runtime/shutdown',{});await restored.host.waitForExit(7000);
  const {writeFile}=await import('node:fs/promises');
  await writeFile(fixture.envFilePath,(await readFile(fixture.envFilePath,'utf8')).split('\n').filter(line=>!line.startsWith('NOTALONE_OWNER_ID=')).join('\n'));
  await fixture.client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)',[randomUUID(),'第二位本人']);
  const ambiguous=await start(t,fixture);
  assert.equal((await ambiguous.request('/api/setup/status')).data.recoverable_owner,false);
  assert.equal((await ambiguous.request('/api/setup/recover-owner',{confirm_existing_owner:true})).status,409);
});


test('官方宿主把原PG环境传给TS与旧业务，不能丢失原连接目标',async t=>{
  const fixture=await createStorageFixture();t.after(async()=>{for(const host of fixture.hosts??[])assert.equal(await host.terminate(),true);await fixture.close();});
  const original=(await fixture.client.query('SELECT current_database() AS name,current_user AS role')).rows[0];
  const port=(await fixture.client.query('SHOW port')).rows[0].port;
  await writeFile(fixture.envFilePath,`NOTALONE_DATABASE_URL=sslmode=disable\nNOTALONE_SKILLS_DIR=${fixture.directory}/skills\n`);
  const app=await start(t,fixture,{PGHOST:'/tmp',PGPORT:port,PGDATABASE:original.name,PGUSER:original.role});
  assert.equal((await app.request('/api/runtime/status')).data.ownership.contacts,'python');
  const owner=await app.request('/api/setup/initialize',{display_name:'原目标合成本人',create_only:true});
  assert.equal(owner.status,200);
  assert.deepEqual((await fixture.client.query('SELECT id FROM owner')).rows,[{id:owner.data.owner_id}]);
  const contactId='10000000-0000-4000-8000-000000000001';
  await fixture.client.query('INSERT INTO contact(owner_id,id,display_name) VALUES($1,$2,$3)',[owner.data.owner_id,contactId,'同库合成联系人']);
  await app.request('/api/runtime/shutdown',{});assert.equal(await app.host.waitForExit(7000),true);
  const reopened=await start(t,fixture,{PGHOST:'/tmp',PGPORT:port,PGDATABASE:original.name,PGUSER:original.role});
  const contacts=await reopened.request('/api/contacts');
  assert.equal(contacts.status,200);
  assert.deepEqual(contacts.data.contacts.map(item=>item.contact_id),[contactId],'旧业务公开读取必须返回原合成库联系人');
  await reopened.request('/api/runtime/shutdown',{});assert.equal(await reopened.host.waitForExit(7000),true);
});
