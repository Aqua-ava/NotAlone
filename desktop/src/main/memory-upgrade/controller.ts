import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { BackendRequestFailure } from '../backend/json-client';
import { isUuid } from '../uuid';
import type { MemoryUpgradeState, UpgradeKind, UpgradeSelection, UpgradeBudget, UpgradeOperation, UpgradeJob } from '../../shared/memory-upgrade-bridge';

type Scope = UpgradeSelection & { generation: number };
export class MemoryUpgradeController {
  private state: MemoryUpgradeState = { revision:0,kind:'contact',contactId:null,scopeRevision:0,phase:'idle',jobs:[],error:null };
  private scope:Scope|undefined;
  private operation=0;
  private pending:AbortController|undefined;
  private mutating=false;
  private pendingDeletions=0;
  private retry: { scope: Scope; method: 'POST'|'DELETE'; path: string; body: unknown } | undefined;
  private listeners=new Set<(state:MemoryUpgradeState)=>void>();
  constructor(private backend:BackendHost,private contacts:ContactSession) {
    backend.onStateChanged(()=>this.synchronize()); contacts.onStateChanged(()=>this.synchronize()); this.synchronize();
  }
  getState() { return structuredClone(this.state); }
  onStateChanged(listener:(state:MemoryUpgradeState)=>void) { this.listeners.add(listener);return ()=>{this.listeners.delete(listener);}; }
  selectScope(kind:UpgradeKind) {
    if (!['contact','owner'].includes(kind)) throw new Error('升级范围无效。');
    if(this.state.kind===kind)return;
    this.scope=undefined;this.clear();this.publish({kind});this.synchronize();
  }
  private synchronize() {
    const contacts=this.contacts.getState(),generation=this.backend.getConnectionGeneration();
    const contactId=this.state.kind==='contact'?contacts.selectedContactId:null;
    const available=this.state.kind==='owner'||contactId!==null&&contacts.directoryPhase==='ready'&&contacts.contacts.some(item=>item.contactId===contactId);
    const next=generation!==undefined&&available?{kind:this.state.kind,contactId,scopeRevision:contacts.scopeRevision,generation}:undefined;
    if(next?.kind===this.scope?.kind&&next?.contactId===this.scope?.contactId&&next?.scopeRevision===this.scope?.scopeRevision&&next?.generation===this.scope?.generation)return;
    this.scope=next;this.clear();this.publish({contactId:next?.contactId??null,scopeRevision:contacts.scopeRevision});
  }
  private clear() {++this.operation;this.pending?.abort();this.pending=undefined;this.retry=undefined;this.mutating=false;this.publish({phase:'idle',jobs:[],error:null});}
  invalidate(){this.clear();}
  recordDeletionChanged(phase:'started'|'settled') {
    this.pendingDeletions=Math.max(0,this.pendingDeletions+(phase==='started'?1:-1));
    this.clear();
  }
  private assertScope(selection:UpgradeSelection) {
    this.synchronize();
    if(!this.scope||selection.kind!==this.scope.kind||selection.contactId!==this.scope.contactId||selection.scopeRevision!==this.scope.scopeRevision)throw new Error('升级范围已变化，请重新选择。');
    return this.scope;
  }
  async refresh(selection:UpgradeSelection){
    const scope=this.assertScope(selection);
    const retry=this.retry;
    if(retry?.scope===scope){
      await this.perform(scope,retry.method,retry.path,retry.body);
      if(this.retry||this.scope!==scope)return;
    }
    await this.perform(scope,'GET',`/api/memory-upgrades?${query(scope)}`);
  }
  async prepare(request:UpgradeSelection & {budget:UpgradeBudget;confirmed:true}){
    const scope=this.assertScope(request);
    if(request.confirmed!==true||!validBudget(request.budget)||this.state.phase!=='ready'||this.retry)throw new Error('请刷新并明确确认范围与预算。');
    await this.perform(scope,'POST','/api/memory-upgrades',{scope:scope.kind==='owner'?{kind:'owner'}:{kind:'contact',contact_id:scope.contactId},
      budget:request.budget,operation_key:randomUUID(),confirmed:true});
  }
  async operate(request:UpgradeOperation){
    const scope=this.assertScope(request),job=this.state.jobs.find(item=>item.job_id===request.jobId);
    if(this.state.phase!=='ready'||this.retry||!job||request.expectedRevision!==job.revision||request.confirmed!==true||!['apply','undo','cancel','resume','delete'].includes(request.action))throw new Error('升级工作已变化，请刷新后重新批准。');
    if(!Array.isArray(request.batches)||request.batches.length>200||new Set(request.batches.map(item=>item.batch_id)).size!==request.batches.length)throw new Error('批次选择无效。');
    const selecting=['apply','undo'].includes(request.action);
    if(selecting&&!request.batches.length||!selecting&&request.batches.length)throw new Error('批次选择无效。');
    for(const chosen of request.batches){const batch=job.batches.find(item=>item.batch_id===chosen.batch_id);
      if(!batch||batch.revision!==chosen.expected_revision||batch.state!==(request.action==='apply'?'ready':'applied'))throw new Error('所选比较已经变化。');
      if(request.action==='apply'&&(!job.algorithm||!batch.algorithm||batch.algorithm.digest!==job.algorithm.digest))throw new Error('算法身份未知或已变化，请重新比较后批准。');}
    await this.perform(scope,request.action==='delete'?'DELETE':'POST',`/api/memory-upgrades/${job.job_id}?${query(scope)}`,
      {action:request.action,expected_revision:job.revision,operation_key:randomUUID(),confirmed:true,...(selecting?{batches:request.batches}:{})});
  }
  private async perform(scope:Scope,method:'GET'|'POST'|'DELETE',path:string,body?:unknown){
    if(this.mutating||this.pendingDeletions>0)return;
    const operation=++this.operation, previous=this.state.jobs;
    this.pending?.abort();const pending=this.pending=new AbortController();this.mutating=method!=='GET';
    if(method!=='GET')this.retry={scope,method,path,body:structuredClone(body)};
    this.publish({phase:'loading',jobs:method==='GET'?previous:[],error:null});
    try{
      const result=await this.backend.requestJson({method,path,body,signal:pending.signal});
      if(this.scope!==scope||operation!==this.operation||result.generation!==scope.generation)return;
      const values=method==='GET'?(result.data as {jobs:unknown[]}).jobs:[result.data];
      if(!Array.isArray(values)||values.length>50)throw new Error('升级工作格式无效。');
      const jobs=values.map(value=>readJob(value,scope)).filter(job=>job.state!=='deleted');
      this.retry=undefined;
      this.publish({jobs:method==='GET'?jobs:[...jobs,...previous.filter(job=>!values.some(value=>(value as UpgradeJob).job_id===job.job_id))].slice(0,50),phase:'ready'});
    }catch(error){if(this.scope===scope&&operation===this.operation){
      const unknown=method!=='GET'&&!(error instanceof BackendRequestFailure&&error.kind==='response'&&!!error.status&&error.status<500);
      if(!unknown)this.retry=undefined;
      this.publish({phase:'failed',jobs:[],error:unknown?'上次升级操作结果尚未确认，刷新将重试原动作。':'升级算法或资料已经变化，请刷新权威状态；需要重新比较时创建新工作，原批准不能复用。'});
    }}
    finally{if(this.pending===pending){this.pending=undefined;this.mutating=false;}}
  }
  private publish(change:Partial<MemoryUpgradeState>){this.state={...this.state,...change,revision:this.state.revision+1};for(const listener of this.listeners)listener(this.getState());}
}
function query(scope:UpgradeSelection){return scope.kind==='owner'?'scope=owner':`contact_id=${scope.contactId}`;}
function positive(value:unknown){return Number.isSafeInteger(value)&&(value as number)>0;}
function validBudget(value:UpgradeBudget){return value&&Object.keys(value).length===3&&[[value.message_limit,200],[value.batch_size,20],[value.model_calls,40]].every(([amount,max])=>positive(amount)&&amount<=max);}
function validAlgorithm(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = ['version', 'digest', 'protocol', 'compiler', 'verification_mode', 'configuration'];
  if (Object.keys(row).length !== keys.length || !Object.keys(row).every(key => keys.includes(key))
    || row.version !== 1 || typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest)
    || !['protocol', 'compiler', 'verification_mode'].every(key => typeof row[key] === 'string' && (row[key] as string).length > 0 && (row[key] as string).length <= 256)
    || !row.configuration || typeof row.configuration !== 'object' || Array.isArray(row.configuration)) return false;
  let entries = 0;
  const json = (item: unknown, depth: number): boolean => {
    if (++entries > 1024 || depth > 8) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'string') return item.length <= 2048;
    if (typeof item === 'number') return Number.isFinite(item);
    if (Array.isArray(item)) return item.length <= 128 && item.every(child => json(child, depth + 1));
    return typeof item === 'object' && Object.entries(item as Record<string, unknown>).every(([key, child]) =>
      key.length <= 256 && !['__proto__', 'constructor', 'prototype'].includes(key) && json(child, depth + 1));
  };
  return json(row.configuration, 0);
}
function readJob(value:unknown,scope:Scope):UpgradeJob{
  const job=value as UpgradeJob;
  if(!job||!isUuid(job.job_id)||!positive(job.revision)||!job.scope||job.scope.kind!==scope.kind||job.scope.contact_id!==scope.contactId||!['active','cancelled','deleted'].includes(job.state)
    ||!validAlgorithm(job.algorithm)||!validBudget(job.budget)||!Number.isSafeInteger(job.model_calls_used)||job.model_calls_used<0||job.model_calls_used>job.budget.model_calls||!Array.isArray(job.batches)||job.batches.length>200)throw new Error('升级工作格式无效。');
  for(const batch of job.batches){
    if(!batch||!isUuid(batch.batch_id)||!isUuid(batch.contact_id)||scope.kind==='contact'&&batch.contact_id!==scope.contactId||!positive(batch.revision)||!positive(batch.number)||!Number.isSafeInteger(batch.message_count)||batch.message_count<0||batch.message_count>20
      ||!['queued','ready','apply_queued','applied','undone','failed','invalidated'].includes(batch.state)||!['queued','running','verifying','succeeded','failed','cancelled'].includes(batch.task_status)
      ||!['preview_upgrade','verify_upgrade_preview','apply_upgrade','verify_upgrade_apply'].includes(batch.current_step)||batch.error_code!==null&&typeof batch.error_code!=='string'
      ||!validAlgorithm(batch.algorithm)||batch.algorithm!==null&&(!job.algorithm||!isDeepStrictEqual(batch.algorithm,job.algorithm)))throw new Error('升级批次格式无效。');
    if(batch.comparison!==null){const compared=batch.comparison;
      if(!compared||compared.version!==1||!Array.isArray(compared.actions)||compared.actions.length>64||!Array.isArray(compared.current)||compared.current.length>8||!Number.isSafeInteger(compared.current_count)||compared.current_count<compared.current.length)throw new Error('比较格式无效。');
      for(const action of compared.actions){if(!action||!['pending','auto_add','auto_update'].includes(action.kind)||!isUuid(action.candidate_id)||action.result_memory_id!==null&&!isUuid(action.result_memory_id)||!action.new||!['self','contact','shared'].includes(action.new.subject)||(scope.kind==='owner')!==(action.new.subject==='self')||typeof action.new.text!=='string'||action.new.text.length>24000||!Array.isArray(action.new.source_ids)||!action.new.source_ids.every(isUuid)||typeof action.new.has_new_proof!=='boolean'||!Array.isArray(action.new.correction_review))throw new Error('比较格式无效。');}
      for(const record of [...compared.current,...compared.actions.flatMap(action=>action.previous?[action.previous]:[])])if(!record||!isUuid(record.memory_id)||typeof record.text!=='string'||record.text.length>24000||!positive(record.revision)||!['manual','auto'].includes(record.adoption_method)||!['unknown','version_receipt'].includes(record.proof_kind)||record.scope_kind!==scope.kind||!Array.isArray(record.source_ids)||!record.source_ids.every(isUuid))throw new Error('旧资料范围无效。');
    }
    if(['invalidated','undone'].includes(batch.state)&&batch.comparison!==null)throw new Error('已清除工作不得携带旧比较。');
  }
  return structuredClone(job);
}
