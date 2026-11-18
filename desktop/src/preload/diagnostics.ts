import type { DiagnosticLogBridge } from '../shared/diagnostic-bridge';
import { pageInvokers, type PageTransport } from './transport';
export function createDiagnosticLogBridge(transport: PageTransport): DiagnosticLogBridge {
  const { empty } = pageInvokers(transport, '诊断日志操作不可用。');
  return Object.freeze({
    getState: (...args: unknown[]) => empty('diagnostics:get-state', args),
    setEnabled: (...args: unknown[]) => args.length === 1 && typeof args[0] === 'boolean' ? transport.invoke('diagnostics:set-enabled', args[0]) : Promise.reject(new Error('诊断日志设置无效。')),
    clear: (...args: unknown[]) => empty('diagnostics:clear', args),
    exportBundle: (...args: unknown[]) => empty('diagnostics:export', args),
  });
}
