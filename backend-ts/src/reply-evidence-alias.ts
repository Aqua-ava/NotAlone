/** 单次回复内的模型可见证据别名；真实来源身份只留在业务侧映射。 */
import {ReplyError} from './reply-contract.ts';
export interface EvidenceAliases {
  aliasFor(evidenceId:string):string;
  resolve(alias:string):string|undefined;
  referenceFor(realId:string):string;
  sessionFor(realId:string):string;
  resolveSession(alias:string):string|undefined;
  skillFor(versionId:string):string;
  resolveSkill(alias:string):string|undefined;
  entries():readonly {alias:string;evidence_id:string}[];
}

class RequestEvidenceAliases implements EvidenceAliases {
  private readonly realByAlias=new Map<string,string>();
  private readonly aliasByReal=new Map<string,string>();
  private readonly realByReferenceAlias=new Map<string,string>();
  private readonly referenceByReal=new Map<string,string>();
  private readonly realBySessionAlias=new Map<string,string>();
  private readonly sessionByReal=new Map<string,string>();
  private readonly realBySkillAlias=new Map<string,string>();
  private readonly skillByReal=new Map<string,string>();

  constructor(evidenceIds:readonly string[]){
    for(const evidenceId of evidenceIds)this.aliasFor(evidenceId);
  }

  aliasFor(evidenceId:string):string {
    if(this.realByAlias.has(evidenceId))return evidenceId;
    const existing=this.aliasByReal.get(evidenceId);
    if(existing)return existing;
    const alias=`c${this.aliasByReal.size+1}`;
    this.aliasByReal.set(evidenceId,alias);
    this.realByAlias.set(alias,evidenceId);
    return alias;
  }

  resolve(alias:string){return this.realByAlias.get(alias);}

  referenceFor(realId:string):string {
   if(this.realByReferenceAlias.has(realId)||this.realByAlias.has(realId))return realId;
   const evidence=this.aliasByReal.get(realId);
   if(evidence)return evidence;
   const existing=this.referenceByReal.get(realId);
   if(existing)return existing;
   const alias=`r${this.referenceByReal.size+1}`;
   this.referenceByReal.set(realId,alias);
   this.realByReferenceAlias.set(alias,realId);
   return alias;
  }

  sessionFor(realId:string):string {
   if(this.realBySessionAlias.has(realId))return realId;
   const existing=this.sessionByReal.get(realId);
   if(existing)return existing;
   const alias=`s${this.sessionByReal.size+1}`;
   this.sessionByReal.set(realId,alias);
   this.realBySessionAlias.set(alias,realId);
   return alias;
  }

  resolveSession(alias:string){return this.realBySessionAlias.get(alias);}

  skillFor(versionId:string):string {
   if(this.realBySkillAlias.has(versionId))return versionId;
   const existing=this.skillByReal.get(versionId);
   if(existing)return existing;
   const alias=`k${this.skillByReal.size+1}`;
   this.skillByReal.set(versionId,alias);
   this.realBySkillAlias.set(alias,versionId);
   return alias;
  }

  resolveSkill(alias:string){return this.realBySkillAlias.get(alias);}

  entries(){return [...this.aliasByReal].map(([evidence_id,alias])=>({alias,evidence_id}));}
}

export function createEvidenceAliases(evidenceIds:readonly string[]=[]):EvidenceAliases {
  return new RequestEvidenceAliases(evidenceIds);
}

export function restoreReplyEvidenceAliases(value:unknown,aliases:EvidenceAliases):unknown {
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const output=value as Record<string,unknown>;
  if(!Array.isArray(output.candidates))return value;
  return {...output,candidates:output.candidates.map(candidate=>{
    if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))return candidate;
    const row=candidate as Record<string,unknown>;
    if(!Array.isArray(row.citation_ids))return candidate;
    return {...row,citation_ids:row.citation_ids.map(citation=>
      typeof citation==='string'?aliases.resolve(citation)??null:null)};
  })};
}

const referenceStringFields=new Set(['input_version','input_versions']);
const evidenceIdArrayFields=new Set(['evidence_ids','allowed_evidence_ids','evidence_message_ids']);
const isReferenceField=(key:string)=>key.endsWith('_id')||key.endsWith('_key'),isReferenceFields=(key:string)=>key.endsWith('_ids')||key.endsWith('_keys');
const isSessionField=(key:string)=>key.endsWith('session_id'),isSessionFields=(key:string)=>key.endsWith('session_ids');
const isSkillVersionField=(key:string)=>key.endsWith('skill_version_id'),isSkillVersionFields=(key:string)=>key.endsWith('skill_version_ids');
const MAX_ALIAS_DEPTH=16,MAX_ALIAS_NODES=4096;
interface AliasVisit {nodes:number}
const unavailable=():never=>{throw new ReplyError('reply_context_unavailable');};
export function aliasReplyDiscussionText(text:string,aliases:EvidenceAliases):string {
  let parsed:unknown;
  try {parsed=JSON.parse(text);}catch{return text;}
  if(parsed&&typeof parsed==='object')return JSON.stringify(aliasEvidence(parsed,aliases,undefined,0,{nodes:0}));
  return text;
}
export function aliasReplyEvidenceReferences(value:unknown,aliases:EvidenceAliases,parentKey?:string):unknown {
 return aliasEvidence(value,aliases,parentKey,0,{nodes:0});
}
function aliasEvidence(value:unknown,aliases:EvidenceAliases,parentKey:string|undefined,depth:number,visit:AliasVisit):unknown {
 if(depth>MAX_ALIAS_DEPTH||++visit.nodes>MAX_ALIAS_NODES)return unavailable();
 if(typeof value==='string'){
  let parsed:unknown;
  try {parsed=JSON.parse(value);}catch{return value;}
  if(!parsed||typeof parsed!=='object'&&typeof parsed!=='string')return value;
  return JSON.stringify(aliasEvidence(parsed,aliases,parentKey,depth+1,visit));
 }
 if(Array.isArray(value))return value.map(item=>aliasEvidence(item,aliases,parentKey,depth+1,visit));
 if(!value||typeof value!=='object')return value;
 const object=value as Record<string,unknown>;
 const skillSelection=parentKey==='skill_selection'||typeof object.skill_id==='string';
 return Object.fromEntries(Object.entries(object).map(([key,item])=>{
  if(key==='evidence_id'&&typeof item==='string')return [key,aliases.aliasFor(item)];
  if(evidenceIdArrayFields.has(key)&&Array.isArray(item))
   return [key,item.map(id=>typeof id==='string'?aliases.aliasFor(id):id)];
  if(isSessionField(key)&&typeof item==='string')return [key,aliases.sessionFor(item)];
  if(isSessionFields(key)&&Array.isArray(item))
   return [key,item.map(id=>typeof id==='string'?aliases.sessionFor(id):id)];
  if(isSkillVersionField(key)&&typeof item==='string')return [key,aliases.skillFor(item)];
  if(isSkillVersionFields(key)&&Array.isArray(item))
   return [key,item.map(id=>typeof id==='string'?aliases.skillFor(id):id)];
  if(key==='version_id'&&typeof item==='string'&&skillSelection)return [key,aliases.skillFor(item)];
  // 普通 generation input 的关联字段持续扩展，按标识形状统一投影以避免新增键静默泄漏。
  if((isReferenceField(key)||referenceStringFields.has(key))&&typeof item==='string')
   return [key,aliases.referenceFor(item)];
  if((isReferenceFields(key)||referenceStringFields.has(key))&&Array.isArray(item))
   return [key,item.map(id=>typeof id==='string'?aliases.referenceFor(id):id)];
  return [key,aliasEvidence(item,aliases,key,depth+1,visit)];
 }));
}
