/** OpenAI Responses 的纯文字协议边界；不读取凭据或发送网络请求。 */
import {createHash} from 'node:crypto';
import type {GenerateOptions} from '@deepseek-ai/dsh-llm';
import {ModelInputBudgetError, type MessagesBudgetBinding, type MessagesBudgetProfile, type MessagesBudgetReceipt} from './model-input-budget.ts';

export const OPENAI_RESPONSES_MODEL = 'gpt-5.4-mini-2026-03-17';
export const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';
const invalid = (): never => { throw new ModelInputBudgetError('reply_budget_unavailable'); };
function jsonCompatible(value:unknown,seen=new Set<object>()):void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return; }
  if (typeof value !== 'object' || value === null) return invalid();
  if (seen.has(value)) return invalid();
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid();
  seen.add(value);
  for (const entry of Object.values(value)) jsonCompatible(entry,seen);
  seen.delete(value);
}

/** 只接受业务已允许的文字和工具调用，未知内容一律失败关闭。 */
export function buildOpenAIResponsesRequest(options: GenerateOptions, binding: MessagesBudgetBinding): Record<string, unknown> {
  if (options.provider !== binding.provider || options.model !== binding.model || binding.model !== OPENAI_RESPONSES_MODEL
    || options.maxTokens !== binding.maxTokens || options.reasoningEffort !== binding.reasoningEffort
    || binding.reasoningEffort !== 'off' || options.stop !== undefined || options.purpose !== undefined) invalid();
  const input: Record<string, unknown>[] = [];
  if (options.system) input.push({role:'system',content:options.system});
  for (const message of options.messages) {
    if (message.role === 'tool') {
      if (!message.toolCallId || message.content.some(block => block.type !== 'text')) invalid();
      input.push({type:'function_call_output',call_id:String(message.toolCallId),output:message.content.map(block => block.type === 'text' ? block.text : '').join('')});
      continue;
    }
    if (!['system','developer','user','assistant'].includes(message.role)) invalid();
    let text = '';
    const flush = () => { if (text) { input.push({role:message.role,content:text}); text = ''; } };
    for (const block of message.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool-call' && message.role === 'assistant') {
        flush();
        if (!block.id || !block.name || typeof block.arguments !== 'string') invalid();
        input.push({type:'function_call',call_id:String(block.id),name:block.name,arguments:block.arguments});
      } else invalid();
    }
    flush();
  }
  if (!input.length) invalid();
  const tools = (options.tools ?? []).map(tool => {
    if (tool.deferLoading || !tool.name || !tool.description || !tool.parameters || typeof tool.parameters !== 'object') invalid();
    return {type:'function',name:tool.name,description:tool.description,parameters:tool.parameters,strict:false};
  });
  const body: Record<string, unknown> = {model:binding.model,input,store:false,stream:false,
    max_output_tokens:binding.maxTokens,reasoning:{effort:'none'}};
  if (tools.length) body.tools = tools;
  if (binding.toolChoice === 'any') body.tool_choice = 'required';
  else if (binding.toolChoice) body.tool_choice = {type:'function',name:binding.toolChoice.name};
  const chosenName = typeof binding.toolChoice === 'object' ? binding.toolChoice.name : undefined;
  if (binding.toolChoice && (!tools.length || chosenName !== undefined
    && !tools.some(tool => tool.name === chosenName))) invalid();
  jsonCompatible(body);
  return body;
}

/** 在最终 JSON 生成之后估算全量 UTF-8 字节，保留正数安全余量。 */
export function measureOpenAIResponsesRequest(body: Record<string, unknown>, binding: MessagesBudgetBinding, profile: MessagesBudgetProfile): MessagesBudgetReceipt {
  if (body.model !== binding.model || body.store !== false || body.stream !== false || body.max_output_tokens !== binding.maxTokens
    || !Array.isArray(body.input) || !body.input.length || !Number.isSafeInteger(profile.context_window_tokens)
    || !Number.isSafeInteger(profile.safety_margin_tokens) || profile.safety_margin_tokens < 1
    || !Number.isSafeInteger(binding.maxTokens) || binding.maxTokens < 1
    || Object.keys(body).some(key => !['model','input','store','stream','max_output_tokens','reasoning','tools','tool_choice'].includes(key))) invalid();
  jsonCompatible(body);
  const serialized = JSON.stringify(body);
  const bytes = Buffer.byteLength(serialized,'utf8');
  const receipt: MessagesBudgetReceipt = {...binding, measurement_id:'openai-responses-json-utf8-bytes-v1',measurement_kind:'approximate',
    input_tokens:bytes,context_window_tokens:profile.context_window_tokens,safety_margin_tokens:profile.safety_margin_tokens,
    serialized_bytes:bytes,request_sha256:createHash('sha256').update(serialized).digest('hex'),covered_components:['messages','system','tools','controls']};
  if (bytes + binding.maxTokens + profile.safety_margin_tokens > profile.context_window_tokens)
    throw new ModelInputBudgetError('reply_budget_exceeded',receipt);
  return receipt;
}
