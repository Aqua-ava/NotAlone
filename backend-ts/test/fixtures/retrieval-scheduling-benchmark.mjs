/** 真实本机模型的调度对照；资料和存储均为合成，不连接业务库或外部模型。 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {extname, isAbsolute} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createLocalEmbedding, embeddingSnapshot} from '../../src/retrieval/retrieval-embedding.ts';
import {createLocalEmbeddingLifecycle, projectEmbeddingCache} from '../../src/platform/models/local-embedding-lifecycle.ts';
import {ActiveHolders} from '../../src/storage/sqlite/deletion/holders.ts';
import {RETRIEVAL_MODEL_FINGERPRINT} from '../../src/retrieval/sqlite/contracts.ts';

const project = fileURLToPath(new URL('../../../', import.meta.url));
const options = {samples: 5, batchSizes: [1, 2, 4, 8], workloads: ['short', 'long', 'mixed'], snapshot: embeddingSnapshot(projectEmbeddingCache(project))};
const arguments_ = process.argv.slice(2);
for (let n = 0; n < arguments_.length; n += 2) {
  const [key, value] = arguments_.slice(n, n + 2);
  if (!value) throw new Error('参数必须成对提供：--samples N --batch-sizes 1,2,4,8 --workloads short,long,mixed（可选ascii） [--snapshot 绝对路径] [--runtime-module 绝对路径.mjs] [--compare-runtime-module 绝对路径.mjs]');
  if (key === '--samples') options.samples = Number(value);
  else if (key === '--batch-sizes') options.batchSizes = value.split(',').map(Number);
  else if (key === '--workloads') options.workloads = value.split(',');
  else if (key === '--snapshot') {assert.ok(isAbsolute(value), 'snapshot 必须为绝对路径'); options.snapshot = value;}
  else if (key === '--runtime-module') {assert.ok(isAbsolute(value) && extname(value) === '.mjs', 'runtime-module 必须为绝对路径.mjs'); options.runtimeModule = value;}
  else if (key === '--compare-runtime-module') {assert.ok(isAbsolute(value) && extname(value) === '.mjs', 'compare-runtime-module 必须为绝对路径.mjs'); options.compareRuntimeModule = value;}
  else throw new Error('未知基准参数：' + key);
}
assert.ok(Number.isInteger(options.samples) && options.samples >= 1 && options.samples <= 30, 'samples 必须为 1–30');
assert.ok(options.batchSizes.length > 0 && options.batchSizes.every(n => [1, 2, 4, 8].includes(n)) && new Set(options.batchSizes).size === options.batchSizes.length, 'batch-sizes 只能是互不重复的 1、2、4、8');
assert.ok(options.workloads.length > 0 && options.workloads.every(name => ['short', 'long', 'mixed', 'ascii'].includes(name)) && new Set(options.workloads).size === options.workloads.length, 'workloads 只能是互不重复的 short、long、mixed、ascii');
const runtimes = [];
for (const [runtimeLabel, runtimeSource] of [['current', options.runtimeModule ?? fileURLToPath(new URL('../../src/retrieval/index-runtime.ts', import.meta.url))],
  ...(options.compareRuntimeModule ? [['comparison', options.compareRuntimeModule]] : [])]) {
  const runtime = await import(pathToFileURL(runtimeSource).href);
  assert.equal(typeof runtime.createRetrievalIndex, 'function', 'runtime-module 必须导出 createRetrievalIndex');
  runtimes.push({runtimeLabel, runtimeSource, runtimeCodeSHA256: createHash('sha256').update(await readFile(runtimeSource)).digest('hex'), createFactory: runtime.createRetrievalIndex});
}
const [{runtimeSource, runtimeCodeSHA256}] = runtimes;

const query = '上次约好的周末安排有哪些需要注意的事情？';
const subjects = ['周末一起去公园散步', '晚饭提前确认时间', '临时改期需要提前说', '出门前记得查看天气', '聚会结束后告知平安', '共同计划保留休息时间', '遇到分歧先解释想法', '下次见面再讨论细节'];
const short = subjects.map((text, n) => `合成资料第${n + 1}条：${text}。`);
const long = short.map(text => text + '这是一段用于性能测量的合成中文背景。双方沟通安排时应核对时间、地点、天气和各自状态，遇到变化及时说明，不推断未经确认的承诺。'.repeat(12));
const inputs = {short, long, mixed: [], ascii: short.map((_, n) => 'synthetic' + n + 'a'.repeat(2000))};
const queryBudgetMs = 5000, caseTimeoutMs = 45000;
const scope = {contactId: 'synthetic-contact', kind: 'history', generation: 0n};

function syntheticStorage(texts) {
  const pending = texts.map((text, n) => ({docId: String(n + 1), id: String(n + 1), kind: 'history', contactId: scope.contactId,
    text, bodySeal: 'synthetic-seal-' + n, generation: 0n, modelFingerprint: RETRIEVAL_MODEL_FINGERPRINT,
    holderKeys: ['synthetic-doc:' + n], coversAllContacts: false}));
  return {async execute(name, input) {
    if (name === 'retrieval.syncTextBatch') return {processed: 0, remaining: 0};
    if (name === 'retrieval.coverage') return {indexIncomplete: pending.length > 0};
    if (name === 'retrieval.claimVectorBatch') return {items: pending.slice(0, input.limit), remaining: Math.max(0, pending.length - input.limit)};
    if (name === 'retrieval.commitVectorBatch') {
      for (const row of input.items) {
        const index = pending.findIndex(item => item.docId === row.docId);
        assert.notEqual(index, -1, '不能提交不在待办中的合成资料');
        pending.splice(index, 1);
      }
      return {committed: input.items.length, rejected: 0};
    }
    assert.fail('基准不支持动作：' + name);
  }};
}

function bounded(work, label, abort) {
  let timer;
  const timeout = new Promise((_, reject) => {timer = setTimeout(() => {
    const error = new Error(label + ' 超过单样本等待上限'); abort?.(error); reject(error);
  }, caseTimeoutMs);});
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

let observation, encode;
const embedding = createLocalEmbeddingLifecycle(async () => {
  const model = await createLocalEmbedding(options.snapshot);
  encode = model.encode;
  return {async embed(texts) {
    const observed = observation;
    const call = {kind: texts.length === 1 && texts[0] === query ? 'query' : 'backfill', count: texts.length, startedAt: performance.now()};
    observed?.calls.push(call);
    try {
      // 调用返回 Promise 时，真实 session.run 已发起；此后才释放并发查询闸门。
      const inference = model.embed(texts);
      if (call.kind === 'backfill') observed?.backfillStarted.resolve();
      return await inference;
    } finally {call.elapsedMs = performance.now() - call.startedAt;}
  }, close: () => model.close()};
});

async function measure(mode, texts, batchSize, createFactory) {
  const calls = [], backfillStarted = Promise.withResolvers(), controller = new AbortController();
  observation = {calls, backfillStarted};
  const index = createFactory({storage: syntheticStorage(mode === 'idle' ? [] : texts), ownerId: 'synthetic-owner', holders: new ActiveHolders(),
    batchSize, embed: value => embedding.embed(value)});
  let filling, backfillElapsedMs, queryAt, queryElapsedMs, outcome;
  const startedAt = performance.now();
  try {
    if (mode !== 'idle') {
      filling = index.flushForTests().finally(() => {backfillElapsedMs = performance.now() - startedAt;});
      void filling.catch(() => {});
    }
    if (mode === 'busy') await bounded(Promise.race([backfillStarted.promise, filling.then(() => {throw new Error('后台未开始推理便结束');})]), '后台开始', error => controller.abort(error));
    if (mode !== 'backfill-only') {
      queryAt = performance.now();
      try {
        const result = await bounded(index.queryVector(query, AbortSignal.any([controller.signal, AbortSignal.timeout(queryBudgetMs)]), scope), '前台查询', error => controller.abort(error));
        outcome = {strategy: result.strategy, indexIncomplete: result.indexIncomplete, timedOut: false};
      } catch (error) {
        if (error?.name !== 'TimeoutError') throw error;
        outcome = {strategy: null, indexIncomplete: null, timedOut: true};
      }
      queryElapsedMs = performance.now() - queryAt;
    }
    if (filling) await bounded(filling, '后台回填', error => controller.abort(error));
    const elapsedMs = performance.now() - startedAt;
    // 超时只结束查询等待；真实推理排空后才汇总模型工作量。
    await index.close();
    const queryCall = calls.find(call => call.kind === 'query');
    return {mode, elapsedMs, ...(filling ? {backfillElapsedMs} : {}), ...(outcome ? {...outcome, queryElapsedMs, queueMs: queryCall ? Math.max(0, queryCall.startedAt - queryAt) : null,
      exceededFiveSeconds: outcome.timedOut || queryElapsedMs >= queryBudgetMs} : {}),
      modelEmbedMs: calls.reduce((sum, call) => sum + call.elapsedMs, 0), modelCalls: calls.length,
      backfillCalls: calls.filter(call => call.kind === 'backfill').length,
      calls: calls.map(({kind, count, elapsedMs, startedAt: at}) => ({kind, count, elapsedMs, offsetMs: at - startedAt}))};
  } finally {
    controller.abort(new Error('基准样本结束'));
    await index.close();
    if (filling) await filling.catch(() => {});
    observation = undefined;
  }
}

function rotated(values, n) {
  const offset = n % values.length, result = [...values.slice(offset), ...values.slice(0, offset)];
  return n % 2 ? result.reverse() : result;
}
function stats(values) {
  const sorted = values.filter(value => typeof value === 'number').sort((a, b) => a - b);
  const value = p => sorted.length ? Number(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)].toFixed(3)) : null;
  return {samples: sorted.length, p50: value(.5), p95: value(.95)};
}

const details = [], tokenLengths = {};
try {
  // 首次加载和各张量形状的热身均不计入样本；所有内容为本文件固定合成资料。
  await bounded(embedding.embed([query]), '模型加载与热身');
  inputs.mixed = [31, 54, 77, 123, 192, 284, 468, 512].map((target, n) => {
    let low = 1, high = long[n].length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const count = encode([long[n].slice(0, middle)]).mask[0].reduce((sum, value) => sum + value, 0);
      if (count <= target) low = middle; else high = middle - 1;
    }
    return long[n].slice(0, low);
  });
  for (const workload of options.workloads) {
    tokenLengths[workload] = encode(inputs[workload]).mask.map(row => row.reduce((sum, value) => sum + value, 0));
    for (const size of options.batchSizes) await bounded(embedding.embed(inputs[workload].slice(0, size)), '批形状热身');
  }
  for (let sample = 0; sample < options.samples; sample++) {
    for (const workload of rotated(options.workloads, sample)) {
      for (const batchSize of rotated(options.batchSizes, sample)) {
        for (const selected of rotated(runtimes, sample)) {
          const result = {sample: sample + 1, workload, batchSize, runtimeLabel: selected.runtimeLabel};
          for (const mode of sample % 2 ? ['backfill-only', 'busy', 'idle'] : ['idle', 'busy', 'backfill-only']) result[mode] = await measure(mode, inputs[workload], batchSize, selected.createFactory);
          details.push(result);
        }
      }
    }
  }
} finally {await embedding.close();}

const summary = runtimes.flatMap(({runtimeLabel}) => options.workloads.flatMap(workload => options.batchSizes.map(batchSize => {
  const rows = details.filter(row => row.runtimeLabel === runtimeLabel && row.workload === workload && row.batchSize === batchSize);
  return {runtimeLabel, workload, batchSize, samples: rows.length,
    idleQueryMs: stats(rows.map(row => row.idle.queryElapsedMs)), busyQueryMs: stats(rows.map(row => row.busy.queryElapsedMs)),
    busyQueueMs: stats(rows.map(row => row.busy.queueMs)), busyBackfillMs: stats(rows.map(row => row.busy.backfillElapsedMs)),
    backgroundOnlyMs: stats(rows.map(row => row['backfill-only'].backfillElapsedMs)),
    idleModelEmbedMs: stats(rows.map(row => row.idle.modelEmbedMs)), busyModelEmbedMs: stats(rows.map(row => row.busy.modelEmbedMs)),
    backgroundOnlyModelEmbedMs: stats(rows.map(row => row['backfill-only'].modelEmbedMs)),
    modelCalls: rows.map(row => ({idle: row.idle.modelCalls, busy: row.busy.modelCalls, backgroundOnly: row['backfill-only'].modelCalls})),
    busyStrategies: rows.reduce((counts, row) => {const key = row.busy.strategy ?? 'timeout'; counts[key] = (counts[key] ?? 0) + 1; return counts;}, {}),
    exceededFiveSeconds: rows.filter(row => row.busy.exceededFiveSeconds).length};
})));
console.log(JSON.stringify({node: process.version, runtimeSource, runtimeCodeSHA256, samples: options.samples, batchSizes: options.batchSizes, workloads: options.workloads,
  runtimes: runtimes.map(({createFactory, ...metadata}) => metadata),
  queryBudgetMs, caseTimeoutMs, tokenLengths, queryTokens: encode([query]).mask[0].reduce((sum, value) => sum + value, 0),
  measurement: '真实固定CPU ONNX与正式调度生命周期；合成内存storage代理，不含SQLite、业务来源核验、模型加载或外部模型。modelEmbedMs包含分词、张量构建、ONNX及归一化，不含lane排队。',
  order: '同一已预热模型会话内逐样本交错runtime、batch与workload顺序，奇偶轮反转测量模式；p50/p95使用nearest-rank。', summary, details}, null, 2));
