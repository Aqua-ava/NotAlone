#!/usr/bin/env node
/** 只对指定备份的全新副本回放来源元数据握手；不读取正文、不连接模型、不接管正在运行的读取器。 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {constants, copyFileSync, existsSync, mkdirSync, realpathSync, statSync, statfsSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {SharedWechatClient} from '../../src/history/wechat/shared-client.ts';
import {loadSharedNarrowWechatOptions} from '../../src/history/wechat/artifacts.ts';

const args = new Map(process.argv.slice(2).map(value => {
  const split = value.indexOf('=');
  return [value.slice(2, split < 0 ? undefined : split), split < 0 ? true : value.slice(split + 1)];
}));
function reject(code) { throw new Error(code); }
function absoluteArg(name) {
  const value = args.get(name);
  if (typeof value !== 'string' || !value.startsWith('/')) reject(`invalid_${name}`);
  return resolve(value);
}
const backup = realpathSync(absoluteArg('backup'));
let userData = absoluteArg('user-data');
const temporaryRoot = realpathSync(tmpdir());
// 输出只能是尚不存在的临时目录；源必须是显式选中的历史备份，不能误用真实库。
if (!backup.endsWith('/before-migration-43-20261107.sqlite')) reject('historical_backup_required');
if (![temporaryRoot, realpathSync('/tmp')].includes(realpathSync(dirname(userData)))) reject('temporary_copy_required');
if (existsSync(userData)) reject('fresh_user_data_required');
if (statfsSync(temporaryRoot).bavail * statfsSync(temporaryRoot).bsize < 15 * 2 ** 30) reject('insufficient_disk');
const mode = args.get('mode') ?? 'native';
if (!['native', 'saved'].includes(mode)) reject('invalid_mode');
const limit = args.has('limit') ? Number(args.get('limit')) : Infinity;
const expected = Number(args.get('expected') ?? 219);
if (!(limit === Infinity || Number.isSafeInteger(limit) && limit > 0) || !Number.isSafeInteger(expected) || expected < 1) reject('invalid_limit');
const executable = mode === 'native' ? absoluteArg('executable') : undefined;
const original = statSync(backup);
mkdirSync(join(userData, 'managed/sqlite'), {recursive: true, mode: 0o700});
userData = realpathSync(userData);
const file = join(userData, 'managed/sqlite/notalone.sqlite');
copyFileSync(backup, file, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
const query = (sql, parameters = []) => {
  const db = new DatabaseSync(file, {readOnly: true});
  try { return db.prepare(sql).all(...parameters); } finally { db.close(); }
};
const one = (sql, parameters = []) => query(sql, parameters)[0];
const count = table => Number(one(`SELECT count(*) n FROM ${table}`).n);
const counted = ['history_continuity_fence', 'conversation_binding', 'message', 'read_goal', 'sync_capture'];
const counts = () => Object.fromEntries(counted.map(table => [table, count(table)]));
const before = counts();
const identity = one('SELECT database_id,role FROM database_instance WHERE slot=1');
const owner = one("SELECT owner_id FROM owner WHERE state='active' LIMIT 1")?.owner_id;
if (!identity || !owner) reject('copy_identity_missing');
const candidates = query(`SELECT c.id FROM contact c
  WHERE c.owner_id=? AND c.state='active'
  AND NOT EXISTS(SELECT 1 FROM history_continuity_fence f WHERE f.owner_id=c.owner_id AND f.contact_id=c.id)
  AND EXISTS(SELECT 1 FROM history_continuity_scope s WHERE s.owner_id=c.owner_id AND s.contact_id=c.id)
  ORDER BY c.id`, [owner]);
// 此3 GiB历史库升级包含完整校验，回放只把打开等待放宽至10分钟；不跳过任何正式Worker校验。
async function openReplayStorage(options) {
  const worker = new Worker(new URL('../../src/storage/sqlite/worker.ts', import.meta.url),
    {workerData: options, execArgv: ['--experimental-strip-types']});
  let status;
  try {
    status = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('replay_open_timeout')); }, 600_000);
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('message', message => {
        clearTimeout(timer);
        if (message.code) reject(Object.assign(new Error(message.code), {code: message.code})); else resolve(message.value);
      });
    });
  } catch (error) { await worker.terminate(); throw error; }
  let nextId = 0;
  const execute = (name, input) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { worker.off('message', listener); reject(new Error('replay_action_timeout')); }, 30_000);
    const listener = message => {
      if (message.id !== id || message.started) return;
      clearTimeout(timer); worker.off('message', listener);
      if (message.code) reject(Object.assign(new Error(message.code), {code: message.code})); else resolve(message.value);
    };
    worker.on('message', listener); worker.postMessage({id, name, input, lease: status});
  });
  return {execute, close: async () => { try { await execute('storage.close', {}); } finally { await worker.terminate(); } }};
}
let storage;
let shared;
const result = {mode, backupBytes: original.size, candidates: candidates.length, eligible: 0, ok: 0, denied: 0,
  ineligible: 0, errorCodes: {}, bodyOperations: 0};
const started = performance.now();
try {
  storage = await openReplayStorage({userData, intent: 'open', expectedDatabaseId: identity.database_id, role: identity.role});
  if (mode === 'native') shared = new SharedWechatClient(() => loadSharedNarrowWechatOptions(executable));
  for (const contact of candidates) {
    if (result.eligible >= limit) break;
    let token;
    try { token = await storage.execute('identity.eligibility', {ownerId: owner, contactId: contact.id}); }
    catch { result.ineligible++; continue; }
    result.eligible++;
    try {
      let report, target;
      if (mode === 'saved') {
        const previous = one(`SELECT support_json,target_json FROM read_goal WHERE owner_id=? AND contact_id=?
          ORDER BY creation_no DESC,created_at DESC,id DESC LIMIT 1`, [owner, contact.id]);
        if (!previous) reject('saved_evidence_missing');
        report = JSON.parse(previous.support_json); target = JSON.parse(previous.target_json);
      } else {
        const scope = one(`SELECT a.external_key accountKey,c.external_key conversationKey
          FROM channel_conversation c JOIN channel_account a ON a.owner_id=c.owner_id AND a.id=c.account_id
          WHERE c.owner_id=? AND c.id=?`, [owner, token.conversation_id]);
        ({report, target} = await shared.run(contact.id, async native => {
          // 明确拒绝所有正文/图片/引用/边界读取，防止回放器以后意外扩张。
          for (const name of ['pageSelected', 'tailSelected', 'quarantinePageSelected', 'openImageSelected', 'readImageSelected', 'readQuoteSelected', 'boundarySnapshotSelected']) {
            native[name] = () => { result.bodyOperations++; reject('body_operation_forbidden'); };
          }
          const resolved = await native.resolveSelected(scope.conversationKey);
          assert.equal(resolved.accountKey, scope.accountKey);
          assert.equal(resolved.conversationKey, scope.conversationKey);
          assert.equal(resolved.sourceGeneration, token.source_generation);
          await native.inspectSelected();
          return {report: await native.supportSelected(), target: await native.targetSelected()};
        }));
      }
      const accepted = await storage.execute('history.prepareNormalUseGuard', {token, report, target, guardId: randomUUID()});
      if (accepted?.ok) result.ok++; else result.denied++;
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'metadata_replay_failed';
      result.errorCodes[code] = (result.errorCodes[code] ?? 0) + 1;
    }
  }
} finally {
  await shared?.close();
  await storage?.close();
}
result.elapsedMs = Math.round(performance.now() - started);
result.before = before;
result.after = counts();
const final = statSync(backup);
result.backupUnchanged = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => final[key] === original[key]);
console.log(JSON.stringify(result));
assert.equal(result.backupUnchanged, true, '原备份身份和修改时间不变');
assert.equal(result.bodyOperations, 0, '零正文、引用、图片或边界操作');
assert.equal(result.eligible, expected, '有效联系人总数');
assert.equal(result.ok, expected, '全部元数据握手成功');
assert.equal(result.denied, 0, '无重验拒绝');
assert.deepEqual(result.errorCodes, {}, '无重验错误');
assert.deepEqual(result.after, result.before, '围栏、绑定、消息、目标、抓取数量不变');
