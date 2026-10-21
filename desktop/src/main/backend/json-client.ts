import { request, type ClientRequest } from 'node:http';
import type { BackendConnection } from './connection';
import { isUuid } from '../uuid';
import { readAssistantContinuationClarification } from '../../shared/assistant-continuation-clarification';
import type { AssistantInputBudget } from '../../shared/assistant-input-budget';
import { readInputBudgetFailure } from '../reply/input-budget-read';
import { readAssistantNoGenerationProof, type AssistantNoGenerationProof } from '../../shared/assistant-no-generation';
import { readExplorationNoGenerationProof } from '../../shared/exploration-no-generation';

export interface JsonRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  asyncPreparation?: true;
  maxResponseBytes?: number;
  acceptAssistantContinuationClarification?: true;
  acceptAssistantNoGenerationProof?: true;
  manualContactId?: string;
}

// 只携带安全分类；业务模块自行映射已知错误，不把响应原文转给界面。
export class BackendRequestFailure extends Error {
  constructor(readonly kind: 'connection' | 'response' | 'cancelled', readonly status?: number, readonly code?: string,
    readonly reason?: 'target_message_unavailable' | 'source_unavailable' | 'source_deleted' | 'request_invalidated' | 'candidate_unavailable'
      | 'skill_policy_changed'
      | 'prepared_context_reprepare_required' | 'prepared_context_generation_running' | 'prepared_context_generation_unconfirmed',
    readonly inputBudget?: AssistantInputBudget, readonly noGeneration?: AssistantNoGenerationProof) {
    super('本机业务请求未完成');
  }
}

// 主进程共用传输。所有路径由具名业务模块构造，认证信息不进入 preload。
export class JsonClient {
  private readonly requests = new Set<ClientRequest>();
  private readonly preparations = new Set<AbortController>();
  constructor(private readonly connection: BackendConnection) {}

  cancelPending(): void {
    for (const req of this.requests) req.destroy(new BackendRequestFailure('cancelled'));
    for (const controller of this.preparations) controller.abort();
  }

  perform(options: JsonRequest): Promise<{ status: number; data: unknown }> {
    return options.asyncPreparation ? this.performPreparation(options) : this.performOne(options);
  }

  // 只改变准备的等待方式；每次查询仍有网络期限，生成仍由原业务入口显式提交。
  private async performPreparation(options: JsonRequest): Promise<{ status: number; data: unknown }> {
    if (options.method !== 'POST' || !/^\/api\/contacts\/[^/]+\/assistant-sessions\/[^/]+\/(replies|replace|retry-interrupted)\/prepare$/.test(options.path)) {
      throw new BackendRequestFailure('response');
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    this.preparations.add(controller);
    // 比服务端协作式120秒预算多留一个网络请求的收尾时间；不修改通用网络超时。
    let expired = false;
    const deadline = setTimeout(() => { expired = true; controller.abort(); }, 130_000);
    let taskId: string | undefined;
    try {
      let result = await this.performOne({ ...options, signal: controller.signal });
      while (result.status === 202) {
        const value = result.data as { preparation_id?: unknown; state?: unknown } | null;
        if (!value || typeof value !== 'object' || Object.keys(value).length !== 2
          || !isUuid(value.preparation_id) || value.state !== 'preparing'
          || taskId !== undefined && value.preparation_id !== taskId) throw new BackendRequestFailure('response');
        taskId = value.preparation_id;
        await new Promise<void>((resolve, reject) => {
          const stopped = () => { clearTimeout(timer); reject(new BackendRequestFailure('cancelled')); };
          const timer = setTimeout(() => { controller.signal.removeEventListener('abort', stopped); resolve(); }, 250);
          if (controller.signal.aborted) stopped();
          else controller.signal.addEventListener('abort', stopped, { once: true });
        });
        result = await this.performOne({ method: 'GET', path: `${options.path}/status/${taskId}`,
          signal: controller.signal, timeoutMs: options.timeoutMs, maxResponseBytes: options.maxResponseBytes,
          manualContactId: options.manualContactId }, options);
      }
      if (controller.signal.aborted) throw new BackendRequestFailure('cancelled');
      return result;
    } catch (error) {
      if (expired) throw new BackendRequestFailure('response', 504, 'assistant_preparation_timeout');
      throw error;
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', abort);
      this.preparations.delete(controller);
      if (controller.signal.aborted && taskId) {
        // DELETE只表达取消意图；业务终态仍由原任务和退出时的权威回执结算。
        void this.performOne({ method: 'DELETE', path: `${options.path}/status/${taskId}`,
          manualContactId: options.manualContactId, maxResponseBytes: 4096 }).catch(() => {});
      }
    }
  }

  private performOne(options: JsonRequest, responseFor: JsonRequest = options): Promise<{ status: number; data: unknown }> {
    const { method, path, signal } = options;
    const timeout = options.timeoutMs ?? 8000;
    const limit = options.maxResponseBytes ?? 1_048_576;
    if (!/^\/api\/[A-Za-z0-9_/?=&.%:-]+$/.test(path) || path.includes('..')
      || !Number.isFinite(timeout) || timeout < 1 || timeout > 120_000
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 8_388_608) {
      return Promise.reject(new BackendRequestFailure('response'));
    }
    let body: Buffer;
    try { body = Buffer.from(options.body === undefined ? '' : JSON.stringify(options.body)); }
    catch { return Promise.reject(new BackendRequestFailure('response')); }
    if (body.length > 1_048_576) return Promise.reject(new BackendRequestFailure('response'));
    if (signal?.aborted) return Promise.reject(new BackendRequestFailure('cancelled'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: BackendRequestFailure) => { if (!settled) { settled = true; reject(error); } };
      const req = request({
        hostname: '127.0.0.1', port: this.connection.port, method, path,
        headers: { Authorization: `Bearer ${this.connection.token}`, Accept: 'application/json',
          ...(options.manualContactId ? { 'X-NotAlone-Manual-Contact': options.manualContactId } : {}),
          ...(options.asyncPreparation ? { Prefer: 'respond-async' } : {}),
          'Content-Type': 'application/json', 'Content-Length': String(body.length) },
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            const status = response.statusCode ?? 0;
            fail(status >= 200 && status < 300
              ? new BackendRequestFailure('response', undefined, 'response_too_large')
              : new BackendRequestFailure('response', status));
            response.destroy();
          }
          else chunks.push(chunk);
        });
        response.on('error', () => fail(new BackendRequestFailure('connection')));
        response.on('aborted', () => fail(new BackendRequestFailure('connection')));
        response.on('end', () => {
          if (settled) return;
          if (!response.headers['content-type']?.startsWith('application/json')) { fail(new BackendRequestFailure('response')); return; }
          try {
            const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              const parts = responseFor.path.split('/');
              if (responseFor.acceptAssistantContinuationClarification === true && responseFor.method === 'POST' && status === 409
                && (parts.length === 7 || parts.length === 8 && parts[7] === 'prepare')
                && parts[1] === 'api' && parts[2] === 'contacts' && isUuid(parts[3])
                && parts[4] === 'assistant-sessions' && isUuid(parts[5]) && parts[6] === 'continue') {
                const clarification = readAssistantContinuationClarification(data);
                if (clarification) {
                  // 仅本次具名请求返回受限业务状态；普通Error不携带任何响应正文。
                  settled = true;
                  resolve({ status, data: { error: 'assistant_continuation_clarification_required', clarification } });
                  return;
                }
              }
              const code = (data as { error?: unknown })?.error;
              const reason = (data as { reason?: unknown })?.reason;
              const preparedPath = responseFor.acceptAssistantNoGenerationProof === true && responseFor.method === 'POST'
                && parts.length === 8 && parts[1] === 'api' && parts[2] === 'contacts' && isUuid(parts[3])
                && parts[4] === 'assistant-sessions' && isUuid(parts[5]) && parts[7] === 'prepare'
                && ['replies', 'replace', 'continue', 'retry-interrupted'].includes(parts[6]);
              const requestBody = responseFor.body as { idempotency_key?: unknown; request_key?: unknown;
                replacement?: { idempotency_key?: unknown } } | undefined;
              const proof = preparedPath ? readAssistantNoGenerationProof(data, status, {
                contactId: parts[3], sessionId: parts[5], requestKey: parts[6] === 'replace'
                  ? requestBody?.replacement?.idempotency_key : parts[6] === 'retry-interrupted'
                    ? requestBody?.request_key : requestBody?.idempotency_key,
              }) : responseFor.acceptAssistantNoGenerationProof === true && responseFor.method === 'POST'
                ? readExplorationNoGenerationProof(data, status, responseFor.path, responseFor.body) : undefined;
              fail(new BackendRequestFailure('response', status,
                typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : undefined,
                reason === 'target_message_unavailable' || reason === 'source_unavailable' || reason === 'source_deleted'
                  || reason === 'request_invalidated' || reason === 'candidate_unavailable'
                  || reason === 'skill_policy_changed'
                  || reason === 'prepared_context_reprepare_required' || reason === 'prepared_context_generation_running'
                  || reason === 'prepared_context_generation_unconfirmed' ? reason : undefined,
                readInputBudgetFailure(data, status), proof));
            } else { settled = true; resolve({ status, data }); }
          } catch { fail(new BackendRequestFailure('response')); }
        });
      });
      const abort = () => req.destroy(new BackendRequestFailure('cancelled'));
      const timer = setTimeout(() => req.destroy(new BackendRequestFailure('connection')), timeout);
      this.requests.add(req);
      signal?.addEventListener('abort', abort, { once: true });
      req.on('error', (error) => fail(error instanceof BackendRequestFailure ? error : new BackendRequestFailure('connection')));
      req.on('close', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.requests.delete(req); });
      req.end(body);
    });
  }
}
