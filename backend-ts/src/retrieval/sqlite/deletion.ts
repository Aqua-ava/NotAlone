import {StorageFailure,type StorageTransaction,type StorageRow} from '../../storage/sqlite/contracts.ts';
import type {DeletionDomain,DeletionOperation,RowDeletionTarget,DomainChecks} from '../../storage/sqlite/deletion/contracts.ts';
import {memoryDeletionImpact} from '../../memory/sqlite/deletion-impact.ts';
import {sha256StableJson,sortedEntries} from '../../platform/stable-json.ts';
import {removeRetrievalDocument} from './text-index.ts';
import {retrievalHolderKey} from './contracts.ts';

const domain='retrieval_index';
const address=(kind:string,key:Record<string,string>)=>sha256StableJson([kind,sortedEntries(key)]);
function target(rowKind:string,key:Record<string,string>,holderKeys:string[]=[]):RowDeletionTarget{
 return {kind:'row',domain,rowKind,key,identity:address(rowKind,key),holderKeys};
}
function rows(tx:StorageTransaction,op:DeletionOperation):{documents:StorageRow[];pending:StorageRow[]}{
 if(op.scope.kind==='discussion')return {documents:[],pending:[]};
 if(op.scope.kind==='account')return {documents:tx.all('SELECT * FROM retrieval_document WHERE owner_id=?',[op.ownerId]),pending:tx.all('SELECT * FROM retrieval_text_pending WHERE owner_id=?',[op.ownerId])};
 const impact=memoryDeletionImpact(tx,op),memories=JSON.stringify(impact.memories),versions=JSON.stringify(impact.versions.map(v=>[v.memoryId,String(v.versionNo)]));
 // history域先注册真实消息删除目标；仍有替代来源的规范消息不删检索表示。
 const messages=JSON.stringify(tx.all("SELECT row_key_snapshot FROM deletion_target WHERE operation_id=? AND domain='history' AND row_kind='message'",[op.operationId])
  .flatMap(row=>{try{const key=JSON.parse(String(row.row_key_snapshot));return key.owner_id===op.ownerId&&typeof key.id==='string'?[key.id]:[];}catch{return [];}}));
 const contact=op.scope.kind==='contact'?op.scope.contactId:null;
 const unique=(items:StorageRow[],key:(row:StorageRow)=>string)=>[...new Map(items.map(row=>[key(row),row])).values()];
 const documents=unique([
  ...(contact===null?[]:tx.all('SELECT * FROM retrieval_document WHERE owner_id=? AND contact_id=?',[op.ownerId,contact])),
  ...tx.all("SELECT * FROM retrieval_document WHERE owner_id=? AND kind='history' AND entity_id IN(SELECT value FROM json_each(?))",[op.ownerId,messages]),
  ...tx.all("SELECT * FROM retrieval_document WHERE owner_id=? AND kind='memory' AND entity_id IN(SELECT value FROM json_each(?))",[op.ownerId,memories]),
  ...tx.all("SELECT d.* FROM json_each(?) affected JOIN retrieval_document d ON d.owner_id=? AND d.kind='memory' AND d.entity_id=json_extract(affected.value,'$[0]') AND CAST(d.memory_version_no AS TEXT)=json_extract(affected.value,'$[1]')",[versions,op.ownerId]),
 ],row=>String(row.id));
 const docKeys=JSON.stringify(documents.map(row=>[row.kind,row.entity_id]));
 const pending=unique([
  ...(contact===null?[]:tx.all('SELECT * FROM retrieval_text_pending WHERE owner_id=? AND contact_id=?',[op.ownerId,contact])),
  ...tx.all("SELECT * FROM retrieval_text_pending WHERE owner_id=? AND kind='history' AND entity_id IN(SELECT value FROM json_each(?))",[op.ownerId,messages]),
  ...tx.all("SELECT * FROM retrieval_text_pending WHERE owner_id=? AND kind='memory' AND entity_id IN(SELECT value FROM json_each(?))",[op.ownerId,memories]),
  ...tx.all("SELECT p.* FROM json_each(?) affected JOIN retrieval_text_pending p ON p.owner_id=? AND p.kind=json_extract(affected.value,'$[0]') AND p.entity_id=json_extract(affected.value,'$[1]')",[docKeys,op.ownerId]),
  ...tx.all("SELECT p.* FROM json_each(?) affected JOIN memory m ON m.owner_id=? AND m.id=json_extract(affected.value,'$[0]') AND CAST(m.current_version_no AS TEXT)=json_extract(affected.value,'$[1]') JOIN retrieval_text_pending p ON p.owner_id=m.owner_id AND p.kind='memory' AND p.entity_id=m.id",[versions,op.ownerId]),
 ],row=>JSON.stringify([row.kind,row.entity_id]));
 return {documents,pending};
}
function checks(clean:boolean):DomainChecks{
 const pass={result:'passed' as const,proof:'retrieval_copies_absent'},na={result:'not_applicable' as const,proof:'retrieval_no_trace_or_replay'};
 return {database_rows:clean?pass:{result:'blocked',proof:'retrieval_copies_remain'},derived_eligibility:clean?pass:{result:'blocked',proof:'retrieval_copies_remain'},trace_payloads:na,request_replay:na,scope_suppression:na};
}
export const retrievalIndexDeletionDomain:DeletionDomain={
 id:domain,rowKinds:{document:{keys:['owner_id','id'],ownerKey:'owner_id'},text_pending:{keys:['owner_id','kind','entity_id'],ownerKey:'owner_id'}},
 fence(tx,op){tx.run('DELETE FROM retrieval_vector_cursor WHERE owner_id=?',[op.ownerId]);return [];},
 collect(tx,op){const found=rows(tx,op);return [...found.documents.map(row=>target('document',{owner_id:op.ownerId,id:String(row.id)},[retrievalHolderKey(String(row.id))])),
  ...found.pending.map(row=>target('text_pending',{owner_id:op.ownerId,kind:String(row.kind),entity_id:String(row.entity_id)}))];},
 clearRow(tx,op,t){
  if(t.domain!==domain||t.key.owner_id!==op.ownerId||t.identity!==address(t.rowKind,t.key))throw new StorageFailure('deletion_target_invalid');
  if(t.rowKind==='document')removeRetrievalDocument(tx,t.key.id);
  else if(t.rowKind==='text_pending')tx.run('DELETE FROM retrieval_text_pending WHERE owner_id=? AND kind=? AND entity_id=?',[op.ownerId,t.key.kind,t.key.entity_id]);
  else throw new StorageFailure('deletion_target_invalid');
 },
 authorizeFile(){throw new StorageFailure('deletion_target_invalid');},fileCleared(){throw new StorageFailure('deletion_target_invalid');},
 verify(tx,op){
  const found=rows(tx,op);
  const orphan=tx.get('SELECT 1 FROM retrieval_fts f WHERE NOT EXISTS(SELECT 1 FROM retrieval_document d WHERE d.id=f.rowid) LIMIT 1')
   ||tx.get('SELECT 1 FROM retrieval_vec v WHERE NOT EXISTS(SELECT 1 FROM retrieval_document d WHERE d.id=v.doc_id) LIMIT 1');
  return checks(!found.documents.length&&!found.pending.length&&!orphan);
 },
};
