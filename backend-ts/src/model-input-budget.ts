/** 在官方 Messages 序列化之后估算完整JSON；不重写provider，也不声称精确token计量。 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
export const MESSAGES_MEASUREMENT_ID = 'deepseek-messages-json-utf8-bytes-v1/dsh-0.2.1-rc.2/687f282e8625c6b8d11ff58211a90524be2e4317';
export interface MessagesBudgetBinding {
  provider: string; model: string; maxTokens: number;
  temperature?: number; reasoningEffort: 'off'|'low'|'high'|'max'; stop?: readonly string[];
}
export interface MessagesBudgetProfile {
  context_window_tokens: number; safety_margin_tokens: number;
}
export interface MessagesBudgetReceipt {
  provider: string; model: string; maxTokens: number;
  measurement_id: typeof MESSAGES_MEASUREMENT_ID;
  measurement_kind: 'approximate'; input_tokens: number;
  context_window_tokens: number; safety_margin_tokens: number;
  serialized_bytes: number; request_sha256: string;
  covered_components: readonly ['messages','system','tools','controls'];
}
export class ModelInputBudgetError extends Error {
  readonly code: 'reply_budget_unavailable'|'reply_budget_exceeded';
  readonly receipt:MessagesBudgetReceipt|null;
  constructor(code: 'reply_budget_unavailable'|'reply_budget_exceeded',receipt:MessagesBudgetReceipt|null=null) {super(code);this.code=code;this.receipt=receipt?structuredClone(receipt):null;}
}
function unavailable():never {throw new ModelInputBudgetError('reply_budget_unavailable');}
const object = (v:unknown):v is Record<string,unknown> => v!==null&&typeof v==='object'&&!Array.isArray(v);
function jsonCompatible(value: unknown, ancestors = new Set<object>()): void {
  if (value===null || typeof value==='string' || typeof value==='boolean') return;
  if (typeof value==='number') { if(!Number.isFinite(value))unavailable();return; }
  if (typeof value!=='object' || ancestors.has(value)) unavailable();
  if (!Array.isArray(value) && Object.getPrototypeOf(value)!==Object.prototype && Object.getPrototypeOf(value)!==null) unavailable();
  ancestors.add(value);
  for(const child of Object.values(value))jsonCompatible(child,ancestors);
  ancestors.delete(value);
}
function requireTextBlocks(blocks: unknown): void {
  if (!Array.isArray(blocks)) unavailable();
  for(const block of blocks) {
    if (!object(block)) unavailable();
    if (block.type==='image') unavailable();
    if (block.type==='tool_result') requireTextBlocks(block.content);
  }
}
/**
 * body必须直接来自官方DeepSeekAdapter.prepareExtensions的request.body。
 * 该函数应直接作为adapter hook的前置守卫；不能通过会吞异常的extension registry安装。
 * 返回后只允许空扩展字段，最终内容不能被其他插件追加或改写。
 */
export function measureSerializedMessages(body: unknown, binding: MessagesBudgetBinding, profile: MessagesBudgetProfile): MessagesBudgetReceipt {
  const positive = (v:unknown) => Number.isSafeInteger(v)&&Number(v)>0;
  if(!binding.provider?.trim()||!binding.model?.trim()||!positive(binding.maxTokens)||!positive(profile.context_window_tokens)||!positive(profile.safety_margin_tokens)||!['off','low','high','max'].includes(binding.reasoningEffort))unavailable();
  if(!object(body))unavailable();
  jsonCompatible(body);
  const fields=new Set(['model','stream','messages','max_tokens','thinking','output_config','system','temperature','stop_sequences','tools']);
  if(Object.keys(body).some(key=>!fields.has(key))||body.model!==binding.model||body.stream!==true||body.max_tokens!==binding.maxTokens||body.temperature!==binding.temperature||!isDeepStrictEqual(body.stop_sequences,binding.stop))unavailable();
  if(!isDeepStrictEqual(body.thinking,{type:binding.reasoningEffort==='off'?'disabled':'enabled'})||!isDeepStrictEqual(body.output_config,binding.reasoningEffort==='off'?undefined:{effort:binding.reasoningEffort}))unavailable();
  if(!Array.isArray(body.messages)||!body.messages.length||body.system!==undefined&&typeof body.system!=='string'||body.tools!==undefined&&!Array.isArray(body.tools))unavailable();
  for(const message of body.messages) {
    if(!object(message)||!['user','assistant','system'].includes(String(message.role)))unavailable();
    requireTextBlocks(message.content);
  }
  const serialized=JSON.stringify(body);
  const bytes=Buffer.byteLength(serialized,'utf8');
  const receipt:MessagesBudgetReceipt={...binding,measurement_id:MESSAGES_MEASUREMENT_ID,measurement_kind:'approximate',input_tokens:bytes,
    context_window_tokens:profile.context_window_tokens,safety_margin_tokens:profile.safety_margin_tokens,
    serialized_bytes:bytes,request_sha256:createHash('sha256').update(serialized).digest('hex'),covered_components:['messages','system','tools','controls']};
  // UTF-8字节数是本地估算策略，不是供应商tokenizer或已验证上界；必须另留正安全余量。
  if(bytes+binding.maxTokens+profile.safety_margin_tokens>profile.context_window_tokens)throw new ModelInputBudgetError('reply_budget_exceeded',receipt);
  return receipt;
}
