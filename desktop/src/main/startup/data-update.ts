import { spawn, type ChildProcess } from 'node:child_process';
import { constants, watch, type FSWatcher } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Writable } from 'node:stream';
import type { BackendHost } from '../backend/host';
import { backendEnvironment, loadBackendConfiguration, type BackendConfiguration } from '../backend/config';
import type { DatabaseUpdateState } from '../../shared/startup-bridge';
import { verifyManagedComponents, type ManagedComponents } from './managed-manifest';
import type { ManagedRuntime } from './managed-runtime';

type Plan = { fingerprint: string; configuration: BackendConfiguration; environmentHash: string };
type Receipt = { formatVersion: 1; fingerprint: string; external: boolean; backup: string; completed?: true; activeFingerprint?: string };
const codes = new Set(['ready', 'migration_pending', 'update_interrupted', 'update_target_changed', 'update_target_unsupported',
  'baseline_missing', 'baseline_invalid', 'baseline_files_mismatch', 'migration_history_mismatch', 'update_schema_mismatch',
  'update_backup_invalid', 'update_backup_incomplete', 'update_recovery_required', 'update_disk_space_insufficient',
  'adoption_writers_present', 'update_source_changed', 'migration_busy', 'migration_failed', 'update_retention_mismatch',
  'backup_restore_failed', 'restore_mismatch', 'update_configuration_invalid', 'update_failed']);

export class LocalDataUpdates {
  private state: DatabaseUpdateState = { phase: 'idle', revision: 0, hasBackup: false, external: false, canContinue: false, canRecheck: false };
  private readonly listeners = new Set<(state: DatabaseUpdateState) => void>();
  private plan: Plan | undefined;
  private components: ManagedComponents | undefined;
  private operation: Promise<void> | undefined;
  private inspection: Promise<void> | undefined;
  private recoveryOperation: Promise<boolean> | undefined;
  private child: ChildProcess | undefined;
  private terminateChild: (() => void) | undefined;
  private commandFinished: Promise<unknown> | undefined;
  private closed = false;
  private generation = 0;
  private backup: string | undefined;
  private backupWatcher: FSWatcher | undefined;
  private recoveryBlocked = false;

  constructor(private readonly userData: string, private readonly resourcesDirectory: string | undefined,
    private readonly managed: ManagedRuntime, private readonly backend: BackendHost) {}

  getState(): DatabaseUpdateState { return { ...this.state }; }
  onStateChanged(listener: (state: DatabaseUpdateState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  getBackupDirectory(): string { return path.join(this.userData, 'updates'); }
  isRecoveryBlocked(): boolean { return this.recoveryBlocked; }

  private monitorBackup(): void {
    this.backupWatcher?.close(); this.backupWatcher = undefined;
    if (!this.backup || this.closed) return;
    const archive = path.join(this.backup, 'database.dump');
    const refresh = () => { void lstat(archive).then(value => value.isFile(), () => false).then(hasBackup => {
      if (!this.closed && this.backup && archive === path.join(this.backup, 'database.dump') && hasBackup !== this.state.hasBackup) this.publish({ hasBackup });
    }); };
    try { this.backupWatcher = watch(archive, { persistent: false }, refresh); this.backupWatcher.on('error', refresh); }
    catch { refresh(); }
  }

  async prepareRecoveryInstructions(): Promise<string> {
    const directory = path.join(this.userData, 'updates');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const selected = path.join(directory, '恢复说明.txt');
    await privateWrite(selected, 'NotAlone 本机资料恢复说明\n\n'
      + '此入口不会覆盖或删除任何数据库。请保留本目录及原资料目录。备份只在这台 Mac 保存，不会上传。\n\n'
      + '每次更新位于独立目录。database.dump 是原资料的完整备份；只有 checkpoint.json 中 restore_verified 为 true 且文件摘要仍匹配，才能称为已验证备份。未完成的归档不可当作已验证恢复点。\n\n'
      + '“重新检查资料”只核验，不会改库。其他程序仍连接时请先正常退出旧版 App。更新中断后可用“继续备份更新”，App 会按真正版本记录续接；不会自动用备份覆盖原资料。\n\n'
      + '旧外置安装的数据库一直保持旧结构；legacy-launch.json 与 retired-launch.json 保留原启动配置，包含私人路径，勿公开分享。若版本记录或备份不一致，请保留现场并使用原版 App 或取得支持后的兼容版本继续；当前版本不会猜测基线或改写凭证。\n\n'
      + '受管资料若已完成部分更新，将保持禁止旧程序重连的保护状态。须用支持本次检查点的兼容版本继续；不要删除数据库锁、迁移记录或恢复点，不要将旧备份覆盖原目录。\n\n'
      + '删除来源、过程、关系资料或助手会话时，会清除本 App 管理的全部已完成更新快照，避免恢复已删除内容。原安装保留的外部资料、你另存的副本和模型供应商副本由你管理，App 不会自动删除。\n\n'
      + '如果提示“更新备份尚未清理”，本次删除没有完成。先在 App 打开备份目录，在 Finder 核对具体目录：未完成更新应先恢复完成；对自己确认不再需要的损坏备份，可在 Finder 移至废纸篓后重试原删除。归属不明的文件请保留并取得支持，不要按猜测清空。App 不会跳过这些目录或把删除显示成成功。\n');
    return selected;
  }

  recoverInterruptedSwitch(): Promise<boolean> {
    if (this.recoveryOperation) return this.recoveryOperation;
    this.recoveryOperation = this.recoverSwitch().finally(() => { this.recoveryOperation = undefined; });
    return this.recoveryOperation;
  }

  private async recoverSwitch(): Promise<boolean> {
    try {
      const receipt = await this.receipt();
      if (!receipt?.external || receipt.completed || await lstat(path.join(this.userData, 'backend-launch.json')).then(() => true, () => false)) { this.recoveryBlocked = false; return true; }
      const backup = path.join(this.userData, 'updates', receipt.backup);
      await privateDirectory(path.join(this.userData, 'updates')); await privateDirectory(backup);
      this.backup = backup;
      this.monitorBackup();
      const retired = path.join(backup, 'retired-launch.json');
      const original = await privateRead(retired, 8192);
      const checkpoint = JSON.parse(await privateRead(path.join(backup, 'checkpoint.json'), 131072));
      if (checkpoint.target_fingerprint !== receipt.fingerprint || checkpoint.restore_verified !== true
        || !/^[a-f0-9]{64}$/.test(checkpoint.destination_fingerprint)) throw new Error('update_target_changed');
      if (checkpoint.activation_complete !== true) await rename(retired, path.join(this.userData, 'backend-launch.json'));
      else {
        if (original !== await privateRead(path.join(backup, 'legacy-launch.json'), 8192)) throw new Error('update_configuration_invalid');
        if (!this.resourcesDirectory) throw new Error('update_recovery_required');
        this.components ??= await verifyManagedComponents(this.resourcesDirectory, () => !this.closed);
        const current = await loadBackendConfiguration(this.userData, this.resourcesDirectory);
        if (current.source !== 'managed') throw new Error('update_configuration_invalid');
        await this.managed.start(current, () => !this.closed);
        const result = await this.command(current, ['--inspect']);
        if (result.target_fingerprint !== checkpoint.destination_fingerprint) throw new Error('update_target_changed');
        if (checkpoint.source_gate === true) {
          const legacy = JSON.parse(original);
          const env = legacy.envFilePath || (typeof legacy.projectDirectory === 'string' ? path.join(legacy.projectDirectory, '.env') : undefined);
          if (typeof env !== 'string' || !path.isAbsolute(env) || /[\0\r\n]/.test(env)) throw new Error('update_configuration_invalid');
          await this.command({ source: 'external', envFilePath: env, infoPath: path.join(this.userData, 'unused-update.info') },
            ['--release-source-gate', '--backup-dir', backup, '--expected-target', receipt.fingerprint]);
        }
        await this.writeReceipt({ ...receipt, completed: true, activeFingerprint: checkpoint.destination_fingerprint });
      }
      this.recoveryBlocked = false;
      return true;
    } catch (error) {
      this.recoveryBlocked = true;
      this.publish({ phase: 'failed', code: safeCode(error), step: undefined, canContinue: false, canRecheck: true });
      return false;
    }
  }

  refresh(): Promise<void> {
    if (this.inspection) return this.inspection;
    this.inspection = this.refreshNow().finally(() => { this.inspection = undefined; });
    return this.inspection;
  }

  private async refreshNow(): Promise<void> {
    if (this.closed || this.operation || !this.resourcesDirectory) return;
    const wasRecoveryBlocked = this.recoveryBlocked;
    if (!await this.recoverInterruptedSwitch()) return;
    const generation = ++this.generation;
    this.plan = undefined;
    try {
      const configuration = await loadBackendConfiguration(this.userData, this.resourcesDirectory);
      if (configuration.source === 'first-run') { this.publish({ phase: 'idle' }); return; }
      this.publish({ phase: 'checking', external: configuration.source === 'external', canContinue: false, canRecheck: false });
      this.components = await verifyManagedComponents(this.resourcesDirectory, () => !this.closed && generation === this.generation);
      const environmentHash = await this.environmentHash(configuration);
      const inspected = await this.command(configuration, ['--inspect']);
      if (this.closed || generation !== this.generation) return;
      if (typeof inspected.target_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(inspected.target_fingerprint)) throw new Error(String(inspected.code));
      this.plan = { fingerprint: inspected.target_fingerprint, configuration, environmentHash };
      const receipt = await this.receipt();
      if (receipt && (receipt.fingerprint === this.plan.fingerprint || receipt.completed && receipt.activeFingerprint === this.plan.fingerprint)) {
        this.backup = path.join(this.userData, 'updates', receipt.backup);
        this.publish({ hasBackup: await lstat(path.join(this.backup, 'database.dump')).then(value => value.isFile(), () => false) });
        this.monitorBackup();
      }
      const available = configuration.source === 'external' || inspected.code !== 'ready';
      if (wasRecoveryBlocked && !available) await this.backend.connect();
      this.publish({ phase: available ? 'available' : receipt?.completed && receipt.activeFingerprint === this.plan.fingerprint ? 'complete' : 'idle',
        code: String(inspected.code), step: undefined, canContinue: available, canRecheck: true });
    } catch (error) {
      if (!this.closed && generation === this.generation) this.publish({ phase: 'failed', code: safeCode(error), step: undefined, canContinue: false, canRecheck: true });
    }
  }

  begin(): Promise<void> {
    if (this.closed || this.operation || this.inspection || !this.plan || !this.state.canContinue || !['available', 'failed'].includes(this.state.phase)) return Promise.reject(new Error('资料更新暂时不可用'));
    ++this.generation;
    const plan = this.plan;
    this.operation = this.perform(plan).catch(error => {
      const code = safeCode(error);
      if (!this.closed) this.publish({ phase: 'failed', code, step: undefined, canRecheck: true,
        canContinue: !['update_target_changed', 'update_source_changed', 'update_retention_mismatch', 'update_schema_mismatch',
          'update_backup_invalid', 'update_recovery_required', 'migration_history_mismatch', 'baseline_invalid', 'baseline_missing'].includes(code) });
      throw new Error('资料更新未完成，请按当前提示恢复');
    }).finally(() => { this.operation = undefined; });
    return this.operation;
  }

  async stop(): Promise<void> {
    this.closed = true; ++this.generation;
    this.backupWatcher?.close(); this.backupWatcher = undefined;
    // 每个更新命令是本次 spawn 的独立组；数据库 guardian 另按寿命锁顺序退出。
    this.terminateChild?.();
    await this.commandFinished?.catch(() => {});
    await this.inspection?.catch(() => {});
    await this.recoveryOperation?.catch(() => {});
    await this.operation?.catch(() => {});
  }

  private async perform(plan: Plan): Promise<void> {
    this.publish({ phase: 'running', step: 'stopping', code: undefined, canContinue: false, canRecheck: false });
    if (!await this.backend.prepareConfiguration() || this.closed) throw new Error('update_stop_unconfirmed');
    await this.backend.saveStartupConfiguration(async () => { await this.performLocked(plan); });
    if (this.closed) throw new Error('update_interrupted');
    this.publish({ step: 'reconnecting' });
    await this.backend.connect();
    if (this.backend.getState().phase !== 'connected') throw new Error('update_reconnect_failed');
    this.publish({ phase: 'complete', code: 'ready', step: undefined, canContinue: false, canRecheck: false });
  }

  private async performLocked(plan: Plan): Promise<void> {
    const current = await loadBackendConfiguration(this.userData, this.resourcesDirectory);
    if (JSON.stringify(current) !== JSON.stringify(plan.configuration) || await this.environmentHash(current) !== plan.environmentHash) throw new Error('update_target_changed');
    let destination: string | undefined;
    this.publish({ step: 'preparing' });
    if (current.source === 'external') destination = await this.managed.prepareImportTarget(() => !this.closed);
    else await this.managed.start(current, () => !this.closed);
    if (this.closed) throw new Error('update_interrupted');
    const inspected = await this.command(current, ['--inspect']);
    if (inspected.target_fingerprint !== plan.fingerprint) throw new Error('update_target_changed');
    const updates = path.join(this.userData, 'updates');
    await mkdir(updates, { recursive: true, mode: 0o700 });
    await privateDirectory(updates);
    let receipt = await this.receipt();
    if (receipt?.completed && receipt.activeFingerprint === plan.fingerprint && inspected.code === 'ready') {
      this.backup = path.join(updates, receipt.backup);
      this.publish({ hasBackup: await lstat(path.join(this.backup, 'database.dump')).then(value => value.isFile(), () => false) });
      this.monitorBackup();
      return;
    }
    if (receipt?.completed && !['ready', 'migration_pending'].includes(String(inspected.code))) throw new Error('update_recovery_required');
    if (!receipt || receipt.completed || receipt.fingerprint !== plan.fingerprint || receipt.external !== (current.source === 'external')) {
      receipt = { formatVersion: 1, fingerprint: plan.fingerprint, external: current.source === 'external', backup: randomUUID() };
      await this.writeReceipt(receipt);
    }
    this.backup = path.join(updates, receipt.backup);
    // 备份尚未得到恢复凭证时可以重新备份；保留上次失败归档供查看，不当作恢复点。
    if (await stat(this.backup).then(() => true, () => false)
      && !await stat(path.join(this.backup, 'checkpoint.json')).then(() => true, () => false)) {
      await privateDirectory(this.backup);
      await rename(this.backup, `${this.backup}-incomplete-${randomUUID()}`);
    }
    this.publish({ step: 'verifying' });
    let switched = false;
    try {
      await this.command(current, [destination ? '--copy-update' : '--update', '--backup-dir', this.backup, '--expected-target', plan.fingerprint,
        ...(destination ? ['--destination-env-file', path.join(this.userData, 'managed/runtime.env'), '--activation-fd', '3'] : [])], destination,
      destination ? async () => {
        if (this.closed) throw new Error('update_interrupted');
        const savedConfiguration = await readFile(path.join(this.userData, 'backend-launch.json'));
        const preserved = path.join(this.backup!, 'legacy-launch.json');
        try { await writeFile(preserved, savedConfiguration, { mode: 0o600, flag: 'wx' }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
          || !savedConfiguration.equals(await readFile(preserved))) throw new Error('update_configuration_invalid'); }
        await this.managed.completeImport();
        if (this.closed) throw new Error('update_interrupted');
        await rename(path.join(this.userData, 'backend-launch.json'), path.join(this.backup!, 'retired-launch.json'));
        await chmod(path.join(this.backup!, 'retired-launch.json'), 0o600);
        switched = true;
      } : undefined);
      const completed = JSON.parse(await privateRead(path.join(this.backup, 'checkpoint.json'), 131072));
      if (completed.phase !== 'complete' || completed.restore_verified !== true || completed.connection_gate !== false
        || destination && (completed.activation_complete !== true || completed.source_gate !== false)) throw new Error('update_recovery_required');
      const activeFingerprint = destination ? completed.destination_fingerprint : plan.fingerprint;
      if (typeof activeFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(activeFingerprint)) throw new Error('update_target_changed');
      await this.writeReceipt({ ...receipt, completed: true, activeFingerprint });
    } catch (error) {
      if (switched) await rename(path.join(this.backup, 'retired-launch.json'), path.join(this.userData, 'backend-launch.json'));
      throw error;
    } finally {
      this.publish({ hasBackup: await lstat(path.join(this.backup, 'database.dump')).then(value => value.isFile(), () => false) });
      this.monitorBackup();
    }
    if (this.closed) throw new Error('update_interrupted');
  }

  private async command(configuration: BackendConfiguration, arguments_: string[], destination?: string,
    activate?: () => Promise<void>): Promise<Record<string, unknown>> {
    if (this.closed || !this.components) throw new Error('update_interrupted');
    const components = this.components;
    const environment: NodeJS.ProcessEnv = { ...backendEnvironment({ ...configuration, source: 'managed' }, this.userData),
      PATH: `${components.postgres}:/usr/bin:/bin`, NOTALONE_ENV_FILE: configuration.envFilePath || path.join(configuration.projectDirectory || '', '.env'),
      ...(destination ? { NOTALONE_UPDATE_DESTINATION_URL: destination } : {}) };
    delete environment.NOTALONE_MANAGED_PG_LIFETIME_LOCK;
    const child = spawn(components.python, ['-I', '-B', '-m', 'notalone.database_updates', '--migrations',
      path.join(components.project, 'backend/database/migrations'), '--parent-pid', String(process.pid),
      ...(this.managed.getLifetimeLock() ? ['--lifetime-lock', this.managed.getLifetimeLock()!] : []), ...arguments_],
    { cwd: this.userData, env: environment, detached: true, stdio: ['pipe', 'pipe', 'ignore', 'pipe'] });
    this.child = child;
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      let output = ''; let outputBytes = 0; let interrupted = false; let response: Record<string, unknown> | undefined;
      let activation: Promise<void> | undefined;
      let force: NodeJS.Timeout | undefined;
      const stop = () => {
        if (interrupted) return;
        interrupted = true;
        child.stdin?.end();
        try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { /* 自有命令已退场。 */ }
        force = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* 只回收本次命令组。 */ } }, 3000);
      };
      this.terminateChild = stop;
      const timer = setTimeout(stop, arguments_.includes('--inspect') ? 15_000 : 300_000);
      child.stdout!.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > 4096) { stop(); return; }
        output += chunk.toString('utf8');
        let newline: number;
        while ((newline = output.indexOf('\n')) >= 0) {
          const line = output.slice(0, newline); output = output.slice(newline + 1);
          try {
            const value = JSON.parse(line);
            if (value.code === 'activation_ready' && Object.keys(value).length === 1 && activate && !activation && !response) {
              activation = activate().then(() => { if (this.closed || interrupted) throw new Error(); (child.stdio[3] as Writable).write('activate\n'); })
                .catch(() => { stop(); });
            } else if (response || !codes.has(value.code)) { stop(); }
            else response = value;
          } catch { stop(); }
        }
      });
      child.once('error', () => { clearTimeout(timer); clearTimeout(force); if (this.child === child) this.child = undefined; reject(new Error('update_failed')); });
      child.once('close', async exitCode => {
        await activation?.catch(() => {});
        const clean = await finishCommandGroup(child.pid);
        clearTimeout(timer); clearTimeout(force); if (this.child === child) this.child = undefined;
        try {
          if (!clean || !response || output.trim() || exitCode !== 0 || interrupted || this.closed) throw new Error(String(response?.code));
          resolve(response);
        } catch (error) { reject(new Error(this.closed ? 'update_interrupted' : safeCode(error))); }
      });
    });
    this.commandFinished = result;
    try { return await result; }
    finally { if (this.commandFinished === result) { this.commandFinished = undefined; this.terminateChild = undefined; } }
  }

  private async environmentHash(configuration: BackendConfiguration): Promise<string> {
    const file = configuration.envFilePath || path.join(configuration.projectDirectory || '', '.env');
    const descriptor = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const metadata = await descriptor.stat(); if (!metadata.isFile() || metadata.size > 1_048_576) throw new Error();
      return createHash('sha256').update(await descriptor.readFile()).digest('hex'); } finally { await descriptor.close(); }
  }
  private async receipt(): Promise<Receipt | undefined> {
    try {
      const file = await open(path.join(this.userData, 'update-operation.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const metadata = await file.stat(); if (!metadata.isFile() || metadata.size > 4096 || metadata.mode & 0o077 || process.getuid && metadata.uid !== process.getuid()) throw new Error();
        const value = JSON.parse(await file.readFile('utf8'));
        if (value.formatVersion !== 1 || !/^[a-f0-9]{64}$/.test(value.fingerprint) || typeof value.external !== 'boolean'
          || !/^[a-f0-9-]{36}$/.test(value.backup)
          || (Object.keys(value).length !== 4 && (Object.keys(value).length !== 6 || value.completed !== true || !/^[a-f0-9]{64}$/.test(value.activeFingerprint)))) throw new Error();
        return value;
      } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('update_configuration_invalid'); }
  }
  private async writeReceipt(value: Receipt): Promise<void> {
    await privateWrite(path.join(this.userData, 'update-operation.json'), JSON.stringify(value));
  }
  private publish(update: Partial<DatabaseUpdateState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}

async function privateDirectory(selected: string): Promise<void> {
  const metadata = await lstat(selected);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.mode & 0o077 || process.getuid && metadata.uid !== process.getuid()
    || await realpath(selected) !== path.join(await realpath(path.dirname(selected)), path.basename(selected))) throw new Error('update_configuration_invalid');
}
async function privateRead(selected: string, limit: number): Promise<string> {
  const file = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > limit || metadata.mode & 0o077 || process.getuid && metadata.uid !== process.getuid()) throw new Error('update_configuration_invalid');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('update_configuration_invalid');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}
async function privateWrite(selected: string, value: string): Promise<void> {
  const temporary = path.join(path.dirname(selected), `.data-update-${randomUUID()}`);
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
  await rename(temporary, selected);
  const directory = await open(path.dirname(selected), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function finishCommandGroup(pid: number | undefined): Promise<boolean> {
  if (!pid) return true;
  const alive = () => { try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
  if (!alive()) return true;
  try { process.kill(-pid, 'SIGTERM'); } catch { /* 自有组已经退场。 */ }
  const deadline = Date.now() + 3000;
  while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  if (!alive()) return true;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* 不触碰其他进程组。 */ }
  const killedDeadline = Date.now() + 1000;
  while (alive() && Date.now() < killedDeadline) await new Promise(resolve => setTimeout(resolve, 50));
  return !alive();
}

function safeCode(error: unknown): string {
  return error instanceof Error && (codes.has(error.message) || ['update_stop_unconfirmed', 'update_reconnect_failed'].includes(error.message)) ? error.message : 'update_failed';
}
