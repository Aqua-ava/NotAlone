import type {SqliteReplyCandidatesBridge} from './sqlite-reply-candidates';
/** 与后端discussion受理正文的UTF-16长度上限一致。 */
export const SQLITE_DISCUSSION_MAX_TEXT_LENGTH=100_000;
export interface SqliteDiscussionSubmit {contactId:string;scopeRevision:number;sessionId:string;requestKey:string;text:string}
export interface SqliteDiscussionReceipt {sessionId:string;segmented:boolean;replayed:boolean;requestKey:string}
export interface SqliteDiscussionInvalidation {revision:number;contactId:string|null;scopeRevision:number}
/** 只提供当前联系人下的一次明确讨论，不暴露认证、owner或通用请求能力。 */
export interface SqliteDiscussionBridge {candidates?:SqliteReplyCandidatesBridge;submit(request:SqliteDiscussionSubmit):Promise<SqliteDiscussionReceipt>;onInvalidated(listener:(event:SqliteDiscussionInvalidation)=>void):()=>void}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
export function readSqliteDiscussionSubmit(value:unknown):SqliteDiscussionSubmit {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('本次讨论操作无效。');
 const r=value as Record<string,unknown>,keys=['contactId','scopeRevision','sessionId','requestKey','text'];
 if(Object.keys(r).length!==keys.length||keys.some(k=>!Object.hasOwn(r,k))||!uuid(r.contactId)||!uuid(r.sessionId)||!uuid(r.requestKey)
  ||!Number.isSafeInteger(r.scopeRevision)||(r.scopeRevision as number)<0||typeof r.text!=='string'||!r.text.trim()||r.text.length>SQLITE_DISCUSSION_MAX_TEXT_LENGTH)throw new Error('本次讨论操作无效。');
 return {contactId:r.contactId.toLowerCase(),scopeRevision:r.scopeRevision as number,sessionId:r.sessionId.toLowerCase(),requestKey:r.requestKey.toLowerCase(),text:r.text};
}
