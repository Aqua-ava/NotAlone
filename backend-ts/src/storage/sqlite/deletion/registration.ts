import { identityDeletionAuthority, identityDeletionDomain } from '../../../contacts/sqlite/deletion.ts';
import { skillMetadataDeletionDomain } from '../../../skills/sqlite/deletion.ts';
import { StorageFailure } from '../contracts.ts';
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
