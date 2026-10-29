import { historyDeletionDomain } from '../../../history/sqlite/deletion.ts';
import { historyReaderHolderKey } from '../../../history/sqlite/service.ts';
import { identityDeletionAuthority, identityDeletionDomain } from '../../../contacts/sqlite/deletion.ts';
import { skillMetadataDeletionDomain } from '../../../skills/sqlite/deletion.ts';
import { StorageFailure, type StorageAction } from '../contracts.ts';
import type { DeletionDomain, DeletionRegistration, DeletionScope } from './contracts.ts';

export const installedDeletionScopes = ['source', 'contact', 'account'] as const;
const supported = (scope: DeletionScope) => installedDeletionScopes.some(kind => kind === scope.kind);

// inspect/target尚无goal时也持有真实只读连接，来源删除必须覆盖这些早期读者。
const installedHistoryDomain:DeletionDomain={...historyDeletionDomain,collect(tx,operation){
  const targets=historyDeletionDomain.collect(tx,operation);
  if(operation.scope.kind!=='source')return targets;
  const {ownerId,acceptedGeneration,scope}=operation;
  const generations=tx.all('SELECT DISTINCT accepted_data_generation AS generation FROM read_goal WHERE owner_id=? AND contact_id=? AND accepted_data_generation<?',[ownerId,scope.contactId,acceptedGeneration]).map(row=>String(row.generation));
  if(acceptedGeneration>0n)generations.push(String(acceptedGeneration-1n));
  const keys=[...new Set(generations.map(generation=>historyReaderHolderKey(scope.contactId,generation)))];
  return targets.map(target=>({...target,holderKeys:[...new Set([...target.holderKeys,...keys])]}));
}};
// contact_history的精确截断由06提供；不因本票接通来源删除而扩大范围。
export const installedDeletionRegistration: DeletionRegistration = {
  authority: {
    fence(tx, ownerId, scope) {
      if (!supported(scope)) throw new StorageFailure('deletion_scope_unavailable');
      return identityDeletionAuthority.fence(tx, ownerId, scope);
    },
    verify(tx, operation) {
      return supported(operation.scope) ? identityDeletionAuthority.verify(tx, operation)
        : {result: 'blocked', proof: 'scope_handler_unavailable'};
    },
  },
  domains: [installedHistoryDomain, identityDeletionDomain, skillMetadataDeletionDomain()],
  requiredDomains: ['history', 'identity', 'skill_metadata'],
};

// 名单缓存覆盖全部联系人，任何未完成删除期间都不重新开启该内存持有者。
export const installedDeletionActions: StorageAction[] = [{name: 'deletion.metadataAvailable', mode: 'read', retryBusy: false,
  execute(tx, input) {
    const ownerId = (input as {ownerId?: unknown})?.ownerId;
    if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 256) throw new StorageFailure('deletion_input_invalid');
    return !!tx.get(`SELECT 1 FROM owner WHERE owner_id=? AND state='active'
      AND NOT EXISTS(SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state!='completed')`, [ownerId, ownerId]);
  },
}];
