import { constants } from 'node:fs';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {diagnose,newTraceId} from './diagnostics/context.ts';

const stages = ['runtime', 'configuration', 'storage', 'modules', 'handshake'] as const;
const causes = ['pending', 'process_exit', 'unexpected_failure', 'permission_denied', 'configuration_invalid', 'storage_mismatch', 'storage_unavailable', 'timeout'] as const;
export type StartupStage = typeof stages[number];
export type StartupCause = typeof causes[number];
export interface StartupDiagnostic { version: 1; stage: StartupStage; cause: StartupCause; recordedAt: number }
export type StartupErrorCode = `backend_startup_${StartupStage}_failed`;
const location = (infoPath: string) => `${infoPath}.startup-diagnostic.json`;
let observed: {infoPath:string;state:string;began:number;traceId:string}|undefined;

/** 每个进程只有一条启动管线；路径只作内存归属比较，绝不进入事件。 */
function recordStage(infoPath:string,state:string,reasonCode:string):void {
  try {
    const now=performance.now();
    if(!observed||observed.infoPath!==infoPath||state==='runtime'&&reasonCode==='started')observed={infoPath,state:'idle',began:now,traceId:newTraceId()};
    const previous=observed;
    diagnose({event:'startup.state_changed',caller:'backend_startup',traceId:previous.traceId,fromState:previous.state,toState:state,reasonCode,durationMs:Math.max(0,now-previous.began)});
    if(state==='failed')diagnose({event:'diagnostics.error',module:'startup',caller:'backend_startup',traceId:previous.traceId,reasonCode,durationMs:Math.max(0,now-previous.began)});
    observed={...previous,state,began:now};
  }catch{/* 统一诊断不改变原专用启动文件或异常行为。 */}
}

/** 仅识别固定错误码，不复制异常文本、堆栈、路径、配置或递归展开 cause。 */
export function startupFailureCause(error: unknown): StartupCause {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  if (code === 'EACCES' || code === 'EPERM') return 'permission_denied';
  if (['sqlite_model_configuration_invalid', 'sqlite_background_configuration_invalid', 'sqlite_image_configuration_invalid', 'storage_configuration_invalid', 'configuration_unavailable'].includes(code)) return 'configuration_invalid';
  if (['instance_mismatch', 'instance_required', 'migration_drift', 'schema_drift', 'schema_too_new', 'integrity_failed', 'foreign_keys_failed'].includes(code)) return 'storage_mismatch';
  if (code === 'storage_timeout') return 'timeout';
  if (['worker_failed', 'unsafe_storage_path', 'storage_identity_changed', 'wal_unavailable'].includes(code)) return 'storage_unavailable';
  return 'unexpected_failure';
}

/** 单个固定文件覆盖保存，最多512字节；诊断失败不阻止正常启动或资源收尾。 */
export async function writeStartupDiagnostic(infoPath: string, stage: StartupStage, cause: StartupCause = 'pending'): Promise<void> {
  const temporary = `${location(infoPath)}.${randomUUID()}.tmp`;
  try {
    if (!stages.includes(stage) || !causes.includes(cause)) return;
    recordStage(infoPath,cause==='pending'?stage:'failed',cause==='pending'?'started':cause);
    const record: StartupDiagnostic = {version: 1, stage, cause, recordedAt: Date.now()};
    await writeFile(temporary, JSON.stringify(record), {mode: 0o600, flag: 'wx'});
    await rename(temporary, location(infoPath));
  } catch { /* 业务失败不应被诊断写入失败覆盖。 */ }
  finally { await rm(temporary, {force: true}).catch(() => {}); }
}

export async function readStartupDiagnostic(infoPath: string): Promise<StartupDiagnostic | undefined> {
  let file;
  try {
    file = await open(location(infoPath), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 512 || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) return;
    const bytes = Buffer.alloc(513), {bytesRead} = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 512) return;
    const value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (!value || Object.keys(value).sort().join(',') !== 'cause,recordedAt,stage,version' || value.version !== 1
      || !stages.includes(value.stage) || !causes.includes(value.cause) || !Number.isSafeInteger(value.recordedAt) || value.recordedAt < 0) return;
    return {version: 1, stage: value.stage, cause: value.cause, recordedAt: value.recordedAt};
  } catch { return; }
  finally { await file?.close().catch(() => {}); }
}

export async function finishStartupDiagnostic(infoPath: string, cause: StartupCause): Promise<StartupDiagnostic | undefined> {
  const record = await readStartupDiagnostic(infoPath);
  if (!record) return;
  if (record.cause === 'pending') {
    await writeStartupDiagnostic(infoPath, record.stage, cause);
    return {...record, cause};
  }
  return record;
}

export async function clearStartupDiagnostic(infoPath: string): Promise<void> {
  await rm(location(infoPath), {force: true}).catch(() => {});
  if(observed?.infoPath===infoPath&&observed.state!=='ready')recordStage(infoPath,'ready','completed');
}

export async function startupErrorCode(infoPath: string, cause: StartupCause): Promise<StartupErrorCode | undefined> {
  const record = await finishStartupDiagnostic(infoPath, cause);
  return record ? `backend_startup_${record.stage}_failed` : undefined;
}
