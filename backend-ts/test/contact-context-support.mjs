import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { launchDsh } from '../src/launch.ts';
import { createStorageFixture } from './host-storage-fixture.mjs';

export async function start(t, fixture, environment = {}, projectDirectory = resolve('..')) {
  const infoPath = join(fixture.directory, 'backend.info');
  // 正常入口只支持受控 SQLite；旧 PG 宿主用例仍按原基线，不在本 helper 中恢复旧启动路径。
  const {SqliteStorage} = await import('../src/storage/sqlite/client.ts');
  const storage = await SqliteStorage.open({userData:fixture.directory,intent:'create',role:'test'});
  const databaseId = storage.status.databaseId; await storage.close();
  const host = await launchDsh({nodeExecutable:process.execPath,projectDirectory,envFilePath:fixture.envFilePath,infoPath,businessHome:fixture.directory,environment:{NOTALONE_MANAGED_USER_DATA:fixture.directory,...environment},sqlite:{userData:fixture.directory,expectedDatabaseId:databaseId,role:'test',capabilities:['contacts']}},()=>true);
  (fixture.hosts ??= []).push(host);
  let connection;
  for (let i=0;i<150 && host.isRunning();i++) {
    try { const data=await readFile(infoPath,'utf8');connection=Object.fromEntries(data.trim().split('\n').map(line=>line.split('='))); break; } catch {}
    await delay(100);
  }
  assert.ok(connection,'真实DSH后台必须发布认证握手');
  return {host,connection, async request(path,body,token=connection.token) {const response=await fetch(`http://${connection.address}${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body&&JSON.stringify(body)});return {status:response.status,data:await response.json()};}};
}

