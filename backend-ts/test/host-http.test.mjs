import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
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

test('已配置owner与凭据原地恢复，重启不重放迁移',async t=>{
  const fixture=await createStorageFixture();t.after(async()=>{for(const host of fixture.hosts??[])assert.equal(await host.terminate(),true);await fixture.close();});
  const first=await start(t,fixture);
  const owner=(await first.request('/api/setup/initialize',{display_name:'保留本人',create_only:true})).data.owner_id;
  assert.equal((await first.request('/api/setup/credentials',{provider:'deepseek',api_key:'synthetic-key'})).status,200);
  const before=(await fixture.client.query('SELECT name,checksum FROM notalone_schema_migration ORDER BY name')).rows;
  await first.request('/api/runtime/shutdown',{});await first.host.waitForExit(7000);
  const second=await start(t,fixture);
  const status=await second.request('/api/setup/status');
  assert.equal(status.data.runtime_owner_configured,true);
  assert.equal(status.data.credentials_configured,true);
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
  await fixture.client.query("INSERT INTO notalone_schema_migration(name,checksum) VALUES('111_unknown.sql','unknown')");
  const before=await readFile(fixture.envFilePath,'utf8');
  const host=await launchDsh({nodeExecutable:process.execPath,projectDirectory:resolve('..'),envFilePath:fixture.envFilePath,infoPath:join(fixture.directory,'backend.info'),businessHome:fixture.directory,pythonExecutable:join(homedir(),'miniconda3/envs/NotAlone/bin/python'),environment:{}},()=>true);
  t.after(()=>host.terminate());
  assert.equal(await host.waitForExit(7000),true);
  await assert.rejects(readFile(join(fixture.directory,'backend.info'),'utf8'));
  assert.equal(await readFile(fixture.envFilePath,'utf8'),before);
  assert.equal((await fixture.client.query('SELECT count(*)::int AS n FROM notalone_schema_migration')).rows[0].n,111);
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
