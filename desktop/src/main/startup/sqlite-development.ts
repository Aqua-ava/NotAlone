import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SqliteLaunchConfiguration } from '../../../../backend-ts/src/launch';
import {readSqliteCapabilities} from '../../../../backend-ts/src/sqlite-capabilities.ts';
import type { SqliteDevelopmentState } from '../../shared/startup-bridge';
import { sqliteStartupTimeoutMs } from '../../../../backend-ts/src/storage/sqlite/timeouts';

type ReadyResult = { phase: 'ready'; code: 'sqlite_ready' | 'sqlite_reopened'; databaseId: string; ownerId: string; schemaVersion: number; sqliteVersion: string;
  created: boolean; configuration: { capabilities: SqliteLaunchConfiguration['capabilities']; skillPackageRoot?: string } };
type MaintenanceResult = { phase: 'maintenance'; code: string; detail?: string; manifestRevision?: number };
const failureCodes = new Set(['database_cutover_required', 'database_maintenance', 'cutover_manifest_invalid', 'cutover_authorization_required',
  'cutover_authorization_invalid', 'cutover_legacy_target_unclassified', 'cutover_legacy_writer_running', 'cutover_cleanup_failed',
  'cutover_checks_failed', 'cutover_target_unrecorded', 'cutover_configuration_conflict', 'cutover_storage_failed']);
const blocked = (code: string): SqliteDevelopmentState => ({ phase: 'blocked', code, maintenance: true });

/** 正常开发入口的唯一启动探针：默认 SQLite 切换、维护态与旧目标清理都由控制面决定。 */
export class SqliteDevelopmentProbe {
  private cancelChild: (() => void) | undefined;
  private contactConfiguration: SqliteLaunchConfiguration | undefined;
  getContactConfiguration(): SqliteLaunchConfiguration | undefined {
    return this.contactConfiguration ? structuredClone(this.contactConfiguration) : undefined;
  }
  constructor(private readonly userData: string, private readonly projectDirectory: string) {}

  cancel(): void { this.cancelChild?.(); }

  async run(canStart: () => boolean): Promise<SqliteDevelopmentState | undefined> {
    this.contactConfiguration = undefined;
    if (!canStart()) return blocked('sqlite_cancelled');
    let result: ReadyResult | MaintenanceResult;
    try { result = await this.probe(await this.isolatedRoot()); }
    catch { return blocked('sqlite_diagnostic_failed'); }
    if (!canStart()) return blocked('sqlite_cancelled');
    if (result.phase === 'maintenance') return blocked(typeof result.code === 'string' && failureCodes.has(result.code) ? result.code : 'cutover_storage_failed');
    const capabilities = result.configuration ? readSqliteCapabilities(result.configuration.capabilities, result.configuration.skillPackageRoot, this.userData) : undefined;
    if (!capabilities || !result.configuration) return blocked('cutover_configuration_conflict');
    this.contactConfiguration = { userData: this.userData, expectedDatabaseId: result.databaseId, role: 'test', ...capabilities };
    return { phase: 'ready', code: result.code, schemaVersion: result.schemaVersion, sqliteVersion: result.sqliteVersion,
      capabilities: result.configuration.capabilities };
  }

  /** synthetic 授权只允许在系统临时根下的隔离资料目录使用。 */
  private async isolatedRoot(): Promise<boolean> {
    try {
      const temporary = await realpath(tmpdir());
      const candidate = await realpath(this.userData);
      return candidate.startsWith(`${temporary}${path.sep}`);
    } catch { return false; }
  }

  private probe(allowSyntheticAuthorization: boolean): Promise<ReadyResult | MaintenanceResult> {
    const moduleUrl = pathToFileURL(path.join(this.projectDirectory, 'backend-ts/src/platform/cutover/startup.ts')).href;
    // 与开发宿主同一 Node；切换检查只读写 SQLite 与受控目录，不启动 DSH、微信或模型。
    const program = `(async()=>{ try {
      const {runDefaultDatabaseStartup}=await import(${JSON.stringify(moduleUrl)});
      const result=await runDefaultDatabaseStartup({userData:${JSON.stringify(this.userData)},skillPackageRoot:${JSON.stringify(path.join(this.projectDirectory, 'reply-skills/romance'))},allowSyntheticAuthorization:${allowSyntheticAuthorization}});
      console.log(JSON.stringify(result));
    } catch(error) { console.log(JSON.stringify({phase:'maintenance',code:'cutover_storage_failed',detail:'probe_failed'})); } })();`;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '-e', program], {
        cwd: this.projectDirectory,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: undefined, NODE_NO_WARNINGS: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let output = '', stopped = false;
      let killTimer: NodeJS.Timeout | undefined;
      const stop = () => {
        if (stopped) return;
        stopped = true; child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
      };
      this.cancelChild = stop;
      const timer = setTimeout(stop, sqliteStartupTimeoutMs);
      child.stdout.on('data', (data: Buffer) => {
        output += data.toString('utf8');
        if (Buffer.byteLength(output) > 8192) stop();
      });
      child.once('error', () => { /* close 事件统一完成回收和失败。 */ });
      child.once('close', code => {
        clearTimeout(timer); clearTimeout(killTimer);
        if (this.cancelChild === stop) this.cancelChild = undefined;
        try {
          if (stopped || code !== 0) throw new Error();
          const value = JSON.parse(output);
          if (value?.phase === 'maintenance' && typeof value.code === 'string') { resolve(value); return; }
          if (value?.phase !== 'ready' || typeof value.databaseId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.databaseId)
            || typeof value.ownerId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.ownerId)
            || !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1
            || typeof value.sqliteVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.sqliteVersion)
            || !value.configuration || !Array.isArray(value.configuration.capabilities)) throw new Error();
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
  }
}
