import type {StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {available,id,scope,requireVersion,fail} from './qualification.ts';
import type {SourceEligibility} from '../../../history/sqlite/source.ts';
import {qualificationSources} from './dependencies.ts';

// 目录时间只依赖仍保存的准确来源；临时守卫失效不能永久清空排序。
// 正文展示继续在managementRead中独立复验实时资格，这里不授予读取权限。
const storedTimelineSource:SourceEligibility=(tx,ref)=>{
 if(!tx.get(`SELECT 1 FROM capture_record r JOIN message m
  ON m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id
  WHERE r.owner_id=? AND r.contact_id=? AND r.id=? AND m.id=?
   AND r.state='normalized' AND r.availability='available' AND m.availability='available'`,
  [ref.owner_id,ref.contact_id,ref.record_id,ref.message_id]))fail('memory_source_stale');
};

export const timelinePreparationBatchSize=32;
/** 每批让出数据库队列；只重建无正文派生时间，不触发模型、不写业务决定。 */
export function prepareManagementTimeline(tx:StorageTransaction,input:unknown):{ready:boolean;prepared:number} {
 const q=input as any,ownerId=id(q?.ownerId),s=scope(q?.scope);available(tx,ownerId,s);
 if(tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed' AND scope_kind<>'superseded_history'",[ownerId]))return {ready:true,prepared:0};
 const rows=tx.all('SELECT * FROM memory WHERE owner_id=? AND scope_kind=? AND contact_id IS ? AND management_timeline_dirty=1 ORDER BY id LIMIT ?',[ownerId,s.scopeKind,s.contactId,timelinePreparationBatchSize]);
 for(const memory of rows){
  let at:bigint|null=null;
  if(memory.state==='active'&&memory.current_version_no!==null){
   const version=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,memory.id,memory.current_version_no]);
   try{
    if(version){
     // requireVersion返回与展示共用projectCitations后的真实直接来源，旧整窗引文也不例外。
     const sources=requireVersion(tx,ownerId,memory,version,storedTimelineSource);qualificationSources(tx,ownerId,{memoryId:String(memory.id),versionNo:version.version_no as bigint},storedTimelineSource);
     for(const source of sources)if(typeof source.sent_at==='bigint'&&source.sent_at>=0n&&source.sent_at<=253402300799999n&&(at===null||source.sent_at>at))at=source.sent_at;
    }
   }catch{at=null;}
  }
  tx.run('UPDATE memory SET management_source_time=?,management_timeline_dirty=0 WHERE owner_id=? AND id=?',[at,ownerId,memory.id]);
 }
 const pending=tx.get('SELECT 1 FROM memory WHERE owner_id=? AND scope_kind=? AND contact_id IS ? AND management_timeline_dirty=1 LIMIT 1',[ownerId,s.scopeKind,s.contactId]);
 return {ready:!pending,prepared:rows.length};
}
