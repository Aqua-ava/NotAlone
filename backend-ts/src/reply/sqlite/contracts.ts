import type {ManagedAddress} from '../../storage/sqlite/deletion/contracts.ts';
export interface DiscussionScope {ownerId:string;contactId:string;discussionId:string}
export interface Discussion {id:string;contactId:string;state:'active'|'deleting'|'deleted';generation:bigint;currentRuntimeId:string|null;createdAt:bigint;lastActivityAt:bigint;isCurrent:boolean}
export interface RuntimeCopy extends DiscussionScope {
 id:string;sdkInstanceId:string;managedLocator:string;address:ManagedAddress|null;
 writeGeneration:bigint;dataGeneration:bigint;sourceRevision:bigint;
 state:'preparing'|'dirty'|'ready'|'retired'|'blocked'|'cleanup_pending'|'cleared';
 committedRequestId:string|null;eventBoundary:string|null;configurationDigest:string|null;
 cleanupOperationId:string|null;manifestComplete:boolean;
}
/** 07通用调用表的reply producer必须指向这些真实身份；不可按owner推导讨论权限。 */
export interface DiscussionAttempt extends DiscussionScope {requestId:string;attemptId:string;leaseToken:string;dataGeneration:bigint;discussionGeneration:bigint;sourceRevision:bigint}
export type ContextMaterial =
 | {kind:'message';recordId:string;messageId:string;sourceContactId:string;acceptedRevision:bigint}
 | {kind:'entry';entryId:string}
 | {kind:'skill';packageId:string;packageRevisionNo:bigint};
