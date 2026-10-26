import { canonicalJSON, digest, type Evidence } from './sources.ts';
import { boundedContract as contract } from './bounded-contract.ts';
import { length, slice, textSpan, messageSpan, representationPayload, type Message, type Representation } from './bounded-body.ts';
import { pythonISO } from '../projection/time.ts';

type Part = { message: Message; text: string; start: number; order: [number,number]; sender: string };
type Location = [Part,number,number];
type Parsed = { part: Part; match: RegExpExecArray; kind: string };
type Graph = { rule: string; frame: string; roles: Evidence[]; atoms: Evidence[]; qualifiers: Evidence[]; bindings: Evidence[]; event: Part };
const trimSpaces = (text: string): string => text.replace(/^ +| +$/gu,'');
const keysEqual = (left: unknown,right: unknown): boolean => canonicalJSON(left) === canonicalJSON(right);

function sourceParts(messages: Message[]): Part[] {
  const parts: Part[] = [];
  messages.forEach((message,index) => {
    const body = trimSpaces(message.text), offset = length(message.text) - length(message.text.replace(/^ +/u,''));
    if (!body) parts.push({ message,text:'',start:offset,order:[index,offset],sender:message.sender });
    for (const match of body.matchAll(/[^。]+。?|。/gu)) {
      const start = offset + length(body.substring(0,match.index));
      parts.push({ message,text:match[0],start,order:[index,start],sender:message.sender });
    }
  });
  return parts;
}
function candidateParts(messages: Message[], text: string, rep: Representation): Part[] {
  const part = (message: Message, value: string,start: number,sourceStart: number,sourceEnd: number,sender: string): Part => {
    const left = !trimSpaces(slice(message.text,0,sourceStart)) ? length(value)-length(value.replace(/^ +/u,'')) : 0;
    const right = !trimSpaces(slice(message.text,sourceEnd)) ? length(value.replace(/ +$/u,'')) : length(value);
    return { message,text:slice(value,left,right),start:start+left,order:[messages.findIndex(item => item.message_id === message.message_id),sourceStart],sender };
  };
  return [part(rep.target,slice(text,rep.quote_start,rep.quote_end),rep.quote_start,rep.main[0].start,rep.main.at(-1)!.end,rep.author === '用户' ? 'self':'contact'),
    ...rep.contexts.map(({unit,start,end}) => {
      const author = slice(text,start).startsWith('用户说“') ? '用户':'联系人', quoteStart=start+length(author+'说“');
      return part(unit.message,slice(text,quoteStart,end-1),quoteStart,unit.start,unit.end,author === '用户' ? 'self':'contact');
    })];
}
function instant(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return 'invalid';
  const fraction = value.match(/\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/u)?.[1] ?? '';
  return parsed.toISOString().slice(0,19) + '.' + fraction.padEnd(6,'0');
}
function sourceTime(message: Message): string | null {
  if (!message.occurred_at || !message.source_snapshots?.length) return null;
  const values = message.source_snapshots.map((snapshot: Evidence) => snapshot.raw_payload?.time_iso);
  if (values.some((raw: unknown) => typeof raw !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(raw) || instant(raw) !== instant(message.occurred_at!))) return null;
  if (new Set(values.map((raw: string) => raw.match(/(?:Z|[+-]\d{2}:\d{2})$/u)![0].replace('Z','+00:00'))).size !== 1) return null;
  return pythonISO(values[0]);
}
function nextDayInterval(anchor: string, days: number): Evidence {
  const offset = anchor.slice(-6), date = new Date(`${anchor.slice(0,10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate()+days);
  const start = date.toISOString().slice(0,19)+offset;
  date.setUTCDate(date.getUTCDate()+1);
  return {start,end:date.toISOString().slice(0,19)+offset};
}
function parse(parts: Part[], requestedFrame: string, source: boolean): Graph | null {
  const groups: Record<string,Parsed[]> = {events:[],identities:[],catalogs:[],questions:[]};
  for (const part of parts) {
    let found = false;
    for (const kind of ['roles','identity','arrival','lend','request','plan','question','answer']) {
      const grammar = (contract.GRAMMARS as Record<string,string>)[kind].replaceAll('(?P<','(?<');
      const match = new RegExp(`^(?:${grammar})$`,'du').exec(part.text);
      if (!match) continue;
      groups[kind === 'roles' ? 'catalogs' : kind === 'identity' ? 'identities' : kind === 'question' ? 'questions':'events'].push({part,match,kind});
      found = true; break;
    }
    if (!found) return null;
  }
  const {events,identities,catalogs,questions} = groups;
  if (events.length !== 1 || identities.length > 1 || catalogs.length > 1 || questions.length > 1) return null;
  const {part:event,match,kind} = events[0], value = match.groups!, identity=identities[0], catalog=catalogs[0], question=questions[0];
  if (['arrival','plan'].includes(kind) && (identities.length || catalogs.length || questions.length)) return null;
  if (kind === 'answer') {
    if (parts.length !== 2 || !question || identity || catalog || question.part.sender === event.sender || question.part.order[0]+1 !== event.order[0] || question.match.groups!.verb !== value.verb) return null;
  } else if (question) return null;
  if (['lend','request'].includes(kind)) {
    if (!identity || identity.part.sender !== event.sender || identity.match.groups!.pronoun !== value.pronoun || ![event.order[0],event.order[0]-1].includes(identity.part.order[0])) return null;
    if (kind === 'lend' && (value.negative ? !value.time || !!value.completion : value.completion !== '了')) return null;
    const roles = new Set([value.agent,identity.match.groups!.role]);
    if (catalog) {
      const cv = catalog.match.groups!, orderBefore = catalog.part.order[0] < identity.part.order[0] || catalog.part.order[0] === identity.part.order[0] && catalog.part.order[1] < identity.part.order[1];
      if (cv.first === cv.second || catalog.part.sender !== event.sender || !orderBefore || catalog.part.order[0] === event.order[0] || [...roles].some(role => ![cv.first,cv.second].includes(role))) return null;
      roles.add(cv.first); roles.add(cv.second);
    }
    if (roles.size > 2) return null;
  } else if (identity || catalog) return null;
  if (kind === 'request' && !['reported_request','received_request'].includes(requestedFrame)) return null;
  const frame = kind === 'request' ? requestedFrame:'direct';
  const rule = kind === 'arrival' ? 'BR_AUTHOR_ARRIVAL_V1' : kind === 'answer' ? 'BR_COMPLETED_QA_V1' : kind === 'plan' ? 'BR_COND_RUN_V1' : kind === 'request' ? 'BR_REQUEST_V1' : catalog ? 'BR_TWO_ROLES_V1':'BR_KIN_LEND_V1';
  const anchors = new Map<string,Location[]>(), roleKeys = new Map<string,[string|null,string]>();
  const anchor = (part:Part,start:number,end:number):Location => [part,part.start+start,part.start+end];
  const token = (name:string,part=event,matched=match):Location => {
    const indices = matched.indices!.groups![name];
    return anchor(part,length(part.text.substring(0,indices[0])),length(part.text.substring(0,indices[1])));
  };
  const role = (owner:string|null,kind:string,location:Location):string => {
    const key=JSON.stringify([owner,kind]); roleKeys.set(key,[owner,kind]); anchors.set(key,[...(anchors.get(key)??[]),location]); return key;
  };
  const whole=anchor(event,0,length(event.text)), authorAnchor=value.author ? token('author'):whole;
  const author=role(event.sender,'author',authorAnchor), atoms:Evidence[]=[], qualifiers:Evidence[]=[], bindings:Evidence[]=[];
  const atom=(predicate:string,phase:string,slots:Evidence,location:Location):void => { atoms.push({atom_id:atoms.length,predicate,phase,roles:Object.fromEntries(contract.ROLE_SLOTS.map(name=>[name,slots[name]??null])),span:location}); };
  const qualifier=(kind:string,location:Location,fields:Evidence):void => { qualifiers.push({kind,...fields,span:location}); };
  const time=(atomId:number,slot:string,name:string):boolean => {
    if (!value[name]) return true;
    const actual=sourceTime(event.message); if (event.message.occurred_at && !actual) return false;
    if (kind === 'plan' && !actual) return false;
    qualifier('time',token(name),{atom_id:atomId,slot,value:{token:(contract.TIME_TOKENS as Record<string,string>)[value[name]],anchor:actual,interval:kind === 'plan' ? nextDayInterval(actual!,value[name] === '明天' ? 1:2):null}}); return true;
  };
  bindings.push({role:author,method:'actual_sender',mention:authorAnchor,target:authorAnchor,binding:null});
  if (kind === 'arrival' || kind === 'answer') {
    const dp=kind === 'arrival' ? event:question.part, dm=kind === 'arrival' ? match:question.match;
    const destination=role(null,(contract.DESTINATION_TOKENS as Record<string,string>)[dm.groups!.destination],token('destination',dp,dm));
    atom('arrive','completed',{actor:author,destination},whole);
    if (kind === 'answer') bindings.push({role:destination,method:'completed_question',mention:token('verb'),target:token('destination',question.part,question.match),binding:anchor(question.part,0,length(question.part.text))});
    else if (!time(0,'event_time','time')) return null;
  } else if (kind === 'lend' || kind === 'request') {
    const agent=role(event.sender,(contract.RELATION_TOKENS as Record<string,string>)[value.agent],token('agent'));
    const owner=role(event.sender,(contract.RELATION_TOKENS as Record<string,string>)[identity.match.groups!.role],token('role',identity.part,identity.match));
    bindings.push({role:owner,method:'source_identity',mention:token('pronoun'),target:token('role',identity.part,identity.match),binding:anchor(identity.part,0,length(identity.part.text))});
    if (kind === 'lend') {
      const object=role(null,(contract.OBJECT_TOKENS as Record<string,string>)[value.object],token('object'));
      atom('lend','completed',{agent,recipient:author,object,property_owner:owner},whole);
      qualifier('polarity',value.negative ? token('negative'):whole,{atom_id:0,slot:'predicate',value:!value.negative});
      if (!time(0,'event_time','time')) return null;
    } else {
      atom(frame === 'reported_request' ? 'request':'receive_request','historical',{agent,recipient:author},whole);
      atom('cover_shift','requested',{actor:author,beneficiary:owner},[event,token('author')[1],event.start+length(event.text)-(event.text.endsWith('。')?1:0)]);
      if (!time(0,'event_time','outer_time') || !time(1,'requested_time','time')) return null;
    }
  } else {
    if (Number(value.number)>100000) return null;
    // 原产生式最多三位小数；用整数算米，避免 IEEE 浮点改变数量摘要。
    const [integer,fraction='']=value.number.split('.'), thousandths=BigInt(integer)*1000n+BigInt(fraction.padEnd(3,'0'));
    const scaled=thousandths*(value.unit === '公里'?1000n:1n), remainder=(scaled%1000n).toString().padStart(3,'0').replace(/0+$/u,'');
    const metres=(scaled/1000n).toString()+(remainder?'.'+remainder:'');
    const comma=length(event.text.substring(0,event.text.indexOf('，')+1));
    atom('clear_weather','condition',{},anchor(event,0,comma)); atom('run','planned',{actor:author},anchor(event,comma,length(event.text)));
    qualifier('quantity',[event,token('number')[1],token('unit')[2]],{atom_id:1,slot:'distance',value:{metres}});
    for (const modifier of ['only','approx']) if(value[modifier]) qualifier('degree',token(modifier),{quantity_qualifier_id:0,modifier,value:modifier});
    qualifier('condition',whole,{condition_atom_id:0,action_atom_id:1,relation:'requires'}); if(!time(1,'event_time','time')) return null;
  }
  const keys=[...anchors.keys()].sort((a,b)=> {const x=roleKeys.get(a)!,y=roleKeys.get(b)!; return ['self','contact',null].indexOf(x[0])-['self','contact',null].indexOf(y[0]) || (contract.ROLE_KINDS as readonly string[]).indexOf(x[1])-(contract.ROLE_KINDS as readonly string[]).indexOf(y[1]);});
  const ids=new Map(keys.map((key,index)=>[key,index]));
  const roles=keys.map(key=> {const [owner,kind]=roleKeys.get(key)!;const locations=anchors.get(key)!.sort((a,b)=>source ? a[0].order[0]-b[0].order[0] || a[1]-b[1] : a[1]-b[1]);return {role_id:ids.get(key),kind,owner,sender:kind==='author'?owner:null,span:locations[0]};});
  for(const row of atoms) row.roles=Object.fromEntries(Object.entries(row.roles).map(([key,value])=>[key,value===null?null:ids.get(value as string)]));
  const order=['polarity','quantity','degree','condition','time'];
  qualifiers.sort((a,b)=>order.indexOf(a.kind)-order.indexOf(b.kind) || (a.atom_id??a.action_atom_id??0)-(b.atom_id??b.action_atom_id??0) || (a.slot??'').localeCompare(b.slot??'') || (a.kind==='degree'?['only','approx'].indexOf(a.modifier)-['only','approx'].indexOf(b.modifier):0));
  qualifiers.forEach((row,index)=>{row.qualifier_id=index;});
  for(const row of qualifiers) if(row.kind==='degree') row.quantity_qualifier_id=qualifiers.find(item=>item.kind==='quantity')!.qualifier_id;
  for(const row of bindings) {row.role_id=ids.get(row.role);delete row.role;}
  bindings.sort((a,b)=>a.role_id-b.role_id || ['actual_sender','source_identity','completed_question'].indexOf(a.method)-['actual_sender','source_identity','completed_question'].indexOf(b.method) || a.mention[0].order[0]-b.mention[0].order[0] || a.mention[0].order[1]-b.mention[0].order[1] || a.mention[1]-b.mention[1]);
  return {rule,frame,roles,atoms,qualifiers,bindings,event};
}
const semantic=(graph:Graph):Evidence=>({roles:graph.roles.map(({span,...rest})=>rest),atoms:graph.atoms.map(({span,...rest})=>rest),qualifiers:graph.qualifiers.map(({span,...rest})=>rest),frame:graph.frame});
export type BoundedBasisResult =
  | {status:'verified';basis:Evidence;reason:''}
  | {status:'unsupported'|'unknown';basis:null;reason:string};
export function boundedBasisResult(candidate: Evidence,evidence: Evidence,messages: Message[],rep: Representation): BoundedBasisResult {
  const pragmatics=evidence.pragmatics,frame=pragmatics?.speech_act === 'report'?'reported_request':'received_request';
  const original=parse(sourceParts(messages),frame,true), projected=parse(candidateParts(messages,candidate.text_content,rep),frame,false);
  if(!original || !projected)return {status:'unknown',basis:null,reason:'unsupported_grammar'};
  if(original.event.message.message_id!==rep.target.message_id || original.event.text!==trimSpaces(rep.main.map(unit=>unit.text).join('')))return {status:'unknown',basis:null,reason:'uncovered_main_structure'};
  if(!keysEqual(semantic(original),semantic(projected)))return {status:'unsupported',basis:null,reason:'known_graph_difference'};
  const expected:Record<string,string[]>={BR_AUTHOR_ARRIVAL_V1:['common_fact','assertion','asserted'],BR_COMPLETED_QA_V1:['common_fact','assertion','asserted'],BR_KIN_LEND_V1:['relationship_note','assertion','asserted'],BR_TWO_ROLES_V1:['relationship_note','assertion','asserted'],BR_REQUEST_V1:frame==='reported_request'?['relationship_note','report','reported']:['relationship_note','assertion','asserted'],BR_COND_RUN_V1:['recent_state','plan','conditional']};
  if(!keysEqual([candidate.category,pragmatics?.speech_act,pragmatics?.assertion_status],expected[original.rule]) || pragmatics?.figurative_type!=='literal' || candidate.alternatives?.length)return {status:'unknown',basis:null,reason:'pragmatics_not_supported'};
  if(original.rule==='BR_COND_RUN_V1') {const interval=original.qualifiers.find(item=>item.kind==='time')!.value.interval;if(!candidate.valid_at || !candidate.invalid_at || instant(candidate.valid_at)!==instant(interval.start) || instant(candidate.invalid_at)!==instant(interval.end))return {status:'unsupported',basis:null,reason:'known_time_difference'};}
  else if(candidate.valid_at || candidate.invalid_at)return {status:'unsupported',basis:null,reason:'known_time_difference'};
  const origin=([part,start,end]:Location):Evidence=>messageSpan(part.message,start,end);
  const rows=(name:'roles'|'atoms'|'qualifiers'):Evidence[]=>original[name].map((left,index)=>{const {span,value,...row}=left;return {...row,...('value' in left?{value_sha256:digest(value)}:{}),source:origin(span),candidate:textSpan(candidate.text_content,projected[name][index].span[1],projected[name][index].span[2])};});
  const roles=rows('roles');roles.find(row=>row.kind==='author')!.candidate=textSpan(candidate.text_content,rep.author_start,rep.author_start+length(rep.author));
  const basis={version:3,rule_set_sha256:contract.RULE_SET_SHA256,rules:[{rule_id:original.rule,rule_version:1}],roles,atoms:rows('atoms'),qualifiers:rows('qualifiers'),reference_bindings:original.bindings.map(row=>({role_id:row.role_id,method:row.method,mention:origin(row.mention),target:origin(row.target),binding:row.binding?origin(row.binding):null})),frame:original.frame,unresolved:[],source_graph_sha256:digest(semantic(original)),candidate_graph_sha256:digest(semantic(projected)),representation:representationPayload(rep,messages,candidate.text_content),capabilities:contract.CAPABILITIES.filter(item=>item!==(original.frame==='direct'?'reported_attribution':'direct_attribution'))};
  return {status:'verified',basis,reason:''};
}
export function boundedBasis(candidate: Evidence,evidence: Evidence,messages: Message[],rep: Representation): Evidence|null {
  return boundedBasisResult(candidate,evidence,messages,rep).basis;
}
