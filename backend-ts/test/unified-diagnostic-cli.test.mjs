import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UnifiedDiagnosticLog } from '../src/diagnostics/unified-log.mjs';
import { diagnosticFilter, queryDiagnostics } from '../../desktop/scripts/diag.mjs';
test('diag按时间、模块、级别、关联与慢请求筛选跨进程白名单时间线', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-diag-query-'))); await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  const traceId = '11111111-1111-4111-8111-111111111111', main = new UnifiedDiagnosticLog(root, { proc: 'main', development: true }), backend = new UnifiedDiagnosticLog(root, { proc: 'backend', development: true });
  main.diagnose({ event: 'request.started', module: 'memory.management', traceId });
  backend.diagnose({ event: 'request.slow', module: 'memory.management', traceId, durationMs: 1001 });
  main.diagnose({ event: 'request.finished', module: 'contacts' }); await Promise.all([main.flush(), backend.flush()]);
  const options = diagnosticFilter(['--data-dir', root, '--since', '10m', '--trace', traceId]);
  assert.equal((await queryDiagnostics(options)).length, 2);
  assert.equal((await queryDiagnostics({ ...options, level: 'warn', slow: true, module: 'memory.management' })).length, 1);
  assert.equal((await queryDiagnostics({ ...options, since: Date.now() + 1000 })).length, 0);
  assert.throws(() => diagnosticFilter(['--module', '敏感合成正文'])); assert.throws(() => diagnosticFilter(['--arbitrary', 'x']));
});
