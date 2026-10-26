/** 原v1/v2来源证明的只读重解析；规则摘要不替代当前全文和完整关系核验。 */
import { canonicalJSON, digest, sha, type Evidence } from './sources.ts';
import { legacyGrammar } from './legacy-grammar.ts';
type Span = [number,number];
type Parsed = {rule: string;variant: string;frame: string;values: Evidence;spans: Record<string,Span>;whole: Span};
const related: Record<string,string>={'我姐':'elder_sister','我哥':'elder_brother','我同事':'colleague'};
const roles: Record<string,string>={'姐姐':'elder_sister','哥哥':'elder_brother','同事':'colleague'};
const objects: Record<string,string>={'车':'vehicle','书':'book','雨伞':'umbrella'};
const equal=(a:unknown,b:unknown)=>canonicalJSON(a)===canonicalJSON(b);
const person=(token:string)=>{const [base,role]=token.split('的');return [base==='用户'?'self':'contact',role?roles[role]:'author'];};
const length=(text:string)=>[...text].length;
const whitespace='[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const stripStart=(text:string)=>text.replace(new RegExp('^'+whitespace+'+','u'),'');
const strip=(text:string)=>stripStart(text).replace(new RegExp(whitespace+'+$','u'),'');
function trimmed(text:string): {body:string;offset:number} {const t=strip(text);return {body:t.endsWith('。')?t.slice(0,-1):t,offset:length(text)-length(stripStart(text))};}
function matchGrammar(text:string,name:string) {
  const {body,offset}=trimmed(text);
  const grammar=(legacyGrammar.grammar as Record<string,string>)[name];
  const match=new RegExp(`^(?:${grammar.replaceAll('(?P<','(?<')})$`,'du').exec(body);
  if(!match || match[0]!==body)return null;
  const values: Evidence={},spans:Record<string,Span>={};
  for(const [key,value] of Object.entries(match.groups??{})) {
    values[key]=value??null;
    const indexes=match.indices?.groups?.[key];
    if(value && indexes)spans[key]=[offset+length(body.slice(0,indexes[0])),offset+length(body.slice(0,indexes[1]))];
  }
  return {g:values,spans,whole:[offset,offset+length(body)] as Span};
}
function parsed(rule:string,variant:string,frame:string,values:Evidence,m:{spans:Record<string,Span>;whole:Span}):Parsed{return {rule,variant,frame,values,spans:m.spans,whole:m.whole};}
function arrival(text:string,sender:string,source:boolean):Parsed|null {
  const m=matchGrammar(text,source?'arrival_source':'arrival_candidate');if(!m)return null;
  return parsed('AUTHOR_ARRIVAL_H1','direct_h','direct',{author:[source?sender:m.g.author==='用户'?'self':'contact','author'],time:'just'},m);
}
function quote(text:string,sourceText:string):Parsed|null {
  const body=strip(text),offset=length(text)-length(stripStart(text)),inner=strip(sourceText);
  for(const [author,sender] of [['用户','self'],['联系人','contact']]) {
    const prefix=author+'原话：“';if(body!==prefix+inner+'”')continue;
    const p=arrival(inner,sender,true);if(!p)return null;
    const start=offset+length(prefix);
    return {...p,variant:'author_quote_h1',whole:[offset,offset+length(body)],spans:{...Object.fromEntries(Object.entries(p.spans).map(([k,v])=>[k,[start+v[0],start+v[1]] as Span])),outer_author:[offset,offset+length(author)],inner:[start,start+length(inner)]}};
  }
  return null;
}
function lend(text:string,sender:string,source:boolean):Parsed|null {
  const m=matchGrammar(text,source?'lend_source':'lend_candidate');if(!m)return null;
  const g=m.g,negative=g.negative!==null;
  if(negative===(g.completion!==null) || source && negative && g.time===null)return null;
  let agent,recipient,owner;
  if(source) {
    agent=[sender,related[g.related]];recipient=[sender,'author'];owner=null;
    if(g.identity!==null){if(g.identity_pronoun!==g.pronoun || g.identity_role!==g.related)return null;owner=agent;}
  } else {agent=person(g.agent);recipient=person(g.recipient);owner=g.owner==='自己'?agent:person(g.owner);}
  return parsed('KIN_LEND_BA_H1',negative?'negative_h':'completed_h','direct',{author:[sender,'author'],agent,recipient,property_owner:owner,object:objects[g.object],polarity:!negative,phase:'completed',time:g.time},m);
}
function beneficiary(token:string,introduced:string[][]):string[]|null {
  if(!token.startsWith('该'))return person(token);
  const choices=introduced.filter(p=>p[1]===roles[token.slice(1)]),unique=new Map(choices.map(p=>[JSON.stringify(p),p]));
  return unique.size===1?[...unique.values()][0]:null;
}
function request(text:string,sender:string,source:boolean):Parsed|null {
  if(source) {
    if(sender!=='self')return null;
    const m=matchGrammar(text,'request_source');if(!m)return null;
    const g=m.g,requester=[sender,related[g.related]];let target=null;
    if(g.identity!==null){if(g.identity_pronoun!==g.pronoun || g.identity_role!==g.related)return null;target=requester;}
    return parsed('REQUEST_ROLE_H1','quoted_request_h','quoted_request_h',{author:[sender,'author'],requester,recipient:[sender,'author'],actor:[sender,'author'],beneficiary:target,time:g.time,outer_time:null},m);
  }
  for(const frame of ['quoted_request_h','received_request_h']) {
    const m=matchGrammar(text,frame);if(!m)continue;
    const g=m.g,requester=person(g.requester),actor=person(g.actor),recipient=frame==='quoted_request_h'?actor:person(g.recipient),target=beneficiary(g.beneficiary,[requester,actor,recipient]);
    if(!target)return null;
    return parsed('REQUEST_ROLE_H1',frame,frame,{author:[sender,'author'],requester,recipient,actor,beneficiary:target,time:g.time,outer_time:g.outer_time??null},m);
  }
  // 原诊断性新增承诺/执行分支不可能成为verified，直接拒绝。
  return null;
}
function metres(number:string,unit:string):string|null {
  if(Number(number)>100000)return null;
  const [integer,fraction='']=number.split('.');
  const raw=BigInt(integer+fraction)*(unit==='公里'?1000n:1n),scale=10n**BigInt(fraction.length);
  const whole=raw/scale,rest=raw%scale;
  return String(whole)+(rest?'.'+String(rest).padStart(fraction.length,'0').replace(/0+$/,''):'');
}
function plan(text:string,sender:string,source:boolean):Parsed|null {
  const m=matchGrammar(text,source?'plan_source':'plan_candidate');if(!m)return null;
  const g=m.g;if(g.number!==null && Number(g.number)>100000)return null;
  const quantity=g.number!==null && g.unit!==null?metres(g.number,g.unit):null;
  if(!source && (['已','已经','肯定'].includes(g.phase) || g.completion!==null))return null;
  return parsed('COND_PLAN_RUN_V1','conditional_plan','direct',{author:[sender,'author'],actor:source?[sender,'author']:person(g.author),condition:g.condition,phase:g.phase==='计划'?'planned':null,time:g.time,only:g.only!==null,approx:g.approx!==null,distance:quantity},m);
}
const parse=(text:string,sender:string,source:boolean)=>arrival(text,sender,source)||lend(text,sender,source)||request(text,sender,source)||plan(text,sender,source);
function semanticGraph(p:Parsed) {
  const v=p.values,roles:Evidence={author:v.author},atoms:Evidence[]=[],qualifiers:Evidence[]=[],unresolved:Evidence[]=[];
  if(p.rule==='AUTHOR_ARRIVAL_H1') {
    atoms.push({atom_id:0,predicate:'arrive_home',phase:'completed',roles:{actor:v.author}});qualifiers.push({kind:'time',atom_id:0,slot:'event_time',value:'just'});
  } else if(p.rule==='KIN_LEND_BA_H1') {
    for(const key of ['agent','recipient','object','property_owner'])roles[key]=v[key];
    atoms.push({atom_id:0,predicate:'lend',phase:'completed',roles:Object.fromEntries(['agent','recipient','object','property_owner'].map(k=>[k,v[k]]))});
    qualifiers.push({kind:'polarity',atom_id:0,slot:'predicate',value:v.polarity});
    if(v.time!==null)qualifiers.push({kind:'time',atom_id:0,slot:'event_time',value:v.time});
    if(v.property_owner===null)unresolved.push({atom_id:0,slot:'property_owner',reason:'missing_source_identity'});
  } else if(p.rule==='REQUEST_ROLE_H1') {
    for(const key of ['requester','recipient','actor','beneficiary'])roles[key]=v[key];
    atoms.push({atom_id:0,predicate:p.frame==='quoted_request_h'?'request':'receive_request',phase:'historical',roles:{agent:v.requester,recipient:v.recipient}},{atom_id:1,predicate:'cover_shift',phase:'requested',roles:{actor:v.actor,beneficiary:v.beneficiary}});
    qualifiers.push({kind:'time',atom_id:1,slot:'requested_time',value:v.time});
    if(v.outer_time!==null)qualifiers.push({kind:'time',atom_id:0,slot:'event_time',value:v.outer_time});
    if(v.beneficiary===null)unresolved.push({atom_id:1,slot:'beneficiary',reason:'missing_source_identity'});
  } else {
    roles.actor=v.actor;atoms.push({atom_id:0,predicate:'clear_weather',phase:'condition',roles:{}},{atom_id:1,predicate:'run',phase:'planned',roles:{actor:v.actor}});
    qualifiers.push({qualifier_id:0,kind:'quantity',atom_id:1,slot:'distance',value:v.distance});
    for(const modifier of ['only','approx'])if(v[modifier])qualifiers.push({kind:'degree',quantity_qualifier_id:0,modifier,value:v.distance});
    qualifiers.push({kind:'condition',condition_atom_id:0,action_atom_id:1,relation:'requires'},{kind:'time',atom_id:1,slot:'event_time',value:v.time});
  }
  return {roles,atoms,qualifiers,frame:p.frame,unresolved};
}
const emptyRoles=()=>({agent:null,recipient:null,object:null,property_owner:null,beneficiary:null,actor:null} as Evidence);
function buildBasis(s:Parsed,c:Parsed,message:Evidence,sourceText:string,text:string):Evidence {
  const span=(body:string,range:Span)=>({start:range[0],end:range[1],sha256:sha([...body].slice(...range).join(''))});
  const ss=(range:Span)=>({message_id:message.message_id,span:span(sourceText,range)}),cs=(range:Span)=>span(text,range);
  const roleSlots={...emptyRoles(),actor:0};
  const result:Evidence={version:1,rule_set_sha256:legacyGrammar.rulesHash,rules:[{rule_id:s.rule,rule_version:1}],roles:[{role_id:0,kind:'author',sender:message.sender,source:ss(s.spans.author)}],atoms:[{atom_id:0,predicate:'arrive_home',phase:'completed',roles:roleSlots,source:ss(s.whole),candidate:cs(c.whole)}],qualifiers:s.rule==='AUTHOR_ARRIVAL_H1'?[{qualifier_id:0,kind:'time',atom_id:0,slot:'event_time',value_sha256:digest({event_time:'just'}),source:ss(s.spans.time),candidate:cs(c.spans.time)}]:[],reference_bindings:[{role_id:0,method:'actual_sender',mention:ss(s.spans.author),target:ss(s.spans.author),binding:null}],frame:c.frame,unresolved:[],source_graph_sha256:digest(semanticGraph(s)),candidate_graph_sha256:digest(semanticGraph(c))};
  if(['KIN_LEND_BA_H1','REQUEST_ROLE_H1'].includes(s.rule)) {
    const person=s.rule==='KIN_LEND_BA_H1'?s.values.agent:s.values.requester;
    result.roles.push({role_id:1,kind:person[1],sender:null,source:ss(s.spans.related)});
    if(s.rule==='KIN_LEND_BA_H1') {
      result.atoms=[{atom_id:0,predicate:'lend',phase:'completed',roles:{...emptyRoles(),agent:1,recipient:0,object:2,property_owner:1},source:ss(s.spans.action),candidate:cs(c.spans.action)}];
      if(!s.values.polarity)result.qualifiers.push({qualifier_id:0,kind:'polarity',atom_id:0,slot:'predicate',value_sha256:digest(false),source:ss(s.spans.negative),candidate:cs(c.spans.negative)});
      if(s.values.time!==null)result.qualifiers.push({qualifier_id:result.qualifiers.length,kind:'time',atom_id:0,slot:'event_time',value_sha256:digest({event_time:s.values.time}),source:ss(s.spans.time),candidate:cs(c.spans.time)});
    }
    result.rules.push({rule_id:'SOURCE_IDENTITY_H1',rule_version:1});
    result.reference_bindings.push({role_id:1,method:'source_identity',mention:ss(s.spans.pronoun),target:ss(s.spans.identity_role),binding:ss(s.spans.identity)});
    if(s.rule==='REQUEST_ROLE_H1') {
      result.atoms=[{atom_id:0,predicate:c.frame==='quoted_request_h'?'request':'receive_request',phase:'historical',roles:{...emptyRoles(),agent:1,recipient:0},source:ss(s.spans.action),candidate:cs(c.whole)},{atom_id:1,predicate:'cover_shift',phase:'requested',roles:{...emptyRoles(),actor:0,beneficiary:1},source:ss(s.spans.inner),candidate:cs(c.spans.inner)}];
      result.qualifiers=[{qualifier_id:0,kind:'time',atom_id:1,slot:'requested_time',value_sha256:digest({requested_time:s.values.time}),source:ss(s.spans.time),candidate:cs(c.spans.time)}];
    }
  }
  if(s.rule==='KIN_LEND_BA_H1')result.roles.push({role_id:2,kind:s.values.object,sender:null,source:ss(s.spans.object)});
  if(s.rule==='COND_PLAN_RUN_V1') {
    result.atoms=[{atom_id:0,predicate:'clear_weather',phase:'condition',roles:emptyRoles(),source:ss(s.spans.condition),candidate:cs(c.spans.condition)},{atom_id:1,predicate:'run',phase:'planned',roles:roleSlots,source:ss(s.spans.action),candidate:cs(c.spans.action)}];
    result.qualifiers=[{qualifier_id:0,kind:'quantity',atom_id:1,slot:'distance',value_sha256:digest(s.values.distance),source:ss(s.spans.distance),candidate:cs(c.spans.distance)}];
    for(const modifier of ['only','approx'])if(s.values[modifier])result.qualifiers.push({qualifier_id:result.qualifiers.length,kind:'degree',quantity_qualifier_id:0,modifier,value_sha256:digest({modifier,distance:s.values.distance}),source:ss(s.spans[modifier]),candidate:cs(c.spans[modifier])});
    const n=result.qualifiers.length;
    result.qualifiers.push({qualifier_id:n,kind:'condition',condition_atom_id:0,action_atom_id:1,relation:'requires',source:ss(s.spans.condition),candidate:cs(c.spans.condition)},{qualifier_id:n+1,kind:'time',atom_id:1,slot:'event_time',value_sha256:digest({event_time:s.values.time}),source:ss(s.spans.time),candidate:cs(c.spans.time)});
  }
  if(c.variant==='author_quote_h1') {
    const start=length(sourceText)-length(stripStart(sourceText));
    Object.assign(result,{version:2,rule_set_sha256:legacyGrammar.quoteRulesHash,rules:[{rule_id:'AUTHOR_ARRIVAL_H1',rule_version:2}],representation:{version:1,kind:'author_quote_h1',source:ss([start,start+length(strip(sourceText))]),candidate:cs(c.whole),author:cs(c.spans.outer_author),inner:cs(c.spans.inner)},capabilities:legacyGrammar.capabilities});
  }
  return result;
}
export function reverifyLegacyBasis(candidate:Evidence,evidence:Evidence,messages:Evidence[],texts:Record<string,string>,snapshots:Record<string,Evidence[]>):boolean {
  try {
    const basis=evidence.semantic_basis,pragmatics=evidence.pragmatics;
    if(!basis || ![1,2].includes(basis.version) || !pragmatics || messages.length!==1 || !equal(candidate.source_ids,[messages[0].message_id]))return false;
    const message=messages[0],sourceText=texts[message.message_id],text=candidate.text_content;
    if(message.message_type!=='text' || message.text_representation!=='text' || !snapshots[message.message_id]?.length || length(sourceText)>4096 || length(text)>4096)return false;
    let s=basis.version===2?arrival(sourceText,message.sender,true):parse(sourceText,message.sender,true);
    const c=basis.version===2?quote(text,sourceText):parse(text,message.sender,false);
    if(!s || !c || s.rule!==c.rule)return false;
    if(s.rule==='REQUEST_ROLE_H1')s={...s,frame:c.frame,variant:c.variant};
    if(!equal(s.values,c.values) || ['property_owner','beneficiary'].some(k=>k in s.values && s.values[k]===null))return false;
    const speech=c.frame==='quoted_request_h'?'report':c.rule==='COND_PLAN_RUN_V1'?'plan':'assertion';
    const assertion=c.frame==='quoted_request_h'?'reported':c.rule==='COND_PLAN_RUN_V1'?'conditional':'asserted';
    if(candidate.subject!==c.values.author[0] || pragmatics.speech_act!==speech || pragmatics.assertion_status!==assertion || pragmatics.figurative_type!=='literal' || candidate.valid_at!==null || candidate.invalid_at!==null || c.rule==='REQUEST_ROLE_H1' && candidate.category!=='relationship_note' || basis.version===2 && candidate.category!=='common_fact')return false;
    return equal(basis,buildBasis(s,c,message,sourceText,text));
  } catch {return false;}
}
