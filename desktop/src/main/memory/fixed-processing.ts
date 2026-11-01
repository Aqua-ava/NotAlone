import type { BackendHost } from '../backend/host';
import type { PageCommands } from '../page-commands';
import { noArguments } from '../page-commands';
import { isUuid } from '../uuid';
import type { FixedProcessingCall, FixedProcessingControl, FixedProcessingEvent, FixedProcessingRun,
  FixedProcessingStart, FixedProcessingTrace, FixedProcessingTraceRequest, FixedProcessingView, FixedProcessingMode, FixedProcessingQueue, FixedProcessingRead, FixedProcessingHistoryStart, FixedProcessingHistoryResult, FixedHistoryFailureReason } from '../../shared/fixed-memory-processing';

type ContactSelection = {getState():{selectedContactId:string|null;scopeRevision:number}};
const historyFailures:Record<string,FixedHistoryFailureReason>={
  memory_extraction_no_pending_history:'no_pending_history',memory_extraction_contact_busy:'busy',
  memory_extraction_history_blocked:'blocked',memory_extraction_request_scope_mismatch:'scope_changed',
  memory_extraction_scope_stale:'source_stale',memory_extraction_request_deleted:'source_stale',memory_extraction_not_found:'source_stale',
  history_source_not_available:'source_stale',
};
class HistoryStartFailure extends Error { constructor(readonly reason:FixedHistoryFailureReason){super('历史处理暂不可启动');} }

const invalid = () => new Error('记忆处理状态不可用，请刷新后重试。');
const row = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw invalid();
}
function id(value: unknown): string { if (!isUuid(value)) throw invalid(); return value.toLowerCase(); }
function count(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(); return value as number; }
function text(value: unknown, limit = 256): string {
  if (typeof value !== 'string' || !value || value.length > limit) throw invalid(); return value;
}
function decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,24})$/.test(value)) throw invalid(); return value;
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw invalid(); return value; }
function readQueue(raw: unknown): FixedProcessingQueue {
  const queue = row(raw); exact(queue, ['pending','nextDueAt','blockedContacts',...(Object.hasOwn(queue,'later')?['later']:[])]);
  let later: FixedProcessingQueue['later'];
  if (Object.hasOwn(queue,'later')) {
    const value=row(queue.later); exact(value,['pending','nextDueAt','stage']);
    if (value.stage!==null&&!['document_scene','document_profile'].includes(String(value.stage))) throw invalid();
    later={pending:count(value.pending),nextDueAt:value.nextDueAt===null?null:count(value.nextDueAt),stage:value.stage as 'document_scene'|'document_profile'|null};
  }
  return {pending:count(queue.pending),blockedContacts:count(queue.blockedContacts),nextDueAt:queue.nextDueAt===null?null:count(queue.nextDueAt),...(later?{later}:{})};
}
function scope(value: Record<string, unknown>) {
  if (value.scopeKind !== 'self' && value.scopeKind !== 'contact' || value.scopeKind === 'self' && value.contactId !== null) throw invalid();
  return { scopeKind: value.scopeKind as 'self' | 'contact', contactId: value.scopeKind === 'self' ? null : id(value.contactId) };
}
const runStates = ['pending', 'running', 'paused', 'failed', 'incomplete', 'revoked', 'completed'];
const statuses = ['waiting', 'processing', 'paused', 'blocked', 'completed'];
const controlActions = ['pause', 'continue'];
const reasonCode = /^[a-z][a-z0-9_]{0,63}$/;
const callStates = ['prepared', 'sending', 'succeeded', 'failed', 'unknown'];
export function readFixedProcessingRun(raw: unknown): FixedProcessingRun | null {
  if (raw === null) return null;
  const value = row(raw);
  const pausedAfterCompletion = value.state === 'paused' && value.laterStages === 'completed' && value.status === 'paused';
  if (!runStates.includes(String(value.state)) || (value.state === 'completed' || pausedAfterCompletion
    ? value.stage !== 'completed' || value.laterStages !== 'completed'
    : !['extraction_verification','document_scene','document_profile'].includes(String(value.stage)) || value.laterStages !== 'pending')) throw invalid();
  const total = count(value.total), succeeded = count(value.succeeded), failed = count(value.failed), unknown = count(value.unknown);
  if (succeeded + failed + unknown > total) throw invalid();
  if (!statuses.includes(String(value.status)) || (value.statusReason !== null && (typeof value.statusReason !== 'string' || !reasonCode.test(value.statusReason)))
    || !Array.isArray(value.actions) || value.actions.some(action => !controlActions.includes(String(action))) || new Set(value.actions).size !== value.actions.length) throw invalid();
  const controlVersion = count(value.controlVersion), pending = count(value.pending), revoked = count(value.revoked);
  const nextDueAt = value.nextDueAt == null ? null : count(value.nextDueAt);
  if (value.sharedFaultCode !== undefined && value.sharedFaultCode !== null && (typeof value.sharedFaultCode !== 'string' || !reasonCode.test(value.sharedFaultCode))) throw invalid();
  const callInput = row(value.calls);
  if (Object.keys(callInput).length !== callStates.length || callStates.some(state => !Object.hasOwn(callInput, state))) throw invalid();
  const calls = Object.fromEntries(callStates.map(state => [state, count(callInput[state])])) as unknown as FixedProcessingRun['calls'];
  if (pending + revoked > total) throw invalid();
  const tasks = array(value.tasks).map(rawTask => {
    const task = row(rawTask), total = count(task.total), succeeded = count(task.succeeded);
    if (![...runStates, 'unknown', 'succeeded', 'awaiting_decision'].includes(String(task.state)) || succeeded > total) throw invalid();
    return { taskId: id(task.taskId), ...scope(task), state: task.state as FixedProcessingRun['tasks'][number]['state'], total, succeeded,
      errorCode: task.errorCode === null ? null : text(task.errorCode) };
  });
  const inputs = array(value.inputs).map(rawInput => {
    const input = row(rawInput);
    if (!['target', 'context'].includes(String(input.role)) || input.role === 'target' && input.itemId === null
      || input.role === 'context' && input.itemId !== null) throw invalid();
    return { inputNo: count(input.inputNo), role: input.role as 'target' | 'context', contactId: id(input.contactId),
      messageId: id(input.messageId), recordId: id(input.recordId), itemId: input.itemId === null ? null : id(input.itemId) };
  });
  const candidates = array(value.candidates).map(rawCandidate => {
    const candidate = row(rawCandidate);
    if (candidate.state !== 'verified_pending_decision' || candidate.origin !== 'auto') throw invalid();
    return { id: id(candidate.id), ...scope(candidate), body: text(candidate.body, 32000), state: 'verified_pending_decision' as const, origin: 'auto' as const };
  });
  if (new Set(tasks.map(task => task.taskId)).size !== tasks.length || new Set(inputs.map(input => input.inputNo)).size !== inputs.length
    || new Set(candidates.map(candidate => candidate.id)).size !== candidates.length) throw invalid();
  return { runId: id(value.runId), state: value.state as FixedProcessingRun['state'], total, succeeded, failed, unknown,
    stage: value.stage as FixedProcessingRun['stage'], laterStages: value.laterStages as FixedProcessingRun['laterStages'],
    status: value.status as FixedProcessingRun['status'],
    statusReason: value.statusReason as string | null, sharedFaultCode: (value.sharedFaultCode as string | null | undefined) ?? null, actions: value.actions as FixedProcessingRun['actions'],
    controlVersion, pending, revoked, calls, tasks, inputs, candidates, nextDueAt };
}
function readTrace(raw: unknown): FixedProcessingTrace {
  const value = row(raw);
  const events: FixedProcessingEvent[] = array(value.events).map(rawEvent => {
    const event = row(rawEvent);
    return { eventId: id(event.eventId), attemptId: id(event.attemptId), kind: text(event.kind), payload: event.payload,
      callId: event.callId === null ? null : id(event.callId), inputNos: array(event.inputNos).map(count),
      sources: array(event.sources).map(rawSource => { const source = row(rawSource); return { contactId: id(source.contactId), recordId: id(source.recordId) }; }) };
  });
  const calls: FixedProcessingCall[] = array(value.calls).map(rawCall => {
    const call = row(rawCall);
    if (!['prepared', 'sending', 'succeeded', 'failed', 'unknown'].includes(String(call.state))) throw invalid();
    return { callId: id(call.callId), operationId: id(call.operationId), purpose: text(call.purpose), state: call.state as FixedProcessingCall['state'],
      provider: text(call.provider), requestKey: text(call.requestKey), reservedBudgetUnits: decimal(call.reservedBudgetUnits),
      actualBudgetUnits: call.actualBudgetUnits === null ? null : decimal(call.actualBudgetUnits) };
  });
  return { events, calls };
}

/** 不保存过程正文；快照只返回当前请求，所有持有页面同时收到资格失效通知。 */
export class FixedMemoryProcessingController {
  private revision = 0;
  private modeRevision = 0;
  private readonly requests = new Set<AbortController>();
  private readonly modeRequests = new Set<AbortController>();
  constructor(private readonly backend: Pick<BackendHost, 'getConnectionGeneration' | 'requestJson'>,
    private readonly publishInvalidated: () => void, private readonly contacts?:ContactSelection) {}
  synchronize(): void {
    this.modeRevision++;
    for (const operation of this.modeRequests) operation.abort();
    this.modeRequests.clear(); this.invalidateBody();
  }
  private invalidateBody(): void {
    this.revision++;
    for (const operation of this.requests) operation.abort();
    this.requests.clear(); this.publishInvalidated();
  }
  // 页面撤下正文不影响替代页面正在核验的存储模式。
  release(): void { this.invalidateBody(); }
  private generation(input: unknown, fields: string[]): Record<string, unknown> {
    const value = row(input); exact(value, fields);
    if (!Number.isSafeInteger(value.connectionGeneration) || this.backend.getConnectionGeneration() !== value.connectionGeneration) throw invalid();
    return value;
  }
  private async request(path: string, method: 'GET' | 'POST', body?: unknown, expectedGeneration?: number, kind: 'body' | 'mode' | 'history' = 'body'): Promise<{generation: number; data: unknown}> {
    const currentRevision = () => kind === 'mode' ? this.modeRevision : this.revision;
    const generation = this.backend.getConnectionGeneration(), revision = currentRevision();
    if (generation === undefined || expectedGeneration !== undefined && expectedGeneration !== generation) throw invalid();
    const requests = kind === 'mode' ? this.modeRequests : this.requests;
    const operation = new AbortController(); requests.add(operation);
    try {
      const result = await this.backend.requestJson({ path, method, ...(body === undefined ? {} : { body }), signal: operation.signal,
        timeoutMs: 10000, maxResponseBytes: 8_388_608 });
      if (operation.signal.aborted || revision !== currentRevision() || result.generation !== generation || this.backend.getConnectionGeneration() !== generation) throw invalid();
      return result;
    } catch (error) {
      const failure=error as {kind?:unknown;status?:unknown;code?:unknown};
      if(kind==='history'&&!operation.signal.aborted&&revision===currentRevision()&&failure?.kind==='response'
        &&(failure.status===409||failure.status===404)&&typeof failure.code==='string'&&Object.hasOwn(historyFailures,failure.code))throw new HistoryStartFailure(historyFailures[failure.code]!);
      if (!operation.signal.aborted && revision === currentRevision()) this.synchronize();
      throw invalid();
    } finally { requests.delete(operation); }
  }
  private view(response: {generation: number; data: unknown}): FixedProcessingView {
    try { return { connectionGeneration: response.generation, run: readFixedProcessingRun(response.data) }; }
    catch { this.synchronize(); throw invalid(); }
  }
  async mode(): Promise<FixedProcessingMode> {
    const response = await this.request('/api/runtime/status', 'GET', undefined, undefined, 'mode');
    try {
      const value = row(response.data);
      if (value.state !== 'running' || value.runtime !== 'dsh' || value.hostRuntime !== 'typescript'
        || value.storage !== undefined && value.storage !== 'sqlite') throw invalid();
      return { connectionGeneration: response.generation, mode: value.storage === 'sqlite' ? 'sqlite' : 'legacy' };
    } catch { this.synchronize(); throw invalid(); }
  }
  async read(input?: FixedProcessingRead): Promise<FixedProcessingView> {
    if (input !== undefined) {
      const requested = row(input); exact(requested, ['contactId']); const contactId = id(requested.contactId);
      const response = await this.request(`/api/memory-processing/contacts/${contactId}/current`, 'GET');
      return this.contactView(response,contactId);
    }
    const [current, scheduled] = await Promise.all([
      this.request('/api/memory-processing/runs/current', 'GET'), this.request('/api/memory-processing/schedule', 'GET'),
    ]);
    try {
      if (current.generation !== scheduled.generation) throw invalid();
      return {connectionGeneration:current.generation,run:readFixedProcessingRun(current.data),queue:readQueue(scheduled.data)};
    } catch { this.synchronize(); throw invalid(); }
  }
  private contactView(response:{generation:number;data:unknown},contactId:string):FixedProcessingView {
    try {
      const value=row(response.data);exact(value,['contactId','run','queue']);if(value.contactId!==contactId)throw invalid();
      const run=readFixedProcessingRun(value.run);
      if(run&&(run.tasks.some(task=>task.scopeKind!=='contact'||task.contactId!==contactId)
        ||run.inputs.some(item=>item.contactId!==contactId)||run.candidates.some(item=>item.scopeKind!=='contact'||item.contactId!==contactId)))throw invalid();
      return {connectionGeneration:response.generation,contactId,run,queue:readQueue(value.queue)};
    }catch{this.synchronize();throw invalid();}
  }
  async startHistory(input:FixedProcessingHistoryStart):Promise<FixedProcessingHistoryResult> {
    const value=this.generation(input,['contactId','scopeRevision','requestKey','connectionGeneration']),contactId=id(value.contactId),requestKey=id(value.requestKey);
    const scopeRevision=count(value.scopeRevision),selected=this.contacts?.getState();
    if(!selected||selected.selectedContactId!==contactId||selected.scopeRevision!==scopeRevision)throw invalid();
    try{
      const response=await this.request(`/api/memory-processing/contacts/${contactId}/history`,'POST',{request_key:requestKey},value.connectionGeneration as number,'history');
      const current=this.contacts!.getState();if(current.selectedContactId!==contactId||current.scopeRevision!==scopeRevision)throw invalid();
      const view=this.contactView(response,contactId);if(!view.run)throw invalid();
      return {status:'started',view};
    }catch(error){if(error instanceof HistoryStartFailure)return {status:'unavailable',reason:error.reason};throw error;}
  }
  async start(input: FixedProcessingStart): Promise<FixedProcessingView> {
    const value = this.generation(input, ['requestKey', 'connectionGeneration']), requestKey = id(value.requestKey);
    return this.view(await this.request('/api/memory-processing/runs', 'POST', { request_key: requestKey }, value.connectionGeneration as number));
  }
  async control(action: 'pause' | 'continue', input: FixedProcessingControl): Promise<FixedProcessingView> {
    const value = this.generation(input, ['runId', 'controlVersion', 'operationId', 'connectionGeneration']), runId = id(value.runId);
    const actionVersion = count(value.controlVersion);
    const view = this.view(await this.request(`/api/memory-processing/runs/${runId}/${action}`, 'POST',
      { action_version: actionVersion, operation_id: id(value.operationId) }, value.connectionGeneration as number));
    if (view.run?.runId !== runId || view.run.controlVersion < actionVersion) { this.synchronize(); throw invalid(); }
    return view;
  }
  async trace(input: FixedProcessingTraceRequest): Promise<FixedProcessingTrace> {
    const value = this.generation(input, ['taskId', 'connectionGeneration']), taskId = id(value.taskId);
    const response = await this.request(`/api/memory-processing/tasks/${taskId}/events`, 'GET', undefined, value.connectionGeneration as number);
    try { return readTrace(response.data); } catch { this.synchronize(); throw invalid(); }
  }
}

/** 调用方将所有来源删除、联系人取消及连接变化接到同一 synchronize。 */
export function installFixedMemoryProcessingBridge(commands: PageCommands, backend: BackendHost, contacts:ContactSelection): FixedMemoryProcessingController {
  const controller = new FixedMemoryProcessingController(backend, () => commands.publish('memory:fixed-processing-invalidated', {}, 'manager'),contacts);
  backend.onStateChanged(() => controller.synchronize());
  commands.handle('memory:fixed-processing-mode', (...args) => { noArguments(args); return controller.mode(); }, 'manager');
  commands.handle('memory:fixed-processing-current', (...args) => {
    if (args.length > 1) throw invalid(); return controller.read(args[0] as FixedProcessingRead | undefined);
  }, 'manager');
  commands.handle('memory:fixed-processing-start', (...args) => {
    if (args.length !== 1) throw invalid(); return controller.start(args[0] as FixedProcessingStart);
  }, 'manager');
  commands.handle('memory:fixed-processing-history-start',(...args)=>{
    if(args.length!==1)throw invalid();return controller.startHistory(args[0] as FixedProcessingHistoryStart);
  },'manager');
  for (const action of ['pause', 'continue'] as const) commands.handle(`memory:fixed-processing-${action}`, (...args) => {
    if (args.length !== 1) throw invalid(); return controller.control(action, args[0] as FixedProcessingControl);
  }, 'manager');
  commands.handle('memory:fixed-processing-trace', (...args) => {
    if (args.length !== 1) throw invalid(); return controller.trace(args[0] as FixedProcessingTraceRequest);
  }, 'manager');
  commands.handle('memory:fixed-processing-release', (...args) => { noArguments(args); controller.release(); }, 'manager');
  return controller;
}
