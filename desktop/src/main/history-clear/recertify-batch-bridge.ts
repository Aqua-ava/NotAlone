import type { HistoryRecertifyBatchStartRequest } from '../../shared/history-recertify-batch-bridge';
import { historyRecertifyBatchLimitMax } from '../../shared/history-recertify-batch-bridge';
import { noArguments, type PageCommands } from '../page-commands';
import type { HistoryRecertifyBatchController } from './recertify-batch';

function startRequest(args: unknown[]): HistoryRecertifyBatchStartRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('批量修复操作不可用。');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 2 || Object.keys(fields).some(key => !['limit', 'confirmed'].includes(key))
    || fields.confirmed !== true || fields.limit !== null && (typeof fields.limit !== 'number' || !Number.isSafeInteger(fields.limit)
      || fields.limit < 1 || fields.limit > historyRecertifyBatchLimitMax)) throw new Error('批量修复需要明确确认，并核对本次最多修复数量。');
  return { limit: fields.limit as number | null, confirmed: true };
}
/** 只在开发宿主注册；打包宿主不注册任何批量 IPC，也不渲染入口。 */
export function installHistoryRecertifyBatchBridge(commands: PageCommands, controller: HistoryRecertifyBatchController, development: boolean): void {
  if (!development) return;
  controller.onStateChanged(state => commands.publish('history-recertify-batch:state-changed', state));
  commands.handle('history-recertify-batch:get-state', (...args: unknown[]) => { noArguments(args); return controller.getState(); }, 'manager');
  commands.handle('history-recertify-batch:refresh-overview', (...args: unknown[]) => { noArguments(args); return controller.refreshOverview(); }, 'manager');
  commands.handle('history-recertify-batch:start', (...args: unknown[]) => controller.start(startRequest(args)), 'manager');
  commands.handle('history-recertify-batch:stop', (...args: unknown[]) => { noArguments(args); return controller.stop(); }, 'manager');
}
