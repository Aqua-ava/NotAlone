import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { StartupCode, StartupPaths, StartupState } from '../../shared/startup-bridge';
import { backendEnvironment, configurationPaths, loadBackendConfiguration, saveBackendConfiguration, type BackendConfiguration } from '../backend/config';
import { BackendFailure, readConnection } from '../backend/connection';
import { ManagedRuntime, ManagedRuntimeFailure } from './managed-runtime';
import { historicalUpdateComplete } from './historical-update';

const reportCodes = new Set<StartupCode>(['ready', 'python_version_unsupported', 'backend_package_missing',
  'database_unconfigured', 'database_unavailable', 'baseline_missing', 'baseline_invalid',
  'migration_history_mismatch', 'migration_pending', 'schema_incomplete', 'migration_files_invalid', 'diagnostic_failed',
  'database_writers_present', 'database_update_requires_local', 'migration_busy', 'migration_failed']);

export class StartupDiagnostics {
  private state: StartupState = { phase: 'idle', revision: 0, helperWarnings: [] };
  private readonly listeners = new Set<(state: StartupState) => void>();
  private cancelProbe: (() => void) | undefined;
  private saving: Promise<void> | undefined;
  private closing = false;
  private localSetupEpoch = 0;
  private readonly managed: ManagedRuntime;

  constructor(private readonly userData: string, private readonly resourcesDirectory?: string) {
    this.managed = new ManagedRuntime(userData, resourcesDirectory,
      (step) => { if (!this.closing) this.publish({ phase: 'preparing', mode: 'managed', step, code: undefined }); });
  }

  async prepareLocalSetup(canStart: () => boolean): Promise<void> {
    if (this.closing) throw new Error('本机设置已停止');
    const epoch = this.localSetupEpoch;
    const config = await loadBackendConfiguration(this.userData, this.resourcesDirectory);
    if (config.source !== 'first-run' && config.source !== 'managed') throw new Error('已有资料需要接续');
    try {
      if (!await historicalUpdateComplete(this.userData, true)) throw new ManagedRuntimeFailure('runtime_configuration_invalid');
      await this.managed.prepare(() => epoch === this.localSetupEpoch && !this.closing && canStart());
    }
    catch (error) {
      if (epoch === this.localSetupEpoch && !this.closing) this.publish({ phase: 'blocked', mode: 'managed', step: undefined,
        code: error instanceof ManagedRuntimeFailure ? error.code : 'runtime_configuration_invalid' });
      throw new BackendFailure('backend_connection_failed');
    }
  }
  cancelLocalSetup(): void {
    ++this.localSetupEpoch;
    this.managed.cancel(); this.cancelProbe?.();
    if (!this.closing) this.publish({ phase: 'preparing', mode: 'managed', code: undefined, step: 'stopping' });
  }
  completeLocalCancellation(confirmed: boolean): void {
    if (!this.closing) this.publish({ phase: confirmed ? 'cancelled' : 'blocked', mode: 'managed', step: undefined,
      code: confirmed ? 'runtime_cancelled' : 'runtime_stop_unconfirmed' });
  }
  stopManagedRuntime(): Promise<boolean> { return this.managed.stop(); }

  getState(): StartupState { return { ...this.state, helperWarnings: [...this.state.helperWarnings] }; }
  onStateChanged(listener: (state: StartupState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async getPaths(): Promise<StartupPaths> {
    const revision = this.state.revision;
    try { return configurationPaths(await loadBackendConfiguration(this.userData, this.resourcesDirectory)); }
    catch {
      if (!this.closing && this.state.revision === revision && this.state.phase !== 'checking') {
        this.publish({ phase: 'blocked', code: 'configuration_invalid' });
      }
      return configurationPaths({ infoPath: process.env.NOTALONE_BACKEND_INFO || path.join(this.userData, 'backend.info'),
        envFilePath: process.env.NOTALONE_ENV_FILE });
    }
  }
  savePaths(paths: unknown, canSave: () => boolean): Promise<void> {
    if (this.state.mode === 'managed') return Promise.reject(new Error('受管本机设置不能改写为外置路径'));
    if (this.closing || this.saving || this.state.phase === 'checking' || !canSave()) return Promise.reject(new Error('启动路径暂时不可修改'));
    const revision = this.state.revision;
    this.saving = saveBackendConfiguration(this.userData, paths, () => !this.closing && canSave()).then(() => {
      if (!this.closing && this.state.revision === revision) this.publish({ phase: 'idle', code: undefined, helperWarnings: [] });
    }).finally(() => { this.saving = undefined; });
    return this.saving;
  }
  cancel(): void { this.closing = true; this.managed.cancel(); this.cancelProbe?.(); }

  async ensureReady(config: BackendConfiguration, canStart: () => boolean): Promise<void> {
    if (!canStart() || this.closing) throw new BackendFailure('backend_connection_failed');
    await this.saving?.catch(() => {});
    if (!canStart() || this.closing) return;
    if (!await historicalUpdateComplete(this.userData, config.source !== 'external')) {
      this.publish({ phase: 'blocked', mode: config.source === 'external' ? 'external' : 'managed',
        step: undefined, code: 'runtime_configuration_invalid' });
      throw new BackendFailure('backend_connection_failed');
    }
    if (config.source === 'first-run') {
      this.publish({ phase: 'first-run', mode: 'managed', code: 'local_setup_required', helperWarnings: [], step: undefined });
      throw new BackendFailure('backend_launch_unconfigured');
    }
    if (config.source === 'managed') {
      try { await this.managed.start(config, () => canStart() && !this.closing); }
      catch (error) {
        if (!this.closing) this.publish({ phase: 'blocked', mode: 'managed', step: undefined,
          code: error instanceof ManagedRuntimeFailure ? error.code : 'runtime_configuration_invalid' });
        throw new BackendFailure('backend_connection_failed');
      }
      if (!canStart() || this.closing) return;
    }
    this.publish({ phase: 'checking', mode: config.source === 'managed' ? 'managed' : 'external', step: undefined, code: undefined, helperWarnings: [] });
    // 另一窗口可在保存的 await 期间重试；旧配置不能在保存成功后继续通过门禁。
    let current: BackendConfiguration;
    try { current = await loadBackendConfiguration(this.userData, this.resourcesDirectory); }
    catch {
      if (canStart() && !this.closing) this.publish({ phase: 'blocked', code: 'configuration_invalid' });
      throw new BackendFailure('backend_connection_failed');
    }
    if (!canStart() || this.closing) return;
    const selected = configurationPaths(config);
    const latest = configurationPaths(current);
    if ((Object.keys(selected) as Array<keyof StartupPaths>).some((key) => selected[key] !== latest[key])) {
      this.publish({ phase: 'idle', code: undefined });
      throw new BackendFailure('backend_connection_failed');
    }
    let code: StartupCode;
    if (!config.pythonExecutable || !config.projectDirectory) code = 'launch_unconfigured';
    else {
      try {
        code = await this.validatePaths(config);
        if (code === 'ready' && canStart() && !this.closing) code = await this.probe(config, canStart);
        if (code === 'migration_pending' && canStart() && !this.closing) {
          const previous = await readConnection(config.infoPath);
          let previousRunning = false;
          if (previous) {
            try { process.kill(previous.pid, 0); previousRunning = true; }
            catch (error) { previousRunning = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
          }
          if (previousRunning) code = 'database_writers_present';
          else {
            this.publish({ phase: 'preparing', step: 'updating-schema', code: undefined });
            code = await this.probe(config, canStart, true);
            if (code === 'ready' && canStart() && !this.closing) code = await this.probe(config, canStart);
          }
        }
      } catch { code = 'diagnostic_failed'; }
    }
    if (!canStart() || this.closing) return;
    const helperWarnings: StartupState['helperWarnings'] = [];
    if (!await executableExists(config.wechatCliPath)) helperWarnings.push('cli_unavailable');
    if (!await executableExists(config.syncProbePath)) helperWarnings.push('probe_unavailable');
    if (!canStart() || this.closing) return;
    this.publish({ phase: code === 'ready' ? 'ready' : 'blocked', step: undefined, code, helperWarnings });
    if (code !== 'ready') throw new BackendFailure(code === 'launch_unconfigured' ? 'backend_launch_unconfigured'
      : code === 'info_path_unavailable' ? 'backend_handshake_invalid' : 'backend_connection_failed');
  }

  private async validatePaths(config: BackendConfiguration): Promise<StartupCode> {
    if (!await executableExists(config.pythonExecutable)) return 'python_unavailable';
    try {
      if (!path.isAbsolute(config.projectDirectory!) || !(await stat(config.projectDirectory!)).isDirectory()) return 'project_unavailable';
      await access(config.projectDirectory!, constants.R_OK | constants.X_OK);
    } catch { return 'project_unavailable'; }
    try {
      const source = path.join(config.projectDirectory!, 'backend/src/notalone');
      if (!(await stat(path.join(source, 'server/command.py'))).isFile()
        || !(await stat(path.join(source, 'startup_diagnostics.py'))).isFile()) return 'backend_package_missing';
    } catch { return 'backend_package_missing'; }
    for (const [selected, code] of [[config.envFilePath || path.join(config.projectDirectory!, '.env'), 'env_path_unavailable'],
      [config.infoPath, 'info_path_unavailable']] as const) {
      if (!path.isAbsolute(selected)) return code;
      try {
        const item = await stat(selected);
        if (!item.isFile()) return code;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return code;
        // 文件可以由用户后续首启创建；诊断本身不创建配置、握手或目录。
        try { if (!(await stat(path.dirname(selected))).isDirectory()) return code; }
        catch { return code; }
      }
    }
    return 'ready';
  }

  private async probe(config: BackendConfiguration, canStart: () => boolean, prepareSchema = false): Promise<StartupCode> {
    const python = await realpath(config.pythonExecutable!);
    const project = await realpath(config.projectDirectory!);
    if (!canStart() || this.closing) return 'diagnostic_failed';
    return new Promise((resolve) => {
      const child = spawn(python, [...(config.source === 'managed' ? ['-I', '-B'] : []), '-m', prepareSchema ? 'notalone.startup_database' : 'notalone.startup_diagnostics', '--migrations', path.join(project, 'backend/database/migrations')], {
        cwd: project, env: backendEnvironment({ ...config, projectDirectory: project }, this.userData), stdio: ['ignore', 'pipe', 'ignore'],
      });
      let output = '';
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      let interrupted: StartupCode | undefined;
      const finish = (code: StartupCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.cancelProbe === cancel) this.cancelProbe = undefined;
        resolve(code);
      };
      const stop = (code: StartupCode) => {
        if (interrupted) return;
        interrupted = code;
        if (child.exitCode === null) { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 250); }
      };
      // 先回收本次持有的诊断子进程，再完成 gate；否则 App 退出会丢失强制回收计时器。
      const cancel = () => stop('diagnostic_failed');
      this.cancelProbe = cancel;
      const timer = setTimeout(() => stop('diagnostic_timeout'), prepareSchema ? 60_000 : 12_000);
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled || interrupted) return;
        output += chunk.toString('utf8');
        if (Buffer.byteLength(output) > 4096) stop('diagnostic_failed');
      });
      child.once('error', () => finish('python_unavailable'));
      child.once('close', () => {
        clearTimeout(killTimer);
        if (interrupted) { finish(interrupted); return; }
        try {
          const result: unknown = JSON.parse(output);
          const code = (result as { code?: unknown })?.code;
          finish(typeof code === 'string' && reportCodes.has(code as StartupCode) ? code as StartupCode : 'backend_package_missing');
        } catch { finish('backend_package_missing'); }
      });
    });
  }
  private publish(update: Partial<StartupState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}

async function executableExists(selected: string | undefined): Promise<boolean> {
  if (!selected || !path.isAbsolute(selected)) return false;
  try { await access(selected, constants.X_OK); return (await stat(selected)).isFile(); }
  catch { return false; }
}
