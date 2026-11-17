import type { IncomingMessage, ServerResponse } from 'node:http';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import { readHttpBody, HttpBodyError } from '../../platform/http/body.ts';
import { INCREMENTAL_IDENTITY_LIMIT } from '../limits.ts';
import type { HistoryCoverage, HistoryImageMedia, HistoryQuoteErrorCode, HistoryRead, StoredMessage } from './contracts.ts';
import type { FirstHistoryCoordinatorState } from './coordinator.ts';
import type { IncrementalHistoryCoordinatorState } from './incremental-coordinator.ts';
import { displayMessageType, messagePlaceholder } from './message-types.ts';

interface HistoryHttpService {
  readChat(contactId: string, options?: { limit?: number; before?: string }): Promise<HistoryRead>;
  imageMedia(contactId: string, messageIds: readonly string[]): Promise<ReadonlyMap<string, HistoryImageMedia>>;
  coverage(contactId: string): Promise<HistoryCoverage>;
  synchronize(contactId: string, signal?: AbortSignal): Promise<HistoryCoverage>;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const quoteErrorPlaceholders:Record<HistoryQuoteErrorCode,string>={
  history_quote_unavailable:'[引用回复：引用内容暂不可用]',
  history_quote_metadata_invalid:'[引用回复：引用信息无效]',
  history_quote_too_large:'[引用回复：引用内容过长]',
  history_quote_state_unverified:'[引用回复：消息状态尚未核验]',
  history_quote_association_unverified:'[引用回复：引用对象尚未核验]',
  history_quote_read_failed:'[引用回复：引用内容读取失败]',
};
function isoTime(message: StoredMessage): string | null {
  if (message.sentAt === null) return null;
  const timestamp = Number(message.sentAt);
  if (!Number.isSafeInteger(timestamp)) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}
/** 展示位置只服务稳定分页；未知顺序不得由时间或位置补造为已核验。 */
export function projectHistoryMessages(read: HistoryRead, limit: number, imageMedia?: ReadonlyMap<string, HistoryImageMedia>) {
  const selected = read.messages.slice(0, limit);
  return {
    messages: selected.map(message => {
      const type=displayMessageType(message),quote=message.quote;
      const image = imageMedia && message.kind === 'image' ? imageMedia.get(message.id) ?? {state:'pending' as const,fileId:null,mimeType:null} : null;
      const safeImage = image?.state==='available' && uuid.test(image.fileId??'') && image.mimeType && /^image\/[a-z0-9.+-]{1,64}$/.test(image.mimeType)
        ? image : image ? {...image,fileId:null,mimeType:null} : null;
      const quoted=type==='quote'&&quote?{
        text:quote?.referencedText||'引用内容暂不可用',target_message_id:quote?.targetMessageId??null,
        sender:quote?.referencedSender??null,sender_role:quote?.referencedSenderRole??'unknown',
        message_type:quote?.referencedType??null,state:quote?.state??'unavailable',
      }:null;
      return {
        message_id: message.id, speaker: message.sender === 'owner' ? 'user' : 'contact',
        message_type: type, text: quote?.replyText??(message.kind === 'text' ? message.text : null),
        media_placeholder: type==='quote'&&message.quoteErrorCode?quoteErrorPlaceholders[message.quoteErrorCode]:messagePlaceholder(type),
        occurred_at: isoTime(message), quoted,
        ordering: message.ordering, display_position: message.displayPosition, source_record_ids: message.sourceRecordIds,
        ...(safeImage ? {image_media:{state:safeImage.state,file_id:safeImage.fileId,mime_type:safeImage.mimeType,
          ...('errorCode' in safeImage&&safeImage.errorCode?{error_code:safeImage.errorCode}:{})}} : {}),
      };
    }),
    next_cursor: read.messages.length > limit ? selected.at(-1)!.id : null,
  };
}
/** 公共宿主负责实际渠道可用性；本函数只投影已持久化的覆盖，不发起读取。 */
export function projectHistorySyncStatus(base: Record<string, unknown>, persistedCoverages: readonly HistoryCoverage[], runtime?:FirstHistoryCoordinatorState, incremental?:IncrementalHistoryCoordinatorState, bodyCapabilityVerified = false) {
  const blocked=new Set<string>();
  const globalFailure=runtime?.phase==='blocked'&&(runtime.contacts.length===0
    ||runtime.lastError==='history_first_directory_failed'||runtime.lastError==='history_first_stop_failed')?runtime.lastError:null;
  const coverages=persistedCoverages.map(row=>{
    const current=runtime?.contacts.find(contact=>contact.contactId===row.contactId);
    const failure=globalFailure??(current&&(current.phase==='blocked'||current.phase==='incomplete')?current.lastError:null);
    if(row.phase==='complete'||!failure)return row;
    blocked.add(row.contactId);return {...row,failureCode:failure};
  });
  const completed = coverages.filter(row => row.phase === 'complete').length;
  const incomplete = coverages.filter(row => row.phase === 'incomplete'||blocked.has(row.contactId)).length;
  const pending = coverages.filter(row => (row.phase === 'not_started' || row.phase === 'running')&&!blocked.has(row.contactId)).length;
  const textCount = (row: HistoryCoverage) => Math.max(0, row.messageCount - row.nonTextCount);
  const incrementalRuntime = (contactId: string) => incremental?.contacts.find(contact => contact.contactId === contactId);
  const incrementalFailure = (row:HistoryCoverage) => {
    const live=incrementalRuntime(row.contactId);
    if(row.incremental?.emptyTargetAwaitingMessages===true&&(!live||!['blocked','degraded'].includes(live.phase)
      ||live.phase==='blocked'&&live.lastError==='history_incremental_unavailable'))return null;
    return live?.lastError??row.incremental?.failureCode??null;
  };
  // 运行中/降级只影响展示；持久检查点仍是是否允许继续读取的事实。
  const incrementalPhase = (row: HistoryCoverage) => {
    const live = incrementalRuntime(row.contactId);
    if (live) {
      if(live.phase==='blocked'&&live.lastError==='history_incremental_unavailable'&&row.incremental?.emptyTargetAwaitingMessages===true)return 'not_started';
      if (live.phase === 'blocked') return 'blocked';
      if (live.phase === 'degraded') return 'incomplete';
      if (live.phase === 'queued' || live.phase === 'running') return 'syncing';
      if (live.phase === 'stopped') return 'stopped';
      if (live.phase === 'waiting_new_messages') return 'not_started';
    }
    if(row.incremental?.emptyTargetAwaitingMessages===true)return 'not_started';
    return row.incremental?.phase ?? 'not_started';
  };
  const rows = coverages.filter(row => row.bindingId !== null);
  const incrementalPhases = rows.map(incrementalPhase);
  const incrementalFailureCode = rows.map(incrementalFailure).find(code => code !== null) ?? null;
  const incrementalOverallPhase = incrementalPhases.includes('blocked') ? 'incomplete'
    : incrementalPhases.includes('syncing') ? 'active'
      : incrementalPhases.length > 0 && incrementalPhases.every(phase => phase === 'unavailable') ? 'unavailable'
        : incrementalPhases.includes('incomplete') || incrementalPhases.includes('invalidated') ? 'incomplete' : 'idle';
  const specificFailure = coverages.find(row => row.failureCode !== null)?.failureCode ?? incrementalFailureCode;
  const enabled = base.sync_enabled === true;
  const boundCount = typeof base.cli_bound_count === 'number' ? base.cli_bound_count : rows.length;
  const hasEmptyWaiter=rows.some(row=>row.incremental?.emptyTargetAwaitingMessages===true);
  const emptyWaitDoesNotExplainFailure=hasEmptyWaiter&&specificFailure===null&&incomplete===0&&enabled&&boundCount>0;
  const backgroundPhase = bodyCapabilityVerified
    ? !enabled ? 'disabled' : boundCount === 0 ? 'waiting_bindings' : specificFailure || incomplete > 0 || incrementalOverallPhase === 'incomplete' ? 'degraded' : 'active'
    : emptyWaitDoesNotExplainFailure&&base.cli_failure_code==='wechat_body_unavailable'?'active':base.cli_sync_phase;
  const bodyUnavailableOnly=base.cli_failure_code==='wechat_body_unavailable';
  const backgroundFailure = specificFailure
    ?? (bodyUnavailableOnly&&(bodyCapabilityVerified||emptyWaitDoesNotExplainFailure)?null:base.cli_failure_code??null);
  return { ...base,
    cli_history_authorization_state: coverages.some(row=>row.bindingId!==null)?'accepted':'unknown', cli_history_authorization_version: coverages.some(row=>row.bindingId!==null)?1:null, cli_history_authorization_current_version: 1,
    cli_history_coverages: coverages.filter(row => row.bindingId !== null).map(row => ({
      binding_id: row.bindingId, contact_id: row.contactId, phase: row.phase === 'running' ? 'syncing' : row.phase,
      failure_code: row.failureCode, saved_history_complete: row.savedHistoryComplete === true, message_count: textCount(row), non_text_count: row.nonTextCount, metadata_only_count: row.metadataOnlyCount ?? 0, page_count: row.pageCount,
      ...(row.nonTextTypes === undefined ? {} : { non_text_types: row.nonTextTypes.map(item => ({ message_type: item.messageType, label: item.label, count: item.count })) }),
      incremental_phase: incrementalPhase(row), incremental_failure_code: incrementalFailure(row),
      ...(enabled&&row.incremental?.emptyTargetAwaitingMessages===true&&incrementalFailure(row)===null?{incremental_waiting_for_messages:true}:{}),
      incremental_last_accepted_at: row.incremental?.lastAcceptedAt ?? null, incremental_pages: row.incremental?.pagesAccepted ?? 0,
    })),
    cli_backfill_phase: pending > 0 ? 'backfilling' : incomplete > 0 ? 'incomplete' : coverages.length > 0 ? 'complete' : 'not_required',
    cli_backfill_failure_code: coverages.find(row => row.failureCode !== null)?.failureCode ?? null,
    cli_backfill_total_contacts: coverages.length, cli_backfill_completed_contacts: completed,
    cli_backfill_succeeded_contacts: completed, cli_backfill_skipped_contacts: 0, cli_backfill_failed_contacts: 0,
    cli_backfill_incomplete_contacts: incomplete, cli_backfill_pending_contacts: pending,
    cli_incremental_phase: incrementalOverallPhase, cli_incremental_failure_code: incrementalFailureCode,
    cli_incremental_identity_limit: INCREMENTAL_IDENTITY_LIMIT,
    // 即时能力必须由宿主传入当前资格范围的受信任支持核验结果；覆盖数量、进度和缓存错误均不能推导正文能力。
    body_available: bodyCapabilityVerified === true,
    cli_sync_phase: backgroundPhase,
    // 具体会话错误优先；仅在新能力证据已经通过时清除旧通用占位错误。
    cli_failure_code: backgroundFailure,
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
 if(method!=='GET'||!/^\/api\/contacts\/[a-f0-9-]{36}\/history-messages$/.test(url.pathname))return false;
 return [...url.searchParams.keys()].every(key=>['limit','before'].includes(key))&&url.searchParams.getAll('limit').length<=1&&url.searchParams.getAll('before').length<=1;
}
/** 宿主先做唯一Bearer/无Origin认证；所有范围由已绑定的服务owner确定。 */
export class SqliteHistoryHttp {
  private readonly service: HistoryHttpService;
  readonly #imagesViewed?: (contactId: string, messageIds: readonly string[]) => void;
  constructor(service: HistoryHttpService, imagesViewed?: (contactId: string, messageIds: readonly string[]) => void) { this.service = service; this.#imagesViewed = imagesViewed; }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = /^\/api\/contacts\/([a-f0-9-]{36})\/(history-messages|history|history\/sync)$/.exec(url.pathname);
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
      if (operation === 'history-messages') {
        const parameters = url.searchParams;
        if ([...parameters.keys()].some(key => !['limit', 'before'].includes(key))
          || parameters.getAll('limit').length > 1 || parameters.getAll('before').length > 1) throw new StorageFailure('history_request_invalid');
        const rawLimit = parameters.get('limit') ?? '20';
        const before = parameters.get('before');
        if (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100 || before !== null && !uuid.test(before)) throw new StorageFailure('history_request_invalid');
        const limit = Number(rawLimit);
        const options = { limit: limit + 1, ...(before ? { before: before.toLowerCase() } : {}) };
        const read = await this.service.readChat(contactId, options);
        const imageIds = read.messages.slice(0,limit).filter(message=>message.kind==='image').map(message=>message.id);
        const imageMedia = imageIds.length ? await this.service.imageMedia(contactId,imageIds) : new Map();
        // 用户打开聊天看到尚未保存的图片：交给图片同步各再试一次；失败不影响聊天读取。
        const unsaved = imageIds.filter(id => !['available', 'cleared'].includes(imageMedia.get(id)?.state ?? ''));
        if (unsaved.length) { try { this.#imagesViewed?.(contactId, unsaved); } catch { /* 不影响聊天读取 */ } }
        value = projectHistoryMessages(read, limit, imageMedia);
      } else {
        if (url.search) throw new StorageFailure('history_request_invalid');
        if (operation === 'history') value = await this.service.coverage(contactId);
        else {
          const body = JSON.parse((await readHttpBody(req, 1024, 10_000)).toString('utf8') || '{}');
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) throw new StorageFailure('history_request_invalid');
          value = await this.service.synchronize(contactId, controller.signal);
        }
      }
      send(res, 200, value);
    } catch (error) {
      const code = error instanceof StorageFailure ? error.code : error instanceof HttpBodyError ? error.code : error instanceof SyntaxError ? 'history_request_invalid' : 'history_request_failed';
      const status = error instanceof HttpBodyError ? error.status : code === 'history_request_invalid' ? 400 : /not_found/.test(code) ? 404 : /unavailable|unverified|not_authorized/.test(code) ? 503 : 409;
      send(res, status, { error: code });
    } finally { req.removeListener('aborted', abort); }
    return true;
  }
}
