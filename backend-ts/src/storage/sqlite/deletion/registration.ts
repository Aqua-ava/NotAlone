import {memoryManagementDeletionDomain} from '../../../memory/sqlite/management/deletion.ts';
import {memoryDocumentsDeletionDomain} from '../../../memory/sqlite/documents/deletion.ts';
import {replyCandidateDeletionDomain} from '../../../reply/sqlite/candidates/deletion.ts';
import {discussionDeletionDomain,withDiscussionDeletionAuthority} from '../../../reply/sqlite/deletion.ts';
import {discussionCallDeletionDomain} from '../../../reply/sqlite/model-deletion.ts';
import {memoryExtractionDeletionDomain} from '../../../memory/sqlite/deletion.ts';
import { composeMediaDeletionRegistration } from '../../../media/sqlite/deletion.ts';
import { historyDeletionDomain } from '../../../history/sqlite/deletion.ts';
import { historyReaderHolderKey } from '../../../history/sqlite/service.ts';
import { identityDeletionAuthority, identityDeletionDomain } from '../../../contacts/sqlite/deletion.ts';
import { skillMetadataDeletionDomain } from '../../../skills/sqlite/deletion.ts';
import { StorageFailure, type StorageAction } from '../contracts.ts';
import type { DeletionDomain, DeletionRegistration, DeletionScope } from './contracts.ts';

export const installedDeletionScopes = ['source', 'contact', 'contact_history', 'account', 'media_result_clear', 'media_result_replace', 'discussion'] as const;
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
// contact_history的精确截断由06提供：history域只在其完整B被原子接受后通过scope_suppression复核。
const baseDeletionRegistration: DeletionRegistration = {
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
  domains: [memoryDocumentsDeletionDomain, memoryManagementDeletionDomain, replyCandidateDeletionDomain, discussionCallDeletionDomain, memoryExtractionDeletionDomain, discussionDeletionDomain, installedHistoryDomain, identityDeletionDomain, skillMetadataDeletionDomain()],
  requiredDomains: ['memory_documents', 'memory_management', 'reply_candidates', 'discussion_calls', 'memory_extraction', 'discussion', 'history', 'identity', 'skill_metadata'],
};

const mediaRegistration=composeMediaDeletionRegistration(baseDeletionRegistration);
export const installedDeletionRegistration:DeletionRegistration={...mediaRegistration,authority:withDiscussionDeletionAuthority(mediaRegistration.authority)};

// 只有会移除/更换联系人身份的未完成删除（contact/account）才关闭名单服务；
// 来源、清空聊天、讨论与媒体删除只清理内容，联系人与绑定身份仍有效，关闭后会让重启后的
// 联系人目录/授权状态/删除进度全部不可读（t21 跨重启问题）。这些领域的写入门禁仍由各自
// 删除边界与 holder fence 负责，不靠关闭只读名单服务实现。
export const installedDeletionActions: StorageAction[] = [{name: 'deletion.metadataAvailable', mode: 'read', retryBusy: false,
  execute(tx, input) {
    const ownerId = (input as {ownerId?: unknown})?.ownerId;
    if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 256) throw new StorageFailure('deletion_input_invalid');
    return !!tx.get(`SELECT 1 FROM owner WHERE owner_id=? AND state='active'
      AND NOT EXISTS(SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state!='completed'
        AND scope_kind IN ('contact','account'))`, [ownerId, ownerId]);
  },
}];
