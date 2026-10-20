import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import type { SyncControlController } from './controller';

export class SyncPriorityController {
  private generation: number | undefined;
  private enabled: boolean | undefined;
  private desiredContactId: string | null = null;
  private acceptedContactId: string | null | undefined;
  private cleared = false;
  private pending: AbortController | undefined;
  private running: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private disposed = false;
  private readonly unsubscribe: (() => void)[];

  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession,
    private readonly sync: SyncControlController) {
    this.unsubscribe = [backend.onStateChanged(() => this.synchronize()),
      contacts.onStateChanged(() => this.synchronize()), sync.onStateChanged(() => this.synchronize())];
    this.synchronize();
  }

  private synchronize(): void {
    if (this.disposed || this.closing) return;
    const generation = this.backend.getConnectionGeneration();
    if (generation !== this.generation) {
      this.pending?.abort();
      this.generation = generation; this.enabled = undefined;
      this.acceptedContactId = undefined; this.cleared = false;
    }
    const sync = this.sync.getState();
    if (sync.busy === 'disable') this.enabled = false;
    else if (sync.phase === 'ready' && sync.report) this.enabled = sync.report.enabled;
    // 普通状态刷新暂时没有报告，不代表用户关闭了同步。
    const contact = this.contacts.getState();
    this.desiredContactId = this.enabled === true && ['ready', 'loading'].includes(contact.directoryPhase)
      && contact.contacts.some((item) => item.contactId === contact.selectedContactId)
      ? contact.selectedContactId : null;
    this.start();
  }

  private start(): void {
    const generation = this.generation;
    if (this.disposed || this.running || generation === undefined || !this.current(generation)
      || this.cleared && this.acceptedContactId === this.desiredContactId) return;
    const running = this.drain(generation).finally(() => {
      if (this.running === running) this.running = undefined;
      if (generation !== this.generation && !this.closing) this.start();
    });
    this.running = running;
  }

  private async drain(generation: number): Promise<void> {
    while (this.current(generation)) {
      // 复用后台时先清除上一次 App 会话的提示，再登记当前有效选择。
      const contactId = this.cleared ? this.desiredContactId : null;
      if (this.cleared && contactId === this.acceptedContactId) return;
      const pending = new AbortController(); this.pending = pending;
      try {
        const response = await this.backend.requestJson({ method: 'POST', path: '/api/sync/priority',
          body: { contact_id: contactId }, timeoutMs: 2000, maxResponseBytes: 16_384, signal: pending.signal });
        if (!this.current(generation) || response.generation !== generation) return;
        this.cleared = true; this.acceptedContactId = contactId;
      } catch {
        // 提示登记失败不更改总开关；后续有效范围或状态事件会重新核对最新目标。
        return;
      } finally { if (this.pending === pending) this.pending = undefined; }
      // 同一连接串行提交；切换期间只继续登记最新目标，不重放中间联系人。
    }
  }

  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation && generation === this.backend.getConnectionGeneration();
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.desiredContactId = null; this.enabled = false;
    this.closing = (async () => {
      await this.running;
      this.start(); await this.running;
      this.disposed = true; this.pending?.abort();
    })();
    return this.closing;
  }
}
