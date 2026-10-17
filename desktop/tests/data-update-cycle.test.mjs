import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, readdir, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runtimeInventory } from '../scripts/managed-runtime.mjs';
import { requiredRuntimeFiles, managedLayout } from '../managed-runtime-contract.mjs';

const run = promisify(execFile);
const project = path.resolve('..');
const python = path.join(process.env.CONDA_PREFIX || '/unconfigured', 'bin/python');
const migrations = path.join(project, 'backend/database/migrations');
const module = await build({ entryPoints: ['src/main/startup/data-update.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const digest = data => createHash('sha256').update(data).digest('hex');

test('同一资料在正常使用后再次升级创建新恢复点，重连重试复用已完成结果', { timeout: 90_000 }, async () => {
  assert.equal(process.env.CONDA_DEFAULT_ENV, 'NotAlone');
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-update-cycle-'));
  const resources = path.join(directory, 'resources'), root = path.join(resources, 'notalone-runtime');
  const marker = path.join(directory, 'owned-tools');
  let target, updates;
  const fixture = async (action, name) => run(python, [path.resolve('tests/fixtures/update-database.py'), action, '--project', project,
    ...(name ? ['--database', name] : [])], { env: { ...process.env, PYTHONPATH: path.join(project, 'backend/src'), NOTALONE_DISABLE_DOTENV: '1' }, timeout: 60_000 });
  try {
    target = JSON.parse((await fixture('create')).stdout);
    await mkdir(path.join(directory, 'managed'), { mode: 0o700 });
    await writeFile(path.join(directory, 'managed/state.json'), JSON.stringify({ formatVersion: 1, password: 'synthetic', bootstrapComplete: true }), { mode: 0o600 });
    await writeFile(path.join(directory, 'managed/runtime.env'), `NOTALONE_DATABASE_URL=${target.database_url}\nNOTALONE_OWNER_ID=${target.owner}\n`, { mode: 0o600 });
    for (const relative of requiredRuntimeFiles) {
      const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true });
      let contents = '# 合成组件，真实数据库命令由下面固定包装器执行\n';
      if (relative === managedLayout.python) contents = `#!${python}\nimport runpy,sys\nsys.path.insert(0,${JSON.stringify(path.join(project, 'backend/src'))})\narguments=[value for value in sys.argv[1:] if value not in ('-I','-B')]\nassert arguments[0]=='-m' and arguments[1]=='notalone.database_updates'\nsys.argv=[arguments[1],*arguments[2:]]\nrunpy.run_module(arguments[1],run_name='__main__')\n`;
      else if (relative.startsWith('postgres/bin/')) {
        const name = path.basename(relative);
        const executable = (await run('/usr/bin/which', [name])).stdout.trim();
        contents = `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');fs.appendFileSync(${JSON.stringify(marker)},${JSON.stringify(name)}+'\\n');const result=cp.spawnSync(${JSON.stringify(executable)},process.argv.slice(2),{env:process.env,stdio:'inherit'});process.exit(result.status??2);\n`;
      }
      await writeFile(file, contents, { mode: 0o700 });
    }
    const bundledMigrations = path.join(root, 'project/backend/database/migrations');
    await cp(migrations, bundledMigrations, { recursive: true });
    const manifest = { formatVersion: 1, architecture: process.arch,
      components: ['python', 'postgres'].map(name => ({ name, version: 'test-boundary', source: 'repository:test', sha256: 'a'.repeat(64) })), paths: managedLayout };
    const inventory = async () => writeFile(path.join(root, 'manifest.json'), JSON.stringify({ ...manifest, files: await runtimeInventory(root) }));
    await inventory();
    const file = path.join(directory, 'subject.mjs'); await writeFile(file, module.outputFiles[0].text);
    const { LocalDataUpdates } = await import(file);
    let phase = 'connected', failNextConnect = false;
    const backend = { async prepareConfiguration() { return true; }, async saveStartupConfiguration(callback) { await callback(); },
      async connect() { phase = failNextConnect ? 'failed' : 'connected'; failNextConnect = false; }, getState() { return { phase }; } };
    updates = new LocalDataUpdates(directory, resources, { async start() {}, getLifetimeLock() {} }, backend);
    await updates.refresh(); assert.equal(updates.getState().phase, 'available');
    await updates.begin(); assert.equal(updates.getState().phase, 'complete');
    const first = JSON.parse(await readFile(path.join(directory, 'update-operation.json')));
    const archive = path.join(directory, 'updates', first.backup, 'database.dump');
    const firstHash = digest(await readFile(archive));
    // 普通使用真实修改业务资料，然后安装增加一个版本的固定测试运行时。
    await run(python, ['-c', "import os,psycopg\nwith psycopg.connect(os.environ['NOTALONE_TEST_URL']) as c: c.execute(\"UPDATE public.contact SET display_name='再次升级前修改的合成联系人'\")"],
      { env: { ...process.env, NOTALONE_TEST_URL: target.database_url }, timeout: 10_000 });
    const latest = (await readdir(bundledMigrations)).filter(name => name.endsWith('.sql')).length;
    await writeFile(path.join(bundledMigrations, `${String(latest + 1).padStart(3, '0')}_synthetic_second_app_update.sql`), 'CREATE TABLE public.synthetic_second_app_update (id int);\n');
    await inventory();
    await updates.refresh(); assert.equal(updates.getState().phase, 'available');
    failNextConnect = true;
    await assert.rejects(updates.begin());
    assert.equal(updates.getState().code, 'update_reconnect_failed');
    const second = JSON.parse(await readFile(path.join(directory, 'update-operation.json')));
    assert.notEqual(second.backup, first.backup);
    assert.equal(second.completed, true);
    assert.equal(digest(await readFile(archive)), firstHash);
    const before = (await readFile(marker, 'utf8')).split('\n').filter(name => name === 'pg_dump').length;
    await updates.begin(); assert.equal(updates.getState().phase, 'complete');
    assert.equal(JSON.parse(await readFile(path.join(directory, 'update-operation.json'))).backup, second.backup);
    const after = (await readFile(marker, 'utf8')).split('\n').filter(name => name === 'pg_dump').length;
    assert.equal(after, before);
    const retained = await run(python, ['-c', "import os,psycopg\nwith psycopg.connect(os.environ['NOTALONE_TEST_URL']) as c: print(c.execute('SELECT display_name FROM public.contact').fetchone()[0])"],
      { env: { ...process.env, NOTALONE_TEST_URL: target.database_url }, timeout: 10_000 });
    assert.equal(retained.stdout.trim(), '再次升级前修改的合成联系人');
    await run(python, ['-c', "import os,psycopg\nfrom uuid import UUID\nfrom notalone.persistence.source_deletion import PostgresSourceDeletionRepository\nwith psycopg.connect(os.environ['NOTALONE_TEST_URL']) as c: source=c.execute('SELECT id FROM public.source_document').fetchone()[0]\nPostgresSourceDeletionRepository(os.environ['NOTALONE_TEST_URL']).delete_source(owner_id=UUID(os.environ['NOTALONE_TEST_OWNER']),contact_id=UUID(os.environ['NOTALONE_TEST_CONTACT']),source_document_id=source)"],
      { env: { ...process.env, PYTHONPATH: path.join(project, 'backend/src'), NOTALONE_TEST_URL: target.database_url,
        NOTALONE_TEST_OWNER: target.owner, NOTALONE_TEST_CONTACT: target.contact, NOTALONE_MANAGED_USER_DATA: directory }, timeout: 10_000 });
    const deadline = Date.now() + 3000;
    while (updates.getState().hasBackup && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(updates.getState().hasBackup, false);
    await updates.refresh(); assert.equal(updates.getState().hasBackup, false);
    assert.equal(updates.getState().phase, 'complete');
  } finally { await updates?.stop(); if (target) await fixture('drop', target.database); await rm(directory, { recursive: true, force: true }); }
});
