/** 与已注册DDL一致；类型本身不授予范围、租约或来源资格。 */
export type ModelOperationParent=
 | {kind:'memory';ownerId:string;stepId:string;purpose:'extraction'|'verification'}
 | {kind:'discussion';ownerId:string;requestId:string;purpose:'discussion'};
export type ExecutionProducer=
 | {kind:'memory';ownerId:string;stepAttemptId:string}
 | {kind:'discussion';ownerId:string;replyAttemptId:string;replyContextId:string};
export type ModelCallState='prepared'|'sending'|'succeeded'|'failed'|'unknown';
export type ModelOperationState='prepared'|'in_flight'|'unknown'|'resolved'|'applied'|'failed'|'sealed';
export type ActualExecutionInput=
 | {kind:'memory';ownerId:string;eventId:string;stepId:string;inputNo:bigint}
 | {kind:'discussion';ownerId:string;eventId:string;contextId:string;itemNo:bigint};
export interface ActualEventSource {ownerId:string;eventId:string;contactId:string;recordId:string}
export interface VerifiedExtractionOutputReference {ownerId:string;eventId:string}
