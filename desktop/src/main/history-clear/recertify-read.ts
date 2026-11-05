import type { HistoryRecertifyView } from '../../shared/history-clear-bridge';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const time = (value: unknown): value is number | null => value === null || safeCount(value);

/** 来源认证状态的严格解析；控制器与批量编排器共用，避免两套宽严不同的校验。 */
export function recertifyView(value: unknown, contactId: string): HistoryRecertifyView {
  const row = value as Record<string, unknown> | null;
  const keys = ['contact_id', 'request_key', 'state', 'stage', 'completed', 'failure_code', 'message_count', 'non_text_count', 'page_count', 'preserved_message_count', 'started_at', 'finished_at'];
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key))
    || row.contact_id !== contactId || !['none', 'running', 'completed', 'failed', 'interrupted'].includes(String(row.state))
    || !['none', 'metadata', 'history', 'activation', 'completed'].includes(String(row.stage))
    || typeof row.completed !== 'boolean' || row.completed !== (row.state === 'completed')
    || !['message_count', 'non_text_count', 'page_count', 'preserved_message_count'].every(key => safeCount(row[key]))
    || !time(row.started_at) || !time(row.finished_at) || row.failure_code !== null && (typeof row.failure_code !== 'string' || !/^[a-z0-9_]{1,160}$/.test(row.failure_code))) throw new Error('来源认证状态格式无法确认。');
  if (row.state === 'none' ? row.request_key !== null || row.stage !== 'none' || row.started_at !== null || row.finished_at !== null
    : typeof row.request_key !== 'string' || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(row.request_key) || row.started_at === null) throw new Error('来源认证状态格式无法确认。');
  if (row.state === 'completed' && (row.stage !== 'completed' || row.failure_code !== null || row.finished_at === null)
    || row.state === 'running' && (!['metadata', 'history', 'activation'].includes(String(row.stage)) || row.finished_at !== null)) throw new Error('来源认证状态格式无法确认。');
  return { contactId, requestKey: row.request_key as string | null, state: row.state as HistoryRecertifyView['state'], stage: row.stage as HistoryRecertifyView['stage'],
    completed: row.completed, failureCode: row.failure_code as string | null, messageCount: row.message_count as number, nonTextCount: row.non_text_count as number,
    pageCount: row.page_count as number, preservedMessageCount: row.preserved_message_count as number, startedAt: row.started_at as number | null, finishedAt: row.finished_at as number | null };
}

/** 后端候选聚合的内部投影：保留联系人 ID 供逐位调用，但不向页面合同暴露。 */
export interface RecertifyCandidate {
  contactId: string;
  fenced: boolean;
  eligible: boolean;
  storedMessageCount: number;
  imageMessageCount: number;
  imageUnsavedCount: number;
}
export interface RecertifyCandidateList {
  readEnabled: boolean;
  fencedTotal: number;
  contacts: RecertifyCandidate[];
  total: number;
  withUnsavedImages: number;
  messageTotal: number;
  imageUnsavedTotal: number;
}
const candidateKeys = ['contact_id', 'fenced', 'eligible', 'stored_message_count', 'image_message_count', 'image_unsaved_count'];
const listKeys = ['read_enabled', 'fenced_total', 'contacts', 'total', 'with_unsaved_images', 'message_total', 'image_unsaved_total'];
/** 严格解析后端只读候选聚合；任何额外字段或矛盾计数都被拒绝，不把未知结构带进批量状态。 */
export function recertifyCandidateList(value: unknown): RecertifyCandidateList {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== listKeys.length || Object.keys(row).some(key => !listKeys.includes(key))
    || typeof row.read_enabled !== 'boolean' || typeof row.fenced_total !== 'number' || !safeCount(row.fenced_total)
    || !Array.isArray(row.contacts) || !['total', 'with_unsaved_images', 'message_total', 'image_unsaved_total'].every(key => safeCount(row[key]))) throw new Error('批量候选格式无法确认。');
  const contacts = row.contacts.map((entry): RecertifyCandidate => {
    const contact = entry as Record<string, unknown> | null;
    if (!contact || typeof contact !== 'object' || Array.isArray(contact) || Object.keys(contact).length !== candidateKeys.length || Object.keys(contact).some(key => !candidateKeys.includes(key))
      || typeof contact.contact_id !== 'string' || !uuid.test(contact.contact_id) || typeof contact.fenced !== 'boolean' || typeof contact.eligible !== 'boolean'
      || !safeCount(contact.stored_message_count) || !safeCount(contact.image_message_count) || !safeCount(contact.image_unsaved_count)) throw new Error('批量候选格式无法确认。');
    return { contactId: contact.contact_id.toLowerCase(), fenced: contact.fenced, eligible: contact.eligible,
      storedMessageCount: contact.stored_message_count, imageMessageCount: contact.image_message_count, imageUnsavedCount: contact.image_unsaved_count };
  });
  if (row.total !== contacts.filter(contact => contact.fenced && contact.eligible).length || row.contacts.length < row.total
    || contacts.some(contact => contact.imageMessageCount < contact.imageUnsavedCount)
    || row.with_unsaved_images !== contacts.filter(contact => contact.imageUnsavedCount > 0).length
    || row.message_total !== contacts.reduce((sum, contact) => sum + contact.storedMessageCount, 0)
    || row.image_unsaved_total !== contacts.reduce((sum, contact) => sum + contact.imageUnsavedCount, 0)) throw new Error('批量候选格式无法确认。');
  return { readEnabled: row.read_enabled, fencedTotal: row.fenced_total, contacts, total: row.total,
    withUnsavedImages: row.with_unsaved_images, messageTotal: row.message_total, imageUnsavedTotal: row.image_unsaved_total };
}
