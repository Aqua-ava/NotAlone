import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { build } from 'esbuild';

// 不启动 App 或页面，仅验证现有共享 runner 实际传入的四种准备命令。
test('追踪四种模式接受事前归属路径并精确清理本轮库', async () => {
  const evidence = await mkdtemp(path.join(tmpdir(), 'notalone-trace-ownership-check-'));
  const built = await build({ stdin: { contents: `
    export { readDatabaseOwnership, confirmDatabaseAbsent } from './tests/database-ownership';
    export { isolatedAppEnvironment } from './tests/isolated-environment';
  `, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
  const module = path.join(evidence, 'trace-fixture.cjs');
  await writeFile(module, built.outputFiles[0].text);
  const ports = (await import(module)).default;
  const execute = promisify(execFile);
  const python = path.join(process.env.CONDA_PREFIX, 'bin/python');
  const script = path.resolve('tests/fixtures/trace-database.py');
  try {
    for (const mode of ['full', 'deletion-contact', 'deletion-owner', 'deletion-candidate']) {
      const directory = await mkdtemp(path.join(tmpdir(), 'notalone-trace-owned-mode-'));
      const environment = ports.isolatedAppEnvironment(directory, {
        PYTHONPATH: path.resolve('../backend/src'), NOTALONE_TEST_DATABASE_URL: '', NOTALONE_DEEPSEEK_API_KEY: '',
      });
      const marker = path.join(directory, 'database-ownership.json');
      let rejectedBeforeCreate = false;
      try {
        let prepared;
        try {
          prepared = await execute(python, [script, 'create', ...(mode === 'full' ? [] : [mode]), marker], {
            env: environment, timeout: 70_000,
          });
        } catch (error) {
          // 旧CLI只有这个固定参数分派else会给出该错误，尚未调用create_database。
          rejectedBeforeCreate = error.code === 1 && error.stderr.includes('ValueError: 未知追踪夹具操作。');
          throw error;
        }
        const data = JSON.parse(prepared.stdout);
        const name = await ports.readDatabaseOwnership(directory, 'contact');
        assert.equal(data.database_name, name);
        assert.ok(data.trace_id && data.trace_candidate_id && data.processing_id);
        assert.equal(data.traced_memory_id === null, mode === 'deletion-candidate');
        const identity = await execute(python, ['-c', 'import os, psycopg\nassert os.environ["NOTALONE_DATABASE_URL"] == os.environ["NOTALONE_TEST_DATABASE_URL"]\nwith psycopg.connect(os.environ["NOTALONE_DATABASE_URL"]) as c: print(c.execute("SELECT current_database()").fetchone()[0])'], {
          env: { ...environment, NOTALONE_DATABASE_URL: data.database_url, NOTALONE_TEST_DATABASE_URL: data.database_url }, timeout: 5_000,
        });
        assert.equal(identity.stdout.trim(), name);
      } finally {
        if (rejectedBeforeCreate) {
          await assert.rejects(stat(marker), { code: 'ENOENT' });
        } else {
          const name = await ports.readDatabaseOwnership(directory, 'contact');
          await execute(python, [script, 'drop', name], { env: environment, timeout: 15_000 });
          await ports.confirmDatabaseAbsent(python, environment, name);
          console.log(JSON.stringify({ traceFixtureOwnership: { mode, databaseName: name, databaseAbsent: true } }));
        }
        await rm(directory, { recursive: true });
      }
    }
  } finally { await rm(evidence, { recursive: true }); }
});
