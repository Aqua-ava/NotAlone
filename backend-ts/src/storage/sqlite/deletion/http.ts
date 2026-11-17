import type { IncomingMessage, ServerResponse } from 'node:http';
import {checkedTraceId,tracedRequest} from '../../../diagnostics/request-trace.ts';
import { sha256 } from '../../../platform/sha256.ts';
import { StorageFailure } from '../contracts.ts';
import { readHttpBody, HttpBodyError } from '../../../platform/http/body.ts';
import type { DeletionService } from './service.ts';
import type { DeletionScope, DeletionSnapshot } from './contracts.ts';

const invalid = (): never => { throw new StorageFailure('deletion_request_invalid'); };
const identifier = (value: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : invalid();
const exact = (body: Record<string, unknown>, fields: string[]) => Object.keys(body).sort().join(',') === [...fields].sort().join(',');
/** 共用宿主只放行现有只读查询形状，其他查询仍由全局边界拒绝。 */
export function deletionQueryAllowed(method: string | undefined, url: URL): boolean {
  if (method !== 'GET' || url.searchParams.size !== 2 || !/^[a-zA-Z0-9_-]{1,128}$/.test(url.searchParams.get('contact_id') ?? '')) return false;
  return url.pathname === '/api/deletions' ? url.searchParams.get('scope_kind') === 'discussion'
    : url.pathname === '/api/tasks/status' && /^[a-zA-Z0-9_-]{1,128}$/.test(url.searchParams.get('task_id') ?? '');
}
function publicOperation(op: DeletionSnapshot) {
  const status = {fenced: 'queued', cleaning: 'running', verifying: 'verifying', blocked: 'failed', completed: 'succeeded'}[op.state];
  const phase = {fenced: 'invalidate', cleaning: 'erase', verifying: 'verify', blocked: 'verify', completed: 'complete'}[op.state];
  const error = op.checks.find(c => c.result.result === 'blocked')?.result.proof ?? null;
  const scope = op.scope as DeletionScope & {contactId?: string; sourceId?: string; discussionId?: string; messageId?: string};
  return {operation_id: op.operationId, scope_kind: scope.kind, status, phase, state: op.state, error_code: error,
    ...(op.state !== 'completed' ? {contact_id: scope.contactId ?? null, target_id: scope.sourceId ?? scope.discussionId ?? scope.messageId ?? scope.contactId ?? op.ownerId} : {}),
    checks: op.checks.map(c => ({kind: c.kind, domain: c.domain, result: c.result.result, proof: c.result.proof})),
    plan_revision: op.planRevision.toString(), created_at: op.createdAt, updated_at: op.completedAt ?? op.createdAt, finished_at: op.completedAt};
}
function taskStatus(op: DeletionSnapshot) {
  const names = ['mark_deleted', 'delete_derived', 'delete_index', 'clear_cache', 'verify_not_retrievable'];
  const current = op.state === 'completed' || op.state === 'verifying' ? 4 : 1;
  return {task_id: op.operationId, task_type: 'delete', status: publicOperation(op).status, step: names[current], error_code: publicOperation(op).error_code,
    steps: names.map((name, i) => ({name, status: op.state === 'completed' || i < current ? 'succeeded' : i === current ? op.state === 'blocked' ? 'failed' : 'running' : 'pending'}))};
}
/** 装在唯一Bearer/Origin认证之后；owner固定于宿主，不接受客户端owner或内部证明。 */
export class SqliteDeletionHttp {
  private readonly ownerId: string;
  private readonly service: DeletionService;
  constructor(service: DeletionService, ownerId: string) { this.service = service; this.ownerId = ownerId; }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '', 'http://localhost'), method = req.method ?? '';
    const source = /^\/api\/contacts\/([^/]+)\/sources\/([^/]+)$/.exec(url.pathname);
    const discussion = /^\/api\/contacts\/([^/]+)\/assistant-sessions\/([^/]+)$/.exec(url.pathname);
    const contact = /^\/api\/contacts\/([^/]+)$/.exec(url.pathname);
    const state = /^\/api\/deletions\/([^/]+)$/.exec(url.pathname);
    const retry = /^\/api\/deletions\/([^/]+)\/retry$/.exec(url.pathname);
    const isTask = url.pathname === '/api/tasks/status' && url.searchParams.has('task_id');
    if (!((method === 'DELETE' && (source || discussion || contact || url.pathname === '/api/account'))
      || (method === 'GET' && (state || isTask || url.pathname === '/api/deletions')) || (method === 'POST' && retry))) return false;
    const respond = (status: number, body: unknown) => {res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(body));};
    const trace=req.headers['x-trace-id'];if(trace!==undefined&&!checkedTraceId(trace)){respond(400,{error:'deletion_request_invalid'});return true;}
    return tracedRequest(checkedTraceId(trace),'deletion',contact?'contact_deletion':url.pathname==='/api/account'?'account_deletion':'source_deletion',async()=>{
    try {
      let body: Record<string, unknown> = {};
      if (method === 'DELETE' || method === 'POST') {
        const raw = JSON.parse((await readHttpBody(req, 16384, 10_000)).toString('utf8') || '{}');
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
        body = raw;
      }
      if (isTask) {
        if (url.searchParams.size !== 2 || !url.searchParams.has('contact_id')) invalid();
        let op: DeletionSnapshot;
        try { op = await this.service.status({ownerId: this.ownerId, operationId: identifier(url.searchParams.get('task_id')!)}); }
        catch (error) { if (error instanceof StorageFailure && error.code === 'deletion_not_found') return false; throw error; }
        if (op.scope.kind !== 'source' || op.scope.contactId !== identifier(url.searchParams.get('contact_id')!)) throw new StorageFailure('deletion_not_found');
        respond(200, taskStatus(op)); return true;
      }
      if (method === 'GET' && url.pathname === '/api/deletions') {
        let contactId: string | undefined;
        if (url.search) {
          if (url.searchParams.size !== 2 || url.searchParams.get('scope_kind') !== 'discussion' || !url.searchParams.has('contact_id')) invalid();
          contactId = identifier(url.searchParams.get('contact_id')!);
        }
        respond(200, {operations: (await this.service.list({ownerId: this.ownerId, contactId})).map(publicOperation)}); return true;
      }
      if (url.search) invalid();
      if (state) { respond(200, publicOperation(await this.service.status({ownerId: this.ownerId, operationId: identifier(state[1])}))); return true; }
      if (retry) {
        if (!exact(body, ['confirmed']) || body.confirmed !== true) throw new StorageFailure('deletion_confirmation_required');
        const op = await this.run(identifier(retry[1])); respond(op.state === 'completed' ? 200 : 202, publicOperation(op)); return true;
      }
      let scope: DeletionScope;
      if (source) {if (!exact(body, [])) invalid(); scope = {kind: 'source', contactId: identifier(source[1]), sourceId: identifier(source[2])};}
      else if (discussion) {
        if (!exact(body, ['confirmed']) || body.confirmed !== true) throw new StorageFailure('deletion_confirmation_required');
        scope = {kind: 'discussion', contactId: identifier(discussion[1]), discussionId: identifier(discussion[2])};
      } else if (contact) {
        if (!exact(body, ['confirmed', 'confirm_contact_id']) || body.confirmed !== true || body.confirm_contact_id !== contact[1]) throw new StorageFailure('deletion_confirmation_required');
        scope = {kind: 'contact', contactId: identifier(contact[1])};
      } else {
        if (!exact(body, ['confirmed', 'confirm_scope']) || body.confirmed !== true || body.confirm_scope !== 'account') throw new StorageFailure('deletion_confirmation_required');
        scope = {kind: 'account'};
      }
      const requestKey = req.headers['idempotency-key'];
      if (requestKey !== undefined && typeof requestKey !== 'string') invalid();
      // 旧来源/讨论/联系人ID删除后不得复用；账户可形成新资料，必须区分新请求。
      if (scope.kind === 'account' && requestKey === undefined) throw new StorageFailure('deletion_request_key_required');
      const key = typeof requestKey === 'string' ? identifier(requestKey) : sha256(JSON.stringify(scope));
      const planned = await this.service.plan({ownerId: this.ownerId, requestKey: key, scope});
      const op = await this.run(planned.operationId);
      respond(202, source ? {task_id: op.operationId, operation_id: op.operationId, status: publicOperation(op).status} : {operation_id: op.operationId, state: op.state});
    } catch (error) {
      const code = error instanceof StorageFailure || error instanceof HttpBodyError ? error.code : error instanceof SyntaxError ? 'deletion_request_invalid' : 'deletion_unavailable';
      const status = error instanceof HttpBodyError ? error.status : /not_found$/.test(code) ? 404 : /invalid|required/.test(code) ? 400 : /unavailable|storage_|stale_lease/.test(code) ? 503 : 409;
      respond(status, {error: code});
    }
    return true;
    });
  }
  private async run(operationId: string): Promise<DeletionSnapshot> {
    let op = await this.service.advance({ownerId: this.ownerId, operationId});
    for (let i = 0; i < 3 && op.state === 'fenced'; i++) op = await this.service.advance({ownerId: this.ownerId, operationId});
    return op;
  }
}
