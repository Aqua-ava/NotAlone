import type {StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {available,id,scope,requireVersion} from './qualification.ts';
import {qualificationSources} from './dependencies.ts';

export const timelinePreparationBatchSize=32;
/** 每批让出数据库队列；只重建无正文派生时间，不触发模型、不写业务决定。 */
export function prepareManagementTimeline(tx:StorageTransaction,input:unknown):{ready:boolean;prepared:number} {
 const q=input as any,ownerId=id(q?.ownerId),s=scope(q?.scope);available(tx,ownerId,s);
 if(tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed'",[ownerId]))return {ready:true,prepared:0};
 const rows=tx.all('SELECT * FROM memory WHERE owner_id=? AND scope_kind=? AND contact_id IS ? AND management_timeline_dirty=1 ORDER BY id LIMIT ?',[ownerId,s.scopeKind,s.contactId,timelinePreparationBatchSize]);
 for(const memory of rows){
  let at:bigint|null=null;
  if(memory.state==='active'&&memory.current_version_no!==null){
   const version=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,memory.id,memory.current_version_no]);
   try{
    if(version){
     // requireVersion返回与展示共用projectCitations后的真实直接来源，旧整窗引文也不例外。
     const sources=requireVersion(tx,ownerId,memory,version);qualificationSources(tx,ownerId,{memoryId:String(memory.id),versionNo:version.version_no as bigint});
     for(const source of sources)if(typeof source.sent_at==='bigint'&&source.sent_at>=0n&&source.sent_at<=253402300799999n&&(at===null||source.sent_at>at))at=source.sent_at;
    }
   }catch{at=null;}
  }
  tx.run('UPDATE memory SET management_source_time=?,management_timeline_dirty=0 WHERE owner_id=? AND id=?',[at,ownerId,memory.id]);
 }
 const pending=tx.get('SELECT 1 FROM memory WHERE owner_id=? AND scope_kind=? AND contact_id IS ? AND management_timeline_dirty=1 LIMIT 1',[ownerId,s.scopeKind,s.contactId]);
 return {ready:!pending,prepared:rows.length};
}
