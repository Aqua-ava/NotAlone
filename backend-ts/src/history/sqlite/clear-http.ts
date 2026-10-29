import type { IncomingMessage, ServerResponse } from 'node:http';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import { readWechatHttpBody, WechatHttpBodyError } from '../../sync/wechat-http-body.ts';
import type { HistoryClearStatus } from './clear.ts';
import type { HistoryResyncStatus } from './resync.ts';

interface ClearHttpService {
  clear(contactId: string, options?: { signal?: AbortSignal }): Promise<HistoryClearStatus>;
  statusOf(contactId: string): Promise<HistoryClearStatus>;
}
interface ResyncHttpService {
  resync(contactId: string, options: { requestKey: string; signal?: AbortSignal }): Promise<HistoryResyncStatus>;
  status(contactId: string): Promise<HistoryResyncStatus>;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const requestKey = /^[A-Za-z0-9_.:@-]{1,200}$/;
/** 去掉服务端内部游标/证明原文，只给界面必要状态。 */
export function projectClearStatus(status: HistoryClearStatus) {
  return {
    contact_id: status.contactId, phase: status.phase, completed: status.completed,
    deletion_operation_id: status.operationId, deletion_state: status.operationState,
    boundary: status.boundary ? {
      state: status.boundary.state, barrier_generation: status.boundary.barrierGeneration,
      manifest_sha256: status.boundary.manifestSha256, member_count: status.boundary.memberCount,
      reason: status.boundary.reason, established_at: status.boundary.establishedAt,
    } : null,
    boundary_pending: status.phase === 'boundary_pending',
    failure_code: status.failureCode, boundary_reason: status.boundaryReason,
    stored_messages: status.storedMessages, stored_sources: status.storedSources, open_goals: status.openGoals,
  };
}
export function projectResyncStatus(status: HistoryResyncStatus) {
  return {
    contact_id: status.contactId, request_key: status.requestKey, state: status.state, completed: status.completed,
    authorization_id: status.authorizationId, cutoff_operation_id: status.cutoffOperationId,
    barrier_generation: status.barrierGeneration,
    goal: status.coverage ? {
      goal_id: status.coverage.goalId, phase: status.coverage.phase === 'running' ? 'syncing' : status.coverage.phase,
      message_count: Math.max(0, status.coverage.messageCount - status.coverage.nonTextCount),
      non_text_count: status.coverage.nonTextCount, failure_code: status.coverage.failureCode,
    } : null,
  };
}
function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
/** 宿主查询门：只放行这两条固定路径，避免任意路由穿越。 */
export function clearQueryAllowed(method: string | undefined, url: URL): boolean {
  if (!/^\/api\/contacts\/[a-f0-9-]{36}\/history\/(clear|resync)$/.test(url.pathname)) return false;
  if (method === 'GET') return !url.search;
  return method === 'POST' && !url.search;
}
/** 清空与显式重读的受控 HTTP 边界；正文、边界证明和任意 SQL 不进入请求/响应。 */
export class SqliteHistoryClearHttp {
  private readonly clear: ClearHttpService;
  private readonly resync: ResyncHttpService;
  constructor(clear: ClearHttpService, resync: ResyncHttpService) { this.clear = clear; this.resync = resync; }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = /^\/api\/contacts\/([a-f0-9-]{36})\/history\/(clear|resync)$/.exec(url.pathname);
    if (!route) return false;
    if (!uuid.test(route[1]!)) { send(res, 400, { error: 'history_request_invalid' }); return true; }
    const contactId = route[1]!.toLowerCase();
    const operation = route[2]!;
    if (!['GET', 'POST'].includes(req.method ?? '') || url.search) { send(res, 400, { error: 'history_request_invalid' }); return true; }
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    try {
      let value: unknown;
      if (req.method === 'GET') {
        value = operation === 'clear' ? projectClearStatus(await this.clear.statusOf(contactId))
          : projectResyncStatus(await this.resync.status(contactId));
      } else if (operation === 'clear') {
        // 请求体必须为空：清空范围只来自已核验联系人与当前同步选择。
        const body = JSON.parse((await readWechatHttpBody(req, 1024, 10_000)).toString('utf8') || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) throw new StorageFailure('history_request_invalid');
        value = projectClearStatus(await this.clear.clear(contactId, { signal: controller.signal }));
      } else {
        const raw = JSON.parse((await readWechatHttpBody(req, 4096, 10_000)).toString('utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'request_key'
          || typeof raw.request_key !== 'string' || !requestKey.test(raw.request_key)) throw new StorageFailure('history_request_invalid');
        value = projectResyncStatus(await this.resync.resync(contactId, { requestKey: raw.request_key, signal: controller.signal }));
      }
      send(res, 200, value);
    } catch (error) {
      const code = error instanceof StorageFailure ? error.code : error instanceof WechatHttpBodyError ? error.code
        : error instanceof SyntaxError ? 'history_request_invalid' : 'history_request_failed';
      if (code === 'history_request_invalid') send(res, 400, { error: code });
      else if (/not_found|not_authorized|unavailable|unverified/.test(code)) send(res, code.includes('not_found') ? 404 : 409, { error: code });
      else send(res, 409, { error: code });
    } finally { req.removeListener('aborted', abort); }
    return true;
  }
}
