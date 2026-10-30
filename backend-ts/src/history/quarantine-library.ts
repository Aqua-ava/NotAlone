import { lstat, readdir } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import { QuarantineVault, QuarantineVaultError, type QuarantineVaultStatus } from './quarantine-vault.ts';

const snapshotPattern = /^snapshot-\d{8}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export interface QuarantineSnapshotSummary {
  id: string;
  status: QuarantineVaultStatus;
}

/** 只扫描固定本机隔离目录下按导入规则命名的直接子目录。 */
export class QuarantineLibrary {
  readonly #root: string;

  constructor(root: string) {
    if (typeof root !== 'string' || !root || !root.trim() || root.includes('\0') || !isAbsolute(root)) {
      throw new QuarantineVaultError('quarantine_root_invalid');
    }
    this.#root = resolve(root);
  }

  async list(): Promise<QuarantineSnapshotSummary[]> {
    const rootBefore = await this.#rootStat(true);
    if (!rootBefore) return [];

    const entries = await readdir(this.#root, { withFileTypes: true });
    const rootAfterRead = await this.#rootStat(false);
    this.#assertSameDirectory(rootBefore, rootAfterRead);

    const result: QuarantineSnapshotSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !snapshotPattern.test(entry.name)) continue;
      const path = join(this.#root, entry.name);
      let before;
      try { before = await lstat(path); } catch { continue; }
      if (before.isSymbolicLink() || !before.isDirectory()) continue;
      try {
        const status = await QuarantineVault.inspect(path);
        const after = await lstat(path);
        if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
          continue;
        }
        result.push({ id: entry.name, status });
      } catch {
        // 某个快照损坏或版本不受支持时，继续列出其他可校验的本机快照。
      }
    }
    return result.sort((left, right) => right.status.createdAt - left.status.createdAt || right.id.localeCompare(left.id));
  }

  async open(id: string): Promise<QuarantineVault> {
    if (typeof id !== 'string' || !snapshotPattern.test(id)) throw new QuarantineVaultError('quarantine_snapshot_id_invalid');
    const rootBefore = await this.#rootStat(false);
    const path = join(this.#root, id);
    let before;
    try { before = await lstat(path); } catch { throw new QuarantineVaultError('quarantine_root_invalid'); }
    if (before.isSymbolicLink() || !before.isDirectory()) throw new QuarantineVaultError('quarantine_root_invalid');

    const status = await QuarantineVault.inspect(path);
    if (status.snapshotState === 'ready' || status.snapshotState === 'running') throw new QuarantineVaultError('quarantine_snapshot_busy');
    const vault = await QuarantineVault.open(path, { rejectActive: true });
    try {
      const rootAfter = await this.#rootStat(false);
      this.#assertSameDirectory(rootBefore, rootAfter);
      const after = await lstat(path);
      if (after.isSymbolicLink() || !after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) {
        throw new QuarantineVaultError('quarantine_path_changed');
      }
      return vault;
    } catch (error) {
      vault.close();
      throw error;
    }
  }

  async #rootStat(missingAllowed: boolean): Promise<Stats | undefined> {
    let stat: Stats;
    try { stat = await lstat(this.#root); }
    catch (error) {
      if (missingAllowed && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new QuarantineVaultError('quarantine_root_invalid');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new QuarantineVaultError('quarantine_root_invalid');
    return stat;
  }

  #assertSameDirectory(before: Stats | undefined, after: Stats | undefined): void {
    if (!before || !after || before.dev !== after.dev || before.ino !== after.ino) throw new QuarantineVaultError('quarantine_path_changed');
  }
}
