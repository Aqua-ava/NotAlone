// 只复查本轮登记的合成库、夹具目录与子进程，不读取业务内容。
import {readFile, readdir, writeFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const pointer = JSON.parse(await readFile('/tmp/notalone-standards-7a1-pointer.json', 'utf8'));
const config = JSON.parse(await readFile(join(pointer.private, 'config.json'), 'utf8'));
const labels = (await readdir(pointer.private)).filter(name => name.endsWith('.ownership.json'))
  .map(name => name.slice(0, -'.ownership.json'.length));
const names = [], processes = [];
for (const label of labels) {
  const ownership = JSON.parse(await readFile(join(pointer.private, `${label}.ownership.json`), 'utf8'));
  for (const name of ownership.created) {
    if (!/^notalone_pure_ts_[a-f0-9]+_test$/.test(name)) throw new Error('cleanup_scope_rejected');
    if (!ownership.dropRequested.includes(name)) throw new Error('cleanup_not_requested');
    names.push(name);
  }
  try {
    const lines = (await readFile(join(pointer.private, `${label}.ownership.json.processes`), 'utf8')).trim().split('\n');
    processes.push(...lines.filter(Boolean).map(line => JSON.parse(line)));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const require = createRequire(join(config.repo, 'backend-ts/package.json'));
const pg = require('pg');
const admin = new pg.Client({host: '/tmp', database: 'postgres'});
await admin.connect();
let remaining;
try {
  remaining = (await admin.query('SELECT count(*)::int AS remaining FROM pg_database WHERE datname=ANY($1::text[])', [names])).rows[0].remaining;
} finally { await admin.end(); }
const tmpChildren = await readdir(join(pointer.private, 'tmp'));
const spawned = processes.filter(item => item.event === 'spawn').map(item => item.pid);
const alive = spawned.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
const result = {owned_database_count: names.length, owned_databases_remaining: remaining,
  owned_tmp_children_remaining: tmpChildren.length, tracked_spawned_children: spawned.length,
  tracked_children_remaining: alive.length,
  raw_directory_mode: (await stat(pointer.private)).mode & 0o777};
await writeFile(join(config.out, 'cleanup.json'), JSON.stringify(result, null, 2)+'\n');
console.log(JSON.stringify(result));
if (remaining || tmpChildren.length || alive.length) process.exitCode = 1;
