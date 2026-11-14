import {StorageFailure,type StorageRow,type StorageTransaction} from '../../../storage/sqlite/contracts.ts';

/** 恢复版本沿确切原版读取结构资料；不使用当前候选补造过去的时间或条件。 */
export function versionFact(tx:StorageTransaction,ownerId:string,version:StorageRow):Record<string,any>|null {
 let current=version;
 while(current.restored_from_version_no!==null){
  const restored=current.restored_from_version_no;
  if(typeof restored!=='bigint'||typeof current.version_no!=='bigint'||restored>=current.version_no)
   throw new StorageFailure('memory_source_stale');
  const prior=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,current.memory_id,restored]);
  if(!prior)throw new StorageFailure('memory_source_stale');
  current=prior;
 }
 const event=tx.get(`SELECT e.payload FROM decision_candidate dc JOIN memory_candidate c ON c.owner_id=dc.owner_id AND c.id=dc.candidate_id
  JOIN execution_event e ON e.owner_id=c.owner_id AND e.id=c.event_id WHERE dc.owner_id=? AND dc.decision_id=? ORDER BY c.id LIMIT 1`,[ownerId,current.decision_id]);
 return event?JSON.parse(String(event.payload)).fact:null;
}
