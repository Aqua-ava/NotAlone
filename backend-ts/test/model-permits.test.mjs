import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { connect } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelPermitArbiter } from '../src/model-permits.ts';
import { startModelPermitServer } from '../src/model-permit-server.ts';

const turn = () => new Promise(resolve => setImmediate(resolve));
async function ready(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), '合成进程应在有界期限内登记许可');
}
async function fixture(t, limit = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'na-permit-'));
  const arbiter = new ModelPermitArbiter(limit);
  const options = {path: join(directory, 'p.sock'), token: 'synthetic-token-'.repeat(4), arbiter};
  const server = await startModelPermitServer(options);
  t.after(async () => { await server.shutdown(); await rm(directory, {recursive:true,force:true}); });
  return {arbiter, options, server};
}
function python(t, options) {
  const child = spawn(join(homedir(), 'miniconda3/envs/NotAlone/bin/python'), ['test/model-permit-python-fixture.py'], {
    env: {...process.env, PYTHONPATH: resolve('../backend/src')}, stdio:['pipe','pipe','pipe'],
  });
  const lines = createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  child.stdin.write(JSON.stringify(options)+'\n');
  return {child, next: async () => (await lines.next()).value, exited};
}

test('前台登记阻止新后台且整轮跨工具阶段独占', async () => {
  const arbiter = new ModelPermitArbiter(2);
  const b1 = await arbiter.acquire('background');
  let foreground;
  const f = arbiter.acquire('foreground').then(p => foreground = p);
  let b2;
  const b = arbiter.acquire('background').then(p => b2 = p);
  await turn();
  assert.equal(foreground, undefined);
  assert.equal(b2, undefined);
  b1.settle(); await f;
  await turn(); assert.equal(b2, undefined);
  // 第一轮及工具阶段已经结束，但前台整轮尚未结算。
  await turn(); assert.equal(b2, undefined);
  foreground.settle(); await b; b2.settle();
  assert.equal(arbiter.snapshot().backgroundActive, 0);
});

test('排队取消不占容量；在途取消不释放；pause排空可逆；settle幂等', async () => {
  const arbiter = new ModelPermitArbiter();
  const controller = new AbortController();
  const first = await arbiter.acquire('background', controller.signal);
  controller.abort();
  const queued = new AbortController();
  const pending = arbiter.acquire('foreground', queued.signal);
  queued.abort(); await assert.rejects(pending, /stopped/);
  assert.equal(arbiter.snapshot().backgroundActive, 1);
  let drained = false;
  const drain = arbiter.pauseAndDrain().then(() => drained = true);
  await turn(); assert.equal(drained, false);
  first.settle(); first.settle(); await drain;
  let started = false;
  const next = arbiter.acquire('background').then(p => {started = true; return p;});
  await turn(); assert.equal(started, false);
  arbiter.resume(); (await next).settle();
});

test('Python实际进程在途阻挡TS前台，TS整轮结束才放行第二个Python', {timeout:20000}, async t => {
  const {arbiter, options} = await fixture(t, 2);
  const first = python(t, options);
  assert.equal(await first.next(), 'granted');
  let foreground;
  const f = arbiter.acquire('foreground').then(p => foreground = p);
  const second = python(t, options);
  const secondGranted = second.next();
  await ready(() => arbiter.snapshot().backgroundWaiting === 1);
  first.child.stdin.write('cancel\n');
  assert.equal(await first.next(), 'cancelled_but_in_flight');
  assert.equal(foreground, undefined);
  assert.equal(arbiter.snapshot().backgroundActive, 1);
  first.child.stdin.write('settle\n');
  await first.exited; await f;
  assert.equal(arbiter.snapshot().foregroundActive, true);
  assert.equal(arbiter.snapshot().backgroundActive, 0);
  foreground.settle();
  assert.equal(await secondGranted, 'granted');
  second.child.stdin.write('settle\n');
  assert.equal(await second.next(), 'settled'); await second.exited;
});

test('Python崩溃保留孤儿许可并拒绝关闭当作排空', {timeout:20000}, async t => {
  const {arbiter, options, server} = await fixture(t);
  const first = python(t, options);
  assert.equal(await first.next(), 'granted');
  first.child.kill('SIGKILL'); await first.exited;
  // 子进程 exit 后让 socket close 回调完成。
  await ready(() => arbiter.snapshot().orphaned === 1);
  assert.equal(arbiter.snapshot().orphaned, 1);
  assert.equal(arbiter.snapshot().backgroundActive, 1);
  await assert.rejects(server.close(), /not_drained/);
  const cancel = new AbortController();
  const pending = arbiter.acquire('foreground', cancel.signal);
  await turn(); assert.equal(arbiter.snapshot().foregroundWaiting, 1);
  cancel.abort(); await assert.rejects(pending);
});

test('两个Python共用总并发上限且错误认证不能领取许可', {timeout:20000}, async t => {
  const {arbiter, options} = await fixture(t);
  const first = python(t, options);
  assert.equal(await first.next(), 'granted');
  const second = python(t, options);
  const secondGranted = second.next();
  await ready(() => arbiter.snapshot().backgroundWaiting === 1);
  const wrong = connect(options.path);
  await once(wrong, 'connect');
  const closed = once(wrong, 'close');
  wrong.write(JSON.stringify({op:'acquire',kind:'foreground',token:'wrong'})+'\n');
  await closed;
  assert.equal(arbiter.snapshot().backgroundActive, 1);
  assert.equal(arbiter.snapshot().foregroundWaiting, 0);
  first.child.stdin.write('settle\n'); await first.exited;
  assert.equal(await secondGranted, 'granted');
  assert.equal(arbiter.snapshot().backgroundActive, 1);
  second.child.stdin.write('settle\n'); await second.exited;
});

test('空闲关闭允许新世代，保留结算状态不阻断恢复', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'na-permit-generation-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const options = {path:join(directory,'p.sock'), token:'synthetic-generation-token'.repeat(2), arbiter:new ModelPermitArbiter()};
  const first = await startModelPermitServer(options);
  await first.close();
  const next = await startModelPermitServer({...options,arbiter:new ModelPermitArbiter()});
  await next.shutdown();
  const recovered = await startModelPermitServer({...options,arbiter:new ModelPermitArbiter()});
  assert.deepEqual(recovered.unknownSettlements(), []);
  await recovered.close();
});

test('孤儿许可阻止剩余后台容量，只有实际执行者结算才能恢复', async () => {
  const arbiter = new ModelPermitArbiter(2);
  const active = await arbiter.acquire('background');
  active.orphan();
  let started = false;
  const next = arbiter.acquire('background').then(p => { started = true; return p; });
  await turn(); assert.equal(started, false);
  active.settle(); (await next).settle();
  arbiter.stop();
  await assert.rejects(arbiter.acquire('foreground'), /stopped/);
  assert.throws(() => arbiter.resume(), /stopped/);
});

function broker(t, options) {
  const child = spawn(process.execPath, ['test/model-permit-host-fixture.mjs'], {stdio:['pipe','pipe','pipe']});
  const lines = createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const exited = once(child,'exit');
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  child.stdin.write(JSON.stringify(options)+'\n');
  return {child, exited, next: async () => (await lines.next()).value};
}
async function recoveryOptions(t) {
  const directory = await mkdtemp(join(tmpdir(),'na-permit-recovery-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  return {path:join(directory,'p.sock'),token:'synthetic-recovery-token'.repeat(2)};
}

test('零物理调用宿主SIGKILL可恢复，两个新宿主仅一个取得许可世代', {timeout:10000}, async t => {
  const options = await recoveryOptions(t);
  const original = broker(t,options);
  assert.equal(await original.next(),'ready');
  original.child.kill('SIGKILL'); await original.exited;
  const attempts = await Promise.allSettled([1,2].map(() => startModelPermitServer({...options,arbiter:new ModelPermitArbiter()})));
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
  const server = attempts.find(x=>x.status==='fulfilled').value;
  assert.deepEqual(server.unknownSettlements(),[]);
  await server.close();
});

test('宿主SIGKILL后保留未知结算且不重放，原本地执行者消失可新请求', {timeout:10000}, async t => {
  const options = await recoveryOptions(t);
  const original = broker(t,{...options,active:true});
  assert.equal(await original.next(),'ready');
  original.child.kill('SIGKILL'); await original.exited;
  const arbiter = new ModelPermitArbiter();
  const recovered = await startModelPermitServer({...options,arbiter});
  assert.equal(recovered.unknownSettlements().length,1);
  assert.equal(recovered.unknownSettlements()[0].settlement,'unknown');
  const lease = await arbiter.acquire('foreground'); lease.settle();
  await recovered.close();
  const again = await startModelPermitServer({...options,arbiter:new ModelPermitArbiter()});
  assert.equal(again.unknownSettlements().length,1);
  await again.close();
});

test('宿主崩溃后活跃Python仍存在不接管，确认退出后记录未知并恢复', {timeout:10000}, async t => {
  const options = await recoveryOptions(t);
  const original = broker(t,options);
  assert.equal(await original.next(),'ready');
  const worker = python(t,options);
  assert.equal(await worker.next(),'granted');
  original.child.kill('SIGKILL'); await original.exited;
  await assert.rejects(startModelPermitServer({...options,arbiter:new ModelPermitArbiter()}),/worker_alive_or_unknown/);
  worker.child.kill('SIGKILL'); await worker.exited;
  const recovered = await startModelPermitServer({...options,arbiter:new ModelPermitArbiter()});
  assert.equal(recovered.unknownSettlements().length,1);
  await recovered.close();
});

test('listen失败不污染活跃状态并释放内核互斥', {timeout:10000}, async t => {
  const options = await recoveryOptions(t);
  const {mkdir,rmdir} = await import('node:fs/promises');
  await mkdir(options.path);
  await assert.rejects(startModelPermitServer({...options,arbiter:new ModelPermitArbiter()}));
  await rmdir(options.path);
  const recovered = await startModelPermitServer({...options,arbiter:new ModelPermitArbiter()});
  assert.deepEqual(recovered.unknownSettlements(),[]);
  await recovered.close();
});

test('启动失败留下的状态不会覆盖仍存活的未知socket监听者', {timeout:10000}, async t => {
  const options = await recoveryOptions(t);
  const {createServer} = await import('node:net');
  const foreign = createServer(socket=>socket.destroy());
  await new Promise(resolve=>foreign.listen(options.path,resolve));
  t.after(()=>new Promise(resolve=>foreign.close(resolve)));
  await assert.rejects(startModelPermitServer({...options,arbiter:new ModelPermitArbiter()}));
  await assert.rejects(startModelPermitServer({...options,arbiter:new ModelPermitArbiter()}),/socket_path_occupied/);
  const socket = connect(options.path);
  await once(socket,'connect'); socket.destroy();
});

test('Python收到permit/attempt身份且崩溃恢复保留同一关联，不把未知映射成完成', {timeout:10000},async t=>{
 const options=await recoveryOptions(t),original=broker(t,options);
 assert.equal(await original.next(),'ready');
 const worker=python(t,{...options,includeIdentity:true});
 assert.equal(await worker.next(),'granted');
 const identity=JSON.parse(await worker.next());
 assert.match(identity.permit_id,/^[0-9a-f-]{36}$/);assert.match(identity.attempt_id,/^[0-9a-f-]{36}$/);
 original.child.kill('SIGKILL');await original.exited;worker.child.kill('SIGKILL');await worker.exited;
 const recovered=await startModelPermitServer({...options,arbiter:new ModelPermitArbiter()});
 const unknown=recovered.unknownSettlements();assert.equal(unknown.length,1);
 assert.equal(unknown[0].id,identity.permit_id);assert.equal(unknown[0].attempt_id,identity.attempt_id);assert.equal(unknown[0].settlement,'unknown');
 await recovered.close();
});
