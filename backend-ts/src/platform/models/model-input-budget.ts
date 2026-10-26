/** 在官方 Messages 序列化之后估算完整JSON；不重写provider，也不声称精确token计量。 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
export const MESSAGES_MEASUREMENT_ID = 'deepseek-messages-json-utf8-bytes-v1/dsh-0.2.1-rc.2/687f282e8625c6b8d11ff58211a90524be2e4317';
export const STRICT_CHAT_MEASUREMENT_ID = 'deepseek-strict-chat-json-utf8-bytes-v1/beta-20261025';
export interface MessagesBudgetBinding {
  provider: string; model: string; maxTokens: number;
  temperature?: number; reasoningEffort: 'off'|'low'|'high'|'max'; stop?: readonly string[];
  /** 回复必须调用工具提交结果；其他模型调用保持缺省行为。 */
  toolChoice?: 'any'|{name:string};
}
export interface MessagesBudgetProfile {
  context_window_tokens: number; safety_margin_tokens: number;
}
export interface MessagesBudgetReceipt {
  provider: string; model: string; maxTokens: number;
  measurement_id: string;
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
function messagesToolChoice(binding:MessagesBudgetBinding):{type:'any'}|{type:'tool';name:string}|undefined {
  const choice=binding.toolChoice;
  if(choice===undefined)return undefined;
  if(choice==='any')return {type:'any'};
  if(!object(choice)||Object.keys(choice).join(',')!=='name'||typeof choice.name!=='string'||!choice.name.trim())unavailable();
  return {type:'tool',name:choice.name};
}
/** 正式发送与零HTTP预检共用同一扩展，预算覆盖最终实体。 */
export function prepareBoundMessagesRequest(body:unknown,binding:MessagesBudgetBinding) {
  if(!object(body)||Object.hasOwn(body,'tool_choice'))unavailable();
  const choice=messagesToolChoice(binding);
  const fields:Record<string,{type:'any'}|{type:'tool';name:string}>=choice?{tool_choice:choice}:{};
  return {body:{...body,...fields},fields};
}
/**
 * body为官方Adapter序列化实体与本次受控tool_choice扩展合并后的最终请求。
 * 该函数应直接作为adapter hook的前置守卫；不能通过会吞异常的extension registry安装。
 * 返回后仅允许应用同一受控扩展，最终内容不能被其他插件追加或改写。
 */
export function measureSerializedMessages(body: unknown, binding: MessagesBudgetBinding, profile: MessagesBudgetProfile): MessagesBudgetReceipt {
  const positive = (v:unknown) => Number.isSafeInteger(v)&&Number(v)>0;
  if(!binding.provider?.trim()||!binding.model?.trim()||!positive(binding.maxTokens)||!positive(profile.context_window_tokens)||!positive(profile.safety_margin_tokens)||!['off','low','high','max'].includes(binding.reasoningEffort))unavailable();
  if(!object(body))unavailable();
  jsonCompatible(body);
  const fields=new Set(['model','stream','messages','max_tokens','thinking','output_config','system','temperature','stop_sequences','tools','tool_choice']);
  if(Object.keys(body).some(key=>!fields.has(key))||body.model!==binding.model||body.stream!==true||body.max_tokens!==binding.maxTokens||body.temperature!==binding.temperature||!isDeepStrictEqual(body.stop_sequences,binding.stop))unavailable();
  if(!isDeepStrictEqual(body.thinking,{type:binding.reasoningEffort==='off'?'disabled':'enabled'})||!isDeepStrictEqual(body.output_config,binding.reasoningEffort==='off'?undefined:{effort:binding.reasoningEffort}))unavailable();
  const toolChoice=messagesToolChoice(binding);
  if(!isDeepStrictEqual(body.tool_choice,toolChoice))unavailable();
  if(toolChoice&&(!Array.isArray(body.tools)||body.tools.length===0||toolChoice.type==='tool'&&!body.tools.some(tool=>object(tool)&&tool.name===toolChoice.name)))unavailable();
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

/** 授权前测量最终非流式 DeepSeek strict Chat Completions 请求正文。 */
export function measureSerializedStrictChatCompletion(body: unknown, binding: MessagesBudgetBinding, profile: MessagesBudgetProfile): MessagesBudgetReceipt {
  const positive=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
  if(!binding.provider?.trim()||!binding.model?.trim()||!positive(binding.maxTokens)
    ||!positive(profile.context_window_tokens)||!positive(profile.safety_margin_tokens)
    ||!['off','low','high','max'].includes(binding.reasoningEffort))unavailable();
  if(!object(body))unavailable();
  jsonCompatible(body);
  const fields=new Set(['model','stream','messages','max_tokens','temperature','thinking','reasoning_effort','tools','tool_choice']);
  if(Object.keys(body).some(key=>!fields.has(key))||body.model!==binding.model||body.stream!==false
    ||body.max_tokens!==binding.maxTokens||body.temperature!==undefined&&body.temperature!==binding.temperature
    ||!Array.isArray(body.messages)||!body.messages.length||!Array.isArray(body.tools)||body.tools.length!==1)unavailable();
  const thinking=binding.reasoningEffort==='off'?'disabled':'enabled';
  if(!isDeepStrictEqual(body.thinking,{type:thinking})||body.reasoning_effort!==(binding.reasoningEffort==='off'?'none':binding.reasoningEffort))unavailable();
  if(binding.reasoningEffort==='off'
    ?!isDeepStrictEqual(body.tool_choice,{type:'function',function:{name:'SourceVerificationOutput'}})
    :body.tool_choice!==undefined)unavailable();
  const tool=body.tools[0];
  if(!object(tool)||tool.type!=='function'||!object(tool.function)||tool.function.name!=='SourceVerificationOutput'
    ||tool.function.strict!==true||!object(tool.function.parameters))unavailable();
  for(const message of body.messages){
    if(!object(message)||!['system','user'].includes(String(message.role))||typeof message.content!=='string')unavailable();
  }
  const serialized=JSON.stringify(body),bytes=Buffer.byteLength(serialized,'utf8');
  const receipt:MessagesBudgetReceipt={...binding,measurement_id:STRICT_CHAT_MEASUREMENT_ID,measurement_kind:'approximate',input_tokens:bytes,
    context_window_tokens:profile.context_window_tokens,safety_margin_tokens:profile.safety_margin_tokens,
    serialized_bytes:bytes,request_sha256:createHash('sha256').update(serialized).digest('hex'),covered_components:['messages','system','tools','controls']};
  if(bytes+binding.maxTokens+profile.safety_margin_tokens>profile.context_window_tokens)throw new ModelInputBudgetError('reply_budget_exceeded',receipt);
  return receipt;
}
