import {SOURCE_VERIFICATION_CONTRACTS} from './prompts.ts';
import {sourceCalendar} from './calendar.ts';
import {requireValid,uuid,validateExtractionWindow} from './protocol.ts';
import type {ExtractedFact,ExtractionWindow,MemoryEvent} from './protocol.ts';
// 从锁定原Python adapter 的动态分支逐字移植；不改变提示合同。
const REPLACEMENTS = [["当前瞬时状态的valid_at取其证据occurred_at观察点，invalid_at可按来源自身时区取\n当日结束的检索边界；它不声称真实状态恰在该点结束，不因为原话没给实际结束时刻\n就拒绝此既定观察边界。原话明确期间仍完整保留，不能任意提前截断或延长。", "没有原话明示期限的瞬时状态、暂时请求，两有效期必须为null；不能按消息时点或当天结束补造期限。"], ["未来安排、当前临时状态和暂时请求按原期间／观察点规则另核；", "未来安排、当前临时状态和暂时请求只按原话明示期间另核；"], ["暂时关系请求的正文须保留来源日期与暂时限定；valid_at已填观察点不能替正文补日期。", "暂时关系请求须保留来源日期与暂时限定；来源日期不作为事实适用起点。"]];
const ADDITIONS = ["\n直接提取时间核验：只用各消息source_calendar_at解释当地日历，相对表达须归属该消息；unknown时不使用occurred_at的数据库时区替代。event v2须保留原表达与年/月/日/时刻精度，事件阶段、发生日期和事实适用期分开核验；转述时点未确定保持日期未知。证据位置从原消息text的0起计，不能准确数出局部位置时可用[0,text_length)引用完整原消息，不能猜越界索引；引用整条原消息不代替逐项语义核验。", "\nconditions须逐项独立核验，condition_verification列全每项index、verdict、evidence位置；通用supported不代签条件。只核验原话对条件限定的支持，不能认证现在仍满足，更不能从条件变化推断原禁忌或偏好撤销。无条件提案返回null。", "\n有event提案时另填event_verification：分别独立判断stage与occurrence_start/end，不能沿用正文verdict。每项给supported/uncertain/unsupported及本候选原来源的message_id/quote，quote逐字引用实际原消息内唯一的完整片段，不自行计算字符索引；时间引句须包含完整occurrence_expression，重复有歧义时扩大上下文直至唯一；未知时间用uncertain，不能凭当前时间判发生。位置只定位，不代替含义核验；资料无event则该槽null。"];
const position={type:'object',additionalProperties:false,properties:{message_id:{type:'string',format:'uuid'},char_start:{type:'integer',minimum:0},char_end:{type:'integer',minimum:1}},required:['message_id','char_start','char_end']};
const quote={type:'object',additionalProperties:false,properties:{message_id:{type:'string',format:'uuid'},quote:{type:'string',minLength:1,maxLength:8192}},required:['message_id','quote']};
const verdict={type:'string',enum:['supported','uncertain','unsupported']};
export function buildSourceVerificationContract(facts:ExtractedFact[],mode:'legacy-v4'|'nullable-proof-v3'='legacy-v4',options:{require_complete_evidence?:boolean}={}):{prompt:string;schema:Record<string,any>} {
  requireValid(['legacy-v4','nullable-proof-v3'].includes(mode)&&facts.length<=60);
  requireValid(!options.require_complete_evidence||mode==='legacy-v4');
  const base=SOURCE_VERIFICATION_CONTRACTS[mode];let prompt:string=base.prompt;
  const schema=structuredClone(base.schema) as Record<string,any>,properties=schema.properties.results.items.properties;
  if(facts.some(f=>f.requires_all_sources)){for(const [before,after] of REPLACEMENTS)prompt=prompt.replace(before,after);prompt+=ADDITIONS[0];}
  if(facts.some(f=>f.conditions!==null)){properties.condition_verification={type:['array','null'],maxItems:8,items:{type:'object',additionalProperties:false,properties:{index:{type:'integer',minimum:0},verdict,evidence:{type:'array',maxItems:8,items:position}},required:['index','verdict','evidence']}};prompt+=ADDITIONS[1];}
  if(facts.some(f=>f.event!==null)){properties.event_verification={type:['object','null'],additionalProperties:false,properties:{stage_verdict:verdict,occurrence_verdict:verdict,stage_evidence:{type:'array',maxItems:8,items:quote},occurrence_evidence:{type:'array',maxItems:8,items:quote}},required:['stage_verdict','occurrence_verdict','stage_evidence','occurrence_evidence']};prompt+=ADDITIONS[2];}
  if(options.require_complete_evidence){
    prompt+='\n本次 direct 核验必须完整覆盖候选声明的来源：supported 时，candidate.source_message_ids 中每条消息都须在 evidence 中有非空逐字引文，且仍至少包含一条 target。不能只引用回答而遗漏候选声明依赖的相连问句或其他来源；重复同一消息的引文不能补足遗漏。无法核对完整依据时不得签 supported，标 insufficient_evidence；不得替候选补来源或编造引文。完整覆盖只是必要条件，仍逐项核对主体、正文和限定。';
    properties.evidence.description='supported 时逐条覆盖该候选 source_message_ids 的真实逐字引文；重复引用不能补足遗漏，完整覆盖不代替语义核验。';
  }
  return {prompt,schema};
}
function eventPayload(event:MemoryEvent):Record<string,unknown> {
 const {occurrence_precision,occurrence_expression,anchor_message_id,...base}=event;
 const normalized={...base,occurrence_start:modelISO(base.occurrence_start),occurrence_end:modelISO(base.occurrence_end)};
 return event.version===2?{...normalized,occurrence_precision,occurrence_expression,anchor_message_id}:normalized;
}
function modelISO(raw:string|null):string|null {
 if(raw===null)return null;
 const match=raw.match(/^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d)(:\d\d)?(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/)!;
 const micros=(match[4]??'').slice(0,6).padEnd(6,'0');
 return `${match[1]}T${match[2]}${match[3]??':00'}${Number(micros)?'.'+micros:''}${match[5]==='Z'?'+00:00':match[5]}`;
}
export function sourceCalendarPayload(message:ExtractionWindow['messages'][number]):string {
 const anchor=sourceCalendar(message);if(!anchor)return 'unknown';
 const raw=message.source_snapshots![0].raw_payload as Record<string,unknown>;return modelISO(raw.time_iso as string)!;
}
export function buildSourceVerificationPayload(window:ExtractionWindow,facts:ExtractedFact[],options:{positionGuide?:boolean}={}):Record<string,unknown> {
 validateExtractionWindow(window);requireValid(facts.length<=60);
 const targets=new Set((window.target_message_ids??window.messages.map(m=>m.message_id)).map(uuid)),direct=facts.some(f=>f.requires_all_sources);
 const payload:Record<string,unknown>={messages:window.messages.map(m=>({message_id:uuid(m.message_id),role:targets.has(uuid(m.message_id))?'target':'context',sender:m.sender,occurred_at:modelISO(m.occurred_at)??'unknown',text:m.text,...(direct?{source_calendar_at:sourceCalendarPayload(m),text_length:Array.from(m.text).length}:{})})),
 candidates:facts.map((f,candidate_index)=>({candidate_index,text:f.text,subject:f.subject,category:f.category,topic:f.topic,source_message_ids:f.source_message_ids,valid_at:modelISO(f.valid_at),invalid_at:modelISO(f.invalid_at),speech_act:f.speech_act,assertion_status:f.assertion_status,figurative_type:f.figurative_type,...(f.event?{event:eventPayload(f.event)}:{}),...(f.conditions?{conditions:f.conditions}:{})}))};
 if(options.positionGuide){
  const texts=[...window.messages.map(message=>message.text),...facts.map(fact=>fact.text)];
  if(window.messages.length<=4&&texts.every(text=>Array.from(text).length<=4096)&&texts.reduce((sum,text)=>sum+Array.from(text).length,0)<=8192){
   const ruler=(text:string)=>({codepoint_length:Array.from(text).length,blocks:Array.from(text).map((character,start)=>({start,end:start+1,text:character}))});
   payload.position_guide={version:2,unit:'unicode_codepoint',block_width:1,
    messages:window.messages.map(message=>({message_id:uuid(message.message_id),...ruler(message.text)})),
    candidates:facts.map((fact,candidate_index)=>({candidate_index,...ruler(fact.text)}))};
   if(Buffer.byteLength(JSON.stringify(payload.position_guide),'utf8')>128*1024)delete payload.position_guide;
  }
 }
 return payload;
}
