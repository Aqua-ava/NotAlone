// 合成业务工作负载；实际 SQLite/来源核验/同步/提取，模型端使用固定合成响应，不联网。
import { performance } from 'node:perf_hooks';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fixture, owner, record, modelPort } from '../test/fixtures/memory-sqlite/support.mjs';
import { supplier } from '../test/fixtures/memory-management/supplier.mjs';
import { SqliteMemoryExtraction } from '../src/memory/sqlite/service.ts';
import { SqliteMemoryManagement } from '../src/memory/sqlite/management/service.ts';
import { configureDiagnosticLog, withDiagnosticTrace, newTraceId } from '../src/diagnostics/unified.ts';
import { readDiagnosticRecords } from '../src/diagnostics/unified-log.mjs';
const count = Number(process.env.NOTALONE_DIAGNOSTIC_SAMPLES ?? 12);
const quantile = (samples, fraction) => [...samples].sort((a, b) => a - b)[Math.min(samples.length - 1, Math.floor(samples.length * fraction))];
const summarize = samples => ({ n: samples.length, meanMs: samples.reduce((sum, n) => sum + n, 0) / samples.length, p50Ms: quantile(samples, 0.5), p95Ms: quantile(samples, 0.95) });
const cleanup = [], contexts = [];
try {
  for (const enabled of [false, true]) {
    const f = await fixture({ after: work => cleanup.push(work) }, { registryModule: new URL('../test/fixtures/memory-management/registry.mjs', import.meta.url).href });
    await chmod(f.root, 0o700);
    const management = new SqliteMemoryManagement(f.storage, owner), contactId = f.saved[0].contact_id;
    await management.decide({ requestKey: 'diagnostic-benchmark-manual', action: 'manual', scope: { scopeKind: 'contact', contactId }, body: '合成的长期资料' });
    let extraction; const syntheticModel = modelPort(() => extraction.accounting, supplier().respond); extraction = new SqliteMemoryExtraction(f.storage, owner, syntheticModel); cleanup.push(() => extraction.close());
    contexts.push({ ...f, enabled, contactId, management, extraction, syntheticModel, diagnosticStats: { rejected: 0, dropped: 0 }, measurements: { management: [], sync: [], extraction: [] } });
  }
  // 先执行一轮预热，随后交替顺序降低缓存与执行次序偏差。
  for (let iteration = -1; iteration < count; iteration++) {
    for (const f of iteration % 2 ? [...contexts].reverse() : contexts) {
      const log = configureDiagnosticLog(f.root, { proc: 'backend', development: true }); if (!await log.setEnabled(f.enabled)) throw new Error('diagnostic_benchmark_switch_failed');
      async function measured(name, module, work) {
        const traceId = newTraceId(), started = performance.now();
        await withDiagnosticTrace(traceId, async () => { log.diagnose({ event: 'request.started', module, traceId }); await work(); log.diagnose({ event: 'request.finished', module, traceId, durationMs: performance.now() - started }); });
        const elapsed = performance.now() - started; await log.flush(); if (!log.stats().available) throw new Error('diagnostic_benchmark_writer_unavailable'); if (iteration >= 0) f.measurements[name].push(elapsed);
      }
      await measured('management', 'memory.management', async () => { await f.management.read({ scopeKind: 'contact', contactId: f.contactId }); });
      f.channel.page = async () => ({ target: f.target.descriptor, cursorIn: null, cursorOut: null, records: [record(String(iteration + 100), { text: '我长期住在合成城市。' })], completedPartitions: ['shard-a'], exhausted: true });
      await measured('sync', 'history.sync', () => f.service.synchronize(f.contactId));
      await measured('extraction', 'memory.processing', async () => { const started = await f.extraction.start(`diagnostic-benchmark-${iteration + 1}`); await f.extraction.waitForIdle(); await f.extraction.read(started.runId); });
      await log.close(); const stats = log.stats(); f.diagnosticStats.rejected += stats.rejected; f.diagnosticStats.dropped += stats.dropped;
    }
  }
  const workloads = [];
  for (const f of contexts) {
    const records = await readDiagnosticRecords(f.root), events = {}, internalModules = {};
    for (const row of records) {
      events[row.event] = (events[row.event] ?? 0) + 1;
      if (!['request.started', 'request.finished'].includes(row.event)) internalModules[row.module] = (internalModules[row.module] ?? 0) + 1;
    }
    if ((!f.enabled && records.length) || (f.enabled && !['memory.management', 'history.sync', 'memory.processing'].every(module => internalModules[module] > 0))) throw new Error('diagnostic_benchmark_coverage_invalid');
    workloads.push({ enabled: f.enabled, ...Object.fromEntries(Object.entries(f.measurements).map(([name, samples]) => [name, summarize(samples)])),
      modelCalls: f.syntheticModel.calls, diagnostics: { ...f.diagnosticStats, records: records.length, events, internalModules } });
  }
  if (workloads[0].modelCalls !== workloads[1].modelCalls) throw new Error('diagnostic_benchmark_model_workload_changed');
  console.log(JSON.stringify({ machine: `${process.platform}/${process.arch}`, node: process.version, samples: count, model: 'synthetic-no-network', actualSqlite: true, level: 'debug', notes: '耗时包含正常SQLite/同步/提取入口及最终内部诊断校验、排队与并发写盘；样本间flush不计入业务耗时。已核对开关状态、写者可用性、三模块内部事件与相同合成模型调用数。', workloads }));
  const startup = { baseline: [], disabled: [], enabled: [] };
  for (let iteration = 0; iteration < count; iteration++) for (const mode of ['baseline', 'disabled', 'enabled']) {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-diagnostic-startup-'))); await chmod(root, 0o700);
    try {
      if (mode === 'disabled') await writeFile(path.join(root, 'diagnostic-settings.json'), JSON.stringify({ enabled: false }), { mode: 0o600 });
      const module = new URL('../src/diagnostics/unified-log.mjs', import.meta.url).href;
      const code = `const start=performance.now();${mode === 'baseline' ? '' : `const {UnifiedDiagnosticLog}=await import(${JSON.stringify(module)});const log=new UnifiedDiagnosticLog(${JSON.stringify(root)},{proc:'main'});await log.flush();if(!log.stats().available)throw Error('diagnostic_startup_unavailable');await log.close();`}console.log(performance.now()-start);`;
      const start = performance.now(), child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
      if (child.status !== 0) throw new Error('startup_benchmark_failed'); startup[mode].push(performance.now() - start);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  console.log(JSON.stringify({ startup: Object.fromEntries(Object.entries(startup).map(([mode, values]) => [mode, summarize(values)])), scope: '冷Node进程+诊断模块导入/初始化；不是实际Electron/DSH启动验收' }));
} finally { for (const work of cleanup.reverse()) await work(); }
