import {StorageFailure,type StorageAction,type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import {pendingWork,supersededBindings,supersededCounts,supersededGate,type SupersededCounts,type SupersededGateReason} from './superseded.ts';

const fail=(code:string):never=>{throw new StorageFailure(code);};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const text=(value:unknown):string=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x1f]/.test(value)?value:fail('history_request_invalid');
const contact=(value:unknown):string=>typeof value==='string'&&uuid.test(value)?value:fail('history_request_invalid');
const action=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,input:any)=>unknown):StorageAction=>({name:`history.superseded${name}`,mode,retryBusy:mode==='write',execute});

/** 修复通过（Finalize）时在同一事务登记；只记联系人标识，不含正文或来源键。 */
export function requestSupersededCleanup(tx:StorageTransaction,ownerId:string,contactId:string,at:number):void {
 tx.run('INSERT INTO history_superseded_cleanup VALUES(?,?,?) ON CONFLICT(owner_id,contact_id) DO UPDATE SET requested_at=excluded.requested_at',[ownerId,contactId,at]);
}

export interface SupersededPreview {contactId:string;gate:SupersededGateReason|null;counts:SupersededCounts;work:boolean}
export interface SupersededPending {contacts:string[];operations:{operationId:string;contactId:string}[]}
export function previewSuperseded(tx:StorageTransaction,ownerId:string,contactId:string):SupersededPreview {
 const bindings=supersededBindings(tx,ownerId,contactId),gate=supersededGate(tx,ownerId,contactId,bindings);
 const counts=supersededCounts(tx,ownerId,contactId,bindings);
 return {contactId,gate:gate??null,counts,work:gate===undefined&&pendingWork(counts)};
}

export const historySupersededActions:StorageAction[]=[
 // 只读预览：围栏、进行中的修复／删除等条件，以及可清与保留的对象数。
 action('Preview','read',(tx,i)=>previewSuperseded(tx,text(i.ownerId),contact(i.contactId))),
 // 重启续跑：登记过清理请求的联系人，以及尚未结案的清理操作。
 action('Pending','read',(tx,i):SupersededPending=>{
  const ownerId=text(i.ownerId);
  return {contacts:tx.all('SELECT contact_id FROM history_superseded_cleanup WHERE owner_id=? ORDER BY requested_at,contact_id',[ownerId]).map(r=>String(r.contact_id)),
   operations:tx.all("SELECT operation_id,contact_identity FROM deletion_operation WHERE owner_identity=? AND scope_kind='superseded_history' AND state<>'completed' ORDER BY created_at,operation_id",[ownerId])
    .map(r=>({operationId:String(r.operation_id),contactId:String(r.contact_identity)}))};
 }),
 // 没有剩余可清对象，或联系人已不可用时撤销请求标记；有可清对象但被围栏、进行中的修复／删除挡住时保留，条件解除后续清。
 action('Resolve','write',(tx,i):boolean=>{
  const ownerId=text(i.ownerId),contactId=contact(i.contactId),preview=previewSuperseded(tx,ownerId,contactId);
  const unavailable=preview.gate==='contact_inactive'||!tx.get("SELECT 1 FROM contact WHERE owner_id=? AND id=? AND state<>'deleted'",[ownerId,contactId]);
  if(!unavailable&&pendingWork(preview.counts))return false;
  tx.run('DELETE FROM history_superseded_cleanup WHERE owner_id=? AND contact_id=?',[ownerId,contactId]);return true;
 }),
];
