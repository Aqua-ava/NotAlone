import {verifyEvent,groundedEventProposal,groundedValidity} from './calendar.ts';
import {ExtractionProtocolError,object,requireValid,uuid,text,choices,stringArray,when,instantMicros,exactFields,positions,sourcePositions} from './validators.ts';
// 既有调用方仍从 protocol.ts 取校验原语。
export {ExtractionProtocolError,object,requireValid,uuid,text,choices,stringArray,when,instantMicros,exactFields,positions,sourcePositions};
/** direct E 与完整命题 V 的确定性边界；模型调用、许可、重试和写入由宿主负责。 */
export interface ExtractionMessage {
  message_id: string; text: string; sender: 'self'|'contact'; occurred_at: string|null;
  content_kind?:string;
  image?:{id:string;file_id:string;sha256:string;mime_type:string;media_generation:string};
  text_representation?: string; message_snapshot?: Record<string, unknown>;
  source_snapshots?: Record<string, unknown>[];
}
export interface ExtractionWindow {
  owner_id: string; contact_id: string; messages: ExtractionMessage[]; target_message_ids?: string[]|null;
}
export interface EvidencePosition {message_id:string;char_start:number;char_end:number}
export interface MemoryConditions {version:1;items:{text:string;evidence:EvidencePosition[];source_supported:boolean}[]}
export interface MemoryEvent {
  version:1|2; stage:string; stage_evidence:EvidencePosition[]; stage_verified:boolean;
  occurrence_start:string|null; occurrence_end:string|null; occurrence_evidence:EvidencePosition[];
  occurrence_verified:boolean; occurrence_precision:string; occurrence_expression:string|null; anchor_message_id:string|null;
}
export interface ExtractedFact {
  text:string;category:string;subject:string;topic:string;source_message_ids:string[];confidence:number;
  risk_flags:string[];valid_at:string|null;invalid_at:string|null;speech_act:string;assertion_status:string;
  figurative_type:string;alternatives:string[];interpretation_reason:string;requires_all_sources:boolean;
  source_dependency_mode:'any'|'all';_scene_name:string;event:MemoryEvent|null;conditions:MemoryConditions|null;
  timing:{source_started_at:string|null;source_ended_at:string|null;source_time_complete:boolean};
}
export interface SourceVerificationResult {
  candidate_index:number;verdict:'supported'|'uncertain'|'unsupported';issues:string[];
  evidence:{message_id:string;quote:string}[];verification_mode:'complete-claim-v1'|'multimodal-claim-v1';
  content_evidence?:{message_id:string;kind:'text'|'image';quote:string|null;file_id:string|null;sha256:string|null;description:string|null}[];
  model_verdict:'supported'|'uncertain'|'unsupported';model_issues:string[];event:MemoryEvent|null;conditions:MemoryConditions|null;
  /** 保留完整命题与图文存档的固定空槽，不再承载旧有限图证明。 */
  proof:null;proof_verification:null;
  /** 发生时间标注（event）可选：核验不可采纳时丢弃 event 并置真，不参与整条候选的准入；不覆盖 valid_at/invalid_at。 */
  time_unverified?:boolean;
  model_claim_check?:unknown;
  claim_validation?:{status:'checked'|'invalid'|'unverified';policy_fingerprint:string;reason:string;semantic_support:'supported'|'uncertain'|'unsupported'};
}
export function validateExtractionWindow(window:ExtractionWindow):void {
  uuid(window.owner_id);uuid(window.contact_id);
  requireValid(Array.isArray(window.messages)&&window.messages.length>0);
  let last:bigint|null=null;
  for(const message of window.messages){uuid(message.message_id);
    if(message.image){
      uuid(message.image.file_id);requireValid(message.image.id===message.image.file_id&&/^[a-f0-9]{64}$/.test(message.image.sha256)
        &&['image/png','image/jpeg','image/webp','image/gif'].includes(message.image.mime_type)&&/^(0|[1-9][0-9]*)$/.test(message.image.media_generation)
        &&typeof message.text==='string'&&typeof message.content_kind==='string'&&message.content_kind.length>0);
    }else text(message.text);
    choices(message.sender,['self','contact']);
    when(message.occurred_at);if(message.occurred_at!==null){const time=instantMicros(message.occurred_at);requireValid(last===null||time>=last);last=time;}}
  if(window.target_message_ids!=null){requireValid(Array.isArray(window.target_message_ids)&&window.target_message_ids.length>0&&window.target_message_ids.length<=20);
    const ids=new Set(window.messages.map(m=>uuid(m.message_id)));for(const id of window.target_message_ids)requireValid(ids.has(uuid(id)));}
}
function parseConditions(value:unknown):MemoryConditions|null {
  if(value==null)return null;
  const raw=object(value);exactFields(raw,['version','items']);requireValid(raw.version===1&&Array.isArray(raw.items)&&raw.items.length>=1&&raw.items.length<=8);
  return {version:1,items:raw.items.map((entry:unknown)=>{const item=object(entry);exactFields(item,['text','evidence']);
    const label=text(item.text);requireValid(Array.from(label).length<=1000);
    return {text:label,evidence:positions(item.evidence),source_supported:false};})};
}
function parseEvent(value:unknown):MemoryEvent|null {
  if(value==null)return null;
  const raw=object(value);requireValid(raw.version===1||raw.version===2);
  exactFields(raw,['version','stage','stage_evidence','occurrence_start','occurrence_end','occurrence_evidence',...(raw.version===2?['occurrence_precision','occurrence_expression','anchor_message_id']:[])]);
  const start=when(raw.occurrence_start),end=when(raw.occurrence_end);
  requireValid(end===null||start!==null&&instantMicros(end)>instantMicros(start));
  const precision=raw.version===2?choices(raw.occurrence_precision,['year','month','day','instant','unknown']):'unknown';
  requireValid(raw.version!==2||precision!=='unknown'||start===null);
  const expression=raw.occurrence_expression==null?null:text(raw.occurrence_expression);requireValid(expression===null||Array.from(expression.trim()).length<=256);
  return {version:raw.version,stage:choices(raw.stage,['planned','agreed','rescheduled','cancelled','occurred','unknown']),stage_evidence:positions(raw.stage_evidence),stage_verified:false,
    occurrence_start:start,occurrence_end:end,occurrence_evidence:positions(raw.occurrence_evidence),occurrence_verified:false,occurrence_precision:precision,
    occurrence_expression:expression,anchor_message_id:raw.anchor_message_id==null?null:uuid(raw.anchor_message_id)};
}
/** 低把握候选的最低置信度（对齐腾讯偏好类阈值）：低于此线在解析后丢弃并记 low_value_dropped，不影响批次完成。 */
export const LOW_VALUE_EXTRACTION_CONFIDENCE=0.5;

/** malformed scene 拒绝一项；malformed memory 逐项拒绝；顶层缺 scenes 属整次输出错误。 */
export function parseDirectExtraction(payload:unknown,window:ExtractionWindow):{accepted:ExtractedFact[];rejected_count:number;extraction_completed:true} {
  validateExtractionWindow(window);
  const raw=object(payload);requireValid(Array.isArray(raw.scenes));
  const accepted:ExtractedFact[]=[];let rejected_count=0;
  const windowIds=new Set(window.messages.map(m=>uuid(m.message_id))),targets=new Set((window.target_message_ids??window.messages.map(m=>m.message_id)).map(uuid));
  for(const sceneRaw of raw.scenes){
    let scene:Record<string,any>;
    try{scene=object(sceneRaw);text(scene.scene_name);requireValid(Array.isArray(scene.memories));}catch{rejected_count++;continue;}
    for(const entry of scene.memories){try{
      const p=groundedEventProposal(object(entry),window),source_message_ids=(requireValid(Array.isArray(p.source_message_ids)&&p.source_message_ids.length>0),p.source_message_ids.map(uuid));
      requireValid(source_message_ids.every((id:string)=>windowIds.has(id))&&source_message_ids.some((id:string)=>targets.has(id)));
      const confidence=Number(p.confidence);requireValid(['number','string','boolean'].includes(typeof p.confidence)&&(typeof p.confidence!=='string'||p.confidence.trim())&&Number.isFinite(confidence)&&confidence>=0&&confidence<=1);
      const valid_at=when(p.valid_at),invalid_at=when(p.invalid_at);requireValid(valid_at===null||invalid_at===null||instantMicros(invalid_at)>instantMicros(valid_at));
      const times=window.messages.filter(m=>source_message_ids.includes(uuid(m.message_id))).map(m=>m.occurred_at);
      const known=times.filter((t):t is string=>t!==null).sort((a,b)=>Date.parse(a)-Date.parse(b));
      const fact:ExtractedFact={text:text(p.text),category:choices(p.category,['common_fact','preference','taboo','recent_state','relationship_note']),subject:choices(p.subject,['self','contact','shared']),
        topic:choices(p.topic,['health','work','family','travel','finance','study','emotion','other']),source_message_ids,confidence,risk_flags:stringArray(p.risk_flags),valid_at,invalid_at,
        speech_act:choices(p.speech_act,['assertion','plan','question','request','report','correction','unknown']),assertion_status:choices(p.assertion_status,['asserted','hypothetical','conditional','reported','unknown']),
        figurative_type:choices(p.figurative_type,['literal','joke','sarcasm','hyperbole','unknown']),alternatives:stringArray(p.alternatives),interpretation_reason:text(p.interpretation_reason),
        requires_all_sources:true,source_dependency_mode:'any',_scene_name:scene.scene_name,event:parseEvent(p.event),conditions:parseConditions(p.conditions),
        timing:{source_started_at:known[0]??null,source_ended_at:known.at(-1)??null,source_time_complete:times.every(t=>t!==null)}};
      for(const condition of fact.conditions?.items??[])sourcePositions(condition.evidence,fact,window);
      const event=fact.event;
      if(event?.version===2&&event.stage==='unknown'&&event.stage_evidence.length===0&&['unknown','day'].includes(event.occurrence_precision)&&event.occurrence_start===null&&event.occurrence_end===null){
        const anchor=window.messages.find(m=>uuid(m.message_id)===event.anchor_message_id);
        const expression=event.occurrence_expression;
        const grounded=anchor&&fact.source_message_ids.includes(uuid(anchor.message_id))&&expression?.trim()&&event.occurrence_evidence.some(ref=>ref.message_id===event.anchor_message_id&&ref.char_end<=Array.from(anchor.text).length&&Array.from(anchor.text).slice(ref.char_start,ref.char_end).join('').includes(expression));
        if(grounded){sourcePositions(event.occurrence_evidence,fact,window);fact.event=null;}
      }
      let prepared=groundedValidity(fact,window);
      if(prepared.valid_at!==null){const flag=times.some(t=>t===null)?'pragmatic:unknown_source_time':instantMicros(prepared.valid_at)>instantMicros(known.at(-1)!)?'pragmatic:future_validity':null;
        if(flag)prepared={...prepared,risk_flags:[...new Set([...prepared.risk_flags,flag])]};}
      accepted.push(prepared);
    }catch{rejected_count++;}}
  }
  return {accepted,rejected_count,extraction_completed:true};
}

function verifyConditions(raw:unknown,fact:ExtractedFact,window:ExtractionWindow):MemoryConditions|null {
  if(raw==null)return fact.conditions;
  requireValid(fact.conditions!==null&&Array.isArray(raw)&&raw.length===fact.conditions.items.length);
  const items=new Map<number,MemoryConditions['items'][number]>();
  for(const value of raw){const row=object(value);exactFields(row,['index','verdict','evidence']);
    requireValid(Number.isInteger(row.index)&&row.index>=0&&row.index<fact.conditions.items.length&&!items.has(row.index));
    const verdict=choices(row.verdict,['supported','uncertain','unsupported']),refs=positions(row.evidence);sourcePositions(refs,fact,window);
    requireValid(verdict!=='supported'||refs.length>0);
    items.set(row.index,{...fact.conditions.items[row.index],evidence:refs,source_supported:verdict==='supported'});
  }
  return {version:1,items:Array.from({length:fact.conditions.items.length},(_,index)=>items.get(index)!)};
}
function eventAdoptionVerified(event:ExtractedFact['event']):boolean {
 return event===null||event.stage_verified&&(event.occurrence_verified||event.stage==='cancelled');
}
function conditionsAdoptionVerified(conditions:ExtractedFact['conditions']):boolean {
 return conditions===null||conditions.items.every(item=>item.source_supported);
}

export function validateSourceVerification(payload:unknown,window:ExtractionWindow,facts:ExtractedFact[]):SourceVerificationResult[] {
  validateExtractionWindow(window);requireValid(facts.length<=60&&Array.isArray(payload)&&payload.length===facts.length);
  const results=new Map<number,SourceVerificationResult>();
  for(const item of payload){const raw=object(item),required=['candidate_index','verdict','issues','evidence'];
    requireValid(required.every(k=>Object.hasOwn(raw,k))&&Object.keys(raw).every(k=>[...required,'event_verification','condition_verification'].includes(k)));
    const index=raw.candidate_index;requireValid(Number.isInteger(index)&&index>=0&&index<facts.length&&!results.has(index));
    let verdict=choices(raw.verdict,['supported','uncertain','unsupported']) as SourceVerificationResult['verdict'];
    let issues=stringArray(raw.issues).map(issue=>choices(issue,['meaning','subject','negation','degree','quantity','condition','time','pragmatics','disconnected_context','insufficient_evidence']));
    requireValid(verdict==='supported'?issues.length===0:issues.length>0);requireValid(Array.isArray(raw.evidence));
    const fact=facts[index],evidence=raw.evidence.map((entry:unknown)=>{const quote=object(entry);exactFields(quote,['message_id','quote']);
      const message_id=uuid(quote.message_id),message=window.messages.find(m=>uuid(m.message_id)===message_id);
      requireValid(fact.source_message_ids.includes(message_id)&&message&&message.text.includes(text(quote.quote)));
      return {message_id,quote:quote.quote as string};});
    const targets=new Set((window.target_message_ids??window.messages.map(m=>m.message_id)).map(uuid));
    requireValid(verdict!=='supported'||evidence.length>0&&evidence.some((e:{message_id:string})=>targets.has(e.message_id)));
    const modelVerdict=verdict,modelIssues=[...issues];
    const unresolved=verdict==='supported'&&unresolvedAuthorQuote(window,fact);
    if(unresolved){verdict='uncertain';issues=['pragmatics'];}
    const event=verifyEvent(raw.event_verification,fact,window),conditions=verifyConditions(raw.condition_verification,fact,window);
    // 时间标注是可选信息：不可采纳时只丢时间并保留候选正文，不把整条候选判为不通过。
    const timeUnverified=event!==null&&!eventAdoptionVerified(event);
    if(!conditionsAdoptionVerified(conditions)){
      verdict='unsupported';
      if(!issues.includes('condition'))issues=[...issues,'condition'];
    }
    results.set(index,{candidate_index:index,verdict,issues,evidence,model_verdict:modelVerdict,model_issues:modelIssues,
      verification_mode:'complete-claim-v1',event:timeUnverified?null:event,conditions,proof:null,proof_verification:null,
      ...(timeUnverified?{time_unverified:true}:{})});
  }
  return Array.from({length:facts.length},(_,index)=>results.get(index)!);
}

function unresolvedAuthorQuote(window:ExtractionWindow,fact:ExtractedFact):boolean {
  if(window.messages.length!==1||(window.target_message_ids??window.messages).length!==1)return false;
  const message=window.messages[0],id=uuid(message.message_id);
  if(!(window.target_message_ids??[id]).map(uuid).includes(id)||fact.source_message_ids.length!==1||fact.source_message_ids[0]!==id||Array.from(message.text).length>4096||Array.from(fact.text).length>4096)return false;
  if(fact.text!==(message.sender==='self'?'用户':'联系人')+'原话：“'+message.text+'”')return false;
  const body=message.text.trim().replace(/。$/,'');
  const lend=body.match(/^(我姐|我哥)(昨天|前天)?(没有|没)?把(她|他)的(车|书|雨伞)借给我(了)?(?:。这里的“(她|他)”指(我姐|我哥|我同事))?$/);
  if(lend){const negative=lend[3]!==undefined,completion=lend[6]!==undefined;
    if(negative===completion||negative&&lend[2]===undefined)return false;
    if(lend[7]!==undefined)return false;
    return true;
  }
  return message.sender==='self'&&/^(我姐|我哥|我同事)让我(周末|明天|后天)帮(她|他)顶个班$/.test(body);
}

/** 默认生产路径显式开启逐项隔离；严格 validator 保留整批合同供固定存档重放使用。 */
export function parseSourceVerification(payload:unknown,window:ExtractionWindow,facts:ExtractedFact[],options:{isolate_items?:boolean}={}):SourceVerificationResult[] {
  const root=object(payload);exactFields(root,['results']);requireValid(Array.isArray(root.results)&&facts.length<=60);
  const converted=root.results.map((entry:unknown)=>{
    if(entry===null||typeof entry!=='object'||Array.isArray(entry))return entry;
    const row=entry as Record<string,any>,index=row.candidate_index,event=row.event_verification;
    if(!Number.isInteger(index)||index<0||index>=facts.length||event===null||typeof event!=='object'||Array.isArray(event))return entry;
    const adjusted={...event};
    for(const key of ['stage_evidence','occurrence_evidence'])if(Array.isArray(event[key]))adjusted[key]=event[key].map((ref:unknown)=>{
      if(ref===null||typeof ref!=='object'||Array.isArray(ref))return ref;
      const item=ref as Record<string,any>;
      if(Object.keys(item).length!==2||!Object.hasOwn(item,'message_id')||!Object.hasOwn(item,'quote'))return ref;
      const message=window.messages.find(m=>m.message_id===item.message_id),quote=item.quote;
      if(!message||!facts[index].source_message_ids.includes(item.message_id)||message.text_representation!=='text'||typeof quote!=='string'||!quote.trim()||Array.from(quote).length>8192)return ref;
      const start=message.text.indexOf(quote);
      if(start<0||message.text.indexOf(quote,start+1)>=0)return ref;
      const char_start=Array.from(message.text.slice(0,start)).length;
      return {message_id:item.message_id,char_start,char_end:char_start+Array.from(quote).length};
    });
    return {...row,event_verification:adjusted};
  });
  if(!options.isolate_items)return validateSourceVerification(converted,window,facts);
  return facts.map((fact,index)=>{
    const matches=converted.filter((value:unknown)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Number.isInteger((value as any).candidate_index)&&(value as any).candidate_index===index);
   try{
    requireValid(matches.length===1);
    const result=validateSourceVerification([{...(matches[0] as object),candidate_index:0}],window,[fact])[0]!;
    return {...result,candidate_index:index};
   }catch(error){
    if(!(error instanceof ExtractionProtocolError))throw error;
    return {candidate_index:index,verdict:'unsupported' as const,issues:['insufficient_evidence'],evidence:[],
     verification_mode:'complete-claim-v1' as const,model_verdict:'unsupported' as const,model_issues:['insufficient_evidence'],
     event:fact.event,conditions:fact.conditions,proof:null,proof_verification:null};
   }
  });
}
