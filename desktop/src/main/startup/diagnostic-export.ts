import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { DiagnosticPreview, DiagnosticExportResult, StartupState } from '../../shared/startup-bridge';
import type { BackendState } from '../../shared/backend-bridge';

const startupCodes = new Set(['sqlite_business_unavailable', 'sqlite_storage_failed', 'ready', 'launch_unconfigured', 'configuration_invalid', 'python_unavailable',
  'python_version_unsupported', 'backend_package_missing', 'project_unavailable', 'env_path_unavailable',
  'info_path_unavailable', 'database_unconfigured', 'database_unavailable', 'baseline_missing', 'baseline_invalid',
  'migration_history_mismatch', 'migration_pending', 'schema_incomplete', 'migration_files_invalid', 'diagnostic_timeout',
  'diagnostic_failed', 'database_writers_present', 'database_update_requires_local', 'migration_busy', 'migration_failed',
  'runtime_components_unavailable', 'runtime_configuration_invalid', 'runtime_cancelled', 'database_prepare_failed',
  'database_start_failed', 'database_already_running', 'local_setup_required', 'runtime_stop_unconfirmed']);
const selected = (value: unknown, allowed: readonly string[]) => typeof value === 'string' && allowed.includes(value) ? value : null;

/** 只组装版本化白名单；不复制运行时对象、配置、异常、路径或业务记录。 */
export class DiagnosticExportController {
  private current?: DiagnosticPreview;
  private exporting = false;
  constructor(private readonly startup: () => StartupState, private readonly backend: () => BackendState) {}
  preview(): DiagnosticPreview {
    const startup = this.startup();
    const backend = this.backend();
    const report = {
      formatVersion: 1, product: 'NotAlone', generatedAt: new Date().toISOString(), automaticUpload: false,
      startup: {
        phase: selected(startup.phase, ['idle', 'checking', 'ready', 'blocked', 'first-run', 'preparing', 'cancelled']),
        mode: selected(startup.mode, ['managed', 'external']),
        step: selected(startup.step, ['checking-components', 'preparing-data', 'starting-database', 'preparing-database', 'updating-schema', 'stopping']),
        code: typeof startup.code === 'string' && startupCodes.has(startup.code) ? startup.code : null,
        helperWarnings: ['cli_unavailable', 'probe_unavailable'].filter(code => startup.helperWarnings.includes(code as 'cli_unavailable' | 'probe_unavailable')),
      },
      backend: {
        phase: selected(backend.phase, ['disconnected', 'connecting', 'connected', 'stopping', 'shutdown-failed', 'stopped']),
        errorCode: selected(backend.errorCode, ['backend_launch_unconfigured', 'backend_handshake_invalid', 'backend_connection_failed', 'backend_shutdown_unconfirmed']),
        canRetryConnection: backend.canRetryConnection === true,
        canRetryShutdown: backend.canRetryShutdown === true,
      },
    };
    this.current = { previewId: randomUUID(), json: `${JSON.stringify(report, null, 2)}\n` };
    return { ...this.current };
  }
  async export(previewId: unknown, chooseFile: () => Promise<string | undefined>): Promise<DiagnosticExportResult> {
    if (typeof previewId !== 'string' || previewId !== this.current?.previewId) throw new Error('请先预览诊断，再导出到本机');
    if (this.exporting) throw new Error('诊断正在导出，请稍后重试');
    this.exporting = true;
    const json = this.current.json;
    try {
      const target = await chooseFile();
      if (!target) return { status: 'cancelled' };
      if (!path.isAbsolute(target) || /[\0\r\n]/.test(target)) throw new Error();
      // 对话框可确认覆盖普通文件；拒绝符号链接/设备且先收紧权限再写，不跟随任意链接。
      const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        if (!(await file.stat()).isFile()) throw new Error();
        await file.chmod(0o600);
        await file.truncate(0);
        await file.writeFile(json, 'utf8');
        await file.sync();
      } finally { await file.close(); }
      return { status: 'saved' };
    } catch { throw new Error('诊断未能导出，请检查本机保存位置后重试'); }
    finally { this.exporting = false; }
  }
}
