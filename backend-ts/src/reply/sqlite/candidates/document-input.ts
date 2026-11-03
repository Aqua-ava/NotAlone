import {StorageFailure,type StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import type {DiscussionAttempt} from '../contracts.ts';
import {requireAttempt,decode,encode} from '../requests.ts';
import type {ReplyKnowledgeItem,ReplyKnowledgeReader} from './contracts.ts';
import {requireReplyInput} from './input.ts';
import {RELATIONSHIP_BUDGET} from './knowledge-budget.ts';
function requireContext(tx:StorageTransaction,i:DiscussionAttempt&{contextId:string},reader:ReplyKnowledgeReader):void{
 requireAttempt(tx,i);requireReplyInput(tx,i,i.contextId,reader);
 if(!tx.get("SELECT 1 FROM reply_context WHERE owner_id=? AND id=? AND request_id=? AND attempt_id=? AND state='active'",[i.ownerId,i.contextId,i.requestId,i.attemptId]))throw new StorageFailure('discussion_context_invalid');
}
export function hasReplyDocumentTool(tx:StorageTransaction,i:DiscussionAttempt&{contextId:string},reader:ReplyKnowledgeReader):boolean{
 requireContext(tx,i,reader);if(!reader.readDocument)return false;
 return tx.all("SELECT identity_json FROM reply_candidate_input WHERE owner_id=? AND context_id=? AND kind='document'",[i.ownerId,i.contextId]).some(row=>decode<ReplyKnowledgeItem>(String(row.identity_json)).projection?.kind==='directory');
}
/** 工具只能使用本轮冻结的材料编号；追加正文和真实来源是同一短事务。 */
export function readReplyDocument(tx:StorageTransaction,i:DiscussionAttempt&{contextId:string;itemNo:number;startBlock:number;blockCount:number},reader:ReplyKnowledgeReader):{itemNo:number;text:string}{
 requireContext(tx,i,reader);
 if(!reader.readDocument)throw new StorageFailure('reply_document_unavailable');
 if(!Number.isSafeInteger(i.itemNo)||i.itemNo<1)throw new StorageFailure('reply_document_range_invalid');
 const row=tx.get("SELECT identity_json FROM reply_candidate_input WHERE owner_id=? AND context_id=? AND item_no=? AND kind='document'",[i.ownerId,i.contextId,i.itemNo]);
 if(!row)throw new StorageFailure('reply_document_range_invalid');
 const directory=decode<ReplyKnowledgeItem>(String(row.identity_json));
 if(directory.projection?.kind!=='directory')throw new StorageFailure('reply_document_range_invalid');
 const loaded=tx.all("SELECT identity_json FROM reply_candidate_input WHERE owner_id=? AND context_id=? AND kind='document'",[i.ownerId,i.contextId]).filter(row=>decode<ReplyKnowledgeItem>(String(row.identity_json)).projection?.kind==='blocks');
 if(loaded.length>=RELATIONSHIP_BUDGET.documentReadCount)throw new StorageFailure('reply_document_budget_exceeded');
 if(loaded.some(row=>{const prior=decode<ReplyKnowledgeItem>(String(row.identity_json));return prior.id===directory.id&&prior.projection?.kind==='blocks'&&prior.projection.startBlock===i.startBlock&&prior.projection.blockCount===i.blockCount;}))throw new StorageFailure('reply_document_range_invalid');
 const item=reader.readDocument(tx,i,directory,{startBlock:i.startBlock,blockCount:i.blockCount});
 reader.requireCurrent(tx,i,item);
 const itemNo=Number(tx.get('SELECT COALESCE(MAX(item_no),0)+1 n FROM reply_candidate_input WHERE owner_id=? AND context_id=?',[i.ownerId,i.contextId])!.n);
 tx.run('INSERT INTO reply_candidate_input VALUES(?,?,?,?,?,?)',[i.ownerId,i.contextId,itemNo,'document',encode(item),item.text]);
 for(const s of item.sources)tx.run('INSERT INTO reply_candidate_input_source VALUES(?,?,?,?,?,?,?)',[i.ownerId,i.contextId,itemNo,s.contactId,s.recordId,s.messageId,s.acceptedRevision]);
 requireReplyInput(tx,i,i.contextId,reader);
 return {itemNo,text:item.text};
}
