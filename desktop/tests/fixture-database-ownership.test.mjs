import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { build } from 'esbuild';

// 只运行有限子进程；不启动 App、浏览器、探针、租约或外部模型。
test('合成准备未交付可核验归属时保留本轮目录', async () => {
  const evidence = await mkdtemp(path.join(tmpdir(), 'notalone-ownership-check-'));
  let directory, archive;
  try {
    const script = path.join(evidence, 'fail-before-create.py');
    const location = path.join(evidence, 'location.txt');
    await writeFile(script, `import os, pathlib, sys\npathlib.Path(sys.argv[2]).write_text(str(pathlib.Path(os.environ['NOTALONE_ENV_FILE']).parent))\nraise SystemExit(7)\n`);
    const bundle = await build({ stdin: { contents: "export { withSyntheticBackendFixture } from './tests/synthetic-backend-fixture';",
      resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
    const module = path.join(evidence, 'fixture.cjs');
    await writeFile(module, bundle.outputFiles[0].text);
    const { withSyntheticBackendFixture } = (await import(module)).default;
    await assert.rejects(withSyntheticBackendFixture({
      directoryPrefix: 'notalone-ownership-before-create-', databaseScript: script,
      createArguments: [location], prepareTimeoutMs: 5_000, reuseBackend: false,
      createFixture() { throw new Error('准备失败不得进入后端。'); },
    }, async () => { throw new Error('准备失败不得执行场景。'); }), (error) => {
      archive = error.message.match(/原始证据：([^\n]+)$/u)?.[1];
      return /保留.*归属/u.test(error.message);
    });
    directory = await readFile(location, 'utf8');
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal(JSON.parse(await readFile(path.join(directory, 'cleanup-unconfirmed.json'), 'utf8')).prepareStopped, true);
  } finally {
    // 本测试脚本明确在任何数据库调用前退出，已观测子进程结束，仅清理这一个目录。
    if (!directory) directory = await readFile(path.join(evidence, 'location.txt'), 'utf8').catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true });
    if (archive) await rm(archive, { recursive: true, force: true });
    await rm(evidence, { recursive: true });
  }
});

test('离线 created 标记与清理双失败保留原输出和 planned 精确归属', async () => {
  const evidence = await mkdtemp(path.join(tmpdir(), 'notalone-ownership-double-offline-'));
  let directory, archive;
  try {
    const script = path.join(evidence, 'fail-created-and-cleanup.py');
    const location = path.join(evidence, 'location.json');
    const unexpectedDrop = path.join(evidence, 'outer-drop-attempt.txt');
    await writeFile(script, `import json, pathlib, re, runpy, sys, types
if sys.argv[1] != 'create':
 pathlib.Path(${JSON.stringify(unexpectedDrop)}).write_text('unexpected outer DROP')
 raise AssertionError('planned 身份不得授权外层 DROP')
class SQL:
 def __init__(self, value): self.value = value
 def format(self, value): return self.value.format('"' + value + '"')
class Connection:
 def __enter__(self): return self
 def __exit__(self, *_): return False
 def execute(self, query):
  assert query.startswith('CREATE DATABASE')
  name = re.search(r'DATABASE "([a-z0-9_]+)"', query)[1]
  pathlib.Path(sys.argv[2]).write_text(json.dumps({'directory': str(pathlib.Path(sys.argv[3]).parent), 'database_name': name}))
  print('offline CREATE stdout: ' + name, flush=True)
connections = 0
def connect(*args, **kwargs):
 global connections
 connections += 1
 if connections > 1: raise RuntimeError('合成 DROP 管理连接失败')
 return Connection()
sys.modules['psycopg'] = types.SimpleNamespace(connect=connect, sql=types.SimpleNamespace(SQL=SQL, Identifier=lambda value: value))
fixture = runpy.run_path(${JSON.stringify(path.resolve('tests/fixtures/contact-database.py'))})
dump = json.dump
def fail_created_dump(value, stream, **kwargs):
 if value.get('phase') == 'created': raise OSError('合成 created marker 写入失败')
 return dump(value, stream, **kwargs)
json.dump = fail_created_dump
fixture['create_database']('empty', sys.argv[3])
`);
    const bundle = await build({ stdin: { contents: `
      export { withSyntheticBackendFixture } from './tests/synthetic-backend-fixture';
      export { readDatabaseOwnership } from './tests/database-ownership';
    `, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
    const module = path.join(evidence, 'double-failure.cjs');
    await writeFile(module, bundle.outputFiles[0].text);
    const ports = (await import(module)).default;
    let failure;
    try {
      await ports.withSyntheticBackendFixture({
        directoryPrefix: 'notalone-ownership-double-failure-', databaseScript: script,
        createArguments: [location], prepareTimeoutMs: 5_000, reuseBackend: false,
        createFixture() { throw new Error('失败准备不得进入后端。'); },
      }, async () => { throw new Error('失败准备不得执行场景。'); });
    } catch (error) { failure = error; }
    archive = failure?.message.match(/原始证据：([^\n]+)$/u)?.[1];
    const created = JSON.parse(await readFile(location, 'utf8'));
    directory = created.directory;
    const marker = JSON.parse(await readFile(path.join(directory, 'database-ownership.json'), 'utf8'));
    assert.equal(marker.phase, 'planned');
    assert.equal(marker.database_name, created.database_name);
    await assert.rejects(ports.readDatabaseOwnership(directory, 'contact'), /身份不匹配/);
    const retained = JSON.parse(await readFile(path.join(directory, 'cleanup-unconfirmed.json'), 'utf8'));
    assert.equal(retained.databaseName, created.database_name);
    assert.equal(retained.ownershipPhase, 'planned');
    assert.equal(retained.cleanupAuthorized, false);
    assert.equal(retained.prepareStopped, true);
    assert.equal(failure.cause.code, 1);
    assert.match(failure.cause.stdout, new RegExp(created.database_name));
    assert.match(failure.cause.stderr, /合成 created marker 写入失败/);
    assert.match(failure.cause.stderr, /合成 DROP 管理连接失败/);
    assert.ok(failure.cause.stderr.includes('已确证创建') && failure.cause.stderr.includes(created.database_name));
    assert.ok(archive);
    assert.equal(await readFile(path.join(archive, 'original.stdout'), 'utf8'), failure.cause.stdout);
    assert.equal(await readFile(path.join(archive, 'original.stderr'), 'utf8'), failure.cause.stderr);
    assert.equal((await stat(path.join(archive, 'original.stderr'))).mode & 0o777, 0o600);
    await assert.rejects(stat(unexpectedDrop), { code: 'ENOENT' });
  } finally {
    // psycopg 全程由离线驱动替换，只清理本测试明确创建的目录。
    if (!directory) directory = await readFile(path.join(evidence, 'location.json'), 'utf8')
      .then((value) => JSON.parse(value).directory).catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true });
    if (archive) await rm(archive, { recursive: true, force: true });
    await rm(evidence, { recursive: true });
  }
});

test('合成后端收尾失败保留精确库身份供自有资源恢复', async () => {
  const evidence = await mkdtemp(path.join(tmpdir(), 'notalone-ownership-cleanup-check-'));
  let retained, archive;
  const python = path.join(process.env.CONDA_PREFIX, 'bin/python');
  const script = path.resolve('tests/fixtures/contact-database.py');
  const execute = promisify(execFile);
  const built = await build({ stdin: { contents: `
    export { withSyntheticBackendFixture } from './tests/synthetic-backend-fixture';
    export { readDatabaseOwnership, confirmDatabaseAbsent } from './tests/database-ownership';
    export { isolatedAppEnvironment } from './tests/isolated-environment';
  `, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
  const module = path.join(evidence, 'cleanup-fixture.cjs');
  await writeFile(module, built.outputFiles[0].text);
  const ports = (await import(module)).default;
  try {
    await assert.rejects(ports.withSyntheticBackendFixture({
      directoryPrefix: 'notalone-ownership-cleanup-failure-', databaseScript: script,
      createArguments: ['empty'], prepareTimeoutMs: 70_000, reuseBackend: false,
      createFixture(directory, executable, data) {
        retained = { directory, data };
        return { async startBackend() { throw new Error('本场景不启动后端。'); },
          async cleanup() { throw new Error('受控后端收尾失败。'); } };
      },
    }, async () => {}), (error) => {
      archive = error.message.match(/原始证据：([^\n]+)$/u)?.[1];
      return /保留本轮归属/u.test(error.message);
    });
    const name = await ports.readDatabaseOwnership(retained.directory, 'contact');
    assert.equal(name, retained.data.database_name);
    assert.equal((await stat(retained.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(retained.directory, 'cleanup-unconfirmed.json'))).mode & 0o777, 0o600);
    const environment = ports.isolatedAppEnvironment(retained.directory, {
      NOTALONE_DATABASE_URL: retained.data.database_url, NOTALONE_TEST_DATABASE_URL: retained.data.database_url,
    });
    const actual = await execute(python, ['-c', 'import os, psycopg\nassert os.environ["NOTALONE_DATABASE_URL"] == os.environ["NOTALONE_TEST_DATABASE_URL"]\nwith psycopg.connect(os.environ["NOTALONE_DATABASE_URL"]) as c: print(c.execute("SELECT current_database()").fetchone()[0])'], { env: environment, timeout: 5_000 });
    assert.equal(actual.stdout.trim(), name);
  } finally {
    if (retained) {
      const name = await ports.readDatabaseOwnership(retained.directory, 'contact');
      const environment = ports.isolatedAppEnvironment(retained.directory);
      await execute(python, [script, 'drop', name], { env: environment, timeout: 15_000 });
      await ports.confirmDatabaseAbsent(python, environment, name);
      await rm(retained.directory, { recursive: true });
      console.log(JSON.stringify({ cleanupFailureRecovery: { databaseName: name, databaseAbsent: true, directoryRemoved: true } }));
    }
    if (archive) await rm(archive, { recursive: true, force: true });
    await rm(evidence, { recursive: true });
  }
});

test('受控 Core 与合成资料入口通过真实 HTTP 后精确清理本轮库', async () => {
  const evidence = await mkdtemp(path.join(tmpdir(), 'notalone-ownership-http-check-'));
  try {
    const built = await build({ stdin: { contents: `
      export { withRewriteFixture } from './tests/rewrite-backend-fixture';
      export { withImportFixture } from './tests/import-backend-fixture';
      export { withSyntheticBackendFixture } from './tests/synthetic-backend-fixture';
      export { ContactFixture } from './tests/contact-backend-fixture';
      export { readDatabaseOwnership } from './tests/database-ownership';
      export { isolatedAppEnvironment } from './tests/isolated-environment';
    `, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
    const module = path.join(evidence, 'http-fixture.cjs');
    await writeFile(module, built.outputFiles[0].text);
    const ports = (await import(module)).default;
    const python = path.join(process.env.CONDA_PREFIX, 'bin/python');
    const execute = promisify(execFile);
    const verifyIdentity = async (fixture, family) => {
      const name = await ports.readDatabaseOwnership(fixture.directory, family, fixture.child?.pid);
      const environment = ports.isolatedAppEnvironment(fixture.directory, {
        NOTALONE_DATABASE_URL: fixture.data.database_url, NOTALONE_TEST_DATABASE_URL: fixture.data.database_url,
      });
      const actual = await execute(python, ['-c', 'import os, psycopg\nassert os.environ["NOTALONE_DATABASE_URL"] == os.environ["NOTALONE_TEST_DATABASE_URL"]\nwith psycopg.connect(os.environ["NOTALONE_DATABASE_URL"]) as c: print(c.execute("SELECT current_database()").fetchone()[0])'], { env: environment, timeout: 5_000 });
      assert.equal(actual.stdout.trim(), name);
      return name;
    };
    const finished = [];
    for (const kind of ['rewrite', 'import']) {
      let directory, name;
      const use = async (fixture) => {
        directory = fixture.directory;
        name = await verifyIdentity(fixture, 'core');
        assert.equal((await fixture.request('/api/runtime/status')).data.state, 'running');
        assert.equal((await fixture.request('/api/contacts')).status, 200);
        const counts = await fixture.command('observations');
        assert.equal(kind === 'rewrite' ? counts.payloads.length : counts.reply_calls + counts.extraction_calls, 0);
      };
      if (kind === 'rewrite') await ports.withRewriteFixture('notalone-ownership-rewrite-', use);
      else await ports.withImportFixture('notalone-ownership-import-', use);
      await assert.rejects(stat(directory), { code: 'ENOENT' });
      finished.push({ kind, databaseName: name, databaseAbsent: true, directoryRemoved: true, modelCalls: 0 });
    }
    for (const [script, args] of [['contact-database.py', ['ready']], ['memory-database.py', []],
      ['memory-database.py', ['empty-owner-memory']], ['memory-correction-database.py', []]]) {
      let directory, name;
      await ports.withSyntheticBackendFixture({
        directoryPrefix: 'notalone-ownership-data-', databaseScript: path.resolve('tests/fixtures', script),
        createArguments: args, prepareTimeoutMs: 70_000, reuseBackend: true,
        createFixture: (current, executable, data) => new ports.ContactFixture(current, executable, data),
      }, async (fixture) => {
        directory = fixture.directory;
        name = await verifyIdentity(fixture, 'contact');
        assert.equal((await fixture.request('/api/contacts')).status, 200);
        await fixture.stopBackend();
      });
      await assert.rejects(stat(directory), { code: 'ENOENT' });
      finished.push({ kind: `${script}:${args.join(',')}`, databaseName: name, databaseAbsent: true, directoryRemoved: true, modelCalls: 0 });
    }
    // 建库成功但准备回执损坏，仍用事前落盘身份精确清库；不得执行场景。
    const malformed = path.join(evidence, 'malformed.py');
    const malformedLocation = path.join(evidence, 'malformed-location.txt');
    await writeFile(malformed, `import json, pathlib, runpy, sys\nfixture = runpy.run_path(${JSON.stringify(path.resolve('tests/fixtures/contact-database.py'))})\nif sys.argv[1] == 'create':\n data = fixture['create_database']('empty', sys.argv[2])\n pathlib.Path(${JSON.stringify(malformedLocation)}).write_text(json.dumps({'directory': str(pathlib.Path(sys.argv[2]).parent), 'database_name': data['database_name']}))\n print('malformed synthetic receipt')\nelse:\n fixture['drop_database'](sys.argv[2])\n`);
    await assert.rejects(ports.withSyntheticBackendFixture({
      directoryPrefix: 'notalone-ownership-bad-json-', databaseScript: malformed,
      createArguments: [], prepareTimeoutMs: 70_000, reuseBackend: false,
      createFixture() { throw new Error('损坏准备回执不得进入后端。'); },
    }, async () => {}), SyntaxError);
    const malformedResult = JSON.parse(await readFile(malformedLocation, 'utf8'));
    await assert.rejects(stat(malformedResult.directory), { code: 'ENOENT' });
    finished.push({ kind: 'malformed-prepare', databaseName: malformedResult.database_name, databaseAbsent: true, directoryRemoved: true, modelCalls: 0 });
    console.log(JSON.stringify({ fixtureOwnershipHttp: finished }));
  } finally { await rm(evidence, { recursive: true }); }
});
