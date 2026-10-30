/** 实际用户/助手发言，与候选版本分开。 */
export interface SqliteDiscussionEntry {entryId:string;position:string;role:'user'|'assistant';text:string|null;requestId:string;callId:string|null;contentState:'available'|'cleared'}
export type SqliteRuntimeRecovery='none'|'ready'|'blocked';
