import {StorageFailure,type StorageRow,type StorageTransaction} from '../../storage/sqlite/contracts.ts';

/** 只属于当前Worker的读取守卫；此状态不写入SQLite，也不跨进程恢复。 */
export interface SourceGuard extends StorageRow {
 owner_id:string;contact_id:string;binding_id:string;conversation_id:string;source_generation:string;
 guard_id:string;runtime_id:string;state:'active'|'lost';
}
const namespace='history-source-guard' as const;
const key=(ownerId:string,contactId:string)=>JSON.stringify([ownerId,contactId]);
export const getSourceGuard=(tx:StorageTransaction,ownerId:string,contactId:string):SourceGuard|undefined=>
 tx.runtimeGet<SourceGuard>(namespace,key(ownerId,contactId));
export function putSourceGuard(tx:StorageTransaction,guard:SourceGuard):void {
 if(!['active','lost'].includes(guard.state)||['owner_id','contact_id','binding_id','conversation_id','source_generation','guard_id','runtime_id'].some(field=>typeof guard[field]!=='string'||!guard[field]))throw new StorageFailure('history_guard_invalid');
 tx.runtimeSet(namespace,key(guard.owner_id,guard.contact_id),guard);
}
export const removeSourceGuard=(tx:StorageTransaction,ownerId:string,contactId:string):void=>
 tx.runtimeDelete(namespace,key(ownerId,contactId));
export function loseSourceGuard(tx:StorageTransaction,ownerId:string,contactId:string,expected:{guardId?:string;bindingId?:string}={}):boolean {
 const guard=getSourceGuard(tx,ownerId,contactId);
 if(!guard||expected.guardId!==undefined&&guard.guard_id!==expected.guardId||expected.bindingId!==undefined&&guard.binding_id!==expected.bindingId)return false;
 putSourceGuard(tx,{...guard,state:'lost'});return true;
}
