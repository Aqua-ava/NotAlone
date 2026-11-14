import type {DatabaseSync} from 'node:sqlite';
import type {StorageTransaction,StorageRow} from '../../storage/sqlite/contracts.ts';
import {sha256} from '../../platform/sha256.ts';
import {indexText,searchTokenizerFingerprint} from '../search-tokenizer.ts';
import type {RetrievalKind} from './contracts.ts';

/** vec0的DELETE只清有效位；先经正式UPDATE覆写向量槽，避免活chunk保留旧表示。 */
export function removeRetrievalVector(tx:Pick<StorageTransaction,'run'>,docId:bigint|string):void{
 tx.run('UPDATE retrieval_vec SET embedding=? WHERE doc_id=?',[new Uint8Array(512*4),BigInt(docId)]);
 tx.run('DELETE FROM retrieval_vec WHERE doc_id=?',[BigInt(docId)]);
}
export function removeRetrievalDocument(tx:Pick<StorageTransaction,'run'>,docId:bigint|string):void{
 tx.run('DELETE FROM retrieval_fts WHERE rowid=?',[BigInt(docId)]);
 removeRetrievalVector(tx,docId);
 tx.run('DELETE FROM retrieval_document WHERE id=?',[BigInt(docId)]);
}
/** 单一身份定向读取；来源资格仍在召回与本机向量领取时实时复验。 */
export function synchronizeRetrievalText(tx:Pick<StorageTransaction,'run'|'get'>,ownerId:string,kind:RetrievalKind,entityId:string):void{
 const prior=tx.get('SELECT * FROM retrieval_document WHERE owner_id=? AND kind=? AND entity_id=?',[ownerId,kind,entityId]);
 const source=kind==='history'?tx.get("SELECT contact_id,text_body AS body,NULL AS version_no FROM message WHERE owner_id=? AND id=? AND kind='text' AND availability='available'",[ownerId,entityId])
  :tx.get("SELECT m.contact_id,v.body,v.version_no FROM memory m JOIN memory_version v ON v.owner_id=m.owner_id AND v.memory_id=m.id AND v.version_no=m.current_version_no WHERE m.owner_id=? AND m.id=? AND m.state='active' AND v.content_state='present' AND v.provenance_state='eligible'",[ownerId,entityId]);
 if(!source||typeof source.body!=='string'||!source.body.trim()){
  if(prior)removeRetrievalDocument(tx,prior.id as bigint);
 }else{
  const seal=sha256(source.body),tokenizer=searchTokenizerFingerprint();
  if(prior){
   const changed=prior.text_seal!==seal;
   if(changed||prior.tokenizer_fingerprint!==tokenizer){
    tx.run('DELETE FROM retrieval_fts WHERE rowid=?',[prior.id]);
    tx.run('INSERT INTO retrieval_fts(rowid,tokens) VALUES(?,?)',[prior.id,indexText(source.body)]);
   }
   if(changed)removeRetrievalVector(tx,prior.id as bigint);
   tx.run(`UPDATE retrieval_document SET contact_id=?,memory_version_no=?,text_seal=?,tokenizer_fingerprint=?,
    vector_seal=CASE WHEN text_seal=? THEN vector_seal ELSE NULL END,model_fingerprint=CASE WHEN text_seal=? THEN model_fingerprint ELSE NULL END WHERE id=?`,
    [source.contact_id,source.version_no,seal,tokenizer,seal,seal,prior.id]);
  }else{
   tx.run(`INSERT INTO retrieval_document(owner_id,kind,entity_id,contact_id,message_id,memory_id,memory_version_no,text_seal,tokenizer_fingerprint)
    VALUES(?,?,?,?,?,?,?,?,?)`,[ownerId,kind,entityId,source.contact_id,kind==='history'?entityId:null,kind==='memory'?entityId:null,source.version_no,seal,tokenizer]);
   const row=tx.get('SELECT id FROM retrieval_document WHERE owner_id=? AND kind=? AND entity_id=?',[ownerId,kind,entityId])!;
   tx.run('INSERT INTO retrieval_fts(rowid,tokens) VALUES(?,?)',[row.id,indexText(source.body)]);
  }
 }
 tx.run('DELETE FROM retrieval_text_pending WHERE owner_id=? AND kind=? AND entity_id=?',[ownerId,kind,entityId]);
}

const dirty=(row:string,kind:RetrievalKind,id:string)=>`INSERT OR IGNORE INTO notalone_retrieval_dirty VALUES(${row}.owner_id,'${kind}',${row}.${id});`;
const trigger=(name:string,event:string,table:string,body:string)=>`CREATE TEMP TRIGGER ${name} AFTER ${event} ON main.${table} BEGIN ${body} END;`;
const triggers=[
 ...['INSERT','UPDATE','DELETE'].map(event=>trigger(`retrieval_message_${event.toLowerCase()}`,event,'message',dirty(event==='DELETE'?'OLD':'NEW','history','id'))),
 ...['INSERT','UPDATE','DELETE'].map(event=>trigger(`retrieval_memory_${event.toLowerCase()}`,event,'memory',dirty(event==='DELETE'?'OLD':'NEW','memory','id'))),
 ...['INSERT','UPDATE','DELETE'].map(event=>trigger(`retrieval_memory_version_${event.toLowerCase()}`,event,'memory_version',dirty(event==='DELETE'?'OLD':'NEW','memory','memory_id'))),
].join('\n');

/** 沿用管理修订的TEMP聚合：不在SQL触发器内调用JS或不安全的vec0虚表。 */
export function installRetrievalIndexMaintenance(db:DatabaseSync):{begin():void;flush():void}{
 // 字典首次装入在事务外完成；flush中只有确定的CPU分词与SQLite写入。
 indexText('');
 db.exec(`CREATE TEMP TABLE notalone_retrieval_dirty(owner_id TEXT NOT NULL,kind TEXT NOT NULL,entity_id TEXT NOT NULL,PRIMARY KEY(owner_id,kind,entity_id)) STRICT,WITHOUT ROWID;${triggers}`);
 const all=(sql:string,values:any[]=[]):StorageRow[]=>{const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all(...values);};
 const tx={all,get:(sql:string,values?:any[])=>all(sql,values)[0],run:(sql:string,values:any[]=[])=>{db.prepare(sql).run(...values);}};
 let failed:unknown,broken=false;
 return {begin(){failed=undefined;broken=false;},flush(){
  if(broken)throw failed;
  try{
   const rows=all('SELECT owner_id,kind,entity_id FROM temp.notalone_retrieval_dirty');
   if(!rows.length)return;
   for(const row of rows)synchronizeRetrievalText(tx,String(row.owner_id),row.kind as RetrievalKind,String(row.entity_id));
   db.exec('DELETE FROM temp.notalone_retrieval_dirty');
  }catch(error){failed=error;broken=true;throw error;}
 }};
}
