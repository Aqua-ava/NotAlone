import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm, chmod, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const project = await realpath(path.resolve('..'));
const preload = path.join(project, 'desktop/tests/fixtures/fixed-memory-development-network.cjs');
const dsh = path.join(project, 'backend-ts/node_modules/@deepseek-ai/dsh/lib/bin.js');
const guard = path.join(project, 'backend-ts/test/fixtures/sqlite-memory-profile-network-guard.mjs');

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-fixed-memory-')));
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-dsh-host-')));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });
  await mkdir(path.join(root, 'managed'), { mode: 0o700 });
  const plan = { formatVersion: 1, role: 'test', userData: root, databaseId: 'synthetic-database', projectDirectory: project,
    envFilePath: path.join(root, 'synthetic.env'), infoPath: path.join(root, 'managed/sqlite-backend.info'),
    providerUrl: 'http://127.0.0.1:45678', auditPath: path.join(root, 'synthetic-network.jsonl'),
    receiptPath: path.join(root, 'synthetic-desktop-receipts.jsonl') };
  const planPath = path.join(root, 'synthetic-desktop-plan.json');
  await writeFile(plan.envFilePath, 'NOTALONE_DEEPSEEK_API_KEY=synthetic-only\n', { mode: 0o600 });
  for (const file of [plan.auditPath, plan.receiptPath]) await writeFile(file, '', { mode: 0o600 });
  await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
  const stub = path.join(root, 'stub.cjs');
  const options = { cwd: home, env: { ELECTRON_RUN_AS_NODE: '1', HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
    NOTALONE_HOST_CONFIG: path.join(home, 'host.json'), NOTALONE_BACKEND_INFO: plan.infoPath, NOTALONE_ENV_FILE: plan.envFilePath,
    LANG: 'C', RETAIN_SETTING: 'synthetic-kept' }, stdio: ['pipe', 'ignore', 'ignore'] };
  await writeFile(stub, `const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
    const input = JSON.parse(process.env.FIXED_MEMORY_TEST_SCENARIO);
    const hostFile = path.join(input.home, 'host.json');
    const host = {nodeExecutable: process.execPath, projectDirectory: input.plan.projectDirectory,
      envFilePath: input.plan.envFilePath, infoPath: input.plan.infoPath, businessHome: input.plan.userData,
      sqlite: {userData: input.plan.userData, expectedDatabaseId: input.plan.databaseId, role: 'test', capabilities: ['contacts','history','memory']},
      home: input.home, parentPid: process.pid, lockNonce: 'synthetic-nonce', ...input.host};
    fs.writeFileSync(hostFile, JSON.stringify(host), {mode: 0o600});
    globalThis.request = {file: process.execPath, args: [${JSON.stringify(dsh)}, '--profile', 'notalone'], options: input.options, ...input.request};
    globalThis.repeat = input.repeat || 1;
    globalThis.forwarded = []; globalThis.fakeChild = {pid: 12345};
    cp.spawn = (...args) => { globalThis.forwarded.push(args); return globalThis.fakeChild; };
  `, { mode: 0o600 });
  const run = (scenario = {}) => spawnSync(process.execPath, ['--require', stub, '--require', preload, '--input-type=module', '--eval', `
    import {spawn} from 'node:child_process';
    const before = JSON.stringify(globalThis.request); let error, returned;
    try { const {file,args,options}=globalThis.request; for(let i=0;i<globalThis.repeat;i++)returned=spawn(file,args,options); }
    catch (failure) { error=failure.message; }
    console.log(JSON.stringify({error,forwarded:globalThis.forwarded,sameChild:returned===globalThis.fakeChild,
      unchanged:before===JSON.stringify(globalThis.request)}));
  `], { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
    NOTALONE_FIXED_MEMORY_DEVELOPMENT_PLAN: planPath, FIXED_MEMORY_TEST_SCENARIO: JSON.stringify({ home, plan, options, ...scenario }),
    PARENT_SECRET_SENTINEL: 'synthetic-parent-only', NODE_OPTIONS: '' } });
  return { root, home, plan, planPath, options, run };
}

test('纯 Node 预加载器仅给正式 DSH 子进程加入网络守卫，保留净化环境与寿命管道', async t => {
  const f = await fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.error, undefined);
  assert.equal(observed.sameChild, true);
  assert.equal(observed.unchanged, true);
  const [executable, args, options] = observed.forwarded[0];
  assert.equal(executable, process.execPath);
  assert.deepEqual(args, ['--import', guard, dsh, '--profile', 'notalone']);
  assert.deepEqual(options.stdio, ['pipe', 'ignore', 'ignore']);
  assert.equal(options.cwd, f.home);
  assert.equal(options.env.RETAIN_SETTING, 'synthetic-kept');
  assert.equal(options.env.NOTALONE_SYNTHETIC_PROVIDER_URL, f.plan.providerUrl);
  assert.equal(options.env.NOTALONE_SYNTHETIC_NETWORK_AUDIT, f.plan.auditPath);
  assert.equal(options.env.PARENT_SECRET_SENTINEL, undefined);
  assert.equal(options.env.NODE_OPTIONS, undefined);
  const receipts = (await readFile(f.plan.receiptPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(receipts.map(receipt => receipt.kind), ['preload', 'spawn']);
  assert.ok(receipts.every(receipt => Object.keys(receipt).every(key => ['kind', 'parentPid', 'guardApplied'].includes(key))));
});

test('正式 DSH 的启动参数或宿主身份不符时拒绝，不转发第二次目标启动', async t => {
  const f = await fixture(t);
  const scenarios = [
    { request: { file: '/synthetic-other-node' } },
    { request: { args: [dsh, '--profile', 'other'] } },
    { request: { options: { ...f.options, cwd: f.root } } },
    { request: { options: { ...f.options, stdio: ['ignore', 'ignore', 'ignore'] } } },
    { request: { options: { ...f.options, env: { ...f.options.env, ELECTRON_RUN_AS_NODE: '0' } } } },
    { request: { options: { ...f.options, env: { ...f.options.env, NODE_OPTIONS: '--require=other' } } } },
    { request: { options: { ...f.options, env: { ...f.options.env, NOTALONE_ENV_FILE: '/synthetic-other.env' } } } },
    { host: { parentPid: -1 } }, { host: { projectDirectory: f.root } },
    { host: { envFilePath: path.join(f.root, 'other.env') } }, { host: { infoPath: path.join(f.root, 'other.info') } },
    { host: { sqlite: { userData: f.root, expectedDatabaseId: 'other-database', role: 'test', capabilities: ['contacts', 'history', 'memory'] } } },
    { host: { sqlite: { userData: f.root, expectedDatabaseId: f.plan.databaseId, role: 'business', capabilities: ['contacts', 'history', 'memory'] } } },
  ];
  for (const scenario of scenarios) {
    const result = f.run(scenario);
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.error, 'fixed_memory_development_launch_invalid', JSON.stringify(scenario));
    assert.deepEqual(observed.forwarded, []);
  }
  const repeated = JSON.parse(f.run({ repeat: 2 }).stdout);
  assert.equal(repeated.error, 'fixed_memory_development_launch_invalid');
  assert.equal(repeated.forwarded.length, 1);
});

test('非法计划、供应商地址或不私有文件在安装预加载器时拒绝', async t => {
  const f = await fixture(t);
  const changes = [
    { role: 'business' }, { formatVersion: 2 }, { databaseId: '' }, { userData: f.home },
    { projectDirectory: f.root }, { providerUrl: 'https://api.deepseek.com/' },
    { providerUrl: 'http://127.0.0.1:45678/other' }, { envFilePath: '/synthetic-other.env' },
    { infoPath: path.join(f.root, 'other.info') }, { auditPath: path.join(f.root, 'other.jsonl') },
    { receiptPath: path.join(f.root, 'other-receipts.jsonl') }, { model: 'synthetic-override' },
  ];
  for (const change of changes) {
    await writeFile(f.planPath, JSON.stringify({ ...f.plan, ...change }));
    const result = f.run();
    assert.equal(result.status, 1, JSON.stringify(change));
    assert.match(result.stderr, /fixed_memory_development_plan_invalid/);
  }
  await writeFile(f.planPath, JSON.stringify(f.plan));
  await chmod(f.planPath, 0o644);
  assert.match(f.run().stderr, /fixed_memory_development_plan_invalid/);
  await chmod(f.planPath, 0o600);
  await chmod(f.root, 0o755);
  assert.match(f.run().stderr, /fixed_memory_development_plan_invalid/);
  await chmod(f.root, 0o700);
  await writeFile(f.plan.envFilePath, 'NOTALONE_DEEPSEEK_API_KEY=synthetic-only\nNOTALONE_REPLY_MODEL=override\n');
  assert.match(f.run().stderr, /fixed_memory_development_plan_invalid/);
  await writeFile(f.plan.envFilePath, 'NOTALONE_DEEPSEEK_API_KEY=synthetic-only\n');
  await rename(f.planPath, path.join(f.root, 'owned-plan.json'));
  await symlink('owned-plan.json', f.planPath);
  assert.match(f.run().stderr, /fixed_memory_development_plan_invalid/);
});

test('普通子进程原样透传，不继承守卫和供应商环境', async t => {
  const f = await fixture(t);
  const request = { file: '/synthetic-other-node', args: ['--experimental-strip-types', '-e', 'synthetic'],
    options: { cwd: f.root, env: { ONLY: 'ordinary' }, stdio: 'pipe' } };
  const result = f.run({ request });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.error, undefined);
  assert.equal(observed.unchanged, true);
  assert.deepEqual(observed.forwarded, [[request.file, request.args, request.options]]);
  assert.deepEqual((await readFile(f.plan.receiptPath, 'utf8')).trim().split('\n').map(JSON.parse).map(value => value.kind), ['preload']);
});
