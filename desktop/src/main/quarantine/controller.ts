import type { QuarantineLibrary } from '../../../../backend-ts/src/history/quarantine-library.ts';
import type { QuarantineVault } from '../../../../backend-ts/src/history/quarantine-vault.ts';
import type { QuarantineSnapshot } from '../../shared/quarantine-bridge';

export interface QuarantinePresentation {
  closed: Promise<void>;
  focus(): void;
  close(): Promise<void>;
}
type OpenSnapshot = { id: string; vault: QuarantineVault; window: QuarantinePresentation; releasing?: boolean };

/** 独立窗口只持有一个隔离仓，不读取联系人、后端或生成服务。 */
export class QuarantineController {
  private current?: OpenSnapshot;
  private pending: Promise<void> = Promise.resolve();
  private stopping = false;
  constructor(private readonly library: Pick<QuarantineLibrary, 'list' | 'open'>,
    private readonly present: (vault: QuarantineVault) => Promise<QuarantinePresentation>) {}

  async list(): Promise<QuarantineSnapshot[]> {
    if (this.stopping) throw new Error('隔离历史窗口正在关闭。');
    const snapshots = await this.library.list();
    return snapshots.map(({ id, status }) => ({ id, displayName: status.displayName,
      recordCount: status.recordCount, createdAt: status.createdAt, snapshotComplete: status.snapshotComplete,
      snapshotState: status.snapshotState }));
  }

  open(id: string): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('隔离历史窗口正在关闭。'));
    return this.enqueue(async () => {
      if (this.stopping) throw new Error('隔离历史窗口正在关闭。');
      if (this.current?.id === id && !this.current.releasing) { this.current.window.focus(); return; }
      await this.release();
      const vault = await this.library.open(id);
      let window: QuarantinePresentation;
      try { window = await this.present(vault); }
      catch (error) { vault.close(); throw error; }
      this.current = { id, vault, window };
      void window.closed.then(() => this.enqueue(async () => {
        if (this.current?.window === window) await this.release();
      })).catch(() => {});
      if (this.stopping) await this.release();
    });
  }

  close(): Promise<void> {
    this.stopping = true;
    return this.enqueue(() => this.release());
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }
  private async release(): Promise<void> {
    const current = this.current;
    if (current) {
      current.releasing = true;
      current.vault.close();
      await current.window.close();
      if (this.current === current) this.current = undefined;
    }
  }
}
