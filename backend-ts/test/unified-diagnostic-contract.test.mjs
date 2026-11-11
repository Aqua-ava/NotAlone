import test from 'node:test';
import assert from 'node:assert/strict';
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
test('所有产品diagnose字面调用点只使用已注册事件与字段', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { default: path } = await import('node:path');
  const roots = [new URL('../src/', import.meta.url), new URL('../../desktop/src/', import.meta.url)];
  let checked = 0;
  async function visitDirectory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visitDirectory(file); continue; }
      if (!/\.(ts|tsx|mjs)$/.test(entry.name) || /\.d\.(ts|mts)$/.test(entry.name)) continue;
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(/\bdiagnose\(\s*\{([\s\S]*?)\}\s*\)/g)) {
        const literal = /\bevent\s*:\s*['"]([^'"]+)['"]/.exec(match[1]);
        if (!literal) continue;
        const name = literal[1], rule = diagnosticEvents[name];
        assert.ok(rule, `未注册事件 ${name}`);
        for (const property of match[1].matchAll(/(?:^|[,\{\n])\s*(\w+)\s*:/g)) {
          const key = property[1];
          assert.ok(['event', 'module', ...rule.fields].includes(key), `${name} 越界字段 ${key}`);
        }
        checked++;
      }
    }
  }
  for (const root of roots) await visitDirectory(root.pathname);
  // 接入点会随02至04增加；每个字面调用均按同一注册表核验。
  // 动态事件及展开字段由写入边界的越界测试兜底，不假称静态扫描能证明任意控制流。
  if (!checked) return;
});
