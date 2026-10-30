/** DSH 公开模型接口上的 OpenAI 文字适配器；发送前必须经过业务守卫。 */
import {LlmAdapter,LlmError,ToolCallId,attributionHeaders,resolveRetryPolicy,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm';
import {buildOpenAIResponsesRequest,OPENAI_RESPONSES_ENDPOINT,OPENAI_RESPONSES_MODEL} from './openai-responses-wire.ts';
import type {MessagesBudgetBinding} from './model-input-budget.ts';

type Guard = (options:GenerateOptions,build:(binding:MessagesBudgetBinding)=>Record<string,unknown>)=>Promise<Record<string,unknown>>;
type Fetch = typeof fetch;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fail=():never=>{throw new LlmError('OpenAI response envelope is invalid.','INVALID_RESPONSE');};

/** 不允许供应商返回未知内容或不完整结果后当作成功。 */
export function decodeOpenAIResponse(value:unknown):StreamChunk[] {
  if (!object(value) || value.status !== 'completed' || !Array.isArray(value.output)) return fail();
  const chunks:StreamChunk[]=[];
  for (const item of value.output) {
    if (!object(item)) return fail();
    if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)) return fail();
      for (const content of item.content) {
        if (!object(content) || content.type !== 'output_text' || typeof content.text !== 'string') return fail();
        const index=chunks.filter(chunk=>chunk.type==='block-start').length;
        chunks.push({type:'block-start',index,blockType:'text'},{type:'text-delta',index,text:content.text},
          {type:'block-end',index,block:{type:'text',text:content.text}});
      }
    } else if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name
        || typeof item.arguments !== 'string') return fail();
      try { JSON.parse(item.arguments); } catch { return fail(); }
      const index=chunks.filter(chunk=>chunk.type==='block-start').length,id=ToolCallId(item.call_id);
      chunks.push({type:'block-start',index,blockType:'tool-call'},
        {type:'tool-call-delta',index,id,name:item.name,argumentsDelta:item.arguments},
        {type:'block-end',index,block:{type:'tool-call',id,name:item.name,arguments:item.arguments}});
    } else return fail();
  }
  if (object(value.usage)) {
    const input=value.usage.input_tokens,output=value.usage.output_tokens;
    const cached=object(value.usage.input_tokens_details)?value.usage.input_tokens_details.cached_tokens:undefined;
    if (!Number.isSafeInteger(input) || Number(input)<0 || !Number.isSafeInteger(output) || Number(output)<0
      || cached!==undefined && (!Number.isSafeInteger(cached) || Number(cached)<0 || Number(cached)>Number(input))) return fail();
    chunks.push({type:'usage',usage:{inputTokens:Number(input)-Number(cached??0),outputTokens:Number(output),
      ...(cached===undefined?{}:{cacheReadTokens:Number(cached)})}});
  }
  chunks.push({type:'finish',reason:{kind:chunks.some(chunk=>chunk.type==='tool-call-delta')?'tool-calls':'stop'}});
  return chunks;
}

export class OpenAIResponsesAdapter extends LlmAdapter {
  private readonly options:{key:string;guard:Guard;fetch?:Fetch;onAccepted?:(options:GenerateOptions)=>void};
  constructor(options:{key:string;guard:Guard;fetch?:Fetch;onAccepted?:(options:GenerateOptions)=>void}) {super();this.options=options;}
  override providerInfo(provider:string){return {id:provider,name:'OpenAI'};}
  override providerRetryPolicy(){return resolveRetryPolicy({mode:'normal',maxRetries:0},'openai');}
  override async *stream(options:GenerateOptions):AsyncGenerator<StreamChunk> {
    if (options.model !== OPENAI_RESPONSES_MODEL || !options.signal || !this.options.key) throw new LlmError('OpenAI configuration unavailable.','NO_MODEL');
    options.signal.throwIfAborted();
    const body=await this.options.guard(options,binding=>buildOpenAIResponsesRequest(options,binding));
    options.signal.throwIfAborted();
    let response:Response;
    try { response=await (this.options.fetch??fetch)(OPENAI_RESPONSES_ENDPOINT,{method:'POST',redirect:'error',signal:options.signal,
      headers:{...attributionHeaders(),'content-type':'application/json',authorization:`Bearer ${this.options.key}`},body:JSON.stringify(body)}); }
    catch(error) {throw new LlmError('OpenAI transport failed.',options.signal.aborted?'ABORTED':'TRANSPORT',{cause:error});}
    if (!response.ok) throw new LlmError('OpenAI request failed.','PROVIDER_ERROR',{status:response.status});
    this.options.onAccepted?.(options);
    const reader=response.body?.getReader(); if (!reader) return fail();
    const parts:Uint8Array[]=[]; let size=0;
    for (;;) {const entry=await reader.read();if(entry.done)break;size+=entry.value.byteLength;
      if(size>2*1024*1024){await reader.cancel();return fail();}parts.push(entry.value);}
    let parsed:unknown;try {parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));}catch{return fail();}
    yield* decodeOpenAIResponse(parsed);
  }
}
