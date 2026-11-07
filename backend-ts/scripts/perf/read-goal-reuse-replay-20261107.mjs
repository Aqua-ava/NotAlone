#!/usr/bin/env node
/**
 * read_goal 目标复用（阶段 B 20261107）隔离副本重放。
 *
 * 在真实库的隔离副本上重放"打开 → 一次后台重启"的元数据重验链：每位联系人取
 * 库内最新 read_goal 行的 support/target 作为既有来源证据，按服务层同一动作顺序执行
 * history.prepareNormalUseGuard（跨运行代次重验，即 continuity.ts 作废决策点）与
 * history.begin（重验后新目标，即 actions.ts 作废与新建决策点），度量每轮新增的
 * read_goal 行数与重验前 running 行的保留情况。对副本只写产品 named action；
 * 联系人一律只输出 ID 前 8 位；不输出消息正文。
 *
 * 用法（在 backend-ts/）：
 *   node scripts/perf/read-goal-reuse-replay-20261107.mjs --user-data=<副本root绝对路径> \
 *     [--passes=2] [--status-passes=7] [--limit=N]
 */
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync, realpathSync, statfsSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {SqliteStorage} from '../../src/storage/sqlite/client.ts';

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));
const fail = message => { console.error(`拒绝：${message}`); process.exit(2); };
const userDataArg = args.get('user-data');
if (!userDataArg || !userDataArg.startsWith('/tmp/')) fail('--user-data 必须是 /tmp 下的副本根路径');
const userData = realpathSync(userDataArg);
const dbPath = join(userData, 'managed/sqlite/notalone.sqlite');
if (!existsSync(dbPath)) fail('副本缺 managed/sqlite/notalone.sqlite');
const statfs = statfsSync(userData);
if (statfs.bavail * statfs.bsize < 15 * 2 ** 30) fail('可用空间不足 15 GiB');

const readonly = (query, params = []) => {
  const db = new DatabaseSync(dbPath, {readOnly: true});
  try { return db.prepare(query).all(...params); } finally { db.close(); }
};
const count = query => Number(readonly(query)[0]?.n ?? 0);
const ticket = {passes: Number(args.get('passes') ?? 2), statusPasses: Number(args.get('status-passes') ?? 7),
  limit: args.get('limit') ? Number(args.get('limit')) : undefined};

const staticIdentity = readonly('SELECT database_id,role FROM database_instance');
const ownerId = readonly("SELECT owner_id FROM owner WHERE state='active' LIMIT 1")[0]?.owner_id;
if (!staticIdentity[0]?.database_id || !ownerId) fail('无法读取副本实例身份');

// lsof 确认无进程持有副本文件后再开。
const holders = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(existsSync).flatMap(file => {
  try { return execFileSync('lsof', ['-t', '--', file], {encoding: 'utf8'}).split('\n').filter(Boolean); }
  catch (error) { if (error.status === 1) return []; throw error; }
});
if (holders.length) fail(`副本仍被进程持有（${[...new Set(holders)].join(',')}）`);

const total = () => count('SELECT COUNT(*) n FROM read_goal');
const stateByKind = () => Object.fromEntries(readonly(`
  SELECT kind||'/'||state||'/'||coalesce(failure_code,'-') k, COUNT(*) n FROM read_goal GROUP BY 1 ORDER BY 2 DESC`)
  .map(row => [row.k, Number(row.n)]));
const runningRows = () => readonly(`
  SELECT id, contact_id, kind, state, cursor, cursor_scope_digest, pages_accepted, eligibility_json
  FROM read_goal WHERE state IN ('running','incomplete') AND creation_no IS NOT NULL
  ORDER BY contact_id, creation_no DESC`);
const kindTally = rows => rows.reduce((acc, row) => { const key = `${row.kind}/${row.state}/${row.failure_code ?? '-'}`; acc[key] ??= 0; acc[key]++; return acc; }, {});

let storage = null;
async function openStorage() {
  storage = await SqliteStorage.open({userData, intent: 'open', expectedDatabaseId: staticIdentity[0].database_id,
    role: staticIdentity[0].role});
}
const closeStorage = async () => { await storage?.close(); storage = null; };

const contacts = readonly('SELECT DISTINCT contact_id FROM read_goal').map(row => String(row.contact_id));
if (!contacts.length) fail('副本没有 read_goal 联系人可重放');
const working = ticket.limit ? contacts.slice(0, ticket.limit) : contacts;

/** 每轮快照：重放前提条件：租约全部丢失、每联系人最新行的 support/target。 */
const evidence = contactId => {
  const row = readonly(`SELECT support_json,target_json FROM read_goal
    WHERE owner_id=? AND contact_id=? ORDER BY creation_no DESC,created_at DESC,id DESC LIMIT 1`,
    [ownerId, contactId])[0];
  if (!row) return null;
  try { return {report: JSON.parse(String(row.support_json)), target: JSON.parse(String(row.target_json))}; }
  catch { return null; }
};

const summary = {userData, contactCount: working.length, passes: [], status: null};
const log = () => { console.log(JSON.stringify(summary, null, 2)); };

/** 一轮：prepareNormalUseGuard（跨运行代次重验）→ begin（重验后目标决策），随后对比新增与保留。 */
async function runPass(pass) {
  const passStart = Date.now();
  const pre = {total: total(), byKind: stateByKind(), running: runningRows()};
  const runningIds = new Set(pre.running.map(row => row.id));
  await openStorage();
  let exercised = 0, guardDenied = 0;
  const errorCodes = {};
  const exercisedContacts = [];
  for (const contactId of working) {
    try {
      const token = await storage.execute('identity.eligibility', {ownerId, contactId});
      const proof = evidence(contactId);
      if (!proof || !token) { errorCodes.evidence_missing ??= 0; errorCodes.evidence_missing++; continue; }
      const guardId = `replay${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const guard = await storage.execute('history.prepareNormalUseGuard',
        {token, target: proof.target, report: proof.report, guardId});
      if (!guard?.ok) { guardDenied++; continue; }
      await storage.execute('history.begin', {token, target: proof.target, report: proof.report, id: randomUUID(), at: Date.now()});
      exercised++; exercisedContacts.push(String(contactId).slice(0, 8));
    } catch (error) {
      const code = error?.code ?? String(error).slice(0, 40);
      errorCodes[code] ??= 0;
      errorCodes[code]++;
    }
  }
  await closeStorage();
  const fresh = readonly('SELECT contact_id, kind, state, failure_code FROM read_goal WHERE created_at>=?', [BigInt(passStart)]);
  const freshPerContact = Object.values(fresh.reduce((acc, row) => {
    acc[row.contact_id] ??= {id: String(row.contact_id).slice(0, 8), n: 0};
    acc[row.contact_id].n++;
    return acc;
  }, {})).map(entry => entry.n).sort((a, b) => a - b);
  const post = {total: total(), byKind: stateByKind(), running: runningRows()};
  const kept = post.running.filter(row => runningIds.has(row.id));
  const invalidatedDuringPass = runningIds.size - kept.length;
  const distribution = list => ({min: list[0] ?? 0, median: list[list.length >> 1] ?? 0, max: list[list.length - 1] ?? 0, contacts: list.length});
  summary.passes.push({
    pass, exercised, guardDenied, exercisedContacts,
    errorCodes,
    freshTotal: fresh.length,
    freshByKind: kindTally(fresh),
    freshPerContact: distribution(freshPerContact),
    invalidatedDuringPass,
    runningPassOverRelationship: {pre: runningIds.size, post: post.running.length, keptUnchanged: kept.length},
    runningPreByKind: kindTally(pre.running),
    runningPostByKind: kindTally(post.running),
    comparison: {totalPre: pre.total, totalPost: post.total, delta: post.total - pre.total},
  });
  log();
}

/** 安静副本 /api/sync/status 同口径计时：history.coverages 每批 4 位联系人。 */
async function measureStatus() {
  await openStorage();
  const batches = [];
  for (let index = 0; index < working.length; index += 4) batches.push(working.slice(index, index + 4));
  const passTimes = [];
  for (let pass = 0; pass < ticket.statusPasses; pass++) {
    const started = performance.now();
    let recovered = 0;
    for (const batch of batches) {
      try { await storage.execute('history.coverages', {ownerId, contactIds: batch}); }
      catch { recovered++; for (const contactId of batch) { try { await storage.execute('history.coverage', {ownerId, contactId}); } catch {/* 跳过无效联系人。 */} } }
    }
    passTimes.push({seconds: Number(((performance.now() - started) / 1000).toFixed(2)), recovered});
  }
  const sorted = passTimes.slice().sort((a, b) => a.seconds - b.seconds);
  summary.status = {batchesPerPass: batches.length,
    passTimes, min: sorted[0].seconds, median: sorted[sorted.length >> 1].seconds, max: sorted[sorted.length - 1].seconds};
  await closeStorage();
  log();
}

for (let pass = 1; pass <= ticket.passes; pass++) await runPass(pass);
await measureStatus();
log();
