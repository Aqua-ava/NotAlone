import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const root = await mkdtemp(path.join(tmpdir(), 'notalone-sqlite-development-'));
after(() => rm(root, { recursive: true, force: true }));
const built = await build({ entryPoints: ['src/main/startup/sqlite-development.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
await writeFile(path.join(root, 'subject.mjs'), built.outputFiles[0].text);
const { SqliteDevelopmentProbe } = await import(path.join(root, 'subject.mjs'));

// 此测试替身仅覆盖桌面与存储子进程之间的合同；真实存储由底座测试验证。
async function fixture(name) {
  const userData = path.join(root, name), project = path.join(userData, 'project');
  await mkdir(path.join(project, 'backend-ts/src/storage/sqlite'), { recursive: true });
  await writeFile(path.join(project, 'backend-ts/src/storage/sqlite/client.ts'), `
    import { readFile, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export class SqliteStorage {
      static async open(options) {
        const target = path.join(options.userData, 'synthetic-instance');
        if(options.intent === 'create') await writeFile(target, 'synthetic-id', { flag:'wx' });
        const databaseId = await readFile(target,'utf8');
        if(options.intent === 'open' && options.expectedDatabaseId !== databaseId) throw Object.assign(new Error('SENSITIVE_ERROR'), { code:'instance_mismatch' });
        return { status:{ databaseId, runtimeId:'private-runtime', epoch:1n, schemaVersion:1, sqliteVersion:'3.53.4',role:'test'}, close:async()=>{} };
      }
    }
  `);
  return { userData, project, config: path.join(userData, 'sqlite-development.json') };
}

test('显式创建成功后保存实例预期，普通重开沿用同一测试库且不暴露身份', async () => {
  const f = await fixture('create');
  const probe = new SqliteDevelopmentProbe(f.userData, f.project);
  assert.equal(await probe.run(() => true), undefined);
  await writeFile(f.config, JSON.stringify({ formatVersion:1, intent:'create',role:'test' }), {mode:0o600});
  const created = await probe.run(() => true);
  assert.deepEqual(created, { phase:'ready',code:'sqlite_ready',schemaVersion:1,sqliteVersion:'3.53.4' });
  assert.deepEqual(JSON.parse(await readFile(f.config,'utf8')), { formatVersion:1,intent:'open',role:'test',expectedDatabaseId:'synthetic-id' });
  assert.deepEqual(await probe.run(() => true), created);
});

test('实例不符时保留库和open配置，固定故障不泄露异常原文', async () => {
  const f = await fixture('mismatch');
  await writeFile(path.join(f.userData, 'synthetic-instance'), 'other-id');
  const config = JSON.stringify({formatVersion:1,intent:'open',role:'test',expectedDatabaseId:'expected-id'});
  await writeFile(f.config, config, {mode:0o600});
  const failed = await new SqliteDevelopmentProbe(f.userData,f.project).run(() => true);
  assert.deepEqual(failed, {phase:'blocked',code:'instance_mismatch'});
  assert.equal(await readFile(f.config,'utf8'), config);
  assert.equal(await readFile(path.join(f.userData,'synthetic-instance'),'utf8'),'other-id');
  assert.equal(JSON.stringify(failed).includes('SENSITIVE'), false);
});

test('开发控制拒绝业务库、重置和宽权限配置，不创建库', async () => {
  const f = await fixture('unsafe');
  for (const config of [
    {formatVersion:1,intent:'create',role:'business'},
    {formatVersion:1,intent:'reset',role:'test'},
    {formatVersion:1,intent:'open',role:'test'},
    {formatVersion:1,intent:'create',role:'test',userData:'/untrusted'},
  ]) {
    await writeFile(f.config,JSON.stringify(config),{mode:0o600});
    assert.deepEqual(await new SqliteDevelopmentProbe(f.userData,f.project).run(()=>true),{phase:'blocked',code:'sqlite_configuration_invalid'});
  }
  const { chmod, symlink } = await import('node:fs/promises');
  await writeFile(f.config,JSON.stringify({formatVersion:1,intent:'create',role:'test'}));
  await chmod(f.config,0o644);
  assert.equal((await new SqliteDevelopmentProbe(f.userData,f.project).run(()=>true)).code,'sqlite_configuration_invalid');
  await rm(f.config);
  await symlink(path.join(f.userData,'synthetic-instance'),f.config);
  assert.equal((await new SqliteDevelopmentProbe(f.userData,f.project).run(()=>true)).code,'sqlite_configuration_invalid');
  await assert.rejects(readFile(path.join(f.userData,'synthetic-instance')),{code:'ENOENT'});
});

const diagnosticsBuilt = await build({ entryPoints: ['src/main/startup/diagnostics.ts'], bundle: true, platform:'node',format:'esm',write:false });
await writeFile(path.join(root,'diagnostics.mjs'),diagnosticsBuilt.outputFiles[0].text);
const { StartupDiagnostics } = await import(path.join(root,'diagnostics.mjs'));

test('正常诊断门禁显式开发模式展示底座就绪并封锁业务，普通模式忽略开发文件', async () => {
  const f = await fixture('normal-gate');
  await writeFile(f.config,JSON.stringify({formatVersion:1,intent:'create',role:'test'}),{mode:0o600});
  const config = { source:'external',infoPath:path.join(f.userData,'backend.info') };
  const ordinary = new StartupDiagnostics(f.userData);
  await assert.rejects(ordinary.ensureReady(config,()=>true));
  assert.equal(ordinary.getState().sqlite,undefined);
  await assert.rejects(readFile(path.join(f.userData,'synthetic-instance')),{code:'ENOENT'});
  const development = new StartupDiagnostics(f.userData,undefined,f.project);
  await assert.rejects(development.ensureReady(config,()=>true));
  const state = development.getState();
  assert.equal(state.phase,'blocked');
  assert.equal(state.code,'sqlite_business_unavailable');
  assert.equal(state.sqlite.phase,'ready');
  assert.equal(JSON.stringify(state).includes('synthetic-id'),false);
  state.sqlite.phase='blocked';
  assert.equal(development.getState().sqlite.phase,'ready');
  await assert.rejects(readFile(config.infoPath),{code:'ENOENT'});
});

test('桌面存储探针通过真实Worker创建和重开隔离库', async () => {
  const { realpath } = await import('node:fs/promises');
  const userData = await realpath(await mkdtemp(path.join(root,'real-worker-')));
  const config = path.join(userData,'sqlite-development.json');
  await writeFile(config,JSON.stringify({formatVersion:1,intent:'create',role:'test'}),{mode:0o600});
  const probe = new SqliteDevelopmentProbe(userData,path.resolve('..'));
  const created = await probe.run(()=>true);
  assert.equal(created.phase,'ready');
  assert.equal(created.schemaVersion >= 1,true);
  const saved = await readFile(config,'utf8');
  assert.equal(JSON.parse(saved).intent,'open');
  assert.deepEqual(await probe.run(()=>true),created);
  assert.equal(await readFile(config,'utf8'),saved);
});
