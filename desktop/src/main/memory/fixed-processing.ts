import type { BackendHost } from '../backend/host';
import type { PageCommands } from '../page-commands';
import { noArguments } from '../page-commands';
import { isUuid } from '../uuid';
import type { FixedProcessingCall, FixedProcessingControl, FixedProcessingEvent, FixedProcessingRun,
  FixedProcessingStart, FixedProcessingTrace, FixedProcessingTraceRequest, FixedProcessingView, FixedProcessingMode } from '../../shared/fixed-memory-processing';

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
function scope(value: Record<string, unknown>) {
  if (value.scopeKind !== 'self' && value.scopeKind !== 'contact' || value.scopeKind === 'self' && value.contactId !== null) throw invalid();
  return { scopeKind: value.scopeKind as 'self' | 'contact', contactId: value.scopeKind === 'self' ? null : id(value.contactId) };
}
const runStates = ['pending', 'running', 'paused', 'failed', 'incomplete', 'revoked'];
export function readFixedProcessingRun(raw: unknown): FixedProcessingRun | null {
  if (raw === null) return null;
  const value = row(raw);
  if (!runStates.includes(String(value.state)) || value.stage !== 'extraction_verification' || value.laterStages !== 'pending') throw invalid();
  const total = count(value.total), succeeded = count(value.succeeded), failed = count(value.failed), unknown = count(value.unknown);
  if (succeeded + failed + unknown > total) throw invalid();
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
    stage: 'extraction_verification', laterStages: 'pending', tasks, inputs, candidates };
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
    private readonly publishInvalidated: () => void) {}
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
  private async request(path: string, method: 'GET' | 'POST', body?: unknown, expectedGeneration?: number, kind: 'body' | 'mode' = 'body'): Promise<{generation: number; data: unknown}> {
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
    } catch {
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
  async read(): Promise<FixedProcessingView> { return this.view(await this.request('/api/memory-processing/runs/current', 'GET')); }
  async start(input: FixedProcessingStart): Promise<FixedProcessingView> {
    const value = this.generation(input, ['requestKey', 'connectionGeneration']), requestKey = id(value.requestKey);
    return this.view(await this.request('/api/memory-processing/runs', 'POST', { request_key: requestKey }, value.connectionGeneration as number));
  }
  async control(action: 'pause' | 'continue', input: FixedProcessingControl): Promise<FixedProcessingView> {
    const value = this.generation(input, ['runId', 'connectionGeneration']), runId = id(value.runId);
    const view = this.view(await this.request(`/api/memory-processing/runs/${runId}/${action}`, 'POST', {}, value.connectionGeneration as number));
    if (view.run?.runId !== runId) { this.synchronize(); throw invalid(); }
    return view;
  }
  async trace(input: FixedProcessingTraceRequest): Promise<FixedProcessingTrace> {
    const value = this.generation(input, ['taskId', 'connectionGeneration']), taskId = id(value.taskId);
    const response = await this.request(`/api/memory-processing/tasks/${taskId}/events`, 'GET', undefined, value.connectionGeneration as number);
    try { return readTrace(response.data); } catch { this.synchronize(); throw invalid(); }
  }
}

/** 调用方将所有来源删除、联系人取消及连接变化接到同一 synchronize。 */
export function installFixedMemoryProcessingBridge(commands: PageCommands, backend: BackendHost): FixedMemoryProcessingController {
  const controller = new FixedMemoryProcessingController(backend, () => commands.publish('memory:fixed-processing-invalidated', {}, 'manager'));
  backend.onStateChanged(() => controller.synchronize());
  commands.handle('memory:fixed-processing-mode', (...args) => { noArguments(args); return controller.mode(); }, 'manager');
  commands.handle('memory:fixed-processing-current', (...args) => { noArguments(args); return controller.read(); }, 'manager');
  commands.handle('memory:fixed-processing-start', (...args) => {
    if (args.length !== 1) throw invalid(); return controller.start(args[0] as FixedProcessingStart);
  }, 'manager');
  for (const action of ['pause', 'continue'] as const) commands.handle(`memory:fixed-processing-${action}`, (...args) => {
    if (args.length !== 1) throw invalid(); return controller.control(action, args[0] as FixedProcessingControl);
  }, 'manager');
  commands.handle('memory:fixed-processing-trace', (...args) => {
    if (args.length !== 1) throw invalid(); return controller.trace(args[0] as FixedProcessingTraceRequest);
  }, 'manager');
  commands.handle('memory:fixed-processing-release', (...args) => { noArguments(args); controller.release(); }, 'manager');
  return controller;
}
