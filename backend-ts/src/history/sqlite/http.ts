import type { IncomingMessage, ServerResponse } from 'node:http';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import { readWechatHttpBody, WechatHttpBodyError } from '../../sync/wechat-http-body.ts';
import type { HistoryCoverage, HistoryRead, StoredMessage } from './contracts.ts';

interface HistoryHttpService {
  read(contactId: string, options?: { limit?: number; before?: string }): Promise<HistoryRead>;
  coverage(contactId: string): Promise<HistoryCoverage>;
  synchronize(contactId: string, signal?: AbortSignal): Promise<HistoryCoverage>;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const placeholders: Record<StoredMessage['kind'], string | null> = {
  text: null, image: '[图片]', voice: '[语音]', video: '[视频]', file: '[文件]', sticker: '[表情]', other: '[非文字消息]',
};
function isoTime(message: StoredMessage): string | null {
  if (message.sentAt === null) return null;
  const timestamp = Number(message.sentAt);
  if (!Number.isSafeInteger(timestamp)) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}
/** 展示位置只服务稳定分页；未知顺序不得由时间或位置补造为已核验。 */
export function projectHistoryMessages(read: HistoryRead, limit: number) {
  const selected = read.messages.slice(0, limit);
  return {
    messages: selected.map(message => ({
      message_id: message.id, speaker: message.sender === 'owner' ? 'user' : 'contact',
      message_type: message.kind, text: message.kind === 'text' ? message.text : null,
      media_placeholder: placeholders[message.kind], occurred_at: isoTime(message), quoted: null,
      ordering: message.ordering, display_position: message.displayPosition, source_record_ids: message.sourceRecordIds,
    })),
    next_cursor: read.messages.length > limit ? selected.at(-1)!.id : null,
    reply_eligibility: read.replyEligibility,
  };
}
/** 公共宿主负责实际渠道可用性；本函数只投影已持久化的覆盖，不发起读取。 */
export function projectHistorySyncStatus(base: Record<string, unknown>, coverages: readonly HistoryCoverage[]) {
  const completed = coverages.filter(row => row.phase === 'complete').length;
  const incomplete = coverages.filter(row => row.phase === 'incomplete').length;
  const pending = coverages.filter(row => row.phase === 'not_started' || row.phase === 'running').length;
  const textCount = (row: HistoryCoverage) => Math.max(0, row.messageCount - row.nonTextCount);
  return { ...base,
    cli_history_authorization_state: coverages.some(row=>row.bindingId!==null)?'accepted':'unknown', cli_history_authorization_version: coverages.some(row=>row.bindingId!==null)?1:null, cli_history_authorization_current_version: 1,
    cli_history_coverages: coverages.filter(row => row.bindingId !== null).map(row => ({
      binding_id: row.bindingId, contact_id: row.contactId, phase: row.phase === 'running' ? 'syncing' : row.phase,
      failure_code: row.failureCode, message_count: textCount(row), non_text_count: row.nonTextCount, page_count: row.pageCount,
    })),
    cli_backfill_phase: pending > 0 ? 'backfilling' : incomplete > 0 ? 'incomplete' : coverages.length > 0 ? 'complete' : 'not_required',
    cli_backfill_failure_code: coverages.find(row => row.failureCode !== null)?.failureCode ?? null,
    cli_backfill_total_contacts: coverages.length, cli_backfill_completed_contacts: completed,
    cli_backfill_succeeded_contacts: completed, cli_backfill_skipped_contacts: 0, cli_backfill_failed_contacts: 0,
    cli_backfill_incomplete_contacts: incomplete, cli_backfill_pending_contacts: pending,
    cli_backfill_total_message_count: coverages.reduce((sum, row) => sum + textCount(row), 0),
    cli_backfill_total_non_text_count: coverages.reduce((sum, row) => sum + row.nonTextCount, 0),
  };
}
function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
/** 全局查询门只放行现有消息分页形状，具体值仍由本处理器验证。 */
export function historyQueryAllowed(method:string|undefined,url:URL):boolean {
 if(method!=='GET'||!/^\/api\/contacts\/[a-f0-9-]{36}\/messages$/.test(url.pathname))return false;
 return [...url.searchParams.keys()].every(key=>['limit','before'].includes(key))&&url.searchParams.getAll('limit').length<=1&&url.searchParams.getAll('before').length<=1;
}
/** 宿主先做唯一Bearer/无Origin认证；所有范围由已绑定的服务owner确定。 */
export class SqliteHistoryHttp {
  private readonly service: HistoryHttpService;
  constructor(service: HistoryHttpService) { this.service = service; }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = /^\/api\/contacts\/([a-f0-9-]{36})\/(messages|history|history\/sync)$/.exec(url.pathname);
    if (!route) return false;
    if (!uuid.test(route[1]!)) { send(res, 400, { error: 'history_request_invalid' }); return true; }
    const contactId = route[1]!.toLowerCase();
    const operation = route[2];
    if (req.method !== (operation === 'history/sync' ? 'POST' : 'GET')) {
      send(res, 405, { error: 'method_not_allowed' }); return true;
    }
    const controller = new AbortController();
    const abort = () => controller.abort(); req.once('aborted', abort);
    try {
      let value: unknown;
      if (operation === 'messages') {
        const parameters = url.searchParams;
        if ([...parameters.keys()].some(key => !['limit', 'before'].includes(key))
          || parameters.getAll('limit').length > 1 || parameters.getAll('before').length > 1) throw new StorageFailure('history_request_invalid');
        const rawLimit = parameters.get('limit') ?? '20';
        const before = parameters.get('before');
        if (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100 || before !== null && !uuid.test(before)) throw new StorageFailure('history_request_invalid');
        const limit = Number(rawLimit);
        value = projectHistoryMessages(await this.service.read(contactId, { limit: limit + 1, ...(before ? { before: before.toLowerCase() } : {}) }), limit);
      } else {
        if (url.search) throw new StorageFailure('history_request_invalid');
        if (operation === 'history') value = await this.service.coverage(contactId);
        else {
          const body = JSON.parse((await readWechatHttpBody(req, 1024, 10_000)).toString('utf8') || '{}');
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) throw new StorageFailure('history_request_invalid');
          value = await this.service.synchronize(contactId, controller.signal);
        }
      }
      send(res, 200, value);
    } catch (error) {
      const code = error instanceof StorageFailure ? error.code : error instanceof WechatHttpBodyError ? error.code : error instanceof SyntaxError ? 'history_request_invalid' : 'history_request_failed';
      const status = error instanceof WechatHttpBodyError ? error.status : code === 'history_request_invalid' ? 400 : /not_found/.test(code) ? 404 : /unavailable|unverified|not_authorized/.test(code) ? 503 : 409;
      send(res, status, { error: code });
    } finally { req.removeListener('aborted', abort); }
    return true;
  }
}
