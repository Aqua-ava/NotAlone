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
import { StorageFailure, type StorageAction, type StorageTransaction } from '../contracts.ts';
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

const deletionOwner = (input: unknown): string => {
  const ownerId = (input as {ownerId?: unknown})?.ownerId;
  if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 256) throw new StorageFailure('deletion_input_invalid');
  return ownerId;
};
// 严格门禁：只有 owner 仍 active 且没有任何未完成的 contact/account 删除时才允许重建名单服务。
// 联系人删除的读侧改用 metadataAdmission 提前放行；本动作保留给仍要求完全结束的调用方与兼容测试。
const strictMetadataAvailable: StorageAction = {name: 'deletion.metadataAvailable', mode: 'read', retryBusy: false,
  execute(tx: StorageTransaction, input: unknown) {
    const ownerId = deletionOwner(input);
    return !!tx.get(`SELECT 1 FROM owner WHERE owner_id=? AND state='active'
      AND NOT EXISTS(SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state!='completed'
        AND scope_kind IN ('contact','account'))`, [ownerId, ownerId]);
  },
};
// 名单读侧准入：联系人删除在 plan 事务里已把 contact 置为 deleting（目录/绑定/资格都按 active 过滤），
// 因此封禁后的名单读者只读活跃联系人，可以提前重建；账户删除与尚未封禁/缺失联系人的手写任务仍关闭。
// writable 保持严格语义：任何未完成 contact/account 删除期间都拒绝身份写入与敏感名单预览。
const metadataAdmission: StorageAction = {name: 'deletion.metadataAdmission', mode: 'read', retryBusy: false,
  execute(tx: StorageTransaction, input: unknown) {
    const ownerId = deletionOwner(input);
    if (!tx.get("SELECT 1 FROM owner WHERE owner_id=? AND state='active'", [ownerId])) {
      return { available: false, writable: false, admittedOperations: [] as string[] };
    }
    const unfinished = tx.all("SELECT operation_id,scope_kind,contact_identity FROM deletion_operation WHERE owner_identity=? AND state!='completed' AND scope_kind IN ('contact','account')", [ownerId]);
    const admittedOperations: string[] = [];
    let available = true;
    for (const row of unfinished) {
      if (row.scope_kind === 'account') { available = false; continue; }
      const contactId = row.contact_identity;
      if (typeof contactId !== 'string'
        || !tx.get("SELECT 1 FROM contact WHERE owner_id=? AND id=? AND state IN ('deleting','deleted')", [ownerId, contactId])) available = false;
      else admittedOperations.push(String(row.operation_id));
    }
    return { available, writable: unfinished.length === 0, admittedOperations: admittedOperations.sort() };
  },
};
export const installedDeletionActions: StorageAction[] = [strictMetadataAvailable, metadataAdmission];
