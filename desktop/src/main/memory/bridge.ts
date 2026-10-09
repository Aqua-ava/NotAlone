import { noArguments, type PageCommands } from '../page-commands';
import type { MemoryAdditionRequest, MemoryCandidateRequest, MemoryCorrectionRequest, MemoryReadRequest, MemoryRemovalRequest, MemorySectionName } from '../../shared/memory-bridge';
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
  memory.onStateChanged((state) => commands.publish('memory:state-changed', state));
  contacts.onStateChanged(() => memory.synchronizeScope());
  backend.onStateChanged(() => memory.synchronizeScope());
  memory.synchronizeScope();
  commands.handle('memory:get-state', (...args: unknown[]) => {
    noArguments(args);
    return memory.getState();
  });
  commands.handle('memory:refresh', (...args: unknown[]) => {
    return memory.refresh(requestArguments(args));
  });
  commands.handle('memory:add', (...args: unknown[]) => memory.add(additionArguments(args)), 'manager');
  commands.handle('memory:remove', (...args: unknown[]) => memory.remove(removalArguments(args)), 'manager');
  commands.handle('memory:discard-candidate', (...args: unknown[]) => memory.discardCandidate(candidateArguments(args)), 'manager');
  commands.handle('memory:confirm-candidate', (...args: unknown[]) => memory.confirmCandidate(candidateArguments(args)), 'manager');
  commands.handle('memory:correct', (...args: unknown[]) => memory.correct(correctionArguments(args)), 'manager');
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
