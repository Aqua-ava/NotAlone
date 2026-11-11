import { UnifiedDiagnosticLog,writeObservedDiagnostic, type DiagnosticLogOptions } from './unified-log.mjs';
import {registerDiagnosticLog} from './context.ts';
export {newTraceId,currentDiagnosticTrace,withDiagnosticTrace,diagnosticLog,diagnose} from './context.ts';
export type { DiagnosticEvent, DiagnosticRecord, DiagnosticModule } from './unified-contract.mjs';
/** 显式初始化用于正式宿主与隔离测试；构造和写盘失败不进入业务错误路径。 */
export function configureDiagnosticLog(root: string, options: DiagnosticLogOptions = {}): UnifiedDiagnosticLog {
  const log = new UnifiedDiagnosticLog(root, options);registerDiagnosticLog(log,(event,observedAt,observedNs,protection)=>writeObservedDiagnostic(log,event,observedAt,observedNs,protection));return log;
}
