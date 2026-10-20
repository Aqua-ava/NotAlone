import { conditionProposal } from './condition-proposal';
import { MemoryProcessingController, processingArguments, processingResumeArguments } from './processing';
import { OwnerLayeredMemoryController } from './owner-layered';
import { noArguments, type PageCommands } from '../page-commands';
import type { LayeredMemoryManagementRequest, OwnerLayeredMemoryManagementRequest, MemoryAdditionRequest, MemoryCandidateRequest, MemoryCandidateUpdateRequest, MemoryCorrectionRequest, MemoryReadRequest, MemoryRemovalRequest, MemorySectionName } from '../../shared/memory-bridge';
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
    || !isUuid(fields.contactId)
    || typeof fields.scopeRevision !== 'number' || !Number.isSafeInteger(fields.scopeRevision) || fields.scopeRevision < 0
    || (keys.includes('section') && !['contact', 'owner', 'pending', 'sources'].includes(fields.section as string))) {
    throw new Error('资料读取不可用。');
  }
  return { contactId: fields.contactId.toLowerCase(), scopeRevision: fields.scopeRevision,
    ...(keys.includes('section') ? { section: fields.section as MemorySectionName } : {}) };
}
export function installMemoryBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession): MemoryReadingController {
  const memory = new MemoryReadingController(backend, contacts);
  const processing = new MemoryProcessingController(backend, contacts);
  backend.onStateChanged(() => processing.synchronize());
  let processingScopeRevision = contacts.getState().scopeRevision;
  contacts.onStateChanged(state => {
    if (state.scopeRevision !== processingScopeRevision) { processingScopeRevision = state.scopeRevision; processing.synchronize(true); }
  });
  commands.handle('memory:resume-processing', (...args: unknown[]) => processing.resume(processingResumeArguments(args)), 'manager');
  commands.handle('memory:read-processing', (...args: unknown[]) => processing.read(processingArguments(args)), 'manager');
  commands.handle('memory:cancel-processing-read', (...args: unknown[]) => processing.cancel(processingArguments(args)), 'manager');
  const owner = new OwnerLayeredMemoryController(backend, state => commands.publish('memory:owner-layered-changed', state, 'manager'), phase => memory.ownerFactsChanged(phase), phase => memory.ownerLayeredContextChanged(phase));
  commands.handle('memory:refresh-processing-results', (...args: unknown[]) => {
    const request = processingArguments(args);
    return request.scope === 'owner' ? Promise.all([owner.refreshProcessingResults(), memory.refreshOwnerProcessingResults()]).then(() => {}) : memory.refreshProcessingResults(request);
  }, 'manager');
  backend.onStateChanged(() => owner.synchronize());
  memory.onRecordDeletion((phase, origin) => {
    if (origin !== 'owner-facts') owner.sourceDeletionChanged(phase);
  });
  memory.onOwnerDependenciesChanged(phase => owner.sourceDeletionChanged(phase));
  commands.handle('memory:read-owner-facts', (...args: unknown[]) => { noArguments(args); return owner.readFacts(); }, 'manager');
  for (const action of ['correct', 'delete'] as const) commands.handle(`memory:${action}-owner-fact`, (...args: unknown[]) => {
    const fields = args[0] as Record<string, unknown> | undefined;
    const keys = action === 'correct' ? ['memoryId', 'revision', 'text', 'category', 'changeKind', 'conditions'] : ['memoryId', 'revision'];
    if (args.length !== 1 || !fields || typeof fields !== 'object' || Array.isArray(fields)
      || Object.keys(fields).length !== keys.length - (action === 'correct' && fields.changeKind === undefined ? 1 : 0) - (action === 'correct' && fields.conditions === undefined ? 1 : 0) || !Object.keys(fields).every(key => keys.includes(key))
      || !isUuid(fields.memoryId) || typeof fields.revision !== 'number' || !Number.isSafeInteger(fields.revision) || fields.revision < 1
      || (action === 'correct' && ((fields.changeKind !== undefined && !['error_correction', 'state_changed'].includes(fields.changeKind as string)) || typeof fields.text !== 'string' || !fields.text.trim() || fields.text.length > 4000
        || !['common_fact', 'preference', 'taboo', 'recent_state', 'relationship_note'].includes(fields.category as string)))) throw new Error('本人底层资料操作不可用。');
    return owner.changeFact(action, { memoryId: fields.memoryId, revision: fields.revision,
      ...(action === 'correct' ? { text: fields.text as string, category: fields.category as MemoryAdditionRequest['category'], ...(fields.conditions === undefined ? {} : { conditions: conditionProposal(fields.conditions) }), changeKind: (fields.changeKind ?? 'error_correction') as MemoryCorrectionRequest['changeKind'] } : {}) });
  }, 'manager');
  commands.handle('memory:add-owner', (...args: unknown[]) => {
    const fields = args[0] as Record<string, unknown> | undefined;
    if (args.length !== 1 || !fields || typeof fields !== 'object' || Array.isArray(fields)
      || Object.keys(fields).length !== 2 || !Object.keys(fields).every(key => ['text', 'category'].includes(key))
      || typeof fields.text !== 'string' || !fields.text.trim() || fields.text.length > 4000
      || !['common_fact', 'preference', 'taboo', 'recent_state', 'relationship_note'].includes(fields.category as string)) throw new Error('本人资料补充不可用。');
    return owner.add({ text: fields.text, category: fields.category as MemoryAdditionRequest['category'] });
  }, 'manager');
  commands.handle('memory:owner-layered-state', (...args: unknown[]) => { noArguments(args); return owner.getState(); }, 'manager');
  commands.handle('memory:release-owner-layered', (...args: unknown[]) => { noArguments(args); owner.releaseView(); }, 'manager');
  commands.handle('memory:read-owner-layered', (...args: unknown[]) => {
    const fields = args[0] as Record<string, unknown> | undefined;
    if (args.length !== 1 || !fields || typeof fields !== 'object' || Array.isArray(fields)
      || !Object.keys(fields).every(key => key === 'mappingCursor')
      || (fields.mappingCursor !== undefined && fields.mappingCursor !== null && (typeof fields.mappingCursor !== 'string' || !/^[0-9]{1,18}:[0-9]{1,10}$/.test(fields.mappingCursor)))) throw new Error('本人资料读取不可用。');
    return owner.read(fields as { mappingCursor?: string | null });
  }, 'manager');
  commands.handle('memory:manage-owner-layered', (...args: unknown[]) => {
    const fields = args[0];
    if (args.length !== 1 || !fields || typeof fields !== 'object' || Array.isArray(fields) || 'contactId' in fields || 'scopeRevision' in fields) throw new Error('本人资料操作不可用。');
    const request = layeredMemoryArguments(args, true);
    return owner.manage(request);
  }, 'manager');
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
  commands.handle('memory:release-layered-memory', (...args: unknown[]) => {
    const request = requestArguments(args);
    if (request.section !== undefined) throw new Error('主题资料操作不可用。');
    memory.releaseLayeredMemory(request);
  }, 'manager');
  commands.handle('memory:read-layered-memory', (...args: unknown[]) => {
    const fields = args[0] as Record<string, unknown> | undefined;
    if (args.length !== 1 || !fields || typeof fields !== 'object' || Array.isArray(fields)
      || !Object.keys(fields).every((key) => ['contactId', 'scopeRevision', 'mappingCursor'].includes(key))
      || (fields.mappingCursor !== undefined && fields.mappingCursor !== null
        && (typeof fields.mappingCursor !== 'string' || !/^[0-9]{1,18}:[0-9]{1,10}$/.test(fields.mappingCursor)))) throw new Error('主题资料读取不可用。');
    const request = requestArguments([{ contactId: fields.contactId, scopeRevision: fields.scopeRevision }]);
    return memory.readLayeredMemory({ ...request, mappingCursor: fields.mappingCursor as string | null | undefined });
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
  if (Object.keys(fields).length !== (fields.changeKind === undefined ? 7 : 8) + (fields.conditions === undefined ? 0 : 1) || !Object.keys(fields).every((key) =>
    ['contactId', 'scopeRevision', 'level', 'memoryId', 'revision', 'text', 'category', 'changeKind', 'conditions'].includes(key))
    || !isUuid(fields.contactId) || !isUuid(fields.memoryId)
    || (fields.changeKind !== undefined && !['error_correction', 'state_changed'].includes(fields.changeKind as string))
    || typeof fields.scopeRevision !== 'number' || !Number.isSafeInteger(fields.scopeRevision) || fields.scopeRevision < 0
    || !['owner', 'contact'].includes(fields.level as string) || typeof fields.revision !== 'number' || !Number.isSafeInteger(fields.revision) || fields.revision < 1
    || typeof fields.text !== 'string' || !fields.text.trim()
    || !['common_fact', 'preference', 'taboo', 'recent_state', 'relationship_note'].includes(fields.category as string)) {
    throw new Error('资料修正不可用。');
  }
  return { contactId: fields.contactId.toLowerCase(), scopeRevision: fields.scopeRevision, level: fields.level as MemoryCorrectionRequest['level'],
    memoryId: fields.memoryId.toLowerCase(), revision: fields.revision, text: fields.text, category: fields.category as MemoryCorrectionRequest['category'], ...(fields.conditions === undefined ? {} : { conditions: conditionProposal(fields.conditions) }), changeKind: (fields.changeKind ?? 'error_correction') as MemoryCorrectionRequest['changeKind'] };
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

function layeredMemoryArguments(args: unknown[], owner: true): OwnerLayeredMemoryManagementRequest;
function layeredMemoryArguments(args: unknown[]): LayeredMemoryManagementRequest;
function layeredMemoryArguments(args: unknown[], owner = false): OwnerLayeredMemoryManagementRequest | LayeredMemoryManagementRequest {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('主题资料操作不可用。');
  const fields = value as Record<string, unknown>;
  if (fields.action === 'summary-error' || fields.action === 'fact-error') {
    const summary = fields.action === 'summary-error';
    const keys = [...(owner ? [] : ['contactId', 'scopeRevision']), 'action', 'settingsGeneration', 'organizationGeneration', 'targetKind', 'versionId', 'itemIndex', ...(summary ? ['reason', 'operationId'] : ['memoryId'])];
    if (Object.keys(fields).length !== keys.length || !Object.keys(fields).every(key => keys.includes(key))
      || !Number.isSafeInteger(fields.settingsGeneration) || (fields.settingsGeneration as number) < 0
      || !Number.isSafeInteger(fields.organizationGeneration) || (fields.organizationGeneration as number) < 0
      || !['scenario', 'profile'].includes(fields.targetKind as string) || !isUuid(fields.versionId)
      || !Number.isSafeInteger(fields.itemIndex) || (fields.itemIndex as number) < 0
      || (summary ? typeof fields.reason !== 'string' || !fields.reason.trim() || fields.reason.length > 500 || !isUuid(fields.operationId) : !isUuid(fields.memoryId))) throw new Error('整理纠错操作不可用。');
    return { ...(owner ? {} : requestArguments([{ contactId: fields.contactId, scopeRevision: fields.scopeRevision }])),
      action: fields.action, settingsGeneration: fields.settingsGeneration as number, organizationGeneration: fields.organizationGeneration as number,
      targetKind: fields.targetKind as 'scenario' | 'profile', versionId: (fields.versionId as string).toLowerCase(), itemIndex: fields.itemIndex as number,
      ...(summary ? { reason: fields.reason as string, operationId: (fields.operationId as string).toLowerCase() } : { memoryId: (fields.memoryId as string).toLowerCase() }) };
  }
  const enable = fields.action === 'enable', scenario = owner && fields.action === 'withdraw-scenario';
  const withdraw = fields.action === 'withdraw-profile' || scenario;
  const workAction = fields.action === 'pause' || fields.action === 'continue';
  if (Object.keys(fields).length !== ((withdraw ? 6 : enable || workAction ? 5 : 4) - (owner ? 2 : 0))
    || !Object.keys(fields).every((key) => [...(owner ? [] : ['contactId', 'scopeRevision']), 'action', 'settingsGeneration',
      ...(enable ? ['purposeConfirmed'] : []), ...(workAction ? ['workRevision'] : []),
      ...(withdraw ? ['organizationGeneration', scenario ? 'scenarioVersionId' : 'profileVersionId'] : [])].includes(key))
    || !['enable', 'refresh', 'disable', 'delete', 'withdraw-profile', 'pause', 'continue', ...(owner ? ['withdraw-scenario'] : [])].includes(fields.action as string)
    || typeof fields.settingsGeneration !== 'number' || !Number.isSafeInteger(fields.settingsGeneration) || fields.settingsGeneration < 0
    || (enable && fields.purposeConfirmed !== true)
    || (workAction && (typeof fields.workRevision !== 'number' || !Number.isSafeInteger(fields.workRevision) || fields.workRevision < 1))
    || (withdraw && (typeof fields.organizationGeneration !== 'number' || !Number.isSafeInteger(fields.organizationGeneration)
      || fields.organizationGeneration < 0 || !isUuid(scenario ? fields.scenarioVersionId : fields.profileVersionId)))) throw new Error('主题资料操作不可用。');
  const selection = owner ? {} : requestArguments([{ contactId: fields.contactId, scopeRevision: fields.scopeRevision }]);
  return { ...selection, action: fields.action as LayeredMemoryManagementRequest['action'], settingsGeneration: fields.settingsGeneration,
    ...(enable ? { purposeConfirmed: true as const } : {}), ...(workAction ? { workRevision: fields.workRevision as number } : {}),
    ...(withdraw ? { organizationGeneration: fields.organizationGeneration as number, ...(scenario ? { scenarioVersionId: (fields.scenarioVersionId as string).toLowerCase() } : { profileVersionId: (fields.profileVersionId as string).toLowerCase() }) } : {}) };
}
