import {StorageFailure,type StorageAction,type StorageRow,type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import {sha256} from '../../platform/sha256.ts';
import {assertReplyLocalSource} from '../../history/sqlite/reply-local-source.ts';
import {savedSourceScopeCTE,currentSourcePredicate} from '../../history/sqlite/current-scope.ts';
import {requireVersion} from '../../memory/sqlite/management/qualification.ts';
import {sourceVerificationState} from '../../memory/sqlite/management/evidence.ts';
import {memoryTimeEligibility} from '../../memory/sqlite/management/temporal.ts';
import {RETRIEVAL_MODEL_FINGERPRINT,RETRIEVAL_VECTOR_DIMENSIONS,retrievalHolderKey,type RetrievalKind,type VectorIndexItem} from './contracts.ts';
import {synchronizeRetrievalText,removeRetrievalVector} from './text-index.ts';
import {searchTokenizerFingerprint} from '../search-tokenizer.ts';

const fail=():never=>{throw new StorageFailure('retrieval_request_invalid');};
const id=(v:unknown):string=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\x00-\x1f]/.test(v)?v:fail();
const fingerprint=(v:unknown):string=>typeof v==='string'&&v.length>0&&v.length<=512?v:fail();
const limit=(v:unknown,fallback:number,max:number):number=>v===undefined?fallback:typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=max?v:fail();
function request(input:unknown):{ownerId:string;contactId?:string;kind?:RetrievalKind;modelFingerprint?:string;limit?:unknown}{
 if(!input||typeof input!=='object')return fail();
 const v=input as Record<string,unknown>;
 return {ownerId:id(v.ownerId),...(v.contactId===undefined?{}:{contactId:id(v.contactId)}),...(v.kind===undefined?{}:{kind:v.kind==='memory'||v.kind==='history'?v.kind:fail()}),...(v.modelFingerprint===undefined?{}:{modelFingerprint:fingerprint(v.modelFingerprint)}),limit:v.limit};
}
function admitted(tx:StorageTransaction,ownerId:string,contactId?:string):boolean{
 return !!tx.get("SELECT 1 FROM owner WHERE owner_id=? AND state='active'",[ownerId])
  &&(!contactId||!!tx.get("SELECT 1 FROM contact WHERE owner_id=? AND id=? AND state='active'",[ownerId,contactId]))
  &&!tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed'",[ownerId]);
}
const scopeWhere=(contactId?:string,kind?:RetrievalKind)=>(contactId===undefined?'':' AND (contact_id=? OR contact_id IS NULL)')+(kind===undefined?'':' AND kind=?');
const values=(ownerId:string,contactId?:string,kind?:RetrievalKind)=>[ownerId,...(contactId===undefined?[]:[contactId]),...(kind===undefined?[]:[kind])];
const vectorPredicate='(vector_seal IS NOT text_seal OR model_fingerprint IS NOT ?)';
function pending(tx:StorageTransaction,ownerId:string,contactId?:string,model=RETRIEVAL_MODEL_FINGERPRINT,kind?:RetrievalKind){
 const v=values(ownerId,contactId,kind),where=scopeWhere(contactId,kind);
 const queued=Number(tx.get(`SELECT COUNT(*) n FROM retrieval_text_pending WHERE owner_id=?${where}`,v)!.n);
 const stale=Number(tx.get(`SELECT COUNT(*) n FROM retrieval_document d WHERE owner_id=?${where} AND tokenizer_fingerprint<>?
  AND NOT EXISTS(SELECT 1 FROM retrieval_text_pending p WHERE p.owner_id=d.owner_id AND p.kind=d.kind AND p.entity_id=d.entity_id)`,[...v,searchTokenizerFingerprint()])!.n);
 return {textPending:queued+stale,
  vectorPending:Number(tx.get(`SELECT COUNT(*) n FROM retrieval_document WHERE owner_id=?${where} AND ${vectorPredicate}`,[...v,model])!.n)};
}

/** 所有历史资格查询固定走消息反查索引，不为每条正文重扫联系人全部capture记录。 */
export function legalHistoryRecord(tx:StorageTransaction,ownerId:string,contactId:string,messageId:string,dataGeneration?:bigint):StorageRow|undefined{
 return tx.get(`WITH ${savedSourceScopeCTE} SELECT r.id record_id FROM capture_record r INDEXED BY capture_record_message
  JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
  JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
  JOIN message m ON m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id
  WHERE r.owner_id=? AND r.contact_id=? AND r.message_id=? AND r.state='normalized' AND r.availability='available'
   AND m.availability='available' AND m.binding_id=g.binding_id ${dataGeneration===undefined?'':'AND g.accepted_data_generation<=?'}
   AND EXISTS(SELECT 1 FROM source_proof p WHERE p.owner_id=m.owner_id AND p.contact_id=m.contact_id AND p.state='ok')
   AND NOT EXISTS(SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)
   AND ${currentSourcePredicate()} ORDER BY r.id LIMIT 1`,[ownerId,contactId,contactId,ownerId,contactId,messageId,...(dataGeneration===undefined?[]:[dataGeneration])]);
}

/** 领取与提交均定向核验来源；临时正文只供本机embedding，不写任务或日志。 */
function vectorItem(tx:StorageTransaction,row:StorageRow,modelFingerprint:string):VectorIndexItem|null{
 const ownerId=String(row.owner_id),contactId=row.contact_id as string|null,entityId=String(row.entity_id);
 if(!admitted(tx,ownerId,contactId??undefined))return null;
 let text:string;
 if(row.kind==='history'){
  if(contactId===null||!legalHistoryRecord(tx,ownerId,contactId,entityId))return null;
  const message=tx.get("SELECT text_body FROM message WHERE owner_id=? AND contact_id=? AND id=? AND kind='text' AND availability='available'",[ownerId,contactId,entityId]);
  if(typeof message?.text_body!=='string')return null;text=message.text_body;
 }else{
  const m=tx.get("SELECT * FROM memory WHERE owner_id=? AND id=? AND state='active' AND current_version_no=?",[ownerId,entityId,row.memory_version_no]);
  const v=tx.get("SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?",[ownerId,entityId,row.memory_version_no]);
  if(!m||!v||m.contact_id!==contactId)return null;
  try{
   if(memoryTimeEligibility(tx,ownerId,{memoryId:entityId,versionNo:row.memory_version_no as bigint})!=='eligible')return null;
   if(v.adoption_mode==='auto'&&sourceVerificationState(tx,ownerId,{memoryId:entityId,versionNo:row.memory_version_no as bigint},assertReplyLocalSource)!=='verified')return null;
   requireVersion(tx,ownerId,m,v,assertReplyLocalSource);
  }catch{return null;}
  text=String(v.body);
 }
 if(sha256(text)!==row.text_seal)return null;
 const generation=contactId===null?tx.get('SELECT read_epoch generation FROM owner WHERE owner_id=?',[ownerId])?.generation
  :tx.get('SELECT data_generation generation FROM contact WHERE owner_id=? AND id=?',[ownerId,contactId])?.generation;
 if(typeof generation!=='bigint')return null;
 return {docId:String(row.id),kind:row.kind as RetrievalKind,id:entityId,contactId,
  ...(row.kind==='memory'?{versionNo:row.memory_version_no as bigint}:{}),text,bodySeal:String(row.text_seal),generation,modelFingerprint,
  holderKeys:[retrievalHolderKey(String(row.id))],coversAllContacts:contactId===null};
}

export const retrievalIndexActions:StorageAction[]=[
 {name:'retrieval.pending',mode:'read',retryBusy:false,execute(tx,input){
  const i=request(input);return admitted(tx,i.ownerId,i.contactId)?pending(tx,i.ownerId,i.contactId,i.modelFingerprint,i.kind):{textPending:0,vectorPending:0};
 }},
 {name:'retrieval.syncTextBatch',mode:'write',retryBusy:true,execute(tx,input){
  const i=request(input),n=limit(i.limit,64,128);if(!admitted(tx,i.ownerId,i.contactId))return {processed:0,remaining:0};
  const scopeValues=values(i.ownerId,i.contactId,i.kind),where=scopeWhere(i.contactId,i.kind);
  const rows=tx.all(`SELECT owner_id,kind,entity_id FROM retrieval_text_pending WHERE owner_id=?${where}
   UNION SELECT owner_id,kind,entity_id FROM retrieval_document WHERE owner_id=?${where} AND tokenizer_fingerprint<>?
   ORDER BY kind,entity_id LIMIT ?`,[...scopeValues,...scopeValues,searchTokenizerFingerprint(),n]);
  for(const row of rows)synchronizeRetrievalText(tx,i.ownerId,row.kind as RetrievalKind,String(row.entity_id));
  return {processed:rows.length,remaining:pending(tx,i.ownerId,i.contactId,i.modelFingerprint,i.kind).textPending};
 }},
 {name:'retrieval.claimVectorBatch',mode:'write',retryBusy:true,execute(tx,input){
  const i=request(input),model=fingerprint(i.modelFingerprint),n=limit(i.limit,8,16);if(!admitted(tx,i.ownerId,i.contactId))return {items:[],remaining:0,scanMore:false};
  // 默认全层保留既有游标；层内优先扫描独立编码，不推进或覆盖全局历史进度。
  const key=i.kind===undefined?i.contactId??'':JSON.stringify([i.contactId??null,i.kind]);
  const cursor=tx.get('SELECT last_doc_id FROM retrieval_vector_cursor WHERE owner_id=? AND contact_key=? AND model_fingerprint=?',[i.ownerId,key,model])?.last_doc_id??0n;
  const scopeValues=values(i.ownerId,i.contactId,i.kind),where=scopeWhere(i.contactId,i.kind);
  let rows=tx.all(`SELECT * FROM retrieval_document WHERE owner_id=?${where} AND ${vectorPredicate} AND id>? ORDER BY id LIMIT ?`,[...scopeValues,model,cursor,128]);
  const wrapped=!rows.length&&cursor!==0n;
  if(wrapped)rows=tx.all(`SELECT * FROM retrieval_document WHERE owner_id=?${where} AND ${vectorPredicate} ORDER BY id LIMIT 128`,[...scopeValues,model]);
  const items:VectorIndexItem[]=[];
  let last=0n;
  for(const row of rows){last=row.id as bigint;const item=vectorItem(tx,row,model);if(item)items.push(item);if(items.length>=n)break;}
  tx.run('INSERT INTO retrieval_vector_cursor VALUES(?,?,?,?) ON CONFLICT(owner_id,contact_key,model_fingerprint) DO UPDATE SET last_doc_id=excluded.last_doc_id',[i.ownerId,key,model,last]);
  const scanMore=!wrapped&&last>0n&&!!tx.get(`SELECT 1 FROM retrieval_document WHERE owner_id=?${where} AND ${vectorPredicate} AND id>? LIMIT 1`,[...scopeValues,model,last]);
  return {items,remaining:Math.max(0,pending(tx,i.ownerId,i.contactId,model,i.kind).vectorPending-items.length),scanMore};
 }},
 {name:'retrieval.commitVectorBatch',mode:'write',retryBusy:true,execute(tx,input){
  const i=request(input),raw=(input as {items?:unknown}).items;if(!Array.isArray(raw)||raw.length>16)return fail();
  let committed=0,rejected=0;
  for(const value of raw){
   if(!value||typeof value!=='object')return fail();const item=value as Record<string,unknown>,model=fingerprint(item.modelFingerprint);
   if(typeof item.docId!=='string'||!/^\d+$/.test(item.docId)||typeof item.bodySeal!=='string'||typeof item.generation!=='bigint'
    ||!Array.isArray(item.vector)||item.vector.length!==RETRIEVAL_VECTOR_DIMENSIONS||item.vector.some(v=>typeof v!=='number'||!Number.isFinite(v))
    ||!item.vector.some(v=>v!==0))return fail();
   const row=tx.get('SELECT * FROM retrieval_document WHERE owner_id=? AND id=?',[i.ownerId,BigInt(item.docId)]);
   const current=row?vectorItem(tx,row,model):null;
   if(!current||current.bodySeal!==item.bodySeal||current.generation!==item.generation){rejected++;continue;}
   const packed=new Float32Array(item.vector as number[]);
   if(!packed.every(Number.isFinite)||!packed.some(v=>v!==0))return fail();
   removeRetrievalVector(tx,item.docId);
   tx.run('INSERT INTO retrieval_vec(doc_id,embedding) VALUES(?,?)',[BigInt(item.docId),new Uint8Array(packed.buffer)]);
   tx.run('UPDATE retrieval_document SET vector_seal=?,model_fingerprint=? WHERE owner_id=? AND id=?',[item.bodySeal,model,i.ownerId,BigInt(item.docId)]);committed++;
  }
  return {committed,rejected};
 }},
];
