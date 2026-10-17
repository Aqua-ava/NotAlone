export type UpgradeKind = 'contact' | 'owner';
export interface UpgradeSelection { kind: UpgradeKind; contactId: string | null; scopeRevision: number }
export interface UpgradeBudget { message_limit: number; batch_size: number; model_calls: number }
export type UpgradeConfigurationValue = null | boolean | number | string | UpgradeConfigurationValue[] | { [key: string]: UpgradeConfigurationValue };
export interface UpgradeAlgorithm {
  version: 1; digest: string; protocol: string; compiler: string; verification_mode: string;
  configuration: { [key: string]: UpgradeConfigurationValue };
}
export interface UpgradeRecord {
  memory_id: string; text: string; revision: number; scope_kind: UpgradeKind; adoption_method: 'manual'|'auto';
  status: string; source_ids: string[]; proof_kind: 'unknown'|'version_receipt';
}
export interface UpgradeComparison {
  version: 1; current: UpgradeRecord[]; current_count: number;
  actions: Array<{kind:'pending'|'auto_add'|'auto_update';candidate_id:string;result_memory_id:string|null;
    new:{text:string;subject:'self'|'contact'|'shared';source_ids:string[];has_new_proof:boolean;correction_review:unknown[]};previous:UpgradeRecord|null}>;
  stats: Record<string,number>;
}
export interface UpgradeBatch {
  batch_id: string; revision: number; state: string; number: number; contact_id: string; message_count: number;
  comparison: UpgradeComparison|null; task_status: string; current_step: string; error_code:string|null;
  algorithm: UpgradeAlgorithm|null;
}
export interface UpgradeJob {
  job_id:string; scope:{kind:UpgradeKind;contact_id:string|null};revision:number;state:'active'|'cancelled'|'deleted';
  budget:UpgradeBudget;model_calls_used:number;batches:UpgradeBatch[];
  algorithm: UpgradeAlgorithm|null;
}
export interface MemoryUpgradeState extends UpgradeSelection {
  revision:number;phase:'idle'|'loading'|'ready'|'failed';jobs:UpgradeJob[];error:string|null;
}
export interface UpgradeOperation extends UpgradeSelection {
  jobId:string;action:'apply'|'undo'|'cancel'|'resume'|'delete';expectedRevision:number;confirmed:true;
  batches:Array<{batch_id:string;expected_revision:number}>;
}
export interface MemoryUpgradeBridge {
  getState():Promise<MemoryUpgradeState>;
  selectScope(kind:UpgradeKind):Promise<void>;
  refresh(selection:UpgradeSelection):Promise<void>;
  prepare(request:UpgradeSelection & {budget:UpgradeBudget;confirmed:true}):Promise<void>;
  operate(request:UpgradeOperation):Promise<void>;
  onStateChanged(listener:(state:MemoryUpgradeState)=>void):()=>void;
}
