// 实际改写夹具的未知命令故障：保留未确认记录，另核验自有进程与随机库已回收。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone' || !process.env.CONDA_PREFIX) throw new Error('须激活 Conda NotAlone。');
const compiled = await mkdtemp(path.join(tmpdir(), 'notalone-rewrite-lifecycle-check-'));
let fixture;
let verified = false;
let confirmed = false;
try {
  const modulePath = path.join(compiled, 'fixture.mjs');
  await build({ stdin: { contents: 'export { withRewriteFixture } from "./rewrite-backend-fixture"; export { isolatedAppEnvironment } from "./isolated-environment";',
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), sourcefile: 'lifecycle-check.ts' },
    outfile: modulePath, bundle: true, platform: 'node', format: 'esm' });
  const { withRewriteFixture, isolatedAppEnvironment } = await import(pathToFileURL(modulePath).href);
  await assert.rejects(withRewriteFixture('notalone-rewrite-lifecycle-fault-', async (current) => {
    fixture = current;
    assert.equal((await current.request('/api/contacts')).status, 200);
    await assert.rejects(current.command('synthetic-invalid-operation'), /夹具已退出/);
  }, () => { confirmed = true; }), /收尾未确认，保留归属记录/);
  assert.equal(confirmed, false, '失败不能撤销入口资源登记。');
  assert.equal(fixture.child.exitCode, 1);
  const diagnostic = JSON.parse(await readFile(path.join(fixture.directory, 'cleanup-unconfirmed.json'), 'utf8'));
  assert.equal(diagnostic.childPid, fixture.child.pid);
  assert.equal(diagnostic.exitCode, 1);
  assert.match(diagnostic.databaseName, /^notalone_core_flow_[0-9a-f]{32}_test$/);
  // 只查询由本轮ready和保留记录确认的合成库，不连接业务库或打印连接串。
  const verifier = spawn(path.join(process.env.CONDA_PREFIX, 'bin/python'), ['-c',
    'import json, psycopg, sys\nwith psycopg.connect("host=/tmp dbname=postgres") as admin:\n print(json.dumps({"database_remaining": admin.execute("SELECT count(*) FROM pg_database WHERE datname = %s", (sys.argv[1],)).fetchone()[0]}))',
    diagnostic.databaseName], { env: isolatedAppEnvironment(compiled), stdio: ['ignore', 'pipe', 'ignore'] });
  let result = '';
  verifier.stdout.on('data', (chunk) => { result += chunk; });
  const timer = setTimeout(() => verifier.kill('SIGTERM'), 5000);
  let code;
  try { code = await new Promise((resolve, reject) => { verifier.once('error', reject); verifier.once('close', resolve); }); }
  finally { clearTimeout(timer); }
  assert.equal(code, 0);
  assert.equal(JSON.parse(result).database_remaining, 0);
  verified = true;
  console.log(JSON.stringify({ lifecycleFault: 'unknown-command', childExit: fixture.child.exitCode,
    databaseRemaining: 0, resourceReleaseAcknowledged: confirmed, diagnosticPreservedBeforeOwnedCleanup: true }));
} finally {
  if (verified) await rm(fixture.directory, { recursive: true, force: true });
  await rm(compiled, { recursive: true, force: true });
}
