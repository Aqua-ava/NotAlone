import {ModelPermitArbiter,type ModelPermit} from './model-permits.ts';
import type {ModelLedgerReceipt} from './model-ledger-contract.ts';

/** 原任务领取凭证；类型不授予权限，预约仍核对持久任务租约。 */
export interface ModelTaskClaim {
 task_id:string;step_id:string;step_name:string;worker_id:string;lease_generation:number;
}
export interface ModelPermitAccounting {
 reserve(receipt:ModelLedgerReceipt,claim?:ModelTaskClaim):Promise<void>;
 recordReserved(receipt:ModelLedgerReceipt):Promise<void>;
 unconfirmedRequests?(scope:{owner_id:string;contact_id:string|null}):Promise<string[]>;
}
export interface ModelPermitLease extends ModelPermit {
 reserve(receipt:ModelLedgerReceipt,claim:ModelTaskClaim):Promise<void>;
}
/** 同一宿主的业务端口；账本权威仍在 SQLite，不借助网络或第二份持久状态。 */
export interface ModelPermitPort {
 acquire(signal:AbortSignal,attemptId:string):Promise<ModelPermitLease>;
 recordReserved(receipt:ModelLedgerReceipt):Promise<void>;
 unconfirmedRequests(scope:{owner_id:string;contact_id:string|null}):Promise<string[]>;
}
export function createModelPermitPort(arbiter:ModelPermitArbiter,accounting?:ModelPermitAccounting):ModelPermitPort {
 const required=()=>{if(!accounting)throw new Error('model_permit_accounting_unavailable');return accounting;};
 return {
  async acquire(signal,attemptId){
   const permit=await arbiter.acquire('background',signal);let closed=false;
   return {
    id:permit.id,
    async reserve(receipt,claim){
     if(closed||receipt.permit_id!==permit.id||receipt.attempt_id!==attemptId)throw new Error('model_permit_accounting_invalid');
     await required().reserve(receipt,claim);
    },
    settle(){if(closed)return;closed=true;permit.settle();},
    orphan(){if(!closed)permit.orphan();},
   };
  },
  async recordReserved(receipt){await required().recordReserved(receipt);},
  async unconfirmedRequests(scope){
   const ledger=required();if(!ledger.unconfirmedRequests)throw new Error('model_permit_accounting_unavailable');
   return ledger.unconfirmedRequests({owner_id:scope.owner_id,contact_id:scope.contact_id});
  },
 };
}
