// 真实库仅通过 sqlite3 的只读 .backup 复制；所有写入、迁移、强杀均限于临时副本。
// 运行：node --disable-warning=ExperimentalWarning .scratch/open-timing/measure.mjs
import assert from 'node:assert/strict';
import {execFileSync, fork} from 'node:child_process';
import {once} from 'node:events';
import {chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const repo = realpathSync(join(here, '../..'));
const sourceDir = join(repo, 'backend-ts/src/storage/sqlite');
const round = value => Math.round(value * 1000) / 1000;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const database = root => join(root, 'managed/sqlite/notalone.sqlite');
const sidecars = root => Object.fromEntries(['-wal', '-shm'].map(suffix => {
  try { return [suffix.slice(1) + 'Bytes', statSync(database(root) + suffix).size]; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return [suffix.slice(1) + 'Bytes', null]; }
}));
const hasResidue = root => Object.values(sidecars(root)).some(value => value !== null);
function identity(root) {
  const db = new DatabaseSync(database(root), {readOnly: true});
  try {
    const row = db.prepare('SELECT database_id,role FROM database_instance WHERE slot=1').get();
    return {expectedDatabaseId: row.database_id, role: row.role, version: db.prepare('PRAGMA user_version').get().user_version};
  } finally { db.close(); }
}
function layout(root) {
  mkdirSync(root, {recursive: true, mode: 0o700});
  for (const path of [root, join(root, 'managed'), join(root, 'managed/sqlite')]) {
    mkdirSync(path, {recursive: true, mode: 0o700});
    chmodSync(path, 0o700);
  }
  return root;
}
function relocate(source, origin) {
  return source.replace(/(\bfrom\s*['"])(\.{1,2}\/[^'"]+)(['"])/g,
    (_match, prefix, relative, suffix) => prefix + new URL(relative, pathToFileURL(origin)).href + suffix);
}

// 子进程只持有副本中的项目客户端连接，收到 ready 后由父进程发送 SIGKILL。
if (process.argv[2] === 'hold') {
  process.once('message', async ({clientUrl, options}) => {
    try {
      const {SqliteStorage} = await import(clientUrl);
      const storage = await SqliteStorage.open(options);
      process.send({ready: true, probe: storage.status.openProbe});
    } catch (error) { process.send({failed: true, code: error.code ?? 'probe_failed'}); process.exitCode = 1; }
  });
} else {
  // mktemp 在仓库外创建私有目录；源码变体只在指定 .scratch 子目录临时生成。
  const temp = realpathSync(execFileSync('mktemp', ['-d', '/tmp/notalone-open-timing.XXXXXX'], {encoding: 'utf8'}).trim());
  const generated = mkdtempSync(join(here, '.generated-'));
  writeFileSync(join(generated, 'package.json'), '{"type":"module"}\n', {mode: 0o600});
  const active = new Set();
  let child;
  const summary = {};
  try {
    const clientSource = readFileSync(join(sourceDir, 'client.ts'), 'utf8');
    const workerSource = readFileSync(join(sourceDir, 'worker.ts'), 'utf8');
    const oldSource = execFileSync('git', ['show', '1607cd607^:backend-ts/src/storage/sqlite/worker.ts'], {cwd: repo, encoding: 'utf8'});
    const oldWorker = join(generated, 'before-worker.ts');
    writeFileSync(oldWorker, relocate(oldSource, join(sourceDir, 'worker.ts')), {mode: 0o600});
    async function clientFor(name, workerPath) {
      // 保留项目客户端，仅重定位相对导入、选择对照 Worker，并记录首条 status 的接收时刻。
      const workerExpression = "new URL('./worker.ts', import.meta.url)";
      assert.equal(clientSource.split(workerExpression).length, 2);
      let source = relocate(clientSource, join(sourceDir, 'client.ts'))
        .replace(workerExpression, `new URL(${JSON.stringify(pathToFileURL(workerPath).href)})`)
        .replace("worker.once('message', message => {", "worker.once('message', message => { statusReceivedAt = performance.now();");
      source += '\nexport let statusReceivedAt = 0;\n';
      const target = join(generated, name + '-client.ts');
      writeFileSync(target, source, {mode: 0o600});
      return import(pathToFileURL(target).href);
    }
    const before = await clientFor('before', oldWorker);
    const after = await clientFor('after', join(sourceDir, 'worker.ts'));
    // 独立诊断变体只增加聚合计数和采样布尔值；不参与上面的主计时。
    const probeWorker = join(generated, 'probe-worker.ts');
    assert.equal(workerSource.split('const checks = (quick = false) => {').length, 2);
    const probeSource = workerSource
      .replace('const checks = (quick = false) => {', 'let quickChecks = 0, fullChecks = 0, foreignKeyChecks = 0;\n  const checks = (quick = false) => {\n    if (quick) quickChecks++; else fullChecks++; foreignKeyChecks++;')
      .replace('port.postMessage({value: status});', 'port.postMessage({value: {...status, openProbe: {priorExitResidue, quickChecks, fullChecks, foreignKeyChecks}}});');
    assert.notEqual(probeSource, workerSource);
    writeFileSync(probeWorker, relocate(probeSource, join(sourceDir, 'worker.ts')), {mode: 0o600});
    const probe = await clientFor('probe', probeWorker);
    const probeClientUrl = pathToFileURL(join(generated, 'probe-client.ts')).href;
    const baseline = layout(join(temp, 'baseline'));
    const live = pathToFileURL(join(homedir(), 'Library/Application Support/NotAloneDesktop/managed/sqlite/notalone.sqlite')).href + '?mode=ro';
    execFileSync('sqlite3', [live, `.backup '${database(baseline)}'`], {stdio: ['ignore', 'pipe', 'pipe']});
    chmodSync(database(baseline), 0o600);
    const prior = identity(baseline);
    const options = root => ({userData: root, intent: 'open', role: prior.role, expectedDatabaseId: prior.expectedDatabaseId});
    async function open(client, root) {
      const started = performance.now();
      const storage = await client.SqliteStorage.open(options(root));
      active.add(storage);
      return {storage, ms: round(client.statusReceivedAt - started)};
    }
    async function close(storage) { await storage.close(); active.delete(storage); }
    // 当前 main 完整迁移并正常 close 后冻结基线，迁移耗时不计入比较。
    const upgraded = await open(after, baseline);
    const upgradedVersion = upgraded.storage.status.schemaVersion;
    const sqliteVersion = upgraded.storage.status.sqliteVersion;
    await close(upgraded.storage);
    assert.equal(hasResidue(baseline), false);
    summary.baseline = {bytes: statSync(database(baseline)).size, priorVersion: prior.version, version: upgradedVersion,
      pendingMigrations: upgradedVersion - prior.version, sqliteVersion, nodeVersion: process.version,
      managedMode: statSync(join(baseline, 'managed')).mode & 0o777,
      sqliteMode: statSync(join(baseline, 'managed/sqlite')).mode & 0o777,
      databaseMode: statSync(database(baseline)).mode & 0o777};
    emit({baseline: summary.baseline});
    function clone(name) {
      const root = layout(join(temp, name));
      copyFileSync(database(baseline), database(root));
      chmodSync(database(root), 0o600);
      assert.equal(hasResidue(root), false);
      return root;
    }
    const timings = {before: {cold: [], hot: []}, after: {cold: [], hot: []}};
    for (let trial = 0; trial < 3; trial++) {
      // 交错顺序降低时间漂移；每组新副本首次打开为冷，正常关闭后的第二次为热。
      for (const name of trial % 2 ? ['after', 'before'] : ['before', 'after']) {
        const client = name === 'before' ? before : after;
        for (const cache of ['cold', 'hot']) {
          const root = clone(`timing-${trial}-${name}-${cache}`);
          // 每个计时样本独立复制基线；热样本先完成一次不计时的打开和正常关闭。
          if (cache === 'hot') {
            const warmup = await open(client, root);
            await close(warmup.storage);
            assert.equal(hasResidue(root), false);
          }
          const result = await open(client, root);
          assert.equal(result.storage.status.schemaVersion, upgradedVersion);
          timings[name][cache].push(result.ms);
          await close(result.storage);
          assert.equal(hasResidue(root), false);
          rmSync(root, {recursive: true});
        }
        emit({trial: trial + 1, variant: name, coldMs: timings[name].cold.at(-1), hotMs: timings[name].hot.at(-1)});
      }
    }
    summary.timings = timings;
    summary.medians = Object.fromEntries(Object.entries(timings).map(([name, values]) => [name,
      Object.fromEntries(Object.entries(values).map(([cache, samples]) => [cache, [...samples].sort((a, b) => a - b)[1]]))]));
    const normal = clone('normal');
    summary.normal = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      const result = await open(probe, normal);
      const observed = {cycle: cycle + 1, ms: result.ms, probe: result.storage.status.openProbe, whileOpen: sidecars(normal)};
      assert.deepEqual(observed.probe, {priorExitResidue: false, quickChecks: 0, fullChecks: 0, foreignKeyChecks: 0});
      // 第二轮连同实际附属只读 Worker 一起关闭，覆盖客户端的整体关闭顺序。
      if (cycle === 1) await result.storage.openReader(['identity.foregroundSnapshot']);
      await close(result.storage);
      observed.afterClose = sidecars(normal);
      assert.equal(hasResidue(normal), false);
      summary.normal.push(observed);
    }
    emit({normal: summary.normal});
    const crash = clone('crash');
    child = fork(fileURLToPath(import.meta.url), ['hold'], {stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
    const exited = once(child, 'exit');
    const ready = Promise.race([
      once(child, 'message').then(([value]) => value),
      exited.then(() => { throw new Error('child_exited_before_ready'); })
    ]);
    child.send({clientUrl: probeClientUrl, options: options(crash)});
    let timer;
    const readyMessage = await Promise.race([ready, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('child_ready_timeout')), 90_000);
    })]).finally(() => clearTimeout(timer));
    assert.equal(readyMessage.ready, true);
    assert.equal(readyMessage.probe.quickChecks, 0);
    child.kill('SIGKILL');
    const [, signal] = await exited;
    assert.equal(signal, 'SIGKILL');
    child = undefined;
    const afterKill = sidecars(crash);
    assert.ok(afterKill.walBytes > 0);
    const recovered = await open(probe, crash);
    summary.crash = {signal, afterKill, reopenMs: recovered.ms, probe: recovered.storage.status.openProbe};
    assert.deepEqual(summary.crash.probe, {priorExitResidue: true, quickChecks: 1, fullChecks: 0, foreignKeyChecks: 1});
    await close(recovered.storage);
    summary.crash.afterRecoveryClose = sidecars(crash);
    assert.equal(hasResidue(crash), false);
    const clean = await open(probe, crash);
    summary.crash.nextCleanMs = clean.ms;
    summary.crash.nextCleanProbe = clean.storage.status.openProbe;
    assert.equal(clean.storage.status.openProbe.quickChecks, 0);
    await close(clean.storage);
    emit({crash: summary.crash});
    emit({medians: summary.medians});
    writeFileSync(join(here, 'results.json'), JSON.stringify(summary, null, 2) + '\n', {mode: 0o600});
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
    await Promise.allSettled([...active].map(storage => storage.close()));
    rmSync(temp, {recursive: true, force: true});
    rmSync(generated, {recursive: true, force: true});
    emit({temporaryCopiesRemoved: true, generatedSourcesRemoved: true});
  }
}
