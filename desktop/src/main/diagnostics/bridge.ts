import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { UnifiedDiagnosticLog } from '../../../../backend-ts/src/diagnostics/unified-log.mjs';
import { readDiagnosticRecords } from '../../../../backend-ts/src/diagnostics/unified-log.mjs';
import { checkedDiagnosticRecord } from '../../../../backend-ts/src/diagnostics/unified-contract.mjs';
import { noArguments, type PageCommands } from '../page-commands';

/** 导出只重新投影注册表字段；不读取专用正文追踪、配置或原始异常。 */
export async function exportDiagnosticBundle(root: string, log: UnifiedDiagnosticLog, chooseFile: () => Promise<string | undefined>): Promise<{ status: 'saved' | 'cancelled' }> {
  await log.flush();
  const target = await chooseFile();
  if (!target) return { status: 'cancelled' };
  if (!path.isAbsolute(target) || /[\0\r\n]/.test(target)) throw new Error('诊断包保存位置无效。');
  const records = (await readDiagnosticRecords(root)).map(checkedDiagnosticRecord).filter(value => value !== undefined);
  const bundle = { formatVersion: 1, product: 'NotAlone', generatedAt: new Date().toISOString(), automaticUpload: false, records };
  const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) throw new Error('诊断包保存位置不可用。');
    await file.chmod(0o600); await file.truncate(0); await file.writeFile(JSON.stringify(bundle, null, 2) + '\n');
  } finally { await file.close(); }
  return { status: 'saved' };
}
export function installDiagnosticLogBridge(commands: PageCommands, root: string, log: UnifiedDiagnosticLog, chooseFile: () => Promise<string | undefined>): void {
  commands.handle('diagnostics:get-state', (...args) => { noArguments(args); return log.status(); }, 'manager');
  commands.handle('diagnostics:set-enabled', async (...args) => {
    if (args.length !== 1 || typeof args[0] !== 'boolean') throw new Error('诊断日志设置无效。');
    if (!await log.setEnabled(args[0])) throw new Error('诊断日志设置未保存。');
    return log.status();
  }, 'manager');
  commands.handle('diagnostics:clear', async (...args) => { noArguments(args); if (!await log.clear()) throw new Error('诊断日志清除未完成。'); return log.status(); }, 'manager');
  commands.handle('diagnostics:export', async (...args) => { noArguments(args); return exportDiagnosticBundle(root, log, chooseFile); }, 'manager');
}
