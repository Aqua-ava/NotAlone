import {StorageFailure,type StorageTransaction,type StorageRow} from '../../storage/sqlite/contracts.ts';
import {getMemoryContentRegistry,readFrozenContent} from './content.ts';
import {type ImageContentReference,type ContentCitationReference,type ContentCitation,type ContentEvidence,type ContentSource} from '../content/evidence.ts';
import type {FrozenMemoryContent} from '../content/registry.ts';
export type ImageCitationReference=ImageContentReference;
export function citationContent(row:StorageRow):{contentKind:string;contentRef:ContentCitationReference|null}{
 const contentKind=typeof row.content_kind==='string'?row.content_kind:'text';
 if(contentKind==='text')return {contentKind,contentRef:null};
 try{return {contentKind,contentRef:JSON.parse(String(row.content_ref_json))};}catch{throw new StorageFailure('memory_source_stale');}
}
/** 引用读取统一在同一事务内定向复验，不把模型的观察描述当原始正文。 */
export function resolveContentCitation(tx:StorageTransaction,ownerId:string,row:StorageRow):{source:ContentSource;citation:ContentCitation;frozen:FrozenMemoryContent;message:StorageRow;contactId:string} {
 const contactId=String(row.source_contact_id),messageId=String(row.message_id);
 const message=tx.get('SELECT * FROM message WHERE owner_id=? AND contact_id=? AND id=?',[ownerId,contactId,messageId]);
 if(!message)throw new StorageFailure('memory_source_stale');
 const citation={...citationContent(row),spanStart:row.span_start==null?null:BigInt(row.span_start as string|number|bigint),spanEnd:row.span_end==null?null:BigInt(row.span_end as string|number|bigint),explanation:typeof row.explanation==='string'?row.explanation:null};
 const registry=getMemoryContentRegistry(),scope={ownerId,contactId,message},source=registry.source(tx,scope,citation),frozen=registry.snapshot(tx,scope);
 if(!frozen)throw new StorageFailure('memory_content_source_stale');
 return {source,citation,frozen,message,contactId};
}
/** 新候选引用只使用真实固定输入及其插件证据表示，保留旧文字来源合同。 */
export function citationFromEvidence(tx:StorageTransaction,ownerId:string,input:StorageRow,evidence:ContentEvidence):ContentCitation {
 const contactId=String(input.source_contact_id),message=tx.get('SELECT * FROM message WHERE owner_id=? AND contact_id=? AND id=?',[ownerId,contactId,String(input.message_id)]);
 if(!message)throw new StorageFailure('memory_source_stale');
 const registry=getMemoryContentRegistry(),scope={ownerId,contactId,message};
 const frozen=readFrozenContent(tx,ownerId,input)??(message.kind==='text'?registry.snapshot(tx,scope):null);
 if(!frozen)throw new StorageFailure('memory_content_source_stale');
 return registry.citation(tx,scope,frozen,evidence);
}
