import {EMBEDDING_MODEL,EMBEDDING_REVISION} from '../embedding-model.ts';

export const RETRIEVAL_MODEL_FINGERPRINT=`${EMBEDDING_MODEL}@${EMBEDDING_REVISION}:512:cls:l2:f32:wordpiece-head510:v1`;
export const RETRIEVAL_VECTOR_DIMENSIONS=512;
export type RetrievalKind='memory'|'history';
export type RetrievalStrategy='hybrid'|'bm25'|'vector';
export type RetrievalFrozenScope={kind:'memory';anchors:readonly {id:string;versionNo:bigint;textSeal?:string}[]}
 |{kind:'history';displayNo:bigint;dataGeneration:bigint;messageIds?:readonly string[]};
export interface ReplyRetrievalRequest {
 ownerId:string;contactId:string;kind:RetrievalKind;query:string;queryVector?:readonly number[];
 modelFingerprint?:string;scope:RetrievalFrozenScope;excludeIds?:readonly string[];limit:number;
 /** 仅可信领域调用方使用：复用复杂来源／时间资格，最终top-K与RRF只包含合格身份。 */
 qualify?:(hit:{id:string;versionNo?:bigint})=>boolean;
 check?:()=>void;
}
export interface RetrievalHit {id:string;versionNo?:bigint;score:number;strategy:RetrievalStrategy}
export interface RetrievalRankResult {hits:RetrievalHit[];strategy:RetrievalStrategy;indexIncomplete:boolean}
export interface VectorIndexItem {
 docId:string;kind:RetrievalKind;id:string;contactId:string|null;versionNo?:bigint;text:string;
 bodySeal:string;generation:bigint;modelFingerprint:string;holderKeys:string[];coversAllContacts:boolean;
}
export const retrievalHolderKey=(docId:string)=>`retrieval:${docId}`;
