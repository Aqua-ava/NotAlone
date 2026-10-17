import type { LayeredMemory, LayeredMemoryManagementRequest } from '../../shared/memory-bridge';

export function currentCorrectionTarget(value: LayeredMemory, request: Pick<LayeredMemoryManagementRequest, 'organizationGeneration' | 'targetKind' | 'versionId' | 'itemIndex'>) {
  if (request.organizationGeneration !== value.organizationGeneration || request.itemIndex === undefined) return undefined;
  const profile = value.profile;
  return request.targetKind === 'scenario'
    ? value.scenarios.find(item => item.versionId === request.versionId)?.paragraphs[request.itemIndex]
    : profile && profile.versionId === request.versionId ? profile.entries[request.itemIndex] : undefined;
}

export function summaryErrorBody(request: LayeredMemoryManagementRequest | Omit<LayeredMemoryManagementRequest, 'contactId' | 'scopeRevision'>) {
  return { organization_generation: request.organizationGeneration, target_kind: request.targetKind,
    version_id: request.versionId, item_index: request.itemIndex, reason: request.reason, operation_id: request.operationId };
}
