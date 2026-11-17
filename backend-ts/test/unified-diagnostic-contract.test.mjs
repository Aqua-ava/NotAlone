import test from 'node:test';
import assert from 'node:assert/strict';
import { scanDiagnosticCallSites } from './support/diagnostic-call-sites.mjs';
import { diagnosticEvents, checkedDiagnosticEvent, checkedDiagnosticRecord } from '../src/diagnostics/unified-contract.mjs';
const traceId = '18c9347b-140e-4e63-9576-8b9383cf20fb';
test('统一诊断只接受注册事件和逐事件白名单，字段值不能携带任意正文', () => {
  const event = { event: 'request.finished', module: 'memory.management', traceId, durationMs: 12, caller: 'management_read' };
  assert.deepEqual(checkedDiagnosticEvent(event), event);
  for (const [key, value] of Object.entries({ text: '敏感合成正文', message: '敏感合成正文', stack: '敏感合成正文', path: '/private/synthetic', name: '敏感合成名称', reasonCode: '敏感合成正文', traceId: '敏感合成正文', caller: '敏感合成正文', contactPrefix: '敏感合成正文', durationMs: Infinity })) {
    assert.equal(checkedDiagnosticEvent({ ...event, [key]: value }), undefined, key);
  }
  assert.equal(checkedDiagnosticEvent({ event: 'unknown.event' }), undefined);
  assert.equal(checkedDiagnosticEvent({ event: 'scope.revision_changed', module: 'reply' }), undefined);
  assert.equal(checkedDiagnosticEvent(Object.defineProperty({ event: 'request.finished' }, 'module', { get() { throw new Error('不能读取getter'); } })), undefined);
  assert.equal(checkedDiagnosticEvent(new Error('敏感合成异常')), undefined);
  assert.equal(checkedDiagnosticEvent({ ...event, [Symbol('private')]: '正文' }), undefined);
});
test('每个注册事件最小输入均可校验且固定字段由宿主补齐', () => {
  for (const [event, schema] of Object.entries(diagnosticEvents)) {
    const input = { event, module: schema.module ?? 'memory.management' };
    const checked = checkedDiagnosticEvent(input);
    assert.ok(checked, event);
    const row = { ...checked, time: new Date(0).toISOString(), level: schema.level, proc: 'main' };
    assert.deepEqual(checkedDiagnosticRecord(row), row);
    assert.equal(checkedDiagnosticRecord({ ...row, hostname: 'private' }), undefined);
    assert.equal(checkedDiagnosticRecord({ ...row, level: 'arbitrary' }), undefined);
  }
});
test('诊断调用点扫描识别可选链与嵌套值，只核对日志对象自身字段', () => {
  const source = `
    const unrelated = { event: 'not.registered', payload: '不属于诊断调用' };
    const text = "diagnose({event:'fake.string', payload:'不是调用'})";
    /* recordUnifiedDiagnostic?.({ event: 'fake.comment', payload: 1 }); */
    diagnose({ event: 'request.finished', module: 'memory.management', traceId: makeTrace({ event: 'nested.value', payload: 1 }), durationMs });
    hooks.recordUnifiedDiagnostic?.({ event: 'processing.run_changed', runId, count: size({ nested: { secret: 1 } }), payload: 1 });
    this?.diagnose?.({ event: 'not.registered', count: 1 });
    recordUnifiedDiagnostic?.({ event: 'sql.summary', count, ['path']: '/synthetic' });
    diagnose({ event: 'request.finished', module: 'memory.management', metadata: { event: 'nested', body: 1 } });
  `;
  const result = scanDiagnosticCallSites(source);
  assert.equal(result.sites.length, 5);
  assert.deepEqual(result.sites[0].fields, ['event', 'module', 'traceId', 'durationMs']);
  assert.deepEqual(result.violations.map(({ event, key, reason }) => ({ event, key, reason })), [
    { event: 'processing.run_changed', key: 'payload', reason: 'unknown_field' },
    { event: 'not.registered', key: undefined, reason: 'unregistered_event' },
    { event: 'sql.summary', key: 'path', reason: 'unknown_field' },
    { event: 'request.finished', key: 'metadata', reason: 'unknown_field' },
  ]);
});
test('动态编号值正常通过，动态事件、参数与展开明确留给运行时验证', () => {
  const result = scanDiagnosticCallSites(`
    diagnose(variable);
    diagnose({ event: selectedEvent, count });
    recordUnifiedDiagnostic?.({ ...event });
    diagnose({ event: 'request.finished', traceId: newTraceId(), durationMs: elapsed({ count: 1 }), ...context });
    holder['recordUnifiedDiagnostic']?.({ event: 'sql.summary', sqlFingerprint: fingerprint, count: calculate(a, b) });
  `);
  assert.equal(result.sites.length, 4);
  assert.equal(result.deferredCalls, 4);
  assert.deepEqual(result.violations, []);
});
test('字段值中的模板插值和正则不改变顶层字段边界，缺少事件名仍会失败', () => {
  const result = scanDiagnosticCallSites([
    "diagnose({event:('request.finished') as const,traceId:`trace-${pick({secret:1})}`,durationMs:/[,{}]/.test('{') ? n : 0});",
    "recordUnifiedDiagnostic?.({event:'sql.summary',count: data.map(x => ({ nested: x })).length});",
    "diagnose({ count: 1 });",
  ].join('\n'));
  assert.equal(result.sites.length, 3);
  assert.deepEqual(result.sites[0].fields, ['event', 'traceId', 'durationMs']);
  assert.deepEqual(result.violations.map(item => item.reason), ['missing_event']);
});
test('真实TSX中的独立井号不会使诊断扫描停滞，末尾调用仍完整核验', async () => {
  const { spawnSync } = await import('node:child_process');
  const helper = new URL('./support/diagnostic-call-sites.mjs', import.meta.url).href;
  const file = new URL('../../desktop/src/renderer/SqliteCandidateReferences.tsx', import.meta.url).href;
  // 在子进程设明确边界，扫描器退化时直接失败，避免测试宿主无限分配 token。
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { scanDiagnosticCallSites } from ${JSON.stringify(helper)};
    const source = readFileSync(new URL(${JSON.stringify(file)}), 'utf8');
    const suffix = "\\ndiagnose({event:'sql.summary',count:1});";
    process.stdout.write(JSON.stringify([
      scanDiagnosticCallSites('#' + suffix),
      scanDiagnosticCallSites(source),
      scanDiagnosticCallSites(source + suffix),
    ]));
  `], { encoding: 'utf8', timeout: 2000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const [minimal, original, appended] = JSON.parse(result.stdout);
  assert.deepEqual(original, { sites: [], violations: [], deferredCalls: 0 });
  for (const scanned of [minimal, appended]) {
    assert.deepEqual(scanned.sites.map(({ event, fields }) => ({ event, fields })), [{ event: 'sql.summary', fields: ['event', 'count'] }]);
    assert.deepEqual(scanned.violations, []);
    assert.equal(scanned.deferredCalls, 0);
  }
});
test('所有产品诊断日志对象调用点只使用已注册事件与字段', async t => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { default: path } = await import('node:path');
  const roots = [new URL('../src/', import.meta.url), new URL('../../desktop/src/', import.meta.url)];
  let checked = 0, deferred = 0;
  async function visitDirectory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visitDirectory(file); continue; }
      if (!/\.(ts|tsx|mjs)$/.test(entry.name) || /\.d\.(ts|mts)$/.test(entry.name)) continue;
      const source = await readFile(file, 'utf8');
      const result = scanDiagnosticCallSites(source);
      assert.deepEqual(result.violations, [], '诊断调用点越过事件注册表');
      checked += result.sites.filter(site => site.event !== undefined).length;
      deferred += result.deferredCalls;
    }
  }
  for (const root of roots) await visitDirectory(root.pathname);
  // 只检查具名诊断调用的对象字面量；动态参数、事件与展开由运行时白名单兜底。
  // 动态事件及展开字段由写入边界的越界测试兜底，不假称静态扫描能证明任意控制流。
  assert.ok(checked > 0);
  t.diagnostic(`静态事件调用点 ${checked}；另有 ${deferred} 个动态参数／事件／展开调用仍由运行时核验（两者可重叠）`);
});
