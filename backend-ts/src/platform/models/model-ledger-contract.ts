/** 物理调用台账合同。完整元数据存储必须显式注入，禁止静默丢字段。 */
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
  /** 图片提取已观察到传输终态；不证明上游未处理，也不证明成本已知。 */
  terminal_failure?:'transport';
  usage:ModelLedgerUsage|null;cost:ModelLedgerCost;
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
  if(receipt.terminal_failure!==undefined&&(receipt.terminal_failure!=='transport'||receipt.outcome!=='failed'||receipt.dispatch!=='authorized_unconfirmed'))invalid();
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
