import { rm } from 'node:fs/promises';
import type { BackendState } from '../../shared/backend-bridge';
import { BackendFailure, readConnection } from './connection';
import { startupErrorCode } from '../../../../backend-ts/src/startup-diagnostics';
import { RetiredBackendRuntime, RuntimeClient } from './runtime-client';
import { loadBackendConfiguration, type BackendConfiguration } from './config';
import { OwnedBackendProcess, type OwnedProcess } from './process';
import { BackendRequestFailure, type JsonRequest } from './json-client';
import type { MessageStreamCallbacks } from './message-stream';
import { readAssistantGenerationReceipt } from '../reply/assistant-generation-jobs';
import { isRecord } from '../reply/result-read';
import { isUuid } from '../uuid';
import { sqliteStartupTimeoutMs } from '../../../../backend-ts/src/storage/sqlite/timeouts';

export interface MediaPreviewConnection {status(): Promise<'active' | 'revoking'>; release(): Promise<void>}

function backendProcessHasExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

export class BackendHost {
  private state: BackendState = { phase: 'disconnected', reused: false, revision: 0, canRetryConnection: true, canRetryShutdown: false,
    canSaveStartupPaths: true, canPrepareConfiguration: false };
  private target: RuntimeClient | undefined;
  private ownedChild: OwnedProcess | undefined;
  private initialization: Promise<void> | undefined;
  private stopping: Promise<boolean> | undefined;
  private closing = false;
  private quitting = false;
  private quitPreparationFailed = false;
  private restarting: Promise<boolean> | undefined;
  private preparing: Promise<boolean> | undefined;
  private configurationSave: Promise<void> | undefined;
  private generation = 0;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<(state: BackendState) => void>();
  private readonly manualContacts = new Map<string, number>();
  private readonly unreleasedMediaPreviews = new Set<MediaPreviewConnection>();
  private mediaReleaseDrain: Promise<void> | undefined;
  private connectionChangePreparation: (() => Promise<void>) | undefined;

  setConnectionChangePreparation(prepare: () => Promise<void>): void { this.connectionChangePreparation = prepare; }

  confirmManualInput(contactId: string, generation: number): void {
    if (generation !== this.getConnectionGeneration()) throw new Error('手动联系人确认已失效。');
    this.manualContacts.set(contactId, generation);
  }

  clearManualInput(contactId: string): void { this.manualContacts.delete(contactId); }

  constructor(private readonly userData: string,
    private readonly beforeConnect?: (config: BackendConfiguration, canStart: () => boolean) => Promise<void>,
    private readonly resourcesDirectory?: string,
    private readonly afterShutdown?: () => Promise<boolean>) {}

  getState(): BackendState {
    return { ...this.state, canSaveStartupPaths: !this.configurationSave && this.configurationCanChange(),
      canPrepareConfiguration: !this.quitting && !this.restarting && !this.preparing && !this.stopping && !this.initialization
        && Boolean(this.target || this.ownedChild) && ['connected', 'disconnected', 'shutdown-failed'].includes(this.state.phase) };
  }
  saveStartupConfiguration(save: (canSave: () => boolean) => Promise<void>): Promise<void> {
    if (!this.getState().canSaveStartupPaths) return Promise.reject(new Error('启动配置暂时不可修改'));
    // 保存期间的新连接等待落盘；写入前仍核验实际持有的运行时，退出优先。
    this.configurationSave = Promise.resolve().then(() => save(() => this.configurationCanChange()))
      .finally(() => { this.configurationSave = undefined; this.publishEligibility(); });
    this.publishEligibility();
    return this.configurationSave;
  }
  getConnectionGeneration(): number | undefined {
    return !this.closing && (this.state.phase === 'connected'
      || this.quitting && this.quitPreparationFailed && this.state.phase === 'shutdown-failed')
      && this.target ? this.generation : undefined;
  }
  subscribeMessages(callbacks: MessageStreamCallbacks, signal: AbortSignal): void {
    const target = this.target;
    const generation = this.getConnectionGeneration();
    if (!target || generation === undefined || signal.aborted) return;
    const current = () => !signal.aborted && target === this.target && generation === this.getConnectionGeneration();
    target.subscribeMessages({ connected: () => { if (current()) callbacks.connected(); },
      message: (event) => { if (current()) callbacks.message(event); },
      interrupted: () => { if (current()) callbacks.interrupted(); } }, signal);
  }
  async requestJson(options: JsonRequest): Promise<{ generation: number; data: unknown }> {
    const target = this.target;
    const generation = this.getConnectionGeneration();
    if (!target || generation === undefined) throw new BackendRequestFailure('cancelled');
    let data: unknown;
    const contactId = /^\/api\/contacts\/([a-f0-9-]+)\/assistant-session/.exec(options.path)?.[1];
    const manual = contactId && this.manualContacts.get(contactId) === generation ? contactId : undefined;
    try { data = await target.requestJson({ ...options, manualContactId: manual }); }
    catch (error) {
      if (target !== this.target || generation !== this.getConnectionGeneration()) throw new BackendRequestFailure('cancelled');
      throw error;
    }
    if (target !== this.target || generation !== this.getConnectionGeneration()) throw new BackendRequestFailure('cancelled');
    return { generation, data };
  }
  // 只给已接纳作业保留原认证目标的停止能力，不向页面暴露跨连接业务请求。
  captureAssistantStoppingConnection(scope: { connectionGeneration: number; contactId: string; sessionId: string }):
    Pick<BackendHost, 'getConnectionGeneration' | 'requestJson'> | undefined {
    const target = this.target;
    if (!target || scope.connectionGeneration !== this.getConnectionGeneration()) return undefined;
    const path = `/api/contacts/${scope.contactId}/assistant-sessions/${scope.sessionId}`;
    const generation = scope.connectionGeneration;
    const recovered = new Map<string, { path: string; inputVersionId: string }>();
    // 接纳时固定来源；旧连接只准读取原会话与中断原作业，不能据此重新生成。
    const manualContactId = this.manualContacts.get(scope.contactId) === generation ? scope.contactId : undefined;
    return Object.freeze({ getConnectionGeneration: () => generation, requestJson: async (options: JsonRequest) => {
      const body = isRecord(options.body) ? options.body : undefined;
      const requestKey = body && isUuid(body.request_key) ? body.request_key : undefined;
      let accepted = requestKey ? recovered.get(requestKey) : undefined;
      const lookup = options.method === 'POST' && options.path === `${path}/generation-receipt`
        && requestKey !== undefined && Object.keys(body!).length === 1;
      const parts = options.path.split('/');
      if (!accepted && options.method === 'POST' && requestKey && isUuid(body?.input_version_id)
        && parts.length === 7 && parts[1] === 'api' && parts[2] === 'contacts' && parts[3] === scope.contactId
        && parts[4] === 'assistant-sessions' && isUuid(parts[5]) && parts[6] === 'interrupt' && parts[5] !== scope.sessionId) {
        if (recovered.size >= 32) throw new BackendRequestFailure('cancelled');
        // 正常分段回执也须由原认证目标证明别名；停止能力不接受调用方自行扩展会话范围。
        const proof = await target.requestJson({ method: 'POST', path: `${path}/generation-receipt`, body: { request_key: requestKey }, maxResponseBytes: 4096, manualContactId });
        const receipt = readAssistantGenerationReceipt(proof, scope.sessionId, requestKey);
        if (receipt.sessionId !== parts[5] || receipt.inputVersionId !== body!.input_version_id) throw new BackendRequestFailure('cancelled');
        accepted = { path: `/api/contacts/${scope.contactId}/assistant-sessions/${receipt.sessionId}`, inputVersionId: receipt.inputVersionId };
        recovered.set(requestKey, accepted);
      }
      const allowedRead = options.method === 'GET' && options.body === undefined
        && (options.path === '/api/runtime/status'
          || [path, ...Array.from(recovered.values(), value => value.path)].some(value => options.path === value || options.path.startsWith(`${value}?read_part=`)));
      const allowedInterrupt = options.method === 'POST' && (options.path === `${path}/interrupt`
        || accepted && options.path === `${accepted.path}/interrupt` && body?.input_version_id === accepted.inputVersionId);
      if ((!allowedRead && !allowedInterrupt && !lookup) || (lookup && recovered.size >= 32 && !recovered.has(requestKey!))) {
        throw new BackendRequestFailure('cancelled');
      }
      const data = await target.requestJson({ ...options, manualContactId });
      if (lookup) {
        const receipt = readAssistantGenerationReceipt(data, scope.sessionId, requestKey!);
        recovered.set(requestKey!, { path: `/api/contacts/${scope.contactId}/assistant-sessions/${receipt.sessionId}`, inputVersionId: receipt.inputVersionId });
      }
      return { generation, data };
    } });
  }
  // 预览只保留原认证目标的同一session状态/释放能力，连接换代后仍可确认撤下。
  captureMediaPreviewConnection(input: {sessionId: string; connectionGeneration: number}):
    MediaPreviewConnection | undefined {
    const target = this.target;
    if (!target || input.connectionGeneration !== this.getConnectionGeneration() || !isUuid(input.sessionId)) return undefined;
    return this.mediaPreviewConnection(target, input.sessionId);
  }
  private mediaPreviewConnection(target: RuntimeClient, sessionId: string): MediaPreviewConnection {
    const path = `/api/media/previews/${sessionId.toLowerCase()}`;
    return Object.freeze({
      status: async () => {
        const value = await target.requestJson({method: 'GET', path, maxResponseBytes: 4096});
        if (!isRecord(value) || (value.state !== 'active' && value.state !== 'revoking')) throw new BackendRequestFailure('response');
        return value.state;
      },
      release: async () => { await target.requestJson({method: 'DELETE', path, maxResponseBytes: 4096}); },
    });
  }
  async openMediaPreview(input: {contactId: string; messageId: string; fileId: string; connectionGeneration: number}):
    Promise<{generation: number; data: unknown; connection: MediaPreviewConnection}> {
    const target = this.target, generation = this.getConnectionGeneration();
    if (!target || generation === undefined || input.connectionGeneration !== generation
      || ![input.contactId, input.messageId, input.fileId].every(isUuid)) throw new BackendRequestFailure('cancelled');
    const path = `/api/contacts/${input.contactId}/messages/${input.messageId}/media/files/${input.fileId}/preview`;
    const data = await target.requestJson({method: 'POST', path, body: {}, maxResponseBytes: 45 * 1024 * 1024, timeoutMs: 15_000});
    if (!isRecord(data) || !isUuid(data.sessionId)) throw new BackendRequestFailure('response');
    const connection = this.mediaPreviewConnection(target, data.sessionId);
    if (target !== this.target || generation !== this.getConnectionGeneration()) {
      // 字节尚未交给页面，主进程可直接确认释放；失败保留同一目标供后续显式排空重试。
      this.unreleasedMediaPreviews.add(connection);
      await this.releaseUnhandedMediaPreviews();
      throw new BackendRequestFailure('cancelled');
    }
    return {generation, data, connection};
  }
  releaseUnhandedMediaPreviews(): Promise<void> {
    return this.mediaReleaseDrain ??= (async () => {
      for (const connection of this.unreleasedMediaPreviews) {
        await connection.release(); this.unreleasedMediaPreviews.delete(connection);
      }
    })().finally(() => { this.mediaReleaseDrain = undefined; });
  }
  onStateChanged(listener: (state: BackendState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(): Promise<void> {
    if (this.quitting || this.closing || this.state.phase === 'connected') return Promise.resolve();
    if (this.configurationSave) return this.configurationSave.catch(() => {}).then(() => this.connect());
    if (this.initialization) return this.initialization;
    const generation = ++this.generation;
    clearTimeout(this.pollTimer);
    this.target?.cancelPending();
    this.publish({ phase: 'connecting', errorCode: undefined, canRetryConnection: false });
    this.initialization = this.initialize(generation).then(() => {
      if (!this.closing) this.schedulePoll(generation);
    }).catch(async (error: unknown) => {
      const failedChild = this.ownedChild;
      if (failedChild && !this.target && await failedChild.terminate()) {
        // 已回收的失败启动不再占用下次用户明确重试；旧进程对象不参与新运行时状态。
        if (this.ownedChild === failedChild) this.ownedChild = undefined;
      }
      if (!this.closing && generation === this.generation) this.publish({ phase: 'disconnected', errorCode: error instanceof BackendFailure ? error.code : 'backend_connection_failed', canRetryConnection: true });
    }).finally(() => { this.initialization = undefined; this.publishEligibility(); });
    return this.initialization;
  }

  async stop(beforeShutdown?: () => Promise<void>): Promise<boolean> {
    this.quitting = true;
    try { await beforeShutdown?.(); }
    catch {
      this.quitPreparationFailed = true;
      this.publish({ phase: 'shutdown-failed', errorCode: 'backend_shutdown_unconfirmed',
        canRetryConnection: false, canRetryShutdown: true });
      return false;
    }
    this.quitPreparationFailed = false;
    return this.stopRuntime();
  }

  restart(): Promise<boolean> {
    if (this.quitting) return Promise.resolve(false);
    if (this.restarting) return this.restarting;
    if (this.preparing) return Promise.resolve(false);
    this.restarting = this.restartRuntime().finally(() => { this.restarting = undefined; this.publishEligibility(); });
    return this.restarting;
  }

  prepareConfiguration(): Promise<boolean> {
    if (this.quitting || this.restarting) return Promise.resolve(false);
    if (this.preparing) return this.preparing;
    this.preparing = this.prepareRuntime().finally(() => { this.preparing = undefined; this.publishEligibility(); });
    return this.preparing;
  }

  private async stopRuntime(): Promise<boolean> {
    if (this.state.phase === 'stopped') return true;
    if (this.stopping) return this.stopping;
    this.closing = true;
    ++this.generation;
    clearTimeout(this.pollTimer);
    this.target?.cancelPending();
    this.publish({ phase: 'stopping', errorCode: undefined, canRetryConnection: false, canRetryShutdown: false });
    this.stopping = this.shutdown().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private async restartRuntime(): Promise<boolean> {
    if (!await this.prepareRuntime() || this.quitting) return false;
    await this.connect();
    return this.getConnectionGeneration() !== undefined;
  }

  private async prepareRuntime(): Promise<boolean> {
    if (this.quitting) return false;
    // 仍持有原认证目标时结算接纳的作业；失败不停止或切换连接代际。
    try { await this.connectionChangePreparation?.(); } catch { return false; }
    if (!await this.stopRuntime() || this.quitting) return false;
    // 连接中停读也可能在等待后获得目标；固定 shutdown 实际确认的那个实例。
    const previous = this.target;
    if (previous) {
      const deadline = Date.now() + 5000;
      while (await previous.isListening()) {
        if (this.quitting) return false;
        if (Date.now() >= deadline) {
          this.publish({ phase: 'shutdown-failed', errorCode: 'backend_shutdown_unconfirmed', canRetryShutdown: true });
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (this.quitting) return false;
    if (this.ownedChild?.isRunning()) {
      this.publish({ phase: 'shutdown-failed', errorCode: 'backend_shutdown_unconfirmed', canRetryShutdown: true });
      return false;
    }
    this.target = undefined;
    this.ownedChild = undefined;
    this.closing = false;
    this.publish({ phase: 'disconnected', errorCode: undefined, reused: false, canRetryConnection: true, canRetryShutdown: false });
    return true;
  }

  private async initialize(generation: number): Promise<void> {
    const canStart = () => !this.closing && generation === this.generation;
    const config = await loadBackendConfiguration(this.userData, this.resourcesDirectory);
    if (!canStart()) return;
    await this.beforeConnect?.(config, canStart);
    if (!canStart()) return;
    // 仅明确重试时回收已退出的自有进程；失联本身不自动重放或替换后台。
    const previous = this.ownedChild;
    if (previous && !previous.isRunning()) {
      if (!await previous.waitForExit(8000)) throw new BackendFailure('backend_connection_failed');
      const stale = await readConnection(config.infoPath);
      if (!canStart()) return;
      if (stale && stale.pid !== previous.pid) throw new BackendFailure('backend_handshake_invalid');
      if (stale) await rm(config.infoPath, { force: true });
      this.target?.cancelPending();
      this.target = undefined;
      this.ownedChild = undefined;
    }
    const connection = await readConnection(config.infoPath);
    if (!canStart()) return;
    // 仅明确已退出的旧进程交给受控启动器；它会在互斥内再次核对并回收遗留握手。
    if (connection && !backendProcessHasExited(connection.pid)) {
      // 原自建进程仍存活时不移交另一实例；退出仍须回收本 App 已持有的运行时。
      if (this.ownedChild?.isRunning() && connection.pid !== this.ownedChild.pid) throw new BackendFailure('backend_handshake_invalid');
      const client = new RuntimeClient(connection, config.runtime, config.sqlite?.expectedOwnerId
        ? {databaseId: config.sqlite.expectedDatabaseId, ownerId: config.sqlite.expectedOwnerId} : undefined);
      try {
        if (await client.status() !== 'running') throw new BackendFailure('backend_connection_failed');
      } catch (error) {
        // 已认证的旧 DSH 仅保留停读目标，不开放业务或启动第二位写者。
        if (error instanceof RetiredBackendRuntime && (!this.target || canStart())) {
          this.target?.cancelPending(); this.target = client;
        }
        throw error;
      }
      // 正常明确重连可验证新握手；退出一旦开始，认证中的新目标也不能替换原目标。
      if (!canStart()) return;
      this.target?.cancelPending();
      this.target = client;
      this.publish({ phase: 'connected', reused: !(this.ownedChild?.isRunning() && connection.pid === this.ownedChild.pid), errorCode: undefined, canRetryConnection: false });
      return;
    }
    // 丢失握手不能成为另起读取进程的依据；保留原目标供明确退出使用。
    if (this.target) throw new BackendFailure('backend_connection_failed');
    if (!config.projectDirectory) throw new BackendFailure('backend_launch_unconfigured');
    if (this.ownedChild) throw new BackendFailure('backend_connection_failed');
    this.ownedChild = await OwnedBackendProcess.launch(config, canStart);
    // spawn 已完成的子进程仍须取得认证目标并收尾；取消检查只阻止新的 spawn。
    const deadline = Date.now() + sqliteStartupTimeoutMs;
    while (Date.now() < deadline && this.ownedChild.isRunning()) {
      const started = await readConnection(config.infoPath);
      if (started) {
        if (started.pid !== this.ownedChild.pid) throw new BackendFailure('backend_handshake_invalid');
        const client = new RuntimeClient(started, config.runtime, config.sqlite?.expectedOwnerId
          ? {databaseId: config.sqlite.expectedDatabaseId, ownerId: config.sqlite.expectedOwnerId} : undefined);
        if (await client.status() !== 'running') throw new BackendFailure('backend_connection_failed');
        this.target = client;
        if (!this.closing) this.publish({ phase: 'connected', reused: false, errorCode: undefined, canRetryConnection: false });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new BackendFailure(await startupErrorCode(config.infoPath, this.ownedChild.isRunning() ? 'timeout' : 'process_exit') ?? 'backend_connection_failed');
  }

  private async shutdown(): Promise<boolean> {
    await this.initialization;
    // 自有进程已经退出时仍等待宿主回收屏障，确认依赖进程清理后才结束。
    if (this.ownedChild && !this.ownedChild.isRunning()) {
      if (!await this.ownedChild.waitForExit(8000).catch(() => false)) {
        this.publish({ phase: 'shutdown-failed', errorCode: 'backend_shutdown_unconfirmed', canRetryShutdown: true });
        return false;
      }
      return this.finishShutdown();
    }
    if (!this.target) {
      if (!this.ownedChild) return this.finishShutdown();
      // 没有认证目标却仍持有自有子进程（启动中途失联或回收未完成）：无法请求优雅停读，
      // 只能按启动器约定 SIGTERM→SIGKILL 回收该子进程；回收确认后才算收尾，失败仍保留重试入口。
      if (!await this.ownedChild.terminate().catch(() => false)) {
        this.publish({ phase: 'shutdown-failed', errorCode: 'backend_shutdown_unconfirmed', canRetryShutdown: true });
        return false;
      }
      return this.finishShutdown();
    }
    try {
      // 客户端只有取得原实例的 stopped 确认才返回；服务可能随后退出，不再强求一次 GET。
      if (await this.target.shutdown() !== 'stopped') throw new BackendFailure('backend_shutdown_unconfirmed');
    } catch {
      try {
        if (await this.target.status() !== 'stopped') throw new BackendFailure('backend_shutdown_unconfirmed');
      } catch {
        this.publish({ phase: 'shutdown-failed', errorCode: 'backend_shutdown_unconfirmed', canRetryShutdown: true });
        return false;
      }
    }
    if (this.ownedChild && this.target.connection.pid === this.ownedChild.pid) {
      if (!await this.ownedChild.waitForExit(2500) && !await this.ownedChild.terminate()) {
        this.publish({ phase: 'shutdown-failed', errorCode: 'backend_shutdown_unconfirmed', canRetryShutdown: true });
        return false;
      }
    }
    return this.finishShutdown();
  }

  private async finishShutdown(): Promise<boolean> {
    let confirmed = true;
    try { if (this.afterShutdown) confirmed = await this.afterShutdown(); }
    catch { confirmed = false; }
    if (!confirmed) {
      this.publish({ phase: 'shutdown-failed', errorCode: 'backend_shutdown_unconfirmed', canRetryShutdown: true });
      return false;
    }
    this.publish({ phase: 'stopped', errorCode: undefined, canRetryShutdown: false });
    return true;
  }

  private publish(update: Partial<BackendState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    this.state = this.getState();
    for (const listener of this.listeners) listener(this.getState());
  }

  private configurationCanChange(): boolean {
    return this.state.phase === 'disconnected' && !this.target && !this.ownedChild && !this.initialization
      && !this.closing && !this.quitting && !this.preparing && !this.restarting && !this.stopping;
  }

  private publishEligibility(): void {
    const next = this.getState();
    if (next.canSaveStartupPaths !== this.state.canSaveStartupPaths
      || next.canPrepareConfiguration !== this.state.canPrepareConfiguration) this.publish({});
  }

  private schedulePoll(generation: number): void {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.refresh(generation), 1000);
  }

  private async refresh(generation: number): Promise<void> {
    const client = this.target;
    if (!client || this.closing || generation !== this.generation || this.state.phase !== 'connected') return;
    try {
      const state = await client.status();
      if (this.closing || generation !== this.generation || client !== this.target) return;
      if (state !== 'running') throw new BackendFailure('backend_connection_failed');
      this.schedulePoll(generation);
    } catch {
      if (this.closing || generation !== this.generation || client !== this.target) return;
      client.cancelPending();
      ++this.generation;
      this.publish({ phase: 'disconnected', errorCode: 'backend_connection_failed', canRetryConnection: true });
    }
  }
}
