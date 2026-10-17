import { noArguments, type PageCommands } from '../page-commands';
import type { LayeredMemoryManagementRequest, MemoryAdditionRequest, MemoryCandidateRequest, MemoryCandidateUpdateRequest, MemoryCorrectionRequest, MemoryReadRequest, MemoryRemovalRequest, MemorySectionName } from '../../shared/memory-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { isUuid } from '../uuid';
import { MemoryReadingController } from './controller';

function requestArguments(args: unknown[]): MemoryReadRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('资料读取不可用。');
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  if ((keys.length !== 2 && keys.length !== 3) || !keys.includes('contactId') || !keys.includes('scopeRevision')
    || !keys.every((key) => ['contactId', 'scopeRevision', 'section'].includes(key))
    || typeof fields.contactId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(fields.contactId)
    || typeof fields.scopeRevision !== 'number' || !Number.isSafeInteger(fields.scopeRevision) || fields.scopeRevision < 0
    || (keys.includes('section') && !['contact', 'owner', 'pending', 'sources'].includes(fields.section as string))) {
    throw new Error('资料读取不可用。');
  }
  return { contactId: fields.contactId.toLowerCase(), scopeRevision: fields.scopeRevision,
    ...(keys.includes('section') ? { section: fields.section as MemorySectionName } : {}) };
}
export function installMemoryBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession): MemoryReadingController {
  const memory = new MemoryReadingController(backend, contacts);
  memory.onStateChanged((state) => commands.publish('memory:state-changed', state, 'manager'));
  contacts.onStateChanged(() => memory.synchronizeScope());
  backend.onStateChanged(() => memory.synchronizeScope());
  memory.synchronizeScope();
  commands.handle('memory:get-state', (...args: unknown[]) => {
    noArguments(args);
    return memory.getState();
  }, 'manager');
  commands.handle('memory:refresh', (...args: unknown[]) => {
    return memory.refresh(requestArguments(args));
  }, 'manager');
  commands.handle('memory:refresh-overview', (...args: unknown[]) => {
    const request = requestArguments(args);
    if (request.section !== undefined) throw new Error('概览读取不可用。');
    return memory.refreshOverview(request);
  }, 'manager');
  commands.handle('memory:refresh-owner-overview', (...args: unknown[]) => {
    const request = requestArguments(args);
    if (request.section !== undefined) throw new Error('本人概览读取不可用。');
    return memory.refreshOwnerOverview(request);
  }, 'manager');
  commands.handle('memory:read-layered-memory', (...args: unknown[]) => {
    const request = requestArguments(args);
    if (request.section !== undefined) throw new Error('主题资料读取不可用。');
    return memory.readLayeredMemory(request);
  }, 'manager');
  commands.handle('memory:manage-layered-memory', (...args: unknown[]) => memory.manageLayeredMemory(layeredMemoryArguments(args)), 'manager');
  commands.handle('memory:add', (...args: unknown[]) => memory.add(additionArguments(args)), 'manager');
  commands.handle('memory:remove', (...args: unknown[]) => memory.remove(removalArguments(args)), 'manager');
  commands.handle('memory:discard-candidate', (...args: unknown[]) => memory.discardCandidate(candidateArguments(args)), 'manager');
  commands.handle('memory:confirm-candidate', (...args: unknown[]) => memory.confirmCandidate(candidateArguments(args)), 'manager');
  commands.handle('memory:apply-candidate-update', (...args: unknown[]) => memory.applyCandidateUpdate(candidateUpdateArguments(args)), 'manager');
  commands.handle('memory:correct', (...args: unknown[]) => memory.correct(correctionArguments(args)), 'manager');
  commands.handle('memory:open-versions', (...args: unknown[]) => memory.openVersions(removalArguments(args)), 'manager');
  commands.handle('memory:revert-auto-update', (...args: unknown[]) => memory.revertAutoUpdate(removalArguments(args)), 'manager');
  return memory;
}

function correctionArguments(args: unknown[]): MemoryCorrectionRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('资料修正不可用。');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 7 || !Object.keys(fields).every((key) =>
    ['contactId', 'scopeRevision', 'level', 'memoryId', 'revision', 'text', 'category'].includes(key))
    || !isUuid(fields.contactId) || !isUuid(fields.memoryId)
    || typeof fields.scopeRevision !== 'number' || !Number.isSafeInteger(fields.scopeRevision) || fields.scopeRevision < 0
    || !['owner', 'contact'].includes(fields.level as string) || typeof fields.revision !== 'number' || !Number.isSafeInteger(fields.revision) || fields.revision < 1
    || typeof fields.text !== 'string' || !fields.text.trim()
    || !['common_fact', 'preference', 'taboo', 'recent_state', 'relationship_note'].includes(fields.category as string)) {
    throw new Error('资料修正不可用。');
  }
  return { contactId: fields.contactId.toLowerCase(), scopeRevision: fields.scopeRevision, level: fields.level as MemoryCorrectionRequest['level'],
    memoryId: fields.memoryId.toLowerCase(), revision: fields.revision, text: fields.text, category: fields.category as MemoryCorrectionRequest['category'] };
}

function additionArguments(args: unknown[]): MemoryAdditionRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('资料补充不可用。');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 5 || !Object.keys(fields).every((key) =>
    ['contactId', 'scopeRevision', 'level', 'text', 'category'].includes(key))
    || !isUuid(fields.contactId) || typeof fields.scopeRevision !== 'number'
    || !Number.isSafeInteger(fields.scopeRevision) || fields.scopeRevision < 0
    || !['owner', 'contact'].includes(fields.level as string) || typeof fields.text !== 'string' || !fields.text.trim()
    || !['common_fact', 'preference', 'taboo', 'recent_state', 'relationship_note'].includes(fields.category as string)) {
    throw new Error('资料补充不可用。');
  }
  return { contactId: fields.contactId.toLowerCase(), scopeRevision: fields.scopeRevision,
    level: fields.level as MemoryAdditionRequest['level'], text: fields.text, category: fields.category as MemoryAdditionRequest['category'] };
}

function removalArguments(args: unknown[]): MemoryRemovalRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('资料删除不可用。');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 5 || !Object.keys(fields).every((key) =>
    ['contactId', 'scopeRevision', 'level', 'memoryId', 'revision'].includes(key))
    || !isUuid(fields.contactId) || !isUuid(fields.memoryId) || typeof fields.scopeRevision !== 'number'
    || !Number.isSafeInteger(fields.scopeRevision) || fields.scopeRevision < 0
    || !['owner', 'contact'].includes(fields.level as string) || typeof fields.revision !== 'number'
    || !Number.isSafeInteger(fields.revision) || fields.revision < 1) throw new Error('资料删除不可用。');
  return { contactId: fields.contactId.toLowerCase(), scopeRevision: fields.scopeRevision,
    level: fields.level as MemoryRemovalRequest['level'], memoryId: fields.memoryId.toLowerCase(), revision: fields.revision };
}

function candidateArguments(args: unknown[]): MemoryCandidateRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('候选操作不可用。');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 3 || !Object.keys(fields).every((key) => ['contactId', 'scopeRevision', 'candidateId'].includes(key))
    || !isUuid(fields.contactId) || !isUuid(fields.candidateId) || typeof fields.scopeRevision !== 'number'
    || !Number.isSafeInteger(fields.scopeRevision) || fields.scopeRevision < 0) throw new Error('候选操作不可用。');
  return { contactId: fields.contactId.toLowerCase(), scopeRevision: fields.scopeRevision, candidateId: fields.candidateId.toLowerCase() };
}

function candidateUpdateArguments(args: unknown[]): MemoryCandidateUpdateRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('候选版本更新不可用。');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 5 || !Object.keys(fields).every((key) =>
    ['contactId', 'scopeRevision', 'candidateId', 'previousMemoryId', 'expectedRevision'].includes(key))
    || !isUuid(fields.previousMemoryId) || typeof fields.expectedRevision !== 'number'
    || !Number.isSafeInteger(fields.expectedRevision) || fields.expectedRevision < 1) throw new Error('候选版本更新不可用。');
  const candidate = candidateArguments([{ contactId: fields.contactId, scopeRevision: fields.scopeRevision, candidateId: fields.candidateId }]);
  return { ...candidate, previousMemoryId: fields.previousMemoryId.toLowerCase(), expectedRevision: fields.expectedRevision };
}

function layeredMemoryArguments(args: unknown[]): LayeredMemoryManagementRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('主题资料操作不可用。');
  const fields = value as Record<string, unknown>;
  const enable = fields.action === 'enable';
  if (Object.keys(fields).length !== (enable ? 5 : 4)
    || !Object.keys(fields).every((key) => ['contactId', 'scopeRevision', 'action', 'settingsGeneration', ...(enable ? ['purposeConfirmed'] : [])].includes(key))
    || !['enable', 'refresh', 'disable', 'delete'].includes(fields.action as string)
    || typeof fields.settingsGeneration !== 'number' || !Number.isSafeInteger(fields.settingsGeneration) || fields.settingsGeneration < 0
    || (enable && fields.purposeConfirmed !== true)) throw new Error('主题资料操作不可用。');
  const selection = requestArguments([{ contactId: fields.contactId, scopeRevision: fields.scopeRevision }]);
  return { ...selection, action: fields.action as LayeredMemoryManagementRequest['action'], settingsGeneration: fields.settingsGeneration,
    ...(enable ? { purposeConfirmed: true as const } : {}) };
}
