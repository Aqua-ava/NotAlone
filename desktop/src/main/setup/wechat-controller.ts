import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import { validWechatSetupConfirmation, type WechatSetupConfirmation, type WechatSetupState } from '../../shared/wechat-setup-bridge';
import { StateStore } from '../state-store';

type Operation = { generation: number; epoch: number };
type Report = { state: WechatSetupState['phase']; account_id: string | null; candidate_token: string | null; failure_code: string | null; source_reconfirmation_required?: boolean;
  wechat_compatibility?: { detected_program_version: string; detected_build: string; supported_program_version: string; supported_build: string } };
const serverStates = new Set(['needs_detection', 'needs_owner', 'tool_unavailable', 'tool_not_ready', 'ready', 'connected', 'restart_required', 'conflict']);
const versionPattern = /^[0-9]{1,3}(\.[0-9]{1,3}){1,3}$/;
const buildPattern = /^[0-9]{1,12}$/;
function validCompatibility(value: unknown): value is NonNullable<Report['wechat_compatibility']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 4
    && Object.keys(row).every(key => ['detected_program_version', 'detected_build', 'supported_program_version', 'supported_build'].includes(key))
    && typeof row.detected_program_version === 'string' && versionPattern.test(row.detected_program_version)
    && typeof row.detected_build === 'string' && buildPattern.test(row.detected_build)
    && typeof row.supported_program_version === 'string' && versionPattern.test(row.supported_program_version)
    && typeof row.supported_build === 'string' && buildPattern.test(row.supported_build);
}
function report(data: unknown): Report {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('微信连接状态无效');
  const value = data as Report;
  if (!serverStates.has(value.state)
    || !(value.account_id === null || typeof value.account_id === 'string' && value.account_id.length > 0 && value.account_id.length <= 256 && !/[\u0000-\u001f]/.test(value.account_id))
    || !(value.candidate_token === null || typeof value.candidate_token === 'string' && value.candidate_token.length > 0 && value.candidate_token.length <= 512)
    || !(value.failure_code === null || typeof value.failure_code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(value.failure_code))
    || value.source_reconfirmation_required !== undefined && typeof value.source_reconfirmation_required !== 'boolean'
    || value.source_reconfirmation_required === true && value.state !== 'ready'
    || value.wechat_compatibility !== undefined && !validCompatibility(value.wechat_compatibility)
    || value.state === 'ready' && (!value.account_id || !value.candidate_token)
    || ['connected', 'restart_required'].includes(value.state) && !value.account_id) throw new Error('微信连接状态无效');
  return value;
}

// 授权候选只保存在主进程，渲染进程不能指定本人或微信账号。
export class WechatSetupController extends StateStore<WechatSetupState> {
  private token: string | null = null;
  private epoch = 0;
  private busy = false;
  private pendingRestart = false;
  private generation: number | undefined;
  constructor(private readonly backend: BackendHost) {
    super({ phase: 'offline', accountId: null, failureCode: null, revision: 0 });
    this.generation = backend.getConnectionGeneration();
    backend.onStateChanged(() => {
      const generation = backend.getConnectionGeneration();
      if (generation === this.generation) return;
      this.generation = generation;
      ++this.epoch;
      this.token = null;
      if (this.busy && this.state.phase === 'restarting') return;
      this.pendingRestart = false;
      this.publish({ phase: 'offline', accountId: null, failureCode: null, sourceReconfirmationRequired: false, versionCheck: undefined });
      if (generation !== undefined) void this.refresh();
    });
  }
  async refresh(): Promise<void> {
    if (this.busy) return;
    const operation = this.begin();
    if (operation) await this.read(operation);
  }
  async detect(): Promise<void> {
    if (this.busy || ['restart_required', 'restart-failed', 'needs_owner'].includes(this.state.phase)) return;
    const operation = this.begin();
    if (!operation) return;
    this.busy = true;
    const previousAccount = this.state.accountId;
    const previousPhase = this.state.phase;
    this.token = null;
    this.publish({ phase: 'loading', accountId: null, failureCode: null, compatibility: undefined, versionCheck: undefined });
    try {
      const result = await this.backend.requestJson({ method: 'POST', path: '/api/setup/wechat/detect', body: {}, timeoutMs: 10_000, maxResponseBytes: 4096 });
      const value = report(result.data);
      if (this.current(operation)) {
        if (previousPhase === 'connected' && value.state === 'ready' && value.account_id === previousAccount
          && value.source_reconfirmation_required !== true) {
          this.accept({ state: 'connected', account_id: previousAccount, candidate_token: null, failure_code: null });
          this.publish({ versionCheck: 'passed' });
        } else {
          const retained = value.account_id ?? (['tool_not_ready', 'tool_unavailable'].includes(value.state) ? previousAccount : null);
          this.accept({ ...value, account_id: retained });
        }
      }
    } catch {
      if (this.current(operation)) this.publish({ phase: 'failed', accountId: previousAccount, failureCode: 'detection_failed' });
    } finally {
      this.busy = false;
      if (!this.current(operation) && this.getState().phase === 'offline' && this.backend.getConnectionGeneration() !== undefined) void this.refresh();
    }
  }
  private async read(operation: Operation, expectedAccount?: string | null): Promise<Report | undefined> {
    this.token = null;
    // 已连接时后台查询保留可用展示，避免周期性卸载同步设置。
    if (!['connected', 'needs_owner', 'needs_detection'].includes(this.state.phase)) this.publish({ phase: 'loading', accountId: null, failureCode: null, compatibility: undefined });
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
    const compatibility = value.wechat_compatibility ? { detectedProgramVersion: value.wechat_compatibility.detected_program_version,
      detectedBuild: value.wechat_compatibility.detected_build, supportedProgramVersion: value.wechat_compatibility.supported_program_version,
      supportedBuild: value.wechat_compatibility.supported_build } : undefined;
    this.publish({ phase: value.state, accountId: value.account_id, failureCode: value.failure_code,
      sourceReconfirmationRequired: value.source_reconfirmation_required === true, compatibility,
      ...(value.state === 'connected' ? {} : { versionCheck: undefined }) });
  }
  async confirm(request: WechatSetupConfirmation): Promise<void> {
    if (!validWechatSetupConfirmation(request) || request.revision !== this.state.revision) throw new Error('微信连接页面已变化，请重新核对');
    if (Boolean(request.sourceReconfirmed) !== Boolean(this.state.sourceReconfirmationRequired)) throw new Error('请明确核对本次微信资料来源');
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
          body: { candidate_token: token, confirmed: true, mode: request.mode, history_authorized: request.historyAuthorized,
            ...(request.sourceReconfirmed ? { source_reconfirmed: true } : {}) }, timeoutMs: 30_000, maxResponseBytes: 4096 });
        const value = report(result.data);
        if (!this.current(operation)) return;
        if (['connected', 'restart_required'].includes(value.state) && value.account_id !== accountId) throw new Error('account changed');
        this.accept(value);
      } catch (error) {
        if (!this.current(operation)) return;
        // 已明确拒绝的来源换代没有保存成功，不能用普通状态读回抹去原因。
        if (error instanceof BackendRequestFailure && error.kind === 'response'
          && error.code === 'identity_continuity_unverified') {
          this.accept({ state: 'conflict', account_id: null, candidate_token: null, failure_code: error.code });
          return;
        }
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
}
