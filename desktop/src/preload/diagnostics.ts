import type { DiagnosticLogBridge } from '../shared/diagnostic-bridge';
import type { PageTransport } from './transport';
export function createDiagnosticLogBridge(transport: PageTransport): DiagnosticLogBridge {
  const noArgs = (channel: string, args: unknown[]) => args.length ? Promise.reject(new Error('诊断日志操作不可用。')) : transport.invoke(channel);
  return Object.freeze({
    getState: (...args: unknown[]) => noArgs('diagnostics:get-state', args),
    setEnabled: (...args: unknown[]) => args.length === 1 && typeof args[0] === 'boolean' ? transport.invoke('diagnostics:set-enabled', args[0]) : Promise.reject(new Error('诊断日志设置无效。')),
    clear: (...args: unknown[]) => noArgs('diagnostics:clear', args),
    exportBundle: (...args: unknown[]) => noArgs('diagnostics:export', args),
  });
}
