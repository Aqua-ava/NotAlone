import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { UnifiedDiagnosticLog, type DiagnosticLogOptions } from './unified-log.mjs';
import type { DiagnosticEvent } from './unified-contract.mjs';
export type { DiagnosticEvent, DiagnosticRecord, DiagnosticModule } from './unified-contract.mjs';
const traces = new AsyncLocalStorage<string>();
let current: UnifiedDiagnosticLog | undefined;
export const newTraceId = (): string => randomUUID();
export const currentDiagnosticTrace = (): string | undefined => traces.getStore();
export function withDiagnosticTrace<T>(traceId: string | undefined, work: () => T): T {
  return traceId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(traceId) ? traces.run(traceId, work) : work();
}
/** 显式初始化用于正式宿主与隔离测试；构造和写盘失败不进入业务错误路径。 */
export function configureDiagnosticLog(root: string, options: DiagnosticLogOptions = {}): UnifiedDiagnosticLog {
  current = new UnifiedDiagnosticLog(root, options); return current;
}
export function diagnosticLog(): UnifiedDiagnosticLog | undefined { return current; }
export function diagnose(event: DiagnosticEvent): void {
  try {
    if (!current && process.env.NOTALONE_DIAGNOSTIC_ROOT) configureDiagnosticLog(process.env.NOTALONE_DIAGNOSTIC_ROOT,
      { proc: 'backend', development: process.env.NOTALONE_DIAGNOSTIC_LEVEL === 'debug' });
    current?.diagnose({ ...(currentDiagnosticTrace() ? { traceId: currentDiagnosticTrace() } : {}), ...event });
  } catch { /* 诊断不改变业务结果、异常身份或授权。 */ }
}
