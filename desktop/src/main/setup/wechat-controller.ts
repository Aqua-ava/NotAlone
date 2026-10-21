import type { BackendHost } from '../backend/host';
import type { WechatSetupConfirmation, WechatSetupState } from '../../shared/wechat-setup-bridge';

type Operation = { generation: number; epoch: number };
type Report = { state: WechatSetupState['phase']; account_id: string | null; candidate_token: string | null; failure_code: string | null };
const serverStates = new Set(['needs_detection', 'needs_owner', 'tool_unavailable', 'tool_not_ready', 'ready', 'connected', 'restart_required', 'conflict']);
function report(data: unknown): Report {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('微信连接状态无效');
  const value = data as Report;
  if (!serverStates.has(value.state)
    || !(value.account_id === null || typeof value.account_id === 'string' && value.account_id.length > 0 && value.account_id.length <= 256 && !/[\u0000-\u001f]/.test(value.account_id))
    || !(value.candidate_token === null || typeof value.candidate_token === 'string' && value.candidate_token.length > 0 && value.candidate_token.length <= 512)
    || !(value.failure_code === null || typeof value.failure_code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(value.failure_code))
    || value.state === 'ready' && (!value.account_id || !value.candidate_token)
    || ['connected', 'restart_required'].includes(value.state) && !value.account_id) throw new Error('微信连接状态无效');
  return value;
}

// 授权候选只保存在主进程，渲染进程不能指定本人或微信账号。
export class WechatSetupController {
  private state: WechatSetupState = { phase: 'offline', accountId: null, failureCode: null, revision: 0 };
  private token: string | null = null;
  private epoch = 0;
  private busy = false;
  private pendingRestart = false;
  private generation: number | undefined;
  private listeners = new Set<(state: WechatSetupState) => void>();
  constructor(private readonly backend: BackendHost) {
    this.generation = backend.getConnectionGeneration();
    backend.onStateChanged(() => {
      const generation = backend.getConnectionGeneration();
      if (generation === this.generation) return;
      this.generation = generation;
      ++this.epoch;
      this.token = null;
      if (this.busy && this.state.phase === 'restarting') return;
      this.pendingRestart = false;
      this.publish({ phase: 'offline', accountId: null, failureCode: null });
      if (generation !== undefined) void this.refresh();
    });
  }
  getState(): WechatSetupState { return { ...this.state }; }
  onStateChanged(listener: (state: WechatSetupState) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  async refresh(): Promise<void> {
    if (this.busy) return;
    const operation = this.begin();
    if (operation) await this.read(operation);
  }
  async detect(): Promise<void> {
    if (this.busy || ['connected', 'restart_required', 'restart-failed', 'needs_owner'].includes(this.state.phase)) return;
    const operation = this.begin();
    if (!operation) return;
    this.busy = true;
    this.token = null;
    this.publish({ phase: 'loading', accountId: null, failureCode: null });
    try {
      const result = await this.backend.requestJson({ method: 'POST', path: '/api/setup/wechat/detect', body: {}, timeoutMs: 10_000, maxResponseBytes: 4096 });
      const value = report(result.data);
      if (this.current(operation)) this.accept(value);
    } catch {
      if (this.current(operation)) this.publish({ phase: 'failed', failureCode: 'detection_failed' });
    } finally {
      this.busy = false;
      if (!this.current(operation) && this.getState().phase === 'offline' && this.backend.getConnectionGeneration() !== undefined) void this.refresh();
    }
  }
  private async read(operation: Operation, expectedAccount?: string | null): Promise<Report | undefined> {
    this.token = null;
    this.publish({ phase: 'loading', accountId: null, failureCode: null });
    try {
      const result = await this.backend.requestJson({ method: 'GET', path: '/api/setup/wechat', maxResponseBytes: 4096 });
      const value = report(result.data);
      if (!this.current(operation)) return;
      if (expectedAccount && ['connected', 'restart_required'].includes(value.state) && value.account_id !== expectedAccount) {
        this.accept({ state: 'conflict', account_id: null, candidate_token: null, failure_code: 'account_changed' });
        return;
      }
      this.accept(value);
      return value;
    } catch {
      if (this.current(operation)) this.publish({ phase: 'failed', accountId: null, failureCode: 'status_unavailable' });
    }
  }
  private accept(value: Report): void {
    this.token = value.state === 'ready' ? value.candidate_token : null;
    this.pendingRestart = value.state === 'restart_required';
    this.publish({ phase: value.state, accountId: value.account_id, failureCode: value.failure_code });
  }
  async confirm(request: WechatSetupConfirmation): Promise<void> {
    if (request.confirmed !== true || request.revision !== this.state.revision) throw new Error('微信连接页面已变化，请重新核对');
    if (this.busy || this.state.phase !== 'ready' || !this.token) return;
    const operation = this.begin();
    if (!operation) return;
    const token = this.token;
    const accountId = this.state.accountId;
    this.token = null;
    this.busy = true;
    this.publish({ phase: 'saving', failureCode: null });
    try {
      try {
        const result = await this.backend.requestJson({ method: 'POST', path: '/api/setup/wechat/confirm',
          body: { candidate_token: token, confirmed: true }, timeoutMs: 30_000, maxResponseBytes: 4096 });
        const value = report(result.data);
        if (!this.current(operation)) return;
        if (['connected', 'restart_required'].includes(value.state) && value.account_id !== accountId) throw new Error('account changed');
        this.accept(value);
      } catch {
        if (!this.current(operation)) return;
        // 只读核验已持久化结果；丢失响应时不重放授权。
        await this.read(operation, accountId);
      }
      if (!this.current(operation)) return;
      if (this.pendingRestart) await this.restart();
    } finally {
      this.busy = false;
      if (!this.current(operation) && this.getState().phase === 'offline' && this.backend.getConnectionGeneration() !== undefined) void this.refresh();
    }
  }
  async retryRestart(): Promise<void> {
    if (this.busy || !this.pendingRestart) return;
    this.busy = true;
    try { await this.restart(); } finally { this.busy = false; }
  }
  private async restart(): Promise<void> {
    const accountId = this.state.accountId;
    const generation = this.backend.getConnectionGeneration();
    const epoch = this.epoch;
    this.publish({ phase: 'restarting', failureCode: null });
    let restarted = false;
    try { restarted = await this.backend.restart(); } catch { /* 读取当前连接，避免旧重启错误覆盖新状态。 */ }
    if (!restarted && generation === this.backend.getConnectionGeneration() && epoch === this.epoch) {
      this.publish({ phase: 'restart-failed', accountId, failureCode: 'reload_failed' }); return;
    }
    const operation = this.begin();
    if (!operation) {
      this.publish({ phase: 'offline', accountId, failureCode: 'reload_failed' }); return;
    }
    const value = await this.read(operation, accountId);
    if (!this.current(operation) || this.state.phase === 'conflict') return;
    if (value?.state === 'connected') this.pendingRestart = false;
    else {
      this.pendingRestart = true;
      this.publish({ phase: 'restart-failed', accountId, failureCode: 'reload_failed' });
    }
  }
  private begin(): Operation | undefined {
    const generation = this.backend.getConnectionGeneration();
    return generation === undefined ? undefined : { generation, epoch: ++this.epoch };
  }
  private current(operation: Operation): boolean {
    return operation.generation === this.backend.getConnectionGeneration() && operation.epoch === this.epoch;
  }
  private publish(update: Partial<WechatSetupState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}
