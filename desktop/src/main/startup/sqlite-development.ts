import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SqliteLaunchConfiguration } from '../../../../backend-ts/src/launch';
import {readSqliteCapabilities} from '../../../../backend-ts/src/sqlite-capabilities.ts';
import type { SqliteDevelopmentState } from '../../shared/startup-bridge';

type Configuration = { formatVersion: 1; intent: 'create' | 'open'; role: 'test'; expectedDatabaseId?: string; capabilities?: SqliteLaunchConfiguration['capabilities'];skillPackageRoot?:string };
type ProbeResult = { databaseId: string; schemaVersion: number; sqliteVersion: string };
const failureCodes = new Set(['storage_configuration_invalid', 'instance_required', 'unsafe_storage_path',
  'storage_identity_changed', 'storage_missing', 'storage_already_exists', 'instance_mismatch', 'schema_drift',
  'schema_too_new', 'migration_drift', 'integrity_failed', 'foreign_keys_failed', 'wal_unavailable', 'epoch_exhausted',
  'storage_busy', 'storage_invalid', 'storage_failed', 'worker_failed', 'storage_timeout', 'reset_requires_cutover', 'registry_invalid']);
const blocked = (code: string): SqliteDevelopmentState => ({ phase: 'blocked', code });

/** 只在 Main 已核验的开发模式显式装配，普通启动不读取此控制文件。 */
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
    const target = path.join(this.userData, 'sqlite-development.json');
    let config: Configuration;
    let identity: { dev: number; ino: number };
    try {
      const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.()
          || (metadata.mode & 0o777) !== 0o600 || metadata.size > 4096) return blocked('sqlite_configuration_invalid');
        identity = { dev: metadata.dev, ino: metadata.ino };
        const data = Buffer.alloc(4097);
        const { bytesRead } = await file.read(data, 0, data.length, 0);
        if (bytesRead > 4096) return blocked('sqlite_configuration_invalid');
        const value = JSON.parse(data.subarray(0, bytesRead).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).some(key => !['formatVersion', 'intent', 'role', 'expectedDatabaseId', 'capabilities','skillPackageRoot'].includes(key))
          || (value.capabilities === undefined ? value.skillPackageRoot !== undefined : !readSqliteCapabilities(value.capabilities,value.skillPackageRoot,this.userData))
          || value.formatVersion !== 1 || value.role !== 'test' || !['create', 'open'].includes(value.intent)
          || (value.intent === 'create' ? value.expectedDatabaseId !== undefined
            : typeof value.expectedDatabaseId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.expectedDatabaseId))) {
          return blocked('sqlite_configuration_invalid');
        }
        config = value;
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return blocked('sqlite_configuration_invalid');
    }
    if (!canStart()) return blocked('sqlite_cancelled');
    try {
      const result = await this.probe(config);
      if (!canStart()) return blocked('sqlite_cancelled');
      if (config.intent === 'create') {
        // 创建成功即固化预期实例；普通重开永远不再走创建分支。
        const previous = await lstat(target);
        if (previous.dev !== identity.dev || previous.ino !== identity.ino) return blocked('sqlite_configuration_invalid');
        const temporary = path.join(this.userData, `.sqlite-development-${randomUUID()}.json`);
        try {
          const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try {
            await file.writeFile(`${JSON.stringify({ formatVersion: 1, intent: 'open', role: 'test', expectedDatabaseId: result.databaseId, ...(config.capabilities ? { capabilities: config.capabilities,...(config.skillPackageRoot?{skillPackageRoot:config.skillPackageRoot}:{}) } : {}) })}\n`);
            await file.sync();
          } finally { await file.close(); }
          if (!canStart()) return blocked('sqlite_cancelled');
          await rename(temporary, target);
        } finally { await rm(temporary, { force: true }); }
      }
      if (config.capabilities) this.contactConfiguration = { userData: this.userData, expectedDatabaseId: result.databaseId, role: 'test', ...readSqliteCapabilities(config.capabilities,config.skillPackageRoot,this.userData)! };
      return { phase: 'ready', code: 'sqlite_ready', schemaVersion: result.schemaVersion, sqliteVersion: result.sqliteVersion,
        ...(config.capabilities ? { capabilities: config.capabilities } : {}) };
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      return blocked(typeof code === 'string' && failureCodes.has(code) ? code : 'sqlite_diagnostic_failed');
    }
  }

  private probe(config: Configuration): Promise<ProbeResult> {
    const moduleUrl = pathToFileURL(path.join(this.projectDirectory, 'backend-ts/src/storage/sqlite/client.ts')).href;
    // 与开发宿主使用同一 Node；不装配 PG、DSH、模型或微信。
    const program = `(async()=>{ let storage; let result;
      try {
        const {SqliteStorage}=await import(${JSON.stringify(moduleUrl)});
        storage=await SqliteStorage.open(${JSON.stringify({ userData: this.userData, intent: config.intent, role: config.role, expectedDatabaseId: config.expectedDatabaseId })});
        const status=storage.status;
        result={databaseId:status.databaseId,schemaVersion:status.schemaVersion,sqliteVersion:status.sqliteVersion};
      } catch(error) { result={code:typeof error?.code==='string'?error.code:'sqlite_diagnostic_failed'}; }
      finally { try { await storage?.close(); } catch { result={code:'worker_failed'}; } }
      console.log(JSON.stringify(result)); })();`;
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
      const timer = setTimeout(stop, 12_000);
      child.stdout.on('data', (data: Buffer) => {
        output += data.toString('utf8');
        if (Buffer.byteLength(output) > 4096) stop();
      });
      child.once('error', () => { /* close 事件统一完成回收和失败。 */ });
      child.once('close', code => {
        clearTimeout(timer); clearTimeout(killTimer);
        if (this.cancelChild === stop) this.cancelChild = undefined;
        try {
          if (stopped || code !== 0) throw new Error();
          const value = JSON.parse(output);
          if (typeof value?.code === 'string') throw Object.assign(new Error(), { code: value.code });
          if (typeof value?.databaseId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.databaseId)
            || !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1
            || typeof value.sqliteVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.sqliteVersion)) throw new Error();
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
  }
}
