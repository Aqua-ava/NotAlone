import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchDsh } from '../src/launch.ts';

test('启动前取消不创建后台或握手', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'notalone-host-test-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  await assert.rejects(launchDsh({nodeExecutable:process.execPath, projectDirectory:new URL('../../', import.meta.url).pathname, envFilePath:join(dir,'config.env'), infoPath:join(dir,'backend.info'), businessHome:dir, environment:{}}, () => false));
  await assert.rejects(access(join(dir,'backend.info')));
});

test('官方profile配置缺失失败退出并清理宿主锁', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'notalone-host-test-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const host = await launchDsh({nodeExecutable:process.execPath, projectDirectory:new URL('../../', import.meta.url).pathname, envFilePath:join(dir,'missing.env'), infoPath:join(dir,'backend.info'), businessHome:dir, environment:{}}, () => true);
  t.after(() => host.terminate());
  assert.equal(await host.waitForExit(15000), true);
  await assert.rejects(access(join(dir,'backend.info')));
  await assert.rejects(access(join(dir,'backend.info.dsh-lock')));
});

test('读profile失败后同一配置路径可立即重试且无残留锁', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'notalone-host-test-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const config = {nodeExecutable:process.execPath,projectDirectory:dir,envFilePath:join(dir,'config.env'),infoPath:join(dir,'backend.info'),businessHome:dir,environment:{}};
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(launchDsh(config, () => true));
    await assert.rejects(access(`${config.infoPath}.dsh-lock`));
  }
});

async function syntheticLaunch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'notalone-host-test-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  await mkdir(join(dir, 'backend-ts/profile'), {recursive:true});
  await mkdir(join(dir, 'backend-ts/node_modules/@deepseek-ai/dsh/lib'), {recursive:true});
  await writeFile(join(dir, 'backend-ts/profile/host.patch.yml'), '# 合成进程仅验证宿主寿命管道\n');
  await writeFile(join(dir, 'backend-ts/node_modules/@deepseek-ai/dsh/lib/bin.js'), "process.stdin.resume(); process.stdin.once('end',()=>process.exit(0));");
  return {nodeExecutable:process.execPath, projectDirectory:dir, envFilePath:join(dir,'config.env'), infoPath:join(dir,'backend.info'), businessHome:dir,environment:{}};
}

test('重复或并发启动只保留一个合成后台，SIGKILL后释放临时目录及锁', async t => {
  const config = await syntheticLaunch(t);
  const results = await Promise.allSettled([launchDsh(config,()=>true),launchDsh(config,()=>true)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length, 1);
  const host = results.find(result=>result.status==='fulfilled').value;
  t.after(()=>host.terminate());
  await assert.rejects(launchDsh(config,()=>true), /backend_already_running/);
  const metadata = JSON.parse(await readFile(`${config.infoPath}.dsh-lock`, 'utf8'));
  assert.equal(metadata.childPid,host.pid);
  process.kill(host.pid,'SIGKILL');
  assert.equal(await host.waitForExit(15000),true);
  await assert.rejects(access(metadata.home));
  await assert.rejects(access(`${config.infoPath}.dsh-lock`));
  const retry = await launchDsh(config,()=>true);
  assert.equal(await retry.terminate(),true);
});

test('执行文件不存在失败后清锁，修正路径可启动', async t => {
  const config = await syntheticLaunch(t);
  await assert.rejects(launchDsh({...config,nodeExecutable:join(config.projectDirectory,'missing-node')},()=>true));
  await assert.rejects(access(`${config.infoPath}.dsh-lock`));
  const host = await launchDsh(config,()=>true);
  assert.equal(await host.terminate(),true);
});

test('明确死亡的锁并发回收不覆盖新宿主，未知锁保持不动', async t => {
  const config = await syntheticLaunch(t);
  const lockPath = `${config.infoPath}.dsh-lock`;
  await writeFile(lockPath, '{unknown');
  await assert.rejects(launchDsh(config,()=>true));
  assert.equal(await readFile(lockPath,'utf8'),'{unknown');
  await writeFile(lockPath, JSON.stringify({nonce:'synthetic-old',parentPid:2147483647}));
  const results = await Promise.allSettled([launchDsh(config,()=>true),launchDsh(config,()=>true)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const host = results.find(result=>result.status==='fulfilled').value;
  assert.equal(JSON.parse(await readFile(lockPath,'utf8')).childPid,host.pid);
  assert.equal(await host.terminate(),true);
});

async function waitUntil(check, timeout=15000) {
  const { setTimeout:delay } = await import('node:timers/promises');
  const end = Date.now()+timeout;
  while(Date.now()<end) { if(await check())return; await delay(100); }
  assert.fail('有界等待未完成');
}

test('真实官方profile在父宿主退出后结束并清理临时home', async () => {
  const { spawn } = await import('node:child_process');
  const { homedir } = await import('node:os');
  const { createStorageFixture } = await import('./host-storage-fixture.mjs');
  const fixture = await createStorageFixture();
  const config = {nodeExecutable:process.execPath,projectDirectory:new URL('../../',import.meta.url).pathname,envFilePath:fixture.envFilePath,
    infoPath:join(fixture.directory,'backend.info'),businessHome:fixture.directory,
    environment:{NOTALONE_MANAGED_USER_DATA:fixture.directory}};
  const script = `import {launchDsh} from ${JSON.stringify(new URL('../src/launch.ts',import.meta.url).href)}; const host=await launchDsh(JSON.parse(process.argv[1]),()=>true); process.send({pid:host.pid});`;
  const parent = spawn(process.execPath,['--input-type=module','-e',script,JSON.stringify(config)],{stdio:['ignore','ignore','ignore','ipc']});
  let pid;
  try {
    pid = await new Promise((resolve,reject)=>{parent.once('message',message=>resolve(message.pid));parent.once('exit',()=>reject(new Error('合成父宿主提前退出')));});
    await waitUntil(async()=>{try {await access(config.infoPath);return true;}catch{return false;}});
    const metadata = JSON.parse(await readFile(`${config.infoPath}.dsh-lock`,'utf8'));
    const exited = new Promise(resolve=>parent.once('exit',resolve));
    parent.kill('SIGKILL');await exited;
    await waitUntil(async()=>{try{await access(metadata.home);return false;}catch{return true;}},20000);
    await waitUntil(async()=>{try{process.kill(pid,0);return false;}catch{return true;}},15000);
    await assert.rejects(access(config.infoPath));
    // 同一范围可以重启；旧锁在串行回收期间不能覆盖新实例。
    const restarted=await launchDsh(config,()=>true);
    assert.equal(await restarted.terminate(),true);
  } finally {
    if(parent.exitCode===null && parent.signalCode===null)parent.kill('SIGKILL');
    if(pid){try{process.kill(pid,'SIGTERM');}catch{}}
    await fixture.close();
  }
});

test('真实DSH被SIGKILL后清理自有目录才允许监督重启', async () => {
  const { homedir } = await import('node:os');
  const { createStorageFixture } = await import('./host-storage-fixture.mjs');
  const fixture=await createStorageFixture();
  const config={nodeExecutable:process.execPath,projectDirectory:new URL('../../',import.meta.url).pathname,envFilePath:fixture.envFilePath,
    infoPath:join(fixture.directory,'backend.info'),businessHome:fixture.directory,
    environment:{NOTALONE_MANAGED_USER_DATA:fixture.directory}};
  let host;
  try {
    host=await launchDsh(config,()=>true);
    await waitUntil(async()=>{try{await access(config.infoPath);return true;}catch{return false;}});
    const metadata=JSON.parse(await readFile(`${config.infoPath}.dsh-lock`,'utf8'));
    await assert.rejects(access(join(metadata.home,'legacy.pid')));
    process.kill(host.pid,'SIGKILL');
    assert.equal(await host.waitForExit(20000),true);
    await assert.rejects(access(metadata.home));
    await assert.rejects(access(config.infoPath));
    host=await launchDsh(config,()=>true);
    await waitUntil(async()=>{try{await access(config.infoPath);return true;}catch{return false;}});
    assert.equal(await host.terminate(),true);
  } finally { if(host)await host.terminate();await fixture.close(); }
});

test('持有内核互斥期间宿主SIGKILL可恢复且不留下永久guard', async t => {
  const {spawn}=await import('node:child_process');
  const config=await syntheticLaunch(t);
  const script=`import {launchDsh} from ${JSON.stringify(new URL('../src/launch.ts',import.meta.url).href)};let calls=0;await launchDsh(JSON.parse(process.argv[1]),()=>{if(++calls===2){process.send({locked:true});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return true;});`;
  const parent=spawn(process.execPath,['--input-type=module','-e',script,JSON.stringify(config)],{stdio:['ignore','ignore','ignore','ipc']});
  t.after(()=>{if(parent.exitCode===null && parent.signalCode===null)parent.kill('SIGKILL');});
  await new Promise((resolve,reject)=>{parent.once('message',resolve);parent.once('exit',()=>reject(new Error('未取得互斥')));});
  const exited=new Promise(resolve=>parent.once('exit',resolve));parent.kill('SIGKILL');await exited;
  const host=await launchDsh(config,()=>true);
  assert.equal(await host.terminate(),true);
  await assert.rejects(access(`${config.infoPath}.dsh-lock.guard`));
});

test('已有存活的旧后台握手阻止新启动且不接管未知记录', async t => {
  const config=await syntheticLaunch(t);
  const info=`address=127.0.0.1:12345\ntoken=synthetic\npid=${process.pid}\n`;
  await writeFile(config.infoPath,info,{mode:0o600});
  await assert.rejects(launchDsh(config,()=>true),/backend_already_running/);
  assert.equal(await readFile(config.infoPath,'utf8'),info);
  await assert.rejects(access(`${config.infoPath}.dsh-lock`));
});

test('复用PID的不同启动身份不会收到旧后台清理信号', async t => {
  const {spawn}=await import('node:child_process');
  const config=await syntheticLaunch(t);
  const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  await new Promise((resolve,reject)=>{unrelated.once('spawn',resolve);unrelated.once('error',reject);});
  t.after(()=>unrelated.kill('SIGTERM'));
  const host=await launchDsh(config,()=>true);
  const metadata=JSON.parse(await readFile(`${config.infoPath}.dsh-lock`,'utf8'));
  await writeFile(join(metadata.home,'legacy.pid'),JSON.stringify({pid:unrelated.pid,parentPid:host.pid,nonce:metadata.nonce,
    identity:{pid:unrelated.pid,parentPid:host.pid,startedAt:'Fri Jan 1 00:00:00 1999',executable:process.execPath}}),{mode:0o600});
  process.kill(host.pid,'SIGKILL');
  assert.equal(await host.waitForExit(15000),true);
  assert.doesNotThrow(()=>process.kill(unrelated.pid,0));
  assert.equal(unrelated.signalCode,null);
  await assert.rejects(access(metadata.home));
});
