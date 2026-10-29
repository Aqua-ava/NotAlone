import { identityDeletionAuthority, identityDeletionDomain } from '../../../contacts/sqlite/deletion.ts';
import { skillMetadataDeletionDomain } from '../../../skills/sqlite/deletion.ts';
import { StorageFailure, type StorageAction } from '../contracts.ts';
import type { DeletionRegistration, DeletionScope } from './contracts.ts';

export const installedDeletionScopes = ['contact', 'account'] as const;
const supported = (scope: DeletionScope) => installedDeletionScopes.some(kind => kind === scope.kind);

// 只注册当前真实写者；03/06/11/16安装时必须补自己的闭包及精确authority后才能放行。
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
  domains: [identityDeletionDomain, skillMetadataDeletionDomain()],
  requiredDomains: ['identity', 'skill_metadata'],
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
