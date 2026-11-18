/** 仅用于 SourceVerificationOutput 的 DeepSeek Beta strict 工具传输合同。 */
export const DEEPSEEK_STRICT_VERIFICATION_ENDPOINT='https://api.deepseek.com/beta/chat/completions';
export const DEEPSEEK_STRICT_VERIFICATION_TOOL='SourceVerificationOutput';

export interface DeepSeekStrictVerificationTool {
  name:typeof DEEPSEEK_STRICT_VERIFICATION_TOOL;
  description:string;
  parameters:Record<string,unknown>;
}
export interface DeepSeekStrictVerificationRequestInput {
  model:string;system:string;user:string;tool:DeepSeekStrictVerificationTool;
  maxTokens:number;temperature?:number;reasoningEffort:'off'|'low'|'high'|'max';
  endpoint?:string;
  images?:readonly {mimeType:string;dataBase64:string}[];
}
export interface DeepSeekStrictVerificationRequest {
  endpoint:string;
  body:Record<string,unknown>;
}
export interface DeepSeekStrictVerificationUsage {
  input_tokens:number;output_tokens:number;
  cache_read_tokens:number|null;cache_write_tokens:number|null;
}
export interface DeepSeekStrictVerificationResponse {
  blocks:({type:'text';text:string}|{type:'tool-call';id:string;name:string;arguments:string})[];
  usage:DeepSeekStrictVerificationUsage|null;
  success:boolean;
}

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const invalid=():never=>{throw new Error('deepseek_strict_schema_invalid');};
const DROPPED=new Set(['minLength','maxLength','minItems','maxItems']);
const KEYWORDS=new Set(['type','title','description','default','properties','required','additionalProperties',
  'items','enum','const','format','pattern','minimum','maximum','exclusiveMinimum','exclusiveMaximum',
  'multipleOf','oneOf','anyOf']);
const TYPES=new Set(['object','string','number','integer','boolean','array','null']);

function typeBranches(source:Record<string,unknown>,path:string):Record<string,unknown>{
  const declared=source.type as unknown[];
  if(declared.length<2||declared.some(value=>typeof value!=='string'||!TYPES.has(value))
    ||new Set(declared).size!==declared.length)invalid();
  const {type:_type,...rest}=source;
  return {anyOf:declared.map((value,index)=>{
    const type=value as string;
    if(type==='null')return {type:'null'};
    return strictNode({...rest,type},`${path}.anyOf[${index}]`);
  })};
}

/** 只把已审阅的生产核验合同转换为 DeepSeek strict 支持的子集。 */
export function deepSeekStrictVerificationSchema(input:Record<string,unknown>):Record<string,unknown>{
  const converted=strictNode(input,'$');
  if(!object(converted)||converted.type!=='object')invalid();
  return converted;
}

function strictNode(input:Record<string,unknown>,path:string):Record<string,unknown>{
  if(!object(input))invalid();
  for(const key of Object.keys(input))if(!KEYWORDS.has(key)&&!DROPPED.has(key))invalid();
  if(Array.isArray(input.type))return typeBranches(input,path);
  const output:Record<string,unknown>={};
  for(const [key,value] of Object.entries(input)){
    if(DROPPED.has(key))continue;
    if(key==='properties'){
      if(!object(value))invalid();
      output.properties=Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([name,child])=>{
        if(!object(child))invalid();return [name,strictNode(child as Record<string,unknown>,`${path}.properties.${name}`)];
      }));
    }else if(key==='items'){
      if(!object(value))invalid();output.items=strictNode(value as Record<string,unknown>,`${path}.items`);
    }else if(key==='oneOf'||key==='anyOf'){
      if(!Array.isArray(value)||value.length===0||value.some(item=>!object(item)))invalid();
      output.anyOf=(value as unknown[]).map((item,index)=>strictNode(item as Record<string,unknown>,`${path}.${key}[${index}]`));
    }else if(key==='const'){
      if(typeof value!=='string'&&typeof value!=='number'&&typeof value!=='boolean')invalid();
      output.enum=[value];
    }else output[key]=structuredClone(value);
  }
  if(output.type==='object'&&output.properties){
    output.additionalProperties=false;
    output.required=Object.keys(output.properties as Record<string,unknown>);
  }
  return output;
}

export function buildDeepSeekStrictVerificationRequest(
  input:DeepSeekStrictVerificationRequestInput,
):DeepSeekStrictVerificationRequest{
  if(!input||input.tool?.name!==DEEPSEEK_STRICT_VERIFICATION_TOOL
    ||typeof input.system!=='string'||!input.system.trim()
    ||typeof input.user!=='string'||!input.user.trim()
    ||typeof input.model!=='string'||!input.model.trim()
    ||!Number.isSafeInteger(input.maxTokens)||input.maxTokens<1
    ||input.temperature!==undefined&&(!Number.isFinite(input.temperature)||input.temperature<0||input.temperature>2)
    ||!['off','low','high','max'].includes(input.reasoningEffort))invalid();
  const thinking=input.reasoningEffort==='off'?'disabled':'enabled';
  const body:Record<string,unknown>={
    model:input.model,
    stream:false,
    messages:[{role:'system',content:input.system},{role:'user',content:input.images?.length
      ? [{type:'text',text:input.user},...input.images.map(image=>({type:'image_url',image_url:{url:`data:${image.mimeType};base64,${image.dataBase64}`}}))]
      : input.user}],
    max_tokens:input.maxTokens,
    thinking:{type:thinking},
    reasoning_effort:input.reasoningEffort==='off'?'none':input.reasoningEffort,
    tools:[{type:'function',function:{name:DEEPSEEK_STRICT_VERIFICATION_TOOL,
      description:input.tool.description,parameters:deepSeekStrictVerificationSchema(input.tool.parameters),strict:true}}],
  };
  if(input.temperature!==undefined)body.temperature=input.temperature;
  // 思考模式禁止指定 tool_choice；此时只保留唯一 strict 工具。
  if(input.reasoningEffort==='off')body.tool_choice={type:'function',function:{name:DEEPSEEK_STRICT_VERIFICATION_TOOL}};
  return {endpoint:input.endpoint??DEEPSEEK_STRICT_VERIFICATION_ENDPOINT,body};
}

const count=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
export function decodeDeepSeekStrictVerificationResponse(payload:unknown):DeepSeekStrictVerificationResponse{
  if(!object(payload))invalid();
  const root=payload as Record<string,unknown>,choicesValue=root.choices;
  if(!Array.isArray(choicesValue)||choicesValue.length<1||!object(choicesValue[0]))invalid();
  const choices=choicesValue as unknown[],choice:Record<string,unknown>=choices[0] as Record<string,unknown>,rawMessage=choice.message;
  if(!object(rawMessage))invalid();
  const message=rawMessage as Record<string,unknown>;
  const blocks:DeepSeekStrictVerificationResponse['blocks']=[];
  if(typeof message.content==='string'&&message.content.length)blocks.push({type:'text',text:message.content});
  const toolCallsValue=message.tool_calls;
  if(toolCallsValue!==undefined){
    if(!Array.isArray(toolCallsValue))invalid();
    for(const call of toolCallsValue as unknown[]){
      if(!object(call)||typeof call.id!=='string'||!call.id
        ||!object(call.function)||typeof call.function.name!=='string'
        ||typeof call.function.arguments!=='string')invalid();
      const checked=call as Record<string,unknown>,fn=checked.function as Record<string,unknown>;
      blocks.push({type:'tool-call',id:checked.id as string,name:fn.name as string,arguments:fn.arguments as string});
    }
  }
  let usage:DeepSeekStrictVerificationUsage|null=null;
  const rawUsage=root.usage;
  if(rawUsage!==undefined&&rawUsage!==null){
    if(!object(rawUsage))invalid();
    const checked=rawUsage as Record<string,unknown>,cache=checked.prompt_cache_hit_tokens;
    if(!count(checked.prompt_tokens)||!count(checked.completion_tokens))invalid();
    if(cache!==undefined&&cache!==null&&(!count(cache)||Number(cache)>Number(checked.prompt_tokens)))invalid();
    usage={input_tokens:Number(checked.prompt_tokens),output_tokens:Number(checked.completion_tokens),
      cache_read_tokens:cache===undefined||cache===null?null:Number(cache),cache_write_tokens:null};
  }
  return {blocks,usage,success:['stop','tool_calls'].includes(String(choice.finish_reason))};
}
