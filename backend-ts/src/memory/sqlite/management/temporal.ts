import {instantMicros,when} from '../../extraction/protocol.ts';
import type {StorageTransaction} from '../../../storage/sqlite/contracts.ts';

export type MemoryTimeEligibility='eligible'|'out_of_window'|'invalid'|'needs_revalidation';
export type MemoryTimeParent={candidateId:string}|{memoryId:string;versionNo:bigint};
type FactTime={status:Exclude<MemoryTimeEligibility,'needs_revalidation'>;limited:boolean};

/** 空时间保持未知；已知边界按半开区间判断，损坏的事实不能伪装为未知。 */
function factTime(payload:unknown,at:bigint):FactTime {
 const invalid:FactTime={status:'invalid',limited:false};
 try{
  if(typeof payload!=='string')return invalid;
  const fact=JSON.parse(payload)?.fact;
  if(!fact||typeof fact!=='object'||Array.isArray(fact))return invalid;
  const start=fact.valid_at==null?null:instantMicros(when(fact.valid_at)!);
  const end=fact.invalid_at==null?null:instantMicros(when(fact.invalid_at)!);
  if(start!==null&&end!==null&&end<=start)return invalid;
  return {status:start!==null&&at<start||end!==null&&at>=end?'out_of_window':'eligible',limited:start!==null||end!==null};
 }catch{return invalid;}
}

/** 原候选承载时间；改写不补造期限，恢复版本回到被恢复的确切原版。 */
export function memoryTimeEligibility(tx:StorageTransaction,ownerId:string,parent:MemoryTimeParent,now=Date.now()):MemoryTimeEligibility {
 if(!Number.isSafeInteger(now))return 'invalid';
 const at=BigInt(now)*1000n;
 if('candidateId' in parent){
  const row=tx.get(`SELECT e.payload FROM memory_candidate c LEFT JOIN execution_event e ON e.owner_id=c.owner_id AND e.id=c.event_id
   WHERE c.owner_id=? AND c.id=?`,[ownerId,parent.candidateId]);
  return row?factTime(row.payload,at).status:'invalid';
 }
 let versionNo=parent.versionNo,requiresTimeReview=false;
 for(;;){
  const version=tx.get(`SELECT v.decision_id,v.previous_version_no,v.restored_from_version_no,d.action FROM memory_version v
   LEFT JOIN memory_decision d ON d.owner_id=v.owner_id AND d.id=v.decision_id WHERE v.owner_id=? AND v.memory_id=? AND v.version_no=?`,[ownerId,parent.memoryId,versionNo]);
  if(!version||typeof version.action!=='string')return 'invalid';
  if(version.restored_from_version_no!==null){
   if(typeof version.restored_from_version_no!=='bigint'||version.restored_from_version_no>=versionNo)return 'invalid';
   versionNo=version.restored_from_version_no;continue;
  }
  const rows=tx.all(`SELECT e.payload FROM decision_candidate d LEFT JOIN memory_candidate c ON c.owner_id=d.owner_id AND c.id=d.candidate_id
   LEFT JOIN execution_event e ON e.owner_id=c.owner_id AND e.id=c.event_id WHERE d.owner_id=? AND d.decision_id=? AND d.relation_kind='accepted'`,[ownerId,version.decision_id]);
  if(!rows.length&&['accept','edit_accept','auto_accept','auto_update'].includes(version.action))return 'invalid';
  let status:MemoryTimeEligibility='eligible',limited=false;
  for(const row of rows){
   const value=factTime(row.payload,at);if(value.status==='invalid')return 'invalid';
   if(value.status==='out_of_window')status=value.status;limited||=value.limited;
  }
  if(limited)return requiresTimeReview?'needs_revalidation':status;
  if(['correct','change'].includes(version.action))requiresTimeReview=true;
  if(requiresTimeReview&&version.previous_version_no!==null){
   if(typeof version.previous_version_no!=='bigint'||version.previous_version_no>=versionNo)return 'invalid';
   versionNo=version.previous_version_no;continue;
  }
  return status;
 }
}
