import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import type { StartupCode, StartupPaths, StartupState } from '../../shared/startup-bridge';
import { configurationPaths, loadBackendConfiguration, saveBackendConfiguration, type BackendConfiguration } from '../backend/config';
import { BackendFailure } from '../backend/connection';
import { SqliteDevelopmentProbe } from './sqlite-development';
import {diagnose,newTraceId} from '../../../../backend-ts/src/diagnostics/context';

/** 默认启动由 SQLite 控制面核验受控存储。 */
export class StartupDiagnostics {
  private state: StartupState = { phase: 'idle', revision: 0, helperWarnings: [] };
  private readonly listeners = new Set<(state: StartupState) => void>();
  private saving: Promise<void> | undefined;
  private closing = false;
  private readonly sqliteDevelopment?: SqliteDevelopmentProbe;
  private readonly developmentProjectDirectory?: string;
  private diagnosticBegan=performance.now();
  private diagnosticTrace=newTraceId();

  constructor(private readonly userData: string, resourcesDirectory?: string, developmentProjectDirectory?: string) {
    this.developmentProjectDirectory = developmentProjectDirectory;
    if (developmentProjectDirectory) this.sqliteDevelopment = new SqliteDevelopmentProbe(userData, developmentProjectDirectory);
  }

  getState(): StartupState { return { ...this.state, ...(this.state.sqlite ? { sqlite: { ...this.state.sqlite } } : {}), helperWarnings: [...this.state.helperWarnings] }; }
  onStateChanged(listener: (state: StartupState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async getPaths(): Promise<StartupPaths> {
    const revision = this.state.revision;
    try { return configurationPaths(await loadBackendConfiguration(this.userData)); }
    catch {
      if (!this.closing && this.state.revision === revision && this.state.phase !== 'checking') {
        this.publish({ phase: 'blocked', code: 'configuration_invalid' });
      }
      return configurationPaths({ infoPath: process.env.NOTALONE_BACKEND_INFO || path.join(this.userData, 'managed/sqlite-backend.info'),
        envFilePath: process.env.NOTALONE_ENV_FILE });
    }
  }
  savePaths(paths: unknown, canSave: () => boolean): Promise<void> {
    if (this.closing || this.saving || this.state.phase === 'checking' || !canSave()) return Promise.reject(new Error('启动路径暂时不可修改'));
    const revision = this.state.revision;
    this.saving = saveBackendConfiguration(this.userData, paths, () => !this.closing && canSave()).then(() => {
      if (!this.closing && this.state.revision === revision) this.publish({ phase: 'idle', code: undefined, helperWarnings: [] });
    }).finally(() => { this.saving = undefined; });
    return this.saving;
  }
  cancel(): void { this.closing = true; this.sqliteDevelopment?.cancel(); }

  async ensureReady(config: BackendConfiguration, canStart: () => boolean): Promise<void> {
    if (!canStart() || this.closing) throw new BackendFailure('backend_connection_failed');
    await this.saving?.catch(() => {});
    if (!canStart() || this.closing) return;
    this.publish({ phase: 'checking', mode: 'external', step: undefined, code: undefined, helperWarnings: [] });
    const sqlite = await this.sqliteDevelopment?.run(() => canStart() && !this.closing);
    if (!canStart() || this.closing) return;
    if (sqlite) {
      const contacts = this.sqliteDevelopment?.getContactConfiguration();
      if ((sqlite.phase === 'ready' || sqlite.phase === 'prepared') && contacts) {
        config.sqlite = { ...contacts, ...(config.wechatCliPath ? { wechatCliPath: config.wechatCliPath } : {}) };
        config.infoPath = path.join(this.userData, 'managed/sqlite-backend.info');
        config.runtime = 'dsh';
        config.projectDirectory = this.developmentProjectDirectory;
        config.source = 'external';
        const helperWarnings: StartupState['helperWarnings'] = [];
        if (!await executableExists(config.wechatCliPath)) helperWarnings.push('cli_unavailable');
        if (!await executableExists(config.syncProbePath)) helperWarnings.push('probe_unavailable');
        if (!canStart() || this.closing) return;
        this.publish({ phase: 'ready', mode: 'external', step: undefined, sqlite, helperWarnings, code: 'ready' });
        return;
      }
      this.publish({ phase: 'blocked', mode: 'external', step: undefined, sqlite, helperWarnings: [],
        code: (sqlite.code as StartupCode) ?? 'cutover_storage_failed' });
      // 维护态只保留现场与重试入口，不启动业务后台。
      throw new BackendFailure('backend_connection_failed');
    }
    this.publish({ phase: 'blocked', mode: 'external', step: undefined, sqlite: { phase: 'blocked', code: 'cutover_storage_failed', maintenance: true },
      helperWarnings: [], code: 'cutover_storage_failed' });
    throw new BackendFailure('backend_connection_failed');
  }

  private publish(update: Partial<StartupState>): void {
    const previous=this.state;
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    if(previous.phase!==this.state.phase||previous.code!==this.state.code){
      const now=performance.now();
      if(this.state.phase==='checking'){this.diagnosticBegan=now;this.diagnosticTrace=newTraceId();}
      diagnose({event:'startup.state_changed',caller:'startup_controller',traceId:this.diagnosticTrace,fromState:previous.phase,toState:this.state.phase,
        reasonCode:this.state.phase==='checking'||this.state.phase==='preparing'?'started':this.state.phase==='ready'?'completed':this.state.phase==='cancelled'?'cancelled':this.state.phase==='blocked'?'not_ready':'no_change',
        durationMs:Math.max(0,now-this.diagnosticBegan)});
    }
    for (const listener of this.listeners) listener(this.getState());
  }
}

async function executableExists(selected: string | undefined): Promise<boolean> {
  if (!selected || !path.isAbsolute(selected)) return false;
  try { await access(selected, constants.X_OK); return (await stat(selected)).isFile(); }
  catch { return false; }
}
