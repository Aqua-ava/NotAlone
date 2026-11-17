import { parseIntegerJson, stringifyIntegerJson } from '../../shared/integer-json';
import { request, type ClientRequest } from 'node:http';
import {currentDiagnosticTrace,newTraceId} from '../../../../backend-ts/src/diagnostics/context';
import {checkedTraceId,requestDiagnosticModule,tracedRequest} from '../../../../backend-ts/src/diagnostics/request-trace';
import type { BackendConnection } from './connection';
import { isUuid } from '../uuid';

/** 通用运输层单次请求上限；调用方不得传入更长时限，长任务应由业务入口拆分或轮询。 */
export const requestTimeoutLimitMs = 120_000;

export interface JsonRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  manualContactId?: string;
  metadataConsent?: true;
  idempotencyKey?: string;
  traceId?: string;
}

// 只携带安全分类；业务模块自行映射已知错误，不把响应原文转给界面。
export class BackendRequestFailure extends Error {
  constructor(readonly kind: 'connection' | 'response' | 'cancelled', readonly status?: number, readonly code?: string,
    readonly reason?: 'target_message_unavailable' | 'source_unavailable' | 'source_deleted' | 'request_invalidated' | 'candidate_unavailable'
      | 'skill_policy_changed' | 'resume_required') {
    super('本机业务请求未完成');
  }
}

// 主进程共用传输。所有路径由具名业务模块构造，认证信息不进入 preload。
export class JsonClient {
  private readonly requests = new Set<ClientRequest>();
  constructor(private readonly connection: BackendConnection) {}

  cancelPending(): void {
    for (const req of this.requests) req.destroy(new BackendRequestFailure('cancelled'));
  }

  perform(options: JsonRequest): Promise<{ status: number; data: unknown }> {
    if(options.traceId!==undefined&&!checkedTraceId(options.traceId))return Promise.reject(new BackendRequestFailure('response'));
    const traced={...options,traceId:options.traceId??currentDiagnosticTrace()??newTraceId()};
    return tracedRequest(traced.traceId,requestDiagnosticModule(options.path,options.method),'request_json',()=>this.performRequest(traced));
  }

  private performRequest(options: JsonRequest): Promise<{ status: number; data: unknown }> {
    const { method, path, signal } = options;
    const timeout = options.timeoutMs ?? 8000;
    const limit = options.maxResponseBytes ?? 1_048_576;
    // 大响应仅供固定单消息预览，不扩大其他业务或任意路径的运输预算。
    const previewRoute = /^\/api\/contacts\/([a-f0-9-]+)\/messages\/([a-f0-9-]+)\/media\/files\/([a-f0-9-]+)\/preview$/i.exec(path);
    const preview = method === 'POST' && previewRoute?.slice(1).every(isUuid)
      && options.body !== null && typeof options.body === 'object' && !Array.isArray(options.body) && Object.keys(options.body).length === 0;
    if (!/^\/api\/[A-Za-z0-9_/?=&.%:-]+$/.test(path) || path.includes('..')
      || !Number.isFinite(timeout) || timeout < 1 || timeout > requestTimeoutLimitMs
      || options.idempotencyKey !== undefined && !isUuid(options.idempotencyKey)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > (preview ? 45 * 1024 * 1024 : 8_388_608)) {
      return Promise.reject(new BackendRequestFailure('response'));
    }
    let body: Buffer;
    try { body = Buffer.from(options.body === undefined ? '' : stringifyIntegerJson(options.body)); }
    catch { return Promise.reject(new BackendRequestFailure('response')); }
    if (body.length > 1_048_576) return Promise.reject(new BackendRequestFailure('response'));
    if (signal?.aborted) return Promise.reject(new BackendRequestFailure('cancelled'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: BackendRequestFailure) => { if (!settled) { settled = true; reject(error); } };
      const req = request({
        hostname: '127.0.0.1', port: this.connection.port, method, path,
        headers: { Authorization: `Bearer ${this.connection.token}`, Accept: 'application/json',
          ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
          ...(options.traceId ? { 'X-Trace-Id': options.traceId } : {}),
          ...(options.metadataConsent ? { 'X-NotAlone-Metadata-Consent': 'selected-list' } : {}),
          ...(options.manualContactId ? { 'X-NotAlone-Manual-Contact': options.manualContactId } : {}),
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
            const data: unknown = parseIntegerJson(Buffer.concat(chunks).toString('utf8'));
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              const code = (data as { error?: unknown })?.error;
              const reason = (data as { reason?: unknown })?.reason;
              fail(new BackendRequestFailure('response', status,
                typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : undefined,
                reason === 'target_message_unavailable' || reason === 'source_unavailable' || reason === 'source_deleted'
                  || reason === 'request_invalidated' || reason === 'candidate_unavailable'
                  || reason === 'skill_policy_changed' || reason === 'resume_required' ? reason : undefined));
            } else { settled = true; resolve({ status, data }); }
          } catch { fail(new BackendRequestFailure('response')); }
        });
      });
      const abort = () => req.destroy(new BackendRequestFailure('cancelled'));
      const timer = setTimeout(() => req.destroy(new BackendRequestFailure('connection', undefined, 'request_timeout')), timeout);
      this.requests.add(req);
      signal?.addEventListener('abort', abort, { once: true });
      req.on('error', (error) => fail(error instanceof BackendRequestFailure ? error : new BackendRequestFailure('connection')));
      req.on('close', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.requests.delete(req); });
      req.end(body);
    });
  }
}
