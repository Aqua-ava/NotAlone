/** 物理调用台账合同和旧010表投影。完整元数据存储必须显式注入，禁止静默丢字段。 */
import type pg from 'pg';
import { isDeepStrictEqual } from 'node:util';
import type {MessagesBudgetReceipt} from './model-input-budget.ts';
export interface ModelLedgerUsage {
  input_tokens: number; output_tokens: number;
  cache_read_tokens: number | null; cache_write_tokens: number | null;
}
export type ModelLedgerCost = {status:'unknown';amount:null;currency:null;pricing_version:null}
  | {status:'known'|'estimated';amount:string;currency:string;pricing_version:string};
/** 只保留最终序列化预算的身份与数值，禁止载入正文、工具定义或认证信息。 */
export interface ModelLedgerInputBudget {
  measurement_id:string; measurement_kind:'approximate';
  input_tokens:number;max_output_tokens:number;context_window_tokens:number;safety_margin_tokens:number;
  request_sha256:string;serialized_bytes:number;
}
export function modelLedgerInputBudget(budget:MessagesBudgetReceipt):ModelLedgerInputBudget {
  const value:ModelLedgerInputBudget={measurement_id:budget.measurement_id,measurement_kind:budget.measurement_kind,
    input_tokens:budget.input_tokens,max_output_tokens:budget.maxTokens,context_window_tokens:budget.context_window_tokens,
    safety_margin_tokens:budget.safety_margin_tokens,request_sha256:budget.request_sha256,serialized_bytes:budget.serialized_bytes};
  validateInputBudget(value);return value;
}
const budgetKeys=['measurement_id','measurement_kind','input_tokens','max_output_tokens','context_window_tokens','safety_margin_tokens','request_sha256','serialized_bytes'];
function validateInputBudget(budget:ModelLedgerInputBudget):void {
  const invalid=()=>{throw new ModelLedgerError('model_ledger_budget_invalid');};
  if(!budget||typeof budget!=='object'||Array.isArray(budget)||Object.keys(budget).sort().join(',')!==[...budgetKeys].sort().join(','))invalid();
  if(typeof budget.measurement_id!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(budget.measurement_id)||budget.measurement_kind!=='approximate'||typeof budget.request_sha256!=='string'||! /^[a-f0-9]{64}$/.test(budget.request_sha256))invalid();
  for(const key of ['input_tokens','max_output_tokens','context_window_tokens','safety_margin_tokens','serialized_bytes'] as const)if(!count(budget[key])||budget[key]<1)invalid();
  if(budget.input_tokens+budget.max_output_tokens+budget.safety_margin_tokens>budget.context_window_tokens)invalid();
}
export interface ModelLedgerReceipt {
  input_budget?:ModelLedgerInputBudget|null;
  ledger_entry_id?:string|null;
  legacy_outcome?:'succeeded'|'run_failed'|'rejected_by_validation';
  attempt_id:string;permit_id:string;request_id:string;owner_id:string;contact_id:string|null;
  scope_kind?:'contact'|'owner_memory';
  provider:string;model:string;called_at:string;latency_ms:number|null;
  /** 确认收到HTTP响应才可标response_observed；仅hook通过或transport断连不能推定已发送。 */
  dispatch:'authorized_unconfirmed'|'response_observed'|'http_accepted'|'not_sent';
  outcome:'pending'|'succeeded'|'failed'|'cancelled'|'unknown';
  usage:ModelLedgerUsage|null;cost:ModelLedgerCost;
}
export interface ModelLedgerDetails {
  /** 在同一事务中严格校验身份/幂等/迟到结算并保存完整receipt；缺实现拒绝装配。 */
  record(client:pg.Client,receipt:ModelLedgerReceipt):Promise<void>;
}
export class ModelLedgerError extends Error {
  readonly code: string;
  constructor(code:string) {super(code);this.code=code;}
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const count=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=2147483647;
export function validateModelLedgerReceipt(receipt:ModelLedgerReceipt) {
  const invalid=()=>{throw new ModelLedgerError('model_ledger_receipt_invalid');};
  if(receipt.input_budget!=null)validateInputBudget(receipt.input_budget);
  for(const value of [receipt.attempt_id,receipt.permit_id,receipt.request_id,receipt.owner_id])if(typeof value!=='string'||!uuid.test(value))invalid();
  if(receipt.contact_id===null) {if(receipt.scope_kind!=='owner_memory'||receipt.ledger_entry_id!=null)invalid();}
  else if(!uuid.test(receipt.contact_id)||(receipt.scope_kind??'contact')!=='contact')invalid();
  if(receipt.ledger_entry_id!=null&&!uuid.test(receipt.ledger_entry_id))invalid();
  if(receipt.legacy_outcome!==undefined&&!['succeeded','run_failed','rejected_by_validation'].includes(receipt.legacy_outcome))invalid();
  for(const value of [receipt.provider,receipt.model])if(typeof value!=='string'||!value.trim())invalid();
  if(!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(receipt.called_at)||!Number.isFinite(Date.parse(receipt.called_at))||receipt.latency_ms!==null&&!count(receipt.latency_ms))invalid();
  if(!['authorized_unconfirmed','response_observed','http_accepted','not_sent'].includes(receipt.dispatch)||!['pending','succeeded','failed','cancelled','unknown'].includes(receipt.outcome))invalid();
  if(receipt.outcome==='succeeded'&&!['response_observed','http_accepted'].includes(receipt.dispatch))invalid();
  if(receipt.usage!==null) {
    const usage=receipt.usage;
    if(!count(usage.input_tokens)||!count(usage.output_tokens)||usage.cache_read_tokens!==null&&!count(usage.cache_read_tokens)||usage.cache_write_tokens!==null&&!count(usage.cache_write_tokens))invalid();
    if((usage.cache_read_tokens??0)+(usage.cache_write_tokens??0)>usage.input_tokens)invalid();
  }
  const cost=receipt.cost;
  if(!cost||!['unknown','known','estimated'].includes(cost.status))invalid();
  if(cost.status==='unknown') {if(cost.amount!==null||cost.currency!==null||cost.pricing_version!==null)invalid();}
  else if(typeof cost.amount!=='string'||!/^\d+(?:\.\d+)?$/.test(cost.amount)||!cost.currency?.trim()||!cost.pricing_version?.trim())invalid();
}
/** 这里只投影可确认发生的请求；pending/unknown发送状态仍必须由完整details表持久保存。 */
export function legacyLedgerProjection(receipt:ModelLedgerReceipt) {
  validateModelLedgerReceipt(receipt);
  if(receipt.contact_id===null)return null;
  if(!['response_observed','http_accepted'].includes(receipt.dispatch)||receipt.outcome==='pending')return null;
  return {id:receipt.ledger_entry_id??receipt.attempt_id,owner_id:receipt.owner_id,contact_id:receipt.contact_id,provider:receipt.provider,model_name:receipt.model,
    input_tokens:receipt.usage?.input_tokens??null,output_tokens:receipt.usage?.output_tokens??null,latency_ms:receipt.latency_ms,
    outcome:receipt.legacy_outcome??(receipt.outcome==='succeeded'?'succeeded':'run_failed'),called_at:receipt.called_at};
}
export class PostgresModelLedger {
  private readonly transaction: <T>(fn:(client:pg.Client)=>Promise<T>)=>Promise<T>;
  private readonly details:ModelLedgerDetails;
  constructor(options:{transaction:<T>(fn:(client:pg.Client)=>Promise<T>)=>Promise<T>;details:ModelLedgerDetails}) {
    if(typeof options.details?.record!=='function')throw new ModelLedgerError('model_ledger_details_required');
    this.transaction=options.transaction;this.details=options.details;
  }
  async reserve(receipt:ModelLedgerReceipt,physicalLimit:number):Promise<void> {
    if(!Number.isSafeInteger(physicalLimit)||physicalLimit<1||receipt.outcome!=='pending'||receipt.dispatch!=='authorized_unconfirmed')throw new ModelLedgerError('model_ledger_budget_invalid');
    await this.write(receipt,physicalLimit);
  }
  async record(receipt:ModelLedgerReceipt):Promise<void> { await this.write(receipt); }
  /** 仅可传入journal已核实旧执行者消失的permit；业务队列启动前执行并等待提交。 */
  async recoverUnknownPermits(permitIds:readonly string[]):Promise<{owner_id:string;request_id:string;attempt_id:string}[]> {
    if(permitIds.some(id=>!uuid.test(id)))throw new ModelLedgerError('model_ledger_receipt_invalid');
    return this.transaction(async client=>{
      const owners=(await client.query('SELECT DISTINCT owner_id FROM model_call_receipt WHERE permit_id=ANY($1::uuid[]) ORDER BY owner_id',[permitIds])).rows;
      for(const row of owners)await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${row.owner_id}`]);
      await client.query("UPDATE model_call_receipt SET outcome='unknown',updated_at=now() WHERE permit_id=ANY($1::uuid[]) AND outcome='pending'",[permitIds]);
      return (await client.query("SELECT owner_id,request_id,attempt_id FROM model_call_receipt WHERE permit_id=ANY($1::uuid[]) AND outcome='unknown' ORDER BY owner_id,request_id,attempt_id",[permitIds])).rows;
    });
  }
  async recordReserved(receipt:ModelLedgerReceipt):Promise<void> { await this.write(receipt,undefined,true); }
  private async write(receipt:ModelLedgerReceipt,physicalLimit?:number,requireReserved=false):Promise<void> {
    validateModelLedgerReceipt(receipt);
    const snapshot=structuredClone(receipt),projection=legacyLedgerProjection(snapshot);
    await this.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${snapshot.owner_id}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`model-permit:${snapshot.permit_id}`]);
      const scopeConflict=(await client.query(`SELECT 1 FROM model_call_receipt WHERE
        (permit_id=$1 AND (owner_id<>$2 OR contact_id IS DISTINCT FROM $3 OR request_id<>$4)) OR
        (owner_id=$2 AND request_id=$4 AND contact_id IS DISTINCT FROM $3) LIMIT 1`,
        [snapshot.permit_id,snapshot.owner_id,snapshot.contact_id,snapshot.request_id])).rowCount;
      if(scopeConflict)throw new ModelLedgerError('model_ledger_attempt_conflict');
      // 联系人/owner已删除时拒绝晚台账，不能重建对应范围记录。
      if(!(await client.query(snapshot.contact_id===null?'SELECT 1 FROM owner WHERE id=$1':'SELECT 1 FROM contact WHERE owner_id=$1 AND id=$2',snapshot.contact_id===null?[snapshot.owner_id]:[snapshot.owner_id,snapshot.contact_id])).rowCount)throw new ModelLedgerError('model_ledger_scope_deleted');
      if(requireReserved&&!(await client.query('SELECT 1 FROM model_call_receipt WHERE attempt_id=$1',[snapshot.attempt_id])).rowCount)throw new ModelLedgerError('model_ledger_reservation_missing');
      if(physicalLimit!==undefined) {
        const existing=(await client.query('SELECT outcome FROM model_call_receipt WHERE attempt_id=$1',[snapshot.attempt_id])).rows[0];
        const used=(await client.query('SELECT count(*)::int AS used FROM model_call_receipt WHERE owner_id=$1 AND request_id=$2',[snapshot.owner_id,snapshot.request_id])).rows[0].used;
        // unknown不能重新获得出站ACK；已结算attempt也不能再授权同一次物理发送。
        if(existing?.outcome==='unknown')throw new ModelLedgerError('model_ledger_unknown_requires_resolution');
        if(existing&&existing.outcome!=='pending')throw new ModelLedgerError('model_ledger_attempt_already_settled');
        // 不删unknown、不按已确认HTTP计数退款；仅仍pending的同attempt可幂等预约。
        if(!existing&&used>=physicalLimit)throw new ModelLedgerError('model_ledger_budget_exceeded');
        if(!existing&&(await client.query("SELECT 1 FROM model_call_receipt WHERE owner_id=$1 AND request_id=$2 AND outcome='unknown' LIMIT 1",[snapshot.owner_id,snapshot.request_id])).rowCount)throw new ModelLedgerError('model_ledger_unknown_requires_resolution');
      }
      if(!projection) { await this.details.record(client,snapshot); return; }
      await client.query(`INSERT INTO outbound_ledger_entry(id,owner_id,contact_id,provider,model_name,input_tokens,output_tokens,latency_ms,outcome,called_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,Object.values(projection));
      const row=(await client.query('SELECT * FROM outbound_ledger_entry WHERE id=$1 FOR UPDATE',[projection.id])).rows[0];
      const identityKeys=['owner_id','contact_id','provider','model_name'] as const;
      if(!row||identityKeys.some(key=>row[key]!==projection[key])||new Date(row.called_at).getTime()!==Date.parse(projection.called_at))throw new ModelLedgerError('model_ledger_attempt_conflict');
      // 只有本attempt此前写出的暂定旧投影可细化；历史终态不能凭相同UUID改写。
      if(row.outcome!==projection.outcome) {
        const prior=(await client.query('SELECT ledger_entry_id,outcome FROM model_call_receipt WHERE attempt_id=$1 FOR UPDATE',[snapshot.attempt_id])).rows[0];
        const linked=prior?.ledger_entry_id===projection.id;
        if(linked&&['pending','unknown'].includes(prior.outcome)&&!['pending','unknown'].includes(snapshot.outcome)) {
          await client.query('UPDATE outbound_ledger_entry SET outcome=$2 WHERE id=$1',[projection.id,projection.outcome]);
        } else if(!(linked&&!['pending','unknown'].includes(prior.outcome)&&['pending','unknown'].includes(snapshot.outcome)&&snapshot.legacy_outcome===undefined)) {
          throw new ModelLedgerError('model_ledger_attempt_conflict');
        }
      }
      for(const field of ['input_tokens','output_tokens','latency_ms'] as const) {
        if(row[field]!==null&&projection[field]!==null&&!isDeepStrictEqual(row[field],projection[field]))throw new ModelLedgerError('model_ledger_attempt_conflict');
      }
      // 晚usage只把未知细化为已知，不覆盖已结算不同数值，也不新增第二次调用。
      await client.query('UPDATE outbound_ledger_entry SET input_tokens=coalesce(input_tokens,$2),output_tokens=coalesce(output_tokens,$3),latency_ms=coalesce(latency_ms,$4) WHERE id=$1',
        [projection.id,projection.input_tokens,projection.output_tokens,projection.latency_ms]);
      await this.details.record(client,{...snapshot,ledger_entry_id:projection.id});
    });
  }
}

/** 110新表适配器；必须和原010投影同事务调用。 */
export class PostgresModelLedgerDetails implements ModelLedgerDetails {
  async record(client:pg.Client,receipt:ModelLedgerReceipt):Promise<void> {
    validateModelLedgerReceipt(receipt);
    const previous=(await client.query('SELECT * FROM model_call_receipt WHERE attempt_id=$1 FOR UPDATE',[receipt.attempt_id])).rows[0];
    const usage=receipt.usage,cost=receipt.cost;
    const next={input_budget:receipt.input_budget??null,scope_kind:receipt.scope_kind??'contact',attempt_id:receipt.attempt_id,owner_id:receipt.owner_id,contact_id:receipt.contact_id,request_id:receipt.request_id,permit_id:receipt.permit_id,
      ledger_entry_id:receipt.ledger_entry_id??null,provider:receipt.provider,model_name:receipt.model,called_at:receipt.called_at,
      latency_ms:receipt.latency_ms,dispatch:receipt.dispatch,outcome:receipt.outcome,
      input_tokens:usage?.input_tokens??null,output_tokens:usage?.output_tokens??null,cache_read_tokens:usage?.cache_read_tokens??null,cache_write_tokens:usage?.cache_write_tokens??null,
      cost_status:cost.status,cost_amount:cost.amount,currency:cost.currency,pricing_version:cost.pricing_version};
    if(previous) {
      if(next.input_budget!==null&&!isDeepStrictEqual(previous.input_budget,next.input_budget))throw new ModelLedgerError('model_ledger_attempt_conflict');
      next.input_budget=previous.input_budget;
      for(const key of ['scope_kind','owner_id','contact_id','request_id','permit_id','provider','model_name'] as const)if(previous[key]!==next[key])throw new ModelLedgerError('model_ledger_attempt_conflict');
      if(new Date(previous.called_at).getTime()!==Date.parse(next.called_at))throw new ModelLedgerError('model_ledger_attempt_conflict');
      for(const key of ['ledger_entry_id','latency_ms','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','cost_amount','currency','pricing_version'] as const) {
        if(previous[key]!==null&&next[key]!==null&&String(previous[key])!==String(next[key]))throw new ModelLedgerError('model_ledger_attempt_conflict');
        if(previous[key]!==null&&next[key]===null)(next as Record<string,unknown>)[key]=previous[key];
      }
      // 重启unknown允许同一真实attempt迟到结算；完成结果不被旧pending/unknown回调降级。
      if(previous.outcome==='unknown'&&next.outcome==='pending')next.outcome='unknown';
      if(!['pending','unknown'].includes(previous.outcome)) {
        if(!['pending','unknown',previous.outcome].includes(next.outcome))throw new ModelLedgerError('model_ledger_attempt_conflict');
        next.outcome=previous.outcome;
      }
      const observed=new Set(['response_observed','http_accepted']);
      if(previous.dispatch==='not_sent'&&next.dispatch!=='not_sent'||observed.has(previous.dispatch)&&next.dispatch==='not_sent')throw new ModelLedgerError('model_ledger_attempt_conflict');
      if(observed.has(previous.dispatch)&&!observed.has(next.dispatch))next.dispatch=previous.dispatch;
      if(previous.cost_status!=='unknown') {
        if(next.cost_status!=='unknown'&&next.cost_status!==previous.cost_status)throw new ModelLedgerError('model_ledger_attempt_conflict');
        next.cost_status=previous.cost_status;
      }
      const keys=Object.keys(next).filter(key=>key!=='attempt_id');
      await client.query(`UPDATE model_call_receipt SET ${keys.map((key,index)=>`${key}=$${index+2}`).join(',')},updated_at=now() WHERE attempt_id=$1`,[next.attempt_id,...keys.map(key=>(next as Record<string,unknown>)[key])]);
    } else {
      const keys=Object.keys(next);
      await client.query(`INSERT INTO model_call_receipt(${keys.join(',')}) VALUES(${keys.map((_,index)=>`$${index+1}`).join(',')})`,Object.values(next));
    }
  }
  /** 调用方必须已持owner锁，且已证明旧执行者消失；只标未知，不清预算、不重放。 */
  async markUnsettledUnknown(client:pg.Client,owner_id:string,permit_ids:readonly string[]):Promise<string[]> {
    if(!uuid.test(owner_id)||permit_ids.some(value=>!uuid.test(value)))throw new ModelLedgerError('model_ledger_receipt_invalid');
    const result=await client.query("UPDATE model_call_receipt SET outcome='unknown',updated_at=now() WHERE owner_id=$1 AND permit_id=ANY($2::uuid[]) AND outcome='pending' RETURNING attempt_id",[owner_id,permit_ids]);
    return result.rows.map(row=>row.attempt_id);
  }
}
