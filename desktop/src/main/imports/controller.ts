import path from 'node:path';
import type { ImportIdentity, ImportPreviewSummary, ImportState, ImportSubmission, ImportTarget } from '../../shared/import-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import type { ContactSession } from '../contacts/session';
import { importReceipt, importSources, importTask } from './progress';

const staleMessage = '本次文件或联系人已变化，请重新预览并确认。';
const fileChangedMessage = '文件内容已变化，请重新预览并确认。';
const rejectedMessage = '预览已拒绝。请提供有效的单联系人 JSONL 文件；混合联系人、群聊、损坏或身份不明确的资料不能导入。';
const identityMessage = '本人或联系人渠道身份不一致，预览已拒绝。请检查文件或重新选择联系人。';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export type ImportFileSelector = () => Promise<{ canceled: boolean; filePaths: string[] }>;

export interface ConfirmedImportSelection {
  generation: number;
  body: { path: string; expected_content_sha256: string } & ({ contact_id: string } | { new_contact_name: string });
}

function identity(value: unknown): ImportIdentity {
  if (!record(value) || typeof value.external_id !== 'string' || !value.external_id.trim()
    || typeof value.observed_name !== 'string' || !value.observed_name.trim()) throw new Error(rejectedMessage);
  return { externalId: value.external_id, observedName: value.observed_name };
}

function previewSummary(value: unknown, targetName: string): { summary: ImportPreviewSummary; digest: string } {
  if (!record(value) || value.valid !== true || typeof value.file_name !== 'string' || !value.file_name
    || typeof value.content_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.content_sha256)
    || typeof value.record_count !== 'number' || !Number.isSafeInteger(value.record_count) || value.record_count < 1
    || !record(value.kind_counts)) throw new Error(rejectedMessage);
  const kinds: Record<string, number> = {};
  for (const [kind, count] of Object.entries(value.kind_counts)) {
    if (!/^[a-z_]{1,40}$/.test(kind) || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) throw new Error(rejectedMessage);
    kinds[kind] = count;
  }
  if (Object.values(kinds).reduce((sum, count) => sum + count, 0) !== value.record_count) throw new Error(rejectedMessage);
  return { digest: value.content_sha256, summary: {
    fileName: value.file_name, recordCount: value.record_count, kindCounts: kinds,
    ownerIdentity: identity(value.owner_channel_identity), contactIdentity: identity(value.contact_channel_identity), targetName,
  } };
}

export class ImportController {
  private state: ImportState = { revision: 0, selectionRevision: 0, phase: 'unavailable', fileName: null, target: null, preview: null, error: null,
    submission: null, syncReloadPhase: 'idle' };
  private selectedPath: string | null = null;
  private previewDigest: string | null = null;
  private generation: number | undefined;
  private contactScope = -1;
  private operation = 0;
  private taskRequest = 0;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly pending = new Set<AbortController>();
  private reloading = false;
  private readonly listeners = new Set<(state: ImportState) => void>();

  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession) {
    backend.onStateChanged(() => this.refreshScope());
    contacts.onStateChanged(() => this.refreshScope());
    this.refreshScope();
  }

  getState(): ImportState {
    return { ...this.state, target: this.state.target ? { ...this.state.target } : null,
      preview: this.state.preview ? { ...this.state.preview, kindCounts: { ...this.state.preview.kindCounts },
        ownerIdentity: { ...this.state.preview.ownerIdentity }, contactIdentity: { ...this.state.preview.contactIdentity } } : null,
      submission: this.state.submission ? { ...this.state.submission,
        receipt: this.state.submission.receipt ? { ...this.state.submission.receipt } : null,
        task: this.state.submission.task ? { ...this.state.submission.task, steps: this.state.submission.task.steps.map((step) => ({ ...step })) } : null,
        sources: this.state.submission.sources?.map((source) => ({ ...source })) ?? null } : null };
  }

  onStateChanged(listener: (state: ImportState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async chooseFile(selectFile: ImportFileSelector): Promise<void> {
    this.assertAvailable();
    if (this.state.phase === 'choosing') return;
    this.invalidate({ phase: 'choosing', fileName: null });
    this.selectedPath = null;
    const request = this.operation;
    try {
      const result = await selectFile();
      if (request !== this.operation) return;
      if (result.canceled) { this.publish({ phase: 'idle' }); return; }
      if (result.filePaths.length !== 1 || !path.isAbsolute(result.filePaths[0])) throw new Error();
      this.selectedPath = result.filePaths[0];
      this.publish({ phase: 'idle', fileName: path.basename(this.selectedPath) });
    } catch {
      if (request === this.operation) this.publish({ phase: 'error', error: '历史文件暂时无法选择，请重试。' });
    }
  }

  setTarget(target: ImportTarget): void {
    this.assertAvailable();
    if (this.state.phase === 'choosing') throw new Error(staleMessage);
    if (target.kind === 'existing' && !this.contacts.getState().contacts.some((entry) => entry.contactId === target.contactId)) throw new Error(staleMessage);
    this.invalidate({ target: { ...target }, phase: 'idle' });
  }

  async preview(selectionRevision: number): Promise<void> {
    this.assertSelection(selectionRevision);
    this.invalidate({ phase: 'previewing' });
    const request = this.operation;
    try {
      const result = await this.readPreview();
      if (request !== this.operation) return;
      this.previewDigest = result.digest;
      this.publish({ phase: 'previewed', preview: result.summary });
    } catch (error) {
      if (request === this.operation) this.rejectPreview(error);
    }
  }

  async confirmPreview(selectionRevision: number): Promise<void> {
    this.assertSelection(selectionRevision);
    if (this.state.phase !== 'previewed' || !this.previewDigest) throw new Error(staleMessage);
    const digest = this.previewDigest;
    const request = ++this.operation;
    this.publish({ phase: 'confirming', error: null });
    try {
      const result = await this.readPreview();
      if (request !== this.operation) return;
      if (result.digest !== digest) { this.invalidate({ phase: 'error', error: fileChangedMessage }); return; }
      this.publish({ phase: 'confirmed' });
    } catch (error) {
      if (request === this.operation) this.rejectPreview(error);
    }
  }

  // 用户取消会撤销本次预览；下一次正式提交必须重新核对。
  cancelConfirmation(selectionRevision: number): void {
    this.assertSelection(selectionRevision);
    this.invalidate({ phase: 'idle' });
  }

  // 任务 08 从主进程取用即清除确认；后端仍对同次已读内容校验摘要。
  takeConfirmedSelection(selectionRevision: number): ConfirmedImportSelection {
    this.assertSelection(selectionRevision);
    if (this.state.phase !== 'confirmed' || !this.previewDigest || this.generation === undefined) throw new Error(staleMessage);
    const target = this.state.target!;
    const selection: ConfirmedImportSelection = { generation: this.generation, body: {
      path: this.selectedPath!, expected_content_sha256: this.previewDigest,
      ...(target.kind === 'existing' ? { contact_id: target.contactId } : { new_contact_name: target.displayName.trim() }),
    } };
    this.invalidate({ phase: 'idle' });
    return selection;
  }

  async submit(selectionRevision: number): Promise<void> {
    const summary = this.state.preview;
    const selection = this.takeConfirmedSelection(selectionRevision);
    const request = this.operation;
    const generation = selection.generation;
    // 不缓存正文或请求 body：确认已消耗，失败、取消或换范围均须重新预览。
    if (!summary || generation !== this.backend.getConnectionGeneration()) throw new Error(staleMessage);
    this.publish({ phase: 'submitting', submission: { fileName: summary.fileName, targetName: summary.targetName,
      receipt: null, task: null, taskBusy: null, taskError: null, sources: null, sourcesError: false, syncReloadNeeded: false } });
    const abort = this.beginRequest();
    try {
      const response = await this.backend.requestJson({ method: 'POST', path: '/api/imports/commit',
        body: selection.body, timeoutMs: 60_000, signal: abort.signal });
      if (!this.current(request, generation) || response.generation !== generation) return;
      const receipt = importReceipt(response.data);
      if ('contact_id' in selection.body && receipt.contactId !== selection.body.contact_id) throw new Error();
      if (receipt.importedCount + receipt.skippedDuplicates !== summary.recordCount) throw new Error();
      this.publish({ phase: 'submitted' });
      this.publishSubmission({ receipt });
      await this.contacts.refreshContacts();
      if (!this.current(request, generation)) return;
      await this.loadTask(request, generation);
      if (!this.current(request, generation)) return;
      await this.readSourcesAndSync(request, generation);
    } catch (error) {
      if (!this.current(request, generation)) return;
      // HTTP 丢响应时写入可能已完成，不凭本地失败宣称回滚，也不自动重复提交。
      const changed = error instanceof BackendRequestFailure && error.code === 'import_file_changed';
      const rejected = error instanceof BackendRequestFailure && error.code === 'import_commit_failed';
      this.publish({ phase: 'error', error: changed ? fileChangedMessage : rejected
        ? '导入被拒绝，未通过文件或归属校验。请重新预览并确认。'
        : '本次保存结果尚未确认。请重新预览并确认同一份文件和原联系人；原新建名称未变且归属仍有效时，后端会复用已保存的联系人与任务。归属变化时须明确选择既有联系人。' });
      await this.contacts.refreshContacts();
    } finally { this.pending.delete(abort); }
  }

  async refreshTask(selectionRevision: number): Promise<void> {
    this.assertSubmission(selectionRevision);
    if (this.state.submission!.taskBusy) return;
    const request = this.operation;
    const generation = this.generation!;
    await this.loadTask(request, generation);
    if (this.current(request, generation)) await this.readSourcesAndSync(request, generation);
  }

  async retryTask(selectionRevision: number): Promise<void> {
    this.assertSubmission(selectionRevision);
    if (this.state.submission!.task?.status !== 'failed' || this.state.submission!.taskBusy) throw new Error(staleMessage);
    await this.executeTask(true);
  }

  async runTask(selectionRevision: number): Promise<void> {
    this.assertSubmission(selectionRevision);
    if (this.state.submission!.task?.status !== 'queued' || this.state.submission!.taskBusy) throw new Error(staleMessage);
    await this.executeTask(false);
  }

  // 首份渠道身份导入不会热装配 SyncHost；仅用户明确选择后沿既有认证停读入口重启。
  async reloadSyncHost(selectionRevision: number): Promise<void> {
    if (this.reloading) return;
    if (this.state.syncReloadPhase !== 'failed') {
      this.assertSubmission(selectionRevision);
      if (!this.state.submission!.syncReloadNeeded) throw new Error(staleMessage);
    } else if (selectionRevision !== this.state.selectionRevision) throw new Error(staleMessage);
    this.reloading = true;
    this.invalidate({ phase: 'unavailable', fileName: null, target: null, syncReloadPhase: 'restarting' });
    this.selectedPath = null;
    let restarted: { request: number; generation: number } | undefined;
    try {
      if (!await this.backend.restart()) { this.publish({ syncReloadPhase: 'failed' }); return; }
      const generation = this.backend.getConnectionGeneration();
      if (generation === undefined) { this.publish({ syncReloadPhase: 'failed' }); return; }
      restarted = { request: this.operation, generation };
      const status = await this.backend.requestJson({ method: 'GET', path: '/api/sync/status', maxResponseBytes: 16_384 });
      if (!this.current(restarted.request, generation) || status.generation !== generation) return;
      if (!record(status.data) || typeof status.data.sync_enabled !== 'boolean') throw new Error();
      this.publish({ syncReloadPhase: 'ready' });
    } catch {
      if ((!restarted || this.current(restarted.request, restarted.generation)) && this.backend.getState().phase !== 'stopped') this.publish({ syncReloadPhase: 'failed' });
    } finally {
      this.reloading = false;
      if (this.state.syncReloadPhase === 'restarting') this.publish({ syncReloadPhase: 'idle' });
      this.refreshScope();
    }
  }

  private async executeTask(retry: boolean): Promise<void> {
    const request = this.operation;
    const generation = this.generation!;
    const receipt = this.state.submission!.receipt!;
    clearTimeout(this.pollTimer);
    ++this.taskRequest;
    this.publishSubmission({ taskBusy: retry ? 'retry' : 'run', taskError: null });
    const abort = this.beginRequest();
    try {
      // 持久恢复只排队；随后明确启动同一原任务，不能领取较早的其他任务。
      if (retry) {
        const recovered = await this.backend.requestJson({ method: 'POST', path: '/api/tasks/retry',
          body: { contact_id: receipt.contactId, task_id: receipt.taskId }, signal: abort.signal });
        if (!this.current(request, generation)) return;
        if (!record(recovered.data) || recovered.data.task_id !== receipt.taskId || recovered.data.status !== 'queued') throw new Error();
      }
      const started = await this.backend.requestJson({ method: 'POST', path: '/api/tasks/run',
        body: { contact_id: receipt.contactId, task_id: receipt.taskId }, signal: abort.signal });
      if (!this.current(request, generation)) return;
      if (!record(started.data) || !['started', 'busy'].includes(started.data.status as string)) throw new Error();
      this.publishSubmission({ taskBusy: null });
      await this.loadTask(request, generation);
    } catch {
      if (!this.current(request, generation)) return;
      this.publishSubmission({ taskBusy: null });
      // 恢复可能已落库，失败后复读真实状态；旧 failed 快照不能继续授权第二次恢复。
      await this.loadTask(request, generation);
      if (this.current(request, generation)) this.publishSubmission({ taskError: '原任务启动结果尚未确认。请刷新状态后继续；已成功步骤保留。' });
    } finally { this.pending.delete(abort); }
  }

  private async loadTask(request: number, generation: number, background = false): Promise<void> {
    if (!this.current(request, generation) || !this.state.submission?.receipt) return;
    const receipt = this.state.submission.receipt;
    const read = ++this.taskRequest;
    clearTimeout(this.pollTimer);
    // 定时读取不占用前台按钮；显式刷新及任务写入仍显示忙碌。
    if (!background) this.publishSubmission({ taskBusy: 'refresh', taskError: null });
    const abort = this.beginRequest();
    try {
      const response = await this.backend.requestJson({ method: 'GET',
        path: `/api/tasks/status?contact_id=${receipt.contactId}&task_id=${receipt.taskId}`, signal: abort.signal });
      if (!this.current(request, generation) || read !== this.taskRequest) return;
      const task = importTask(response.data, receipt);
      this.publishSubmission({ task, taskBusy: null, taskError: null });
      if (['queued', 'running', 'verifying'].includes(task.status)) {
        this.pollTimer = setTimeout(() => void this.loadTask(request, generation, true), 1500);
      }
    } catch {
      if (this.current(request, generation) && read === this.taskRequest) this.publishSubmission({ task: null, taskBusy: null,
        taskError: '任务状态暂时无法核验。资料保存结果保留，请刷新状态；当前不能判断处理完成或重试。' });
    } finally { this.pending.delete(abort); }
  }

  private async readSourcesAndSync(request: number, generation: number): Promise<void> {
    const receipt = this.state.submission?.receipt;
    if (!receipt || !this.current(request, generation)) return;
    const abort = this.beginRequest();
    const reads = await Promise.allSettled([
      this.backend.requestJson({ method: 'GET', path: `/api/contacts/${receipt.contactId}/sources`, signal: abort.signal }),
      this.backend.requestJson({ method: 'GET', path: '/api/sync/status', maxResponseBytes: 16_384, signal: abort.signal }),
    ]);
    this.pending.delete(abort);
    if (!this.current(request, generation)) return;
    try {
      if (reads[0].status !== 'fulfilled') throw new Error();
      this.publishSubmission({ sources: importSources(reads[0].value.data), sourcesError: false });
    } catch { this.publishSubmission({ sources: null, sourcesError: true }); }
    this.publishSubmission({ syncReloadNeeded: reads[1].status === 'rejected' && reads[1].reason instanceof BackendRequestFailure
      && reads[1].reason.code === 'sync_unavailable' });
  }

  private assertSubmission(selectionRevision: number): void {
    this.assertAvailable();
    if (selectionRevision !== this.state.selectionRevision || !this.state.submission?.receipt) throw new Error(staleMessage);
  }

  private current(request: number, generation: number): boolean {
    return request === this.operation && generation === this.backend.getConnectionGeneration();
  }

  private beginRequest(): AbortController { const abort = new AbortController(); this.pending.add(abort); return abort; }
  private publishSubmission(update: Partial<ImportSubmission>): void {
    if (this.state.submission) this.publish({ submission: { ...this.state.submission, ...update } });
  }

  private assertAvailable(): void {
    this.refreshScope();
    if (this.reloading || this.generation === undefined || this.contacts.getState().directoryPhase !== 'ready') throw new Error(staleMessage);
  }

  private assertSelection(selectionRevision: number): void {
    this.assertAvailable();
    const target = this.state.target;
    if (selectionRevision !== this.state.selectionRevision || !this.selectedPath || !target
      || (target.kind === 'new' && !target.displayName.trim())
      || (target.kind === 'existing' && !this.contacts.getState().contacts.some((entry) => entry.contactId === target.contactId))) throw new Error(staleMessage);
  }

  private async readPreview(): Promise<{ summary: ImportPreviewSummary; digest: string }> {
    const generation = this.generation;
    const target = this.state.target!;
    const targetName = target.kind === 'new' ? target.displayName.trim()
      : this.contacts.getState().contacts.find((entry) => entry.contactId === target.contactId)!.displayName;
    const result = await this.backend.requestJson({ method: 'POST', path: '/api/imports/preview',
      body: { path: this.selectedPath, ...(target.kind === 'existing' ? { contact_id: target.contactId } : {}) }, timeoutMs: 30_000 });
    if (result.generation !== generation || this.backend.getConnectionGeneration() !== generation) throw new Error(staleMessage);
    return previewSummary(result.data, targetName);
  }

  private refreshScope(): void {
    const generation = this.backend.getConnectionGeneration();
    const scope = this.contacts.getState();
    if (generation !== this.generation || scope.scopeRevision !== this.contactScope) {
      this.generation = generation;
      this.contactScope = scope.scopeRevision;
      this.selectedPath = null;
      this.invalidate({ phase: generation !== undefined && scope.directoryPhase === 'ready' ? 'idle' : 'unavailable', fileName: null, target: null,
        ...(!this.reloading ? { syncReloadPhase: 'idle' as const } : {}) });
    } else if (this.state.phase === 'unavailable' && generation !== undefined && scope.directoryPhase === 'ready') this.publish({ phase: 'idle' });
  }

  private rejectPreview(error: unknown): void {
    this.previewDigest = null;
    const message = error instanceof BackendRequestFailure && error.code === 'import_identity_conflict' ? identityMessage : rejectedMessage;
    this.publish({ phase: 'error', preview: null, error: message });
  }

  private invalidate(update: Partial<ImportState>): void {
    ++this.operation;
    ++this.taskRequest;
    clearTimeout(this.pollTimer);
    for (const abort of this.pending) abort.abort();
    this.pending.clear();
    this.previewDigest = null;
    this.publish({ preview: null, error: null, submission: null, selectionRevision: this.state.selectionRevision + 1, ...update });
  }

  private publish(update: Partial<ImportState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}
