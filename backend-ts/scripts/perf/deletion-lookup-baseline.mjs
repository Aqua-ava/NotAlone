#!/usr/bin/env node
/**
 * 联系人删除计划反查性能基线（runtime-waste-cleanup-20261106 任务 02）。
 *
 * 在同一套确定性合成数据上：
 *   1. 先通过 `SqliteStorage.open(create)` 走产品迁移路径建库（不手工拼迁移 SQL，也不进 App），
 *      关闭后在同一文件上直接打开连接做种子与测量；
 *   2. 直接调用统一删除的真实计划路径 `planDeletion`（`installedDeletionRegistration`），
 *      记录 deletion.plan 的 P50/P95；每次运行换新 requestKey，保证走完整 fence+collect；
 *   3. 记录三个反查查询的 `EXPLAIN QUERY PLAN`（任务 02 的三个调用点）；
 *   4. `--golden-out=<path>` 保存按 target_no 顺序的 deletion_target 黄金集；
 *      `--golden-check=<path>` 断言当前结果与黄金集逐项一致（行类型＋行键＋顺序）。
 *
 * 直接执行 planDeletion 是为了绕开存储 Worker 的 15 秒动作预算：修改前的大联系人计划会越过
 * 预算被 worker 杀掉，脚本需要测出实际耗时做前后对比；对照真实 Worker 预算的差异在报告里如实说明。
 * 事务、语句缓存、FK/WAL/FULL 等设置与产品 worker 一致，保证每条 SQL 的执行形态与 worker 相同。
 *
 * 用法（在 backend-ts/）：
 *   node scripts/perf/deletion-lookup-baseline.mjs --profile=smoke
 *   node scripts/perf/deletion-lookup-baseline.mjs --profile=large --golden-out=/tmp/before.json
 *   node scripts/perf/deletion-lookup-baseline.mjs --profile=large --golden-check=/tmp/before.json
 *
 * 只读写临时目录中的合成库；不启动 App、不访问网络、不读取真实聊天资料；退出时删除临时目录。
 */
import {mkdtemp, rm, readFile, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {SqliteStorage} from '../../src/storage/sqlite/client.ts';
import {planDeletion} from '../../src/storage/sqlite/deletion/actions.ts';
import {installedDeletionRegistration} from '../../src/storage/sqlite/deletion/registration.ts';

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));
const profiles = {
  // 冒烟夹具：秒级完成，验证脚本与黄金集逻辑。
  smoke: {largeMessages: 200, fillerContacts: 3, fillerMessages: 100, runs: 3},
  // 基准夹具：大联系人 3000 条消息＋40 位填充联系人各 1000 条，把 owner 分区撑到真实库量级（约 4.3 万消息）。
  large: {largeMessages: 3000, fillerContacts: 40, fillerMessages: 1000, runs: 5},
};
const config = profiles[args.get('profile') ?? 'large'];
if (!config) throw new Error(`未知 profile，可选：${Object.keys(profiles).join(', ')}`);
const runs = Number(args.get('runs') ?? config.runs);
if (!Number.isSafeInteger(runs) || runs < 2) throw new Error('--runs 必须是 ≥2 的整数');
const goldenOut = args.get('golden-out');
const goldenCheck = args.get('golden-check');

const OWNER = 'perf-owner-0000';
const ACCOUNT = 'perf-account-0000';
const LARGE_CONTACT = 'perf-contact-large';
const hex64 = '0'.repeat(64);
const at = 0;
const pad = (value, width = 8) => String(value).padStart(width, '0');

async function openProductDatabase() {
  // 临时目录只放合成数据；真实库 red-line：本脚本不触碰真实库。
  // 与测试夹具一致：/var 是软链，存储要求传入的是真实路径。
  return realpath(await mkdtemp(join(tmpdir(), 'notalone-deletion-baseline-')));
}

/** 显示序号由脚本维护，避免 INSERT 内子查询；总量即种子总数。 */
async function seed(db, config) {
  const {largeMessages, fillerContacts, fillerMessages} = config;
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY;`);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO owner(owner_id,state,read_enabled,read_epoch,created_at) VALUES(?, 'active', 1, 1, ?)`).run(OWNER, at);
    db.prepare(`INSERT INTO channel_account(owner_id,id,identity_scheme,external_key,identity_state,source_generation,scope_mode)
      VALUES(?,?, 'wechat.account.v1', ?, 'verified', 'perf-1', 'selected')`).run(OWNER, ACCOUNT, 'perf-account');
    const contacts = [[LARGE_CONTACT, largeMessages]];
    for (let index = 0; index < fillerContacts; index++) contacts.push([`${LARGE_CONTACT}-${pad(index)}`, fillerMessages]);
    let displayNo = 0;
    const conversation = db.prepare(`INSERT INTO channel_conversation(owner_id,id,account_id,identity_scheme,external_key)
      VALUES(?,?,?, 'wechat.conversation.v1', ?)`);
    const binding = db.prepare(`INSERT INTO conversation_binding(owner_id,id,contact_id,conversation_id,identity_generation,state)
      VALUES(?,?,?,?,0,'verified')`);
    const verification = db.prepare(`INSERT INTO binding_verification(owner_id,id,binding_id,identity_generation,method,proof_format,proof,verified_at)
      VALUES(?,?,?,?, 'channel_metadata', 'identity-metadata-v1', ?, ?)`);
    const grant = db.prepare(`INSERT INTO read_grant(owner_id,id,contact_id,binding_id,verification_id,selection_generation,granted_at)
      VALUES(?,?,?,?,?,1,?)`);
    const goal = db.prepare(`INSERT INTO read_goal(owner_id,id,contact_id,binding_id,grant_id,accepted_data_generation,accepted_barrier_generation,
      kind,target_protocol,target_descriptor,target_json,eligibility_json,support_json,state,coverage_state,completed_partitions,created_at)
      VALUES(?,?,?,?,?,1,0,'history', 'perf-protocol', 'perf','{}','{}','{}','complete','complete','[]',?)`);
    const capture = db.prepare(`INSERT INTO sync_capture(owner_id,id,contact_id,goal_id,read_epoch,runtime_token,captured_at,adapter_version,state,response_digest)
      VALUES(?,?,?,?,1,'perf',?, 'perf-1', 'accepted', ?)`);
    const message = db.prepare(`INSERT INTO message(owner_id,id,contact_id,binding_id,identity_scheme,external_key,sender_role,kind,text_body,
      original_type,sent_at,time_precision,display_no,availability)
      VALUES(?,?,?,?, 'source-table-local-v1', ?, 'contact', 'text', ?, ?, ?, 'millisecond', ?, 'available')`);
    const aliasLocal = db.prepare(`INSERT INTO message_alias(owner_id,id,contact_id,binding_id,scheme,external_key,message_id)
      VALUES(?,?,?,?,'local',?,?)`);
    const aliasServer = db.prepare(`INSERT INTO message_alias(owner_id,id,contact_id,binding_id,scheme,external_key,message_id)
      VALUES(?,?,?,?,'server',?,?)`);
    const captureRecord = db.prepare(`INSERT INTO capture_record(owner_id,id,contact_id,capture_id,item_no,state,message_id,raw_payload,
      observed_scheme,observed_key,normalizer_version,reason_code,availability)
      VALUES(?,?,?,?,?, 'normalized', ?, '{}', 'source-table-local-v1', ?, 'perf-1', NULL, 'available')`);
    for (const [contactIndex, [contactId, messageCount]] of contacts.entries()) {
      const suffix = contactIndex === 0 ? '' : `-${pad(contactIndex)}`;
      const conversationId = `perf-conv${suffix}`, bindingId = `perf-binding${suffix}`;
      const verificationId = `perf-verification${suffix}`, grantId = `perf-grant${suffix}`;
      const goalId = `perf-goal${suffix}`, captureId = `perf-capture${suffix}`;
      db.prepare(`INSERT INTO contact(owner_id,id,display_name,selection_generation,data_generation) VALUES(?,?,?,1,2)`)
        .run(OWNER, contactId, `合成联系人${suffix}`);
      conversation.run(OWNER, conversationId, ACCOUNT, `perf-conversation-key${suffix}`);
      binding.run(OWNER, bindingId, contactId, conversationId);
      verification.run(OWNER, verificationId, bindingId, 0, JSON.stringify({support_profile: 'perf', source_generation: 'perf-1'}), at);
      grant.run(OWNER, grantId, contactId, bindingId, verificationId, at);
      goal.run(OWNER, goalId, contactId, bindingId, grantId, at);
      capture.run(OWNER, captureId, contactId, goalId, at, hex64);
      for (let item = 0; item < messageCount; item++) {
        // capture_record.item_no 有 <1000 的检查：每满 1000 条消息开一条新 sync_capture。
        let captureIdForItem = captureId;
        if (item >= 1000) {
          captureIdForItem = `${captureId}-${Math.floor(item / 1000)}`;
          if (item % 1000 === 0) capture.run(OWNER, captureIdForItem, contactId, goalId, at, hex64);
        }
        const messageId = `perf-msg${suffix}-${pad(item + 1)}`;
        const externalKey = JSON.stringify({source_generation: 'perf-1', partition: 'p', table: 't', local_id: messageId});
        displayNo++;
        message.run(OWNER, messageId, contactId, bindingId, externalKey, `合成消息 ${displayNo}`, '1', String(at * 1000), displayNo);
        aliasLocal.run(OWNER, `perf-alias${suffix}-l${pad(item + 1)}`, contactId, bindingId, externalKey, messageId);
        aliasServer.run(OWNER, `perf-alias${suffix}-s${pad(item + 1)}`, contactId, bindingId, `perf-server-key${suffix}-${item + 1}`, messageId);
        captureRecord.run(OWNER, `perf-record${suffix}-${pad(item + 1)}`, contactId, captureIdForItem, item % 1000, messageId, externalKey);
      }
    }
    db.exec('COMMIT');
    return displayNo;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 与 storage worker 相同的语句缓存形态（statement.setReadBigInts）：每条 SQL 只 prepare 一次。 */
function preparedSet(db) {
  const cache = new Map();
  return sql => {
    let statement = cache.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statement.setReadBigInts(true);
      cache.set(sql, statement);
    }
    return statement;
  };
}

function transactionAdapter(db) {
  const statement = preparedSet(db);
  return {
    run: (sql, values = []) => statement(sql).run(...values),
    get: (sql, values = []) => statement(sql).all(...values)[0],
    all: (sql, values = []) => statement(sql).all(...values),
  };
}

/** 按目标序号导出黄金集：行类型＋行键＋身份摘要＋顺序。 */
function goldenRows(db, operationId) {
  const statement = preparedSet(db)(`SELECT target_no,storage_kind,domain,row_kind,row_key_snapshot,expected_identity
    FROM deletion_target WHERE operation_id=? ORDER BY target_no`);
  return statement.all(operationId)
    .map(row => ({target_no: Number(row.target_no), storage_kind: row.storage_kind, domain: row.domain,
      row_kind: row.row_kind, row_key_snapshot: row.row_key_snapshot, expected_identity: row.expected_identity}));
}

function runPlan(db, runIndex) {
  const lease = {databaseId: 'perf-synthetic-lease', runtimeId: 'perf-synthetic-runtime'};
  const tx = transactionAdapter(db);
  db.exec('BEGIN IMMEDIATE');
  const started = performance.now();
  try {
    const snapshot = planDeletion(tx, lease, installedDeletionRegistration,
      {ownerId: OWNER, requestKey: `perf-request-${pad(runIndex)}`, scope: {kind: 'contact', contactId: LARGE_CONTACT}});
    return {ms: performance.now() - started, operationId: snapshot.operationId, state: snapshot.state,
      targetCount: snapshot.targets.length, planRevision: String(snapshot.planRevision)};
  } finally {
    db.exec('COMMIT');
  }
}

function stats(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const quantile = q => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return {samples: samples.length, p50Ms: Math.round(quantile(0.5)), p95Ms: Math.round(quantile(0.95)),
    maxMs: Math.round(sorted.at(-1)), meanMs: Math.round(samples.reduce((sum, v) => sum + v, 0) / samples.length)};
}

async function main() {
  const root = await openProductDatabase();
  try {
    const storage = await SqliteStorage.open({userData: root, intent: 'create', role: 'test'});
    const databaseId = storage.status.databaseId;
    await storage.close();
    // 每条语句显式 setReadBigInts（见 preparedSet），与 worker 的整数读取形态一致。
    const db = new DatabaseSync(join(root, 'managed/sqlite/notalone.sqlite'));
    try {
      const messageCount = await seed(db, config);
      const dataset = {};
      for (const [table, sql] of [['message', 'SELECT count(*) n FROM message'],
        ['message_alias', 'SELECT count(*) n FROM message_alias'], ['capture_record', 'SELECT count(*) n FROM capture_record'],
        ['read_goal', 'SELECT count(*) n FROM read_goal']]) dataset[table] = Number(db.prepare(sql).get().n);
      dataset.contacts = config.fillerContacts + 1;

      const results = [];
      let lastOperationId;
      for (let run = 1; run <= runs; run++) {
        const result = runPlan(db, run);
        lastOperationId = result.operationId;
        results.push({...result, planMs: Math.round(result.ms)});
      }
      const timing = stats(results.map(r => r.ms));

      const probeMessage = db.prepare(`SELECT id,contact_id FROM message WHERE owner_id=? AND contact_id=? LIMIT 1`)
        .get(OWNER, LARGE_CONTACT);
      const explain = (sql, values) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values)
        .map(row => String(row.detail));
      const plans = {
        capture_record_by_message: explain('SELECT id FROM capture_record WHERE owner_id=? AND message_id=?', [OWNER, probeMessage.id]),
        capture_record_contact_message: explain('SELECT id FROM capture_record WHERE owner_id=? AND contact_id=? AND message_id=?', [OWNER, probeMessage.contact_id, probeMessage.id]),
        capture_record_contact_message_indexed: explain('SELECT id FROM capture_record INDEXED BY capture_record_message WHERE owner_id=? AND contact_id=? AND message_id=?', [OWNER, probeMessage.contact_id, probeMessage.id]),
        message_alias_by_message: explain('SELECT * FROM message_alias WHERE owner_id=? AND message_id=?', [OWNER, probeMessage.id]),
      };

      const report = {profile: args.get('profile') ?? 'large', node: process.version, runs,
        databaseId, config, dataset: {...dataset, total_messages: messageCount},
        plan_runs: results.map(({ms, ...rest}) => ({...rest, ms: Math.round(ms)})),
        plan_timing: timing, plans};

      const currentGolden = goldenRows(db, lastOperationId);
      report.goldenRows = currentGolden.length;
      if (goldenOut) {
        await writeFile(goldenOut, `${JSON.stringify({profile: report.profile, config, dataset: report.dataset, rows: currentGolden}, null, 1)}\n`);
        report.goldenOut = goldenOut;
      }
      if (goldenCheck) {
        const expected = JSON.parse(await readFile(goldenCheck, 'utf8')).rows;
        report.goldenCheck = {file: goldenCheck, expectedRows: expected.length, equal:
          JSON.stringify(expected) === JSON.stringify(currentGolden)};
        if (!report.goldenCheck.equal) {
          const firstDiff = expected.findIndex((row, index) => !currentGolden[index] ||
            JSON.stringify(row) !== JSON.stringify(currentGolden[index]));
          report.goldenCheck.firstDiffIndex = firstDiff;
          report.goldenCheck.expectedAt = expected[firstDiff];
          report.goldenCheck.currentAt = currentGolden[firstDiff];
        }
      }
      console.log(JSON.stringify(report, null, 2));
      if (goldenCheck && !report.goldenCheck.equal) throw new Error('黄金集不一致：计划输出与修改前基线不同');
    } finally {
      db.close();
    }
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

await main();
