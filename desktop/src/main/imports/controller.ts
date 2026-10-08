import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { dialog } from 'electron';
import type { ImportIdentity, ImportPreviewSummary, ImportState, ImportTarget } from '../../shared/import-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import type { ContactSession } from '../contacts/session';

const staleMessage = '本次文件或联系人已变化，请重新预览并确认。';
const fileChangedMessage = '文件内容已变化，请重新预览并确认。';
const rejectedMessage = '预览已拒绝。请提供有效的单联系人 JSONL 文件；混合联系人、群聊、损坏或身份不明确的资料不能导入。';
const identityMessage = '本人或联系人渠道身份不一致，预览已拒绝。请检查文件或重新选择联系人。';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

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
  private state: ImportState = { revision: 0, selectionRevision: 0, phase: 'unavailable', fileName: null, target: null, preview: null, error: null };
  private selectedPath: string | null = null;
  private previewDigest: string | null = null;
  private generation: number | undefined;
  private contactScope = -1;
  private operation = 0;
  private readonly listeners = new Set<(state: ImportState) => void>();

  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession) {
    backend.onStateChanged(() => this.refreshScope());
    contacts.onStateChanged(() => this.refreshScope());
    this.refreshScope();
  }

  getState(): ImportState {
    return { ...this.state, target: this.state.target ? { ...this.state.target } : null,
      preview: this.state.preview ? { ...this.state.preview, kindCounts: { ...this.state.preview.kindCounts },
        ownerIdentity: { ...this.state.preview.ownerIdentity }, contactIdentity: { ...this.state.preview.contactIdentity } } : null };
  }

  onStateChanged(listener: (state: ImportState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async chooseFile(window: BrowserWindow): Promise<void> {
    this.assertAvailable();
    if (this.state.phase === 'choosing') return;
    this.invalidate({ phase: 'choosing', fileName: null });
    this.selectedPath = null;
    const request = this.operation;
    try {
      const result = await dialog.showOpenDialog(window, {
        title: '选择单联系人历史文件', buttonLabel: '选择这份文件',
        properties: ['openFile'], filters: [{ name: '微信单联系人 JSONL', extensions: ['jsonl'] }],
        message: '只预览你主动选择的这一份单联系人 JSONL 文件。',
      });
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

  private assertAvailable(): void {
    this.refreshScope();
    if (this.generation === undefined || this.contacts.getState().directoryPhase !== 'ready') throw new Error(staleMessage);
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
      this.invalidate({ phase: generation !== undefined && scope.directoryPhase === 'ready' ? 'idle' : 'unavailable', fileName: null, target: null });
    } else if (this.state.phase === 'unavailable' && generation !== undefined && scope.directoryPhase === 'ready') this.publish({ phase: 'idle' });
  }

  private rejectPreview(error: unknown): void {
    this.previewDigest = null;
    const message = error instanceof BackendRequestFailure && error.code === 'import_identity_conflict' ? identityMessage : rejectedMessage;
    this.publish({ phase: 'error', preview: null, error: message });
  }

  private invalidate(update: Partial<ImportState>): void {
    ++this.operation;
    this.previewDigest = null;
    this.publish({ preview: null, error: null, selectionRevision: this.state.selectionRevision + 1, ...update });
  }

  private publish(update: Partial<ImportState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}
