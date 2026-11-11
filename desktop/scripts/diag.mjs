import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { readDiagnosticRecords } from '../../backend-ts/src/diagnostics/unified-log.mjs';
import { diagnosticModules } from '../../backend-ts/src/diagnostics/unified-contract.mjs';
const levels = ['debug', 'info', 'warn', 'error'];
export function diagnosticFilter(argv, now = Date.now()) {
  const result = { root: process.env.NOTALONE_DIAGNOSTIC_ROOT ?? path.join(os.homedir(), 'Library/Application Support/NotAloneDesktop'), since: 0 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--slow') { result.slow = true; continue; }
    if (!['--since', '--module', '--level', '--trace', '--data-dir'].includes(flag) || !argv[i + 1]) throw new Error('诊断查询参数无效');
    const value = argv[++i];
    if (flag === '--since') {
      const match = /^(\d{1,6})(s|m|h|d)$/.exec(value);
      if (!match) throw new Error('诊断查询时间范围无效');
      result.since = now - Number(match[1]) * { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 }[match[2]];
    } else if (flag === '--module') { if (!diagnosticModules.includes(value)) throw new Error('诊断模块无效'); result.module = value; }
    else if (flag === '--level') { if (!levels.includes(value)) throw new Error('诊断级别无效'); result.level = value; }
    else if (flag === '--trace') { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('关联编号无效'); result.trace = value; }
    else { if (!path.isAbsolute(value)) throw new Error('诊断资料目录无效'); result.root = value; }
  }
  return result;
}
export async function queryDiagnostics(options) {
  return (await readDiagnosticRecords(options.root)).filter(row => Date.parse(row.time) >= options.since
    && (!options.module || row.module === options.module)
    && (!options.level || levels.indexOf(row.level) >= levels.indexOf(options.level))
    && (!options.trace || row.traceId === options.trace || row.interruptedTraceId === options.trace)
    && (!options.slow || ['request.slow', 'sql.slow'].includes(row.event)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { for (const record of await queryDiagnostics(diagnosticFilter(process.argv.slice(2)))) process.stdout.write(JSON.stringify(record) + '\n'); }
  catch { process.stderr.write('诊断查询未完成，请核对参数和本机日志权限。\n'); process.exitCode = 1; }
}
