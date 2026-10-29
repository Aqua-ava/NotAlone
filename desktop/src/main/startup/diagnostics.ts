import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { StartupCode, StartupPaths, StartupState } from '../../shared/startup-bridge';
import { backendEnvironment, configurationPaths, loadBackendConfiguration, saveBackendConfiguration, type BackendConfiguration } from '../backend/config';
import { BackendFailure, readConnection } from '../backend/connection';
import { ManagedRuntime, ManagedRuntimeFailure } from './managed-runtime';
import { historicalUpdateComplete } from './historical-update';
import { SqliteDevelopmentProbe } from './sqlite-development';

const reportCodes = new Set<StartupCode>(['ready',
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
  private readonly sqliteDevelopment?: SqliteDevelopmentProbe;

  constructor(private readonly userData: string, private readonly resourcesDirectory?: string, private readonly developmentProjectDirectory?: string) {
    if (developmentProjectDirectory) this.sqliteDevelopment = new SqliteDevelopmentProbe(userData, developmentProjectDirectory);
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

  getState(): StartupState { return { ...this.state, ...(this.state.sqlite ? { sqlite: { ...this.state.sqlite } } : {}), helperWarnings: [...this.state.helperWarnings] }; }
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
  cancel(): void { this.closing = true; this.managed.cancel(); this.sqliteDevelopment?.cancel(); this.cancelProbe?.(); }

  async ensureReady(config: BackendConfiguration, canStart: () => boolean): Promise<void> {
    if (!canStart() || this.closing) throw new BackendFailure('backend_connection_failed');
    await this.saving?.catch(() => {});
    if (!canStart() || this.closing) return;
    delete config.sqlite;
    const sqlite = await this.sqliteDevelopment?.run(() => canStart() && !this.closing);
    if (!canStart() || this.closing) return;
    if (sqlite) {
      const contacts = this.sqliteDevelopment?.getContactConfiguration();
      if (sqlite.phase === 'ready' && contacts) {
        config.sqlite = { ...contacts, ...(config.wechatCliPath ? { wechatCliPath: config.wechatCliPath } : {}) };
        config.infoPath = path.join(this.userData, 'managed/sqlite-backend.info');
        config.runtime = 'dsh';
        config.projectDirectory = this.developmentProjectDirectory;
        config.source = 'external';
        this.publish({ phase: 'ready', mode: 'external', step: undefined, sqlite, helperWarnings: [], code: 'ready' });
        return;
      }
      this.publish({ phase: 'blocked', mode: 'external', step: undefined, sqlite, helperWarnings: [],
        code: sqlite.phase === 'ready' ? 'sqlite_business_unavailable' : 'sqlite_storage_failed' });
      // 底座诊断通过不代表业务切换完成；此模式不启动旧 PG 或后台业务。
      throw new BackendFailure('backend_connection_failed');
    }
    if (this.state.sqlite) this.publish({ sqlite: undefined });
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
    if (!config.projectDirectory) code = 'launch_unconfigured';
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
    try {
      if (!path.isAbsolute(config.projectDirectory!) || !(await stat(config.projectDirectory!)).isDirectory()) return 'project_unavailable';
      await access(config.projectDirectory!, constants.R_OK | constants.X_OK);
    } catch { return 'project_unavailable'; }
    try {
      for (const entry of ['backend-ts/src/platform/database/host-storage.ts', 'backend-ts/src/launch.ts', 'backend-ts/profile/host.patch.yml', 'backend-ts/src/schema-prepare-cli.ts']) {
        if (!(await stat(path.join(config.projectDirectory!, entry))).isFile()) return 'runtime_components_unavailable';
      }
    } catch { return 'runtime_components_unavailable'; }
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
    if (Number(process.versions.node.split('.')[0]) < 24) return 'runtime_components_unavailable';
    const executable = process.execPath;
    const project = await realpath(config.projectDirectory!);
    // 普通诊断只读；纯 TS 准备入口沿同一库复用原迁移与兼容性合同。
    // 独立子进程保留硬超时与退出回收，不装配模型、业务任务或 DSH 遥测。
    const program = `const {HostStorage}=await import(${JSON.stringify(pathToFileURL(path.join(project, 'backend-ts/src/platform/database/host-storage.ts')).href)});
      let storage; let code='diagnostic_failed';
      try { storage=await HostStorage.open({envFilePath:process.env.NOTALONE_ENV_FILE,migrationsDirectory:${JSON.stringify(path.join(project, 'backend-ts/database/migrations'))},environment:process.env});
        code=(await storage.compatibility()).code; } catch {} finally { await storage?.close(); }
      console.log(JSON.stringify({code}));`;
    if (!canStart() || this.closing) return 'diagnostic_failed';
    return new Promise((resolve) => {
      const args = prepareSchema
        ? ['--experimental-strip-types', path.join(project, 'backend-ts/src/schema-prepare-cli.ts'), '--migrations', path.join(project, 'backend-ts/database/migrations'), '--prepare']
        : ['--experimental-strip-types', '--input-type=module', '-e', program];
      const child = spawn(executable, args, {
        cwd: project, env: { ...backendEnvironment({ ...config, projectDirectory: project }, this.userData),
          ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: undefined, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'ignore'],
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
        if (Buffer.byteLength(output) > (prepareSchema ? 32768 : 4096)) stop('diagnostic_failed');
      });
      child.once('error', () => finish('runtime_components_unavailable'));
      child.once('close', () => {
        clearTimeout(killTimer);
        if (interrupted) { finish(interrupted); return; }
        try {
          const result: unknown = JSON.parse(output);
          const code = (result as { code?: unknown })?.code;
          finish(typeof code === 'string' && reportCodes.has(code as StartupCode) ? code as StartupCode : 'runtime_components_unavailable');
        } catch { finish('runtime_components_unavailable'); }
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
