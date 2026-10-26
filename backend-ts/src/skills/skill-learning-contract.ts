/** Skill 学习提案的框架无关合同；模型只能提交建议，不能发布或改资料。 */
import {createHash} from 'node:crypto';
import {validatePackage,serializeSkillDocument} from './skill-package.ts';
import {skillDigest} from './skill-execution-view.ts';

export const MAX_LEARNING_MATERIALS=8;
export const MAX_LEARNING_INPUT_CHARS=24_000;
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface SkillLearningScope {owner_id:string;contact_id:string}
export interface LearningMaterial {
  material_id:string;digest:string;dependency_ids:string[];priority:'correction'|'ordinary';
  session_id:string;kind:string;content:unknown;created_at:string;
  candidates?:unknown[];external_messages?:unknown[];
}
export interface LearningTarget {
  skill_id:string;version_id:string;version_number:number;name:string;description:string;document:string;
  methods:{method_id:string;logical_skill_id:string}[];scope:SkillPublicationScope;
  source_dependency_count:number;
}
export interface SkillPublicationScope {kind:'owner'|'contact'|'scene';contact_id:string|null;scene:string|null}
export interface ReviewInput {incoming_text:string;intent:string;scene:string}
export interface NormalizedMethod {
  method_id:string;logical_skill_id:string;key:string;title:string;instruction:string;
  replaces_method_ids:string[];mapping_status:'new'|'requires_review';
}
export interface NormalizedStrategy {
  name:string;description:string;scene:string;document:string;methods:NormalizedMethod[];
  scope_suggestion:{kind:'owner'|'contact'|'scene';reason:string;contact_id:string|null};
}
export interface NormalizedProposal {
  logical_skill_id:string;proposal_kind:'create'|'update'|'merge';strategy:NormalizedStrategy;
  target_versions:{skill_id:string;version_id:string;version_number:number}[];
}
export interface SkillLearningBatch {
  materials:LearningMaterial[];targets:LearningTarget[];dependency_ids:string[];
  library_revision:number;scope_revision:number;source_generation:Record<string,unknown>;
  material_budget_limited:boolean;key:string;ready:boolean;
}
export class SkillLearningError extends Error {
  readonly code:string;
  readonly status:number;
  readonly retryable:boolean;
  constructor(code='skill_learning_unavailable',status=503,retryable=false){
    super(code);this.code=code;this.status=status;this.retryable=retryable;this.name='SkillLearningError';
  }
}
export class SkillLearningInvalid extends SkillLearningError {
  constructor(){super('skill_learning_stale_or_disabled',409,false);}
}
export class SkillLearningNotFound extends SkillLearningError {
  constructor(){super('not_found',404,false);}
}
export function isSkillUuid(value:unknown):value is string {
  return typeof value==='string'&&uuidPattern.test(value);
}
/** 与 Python uuid.uuid5 按名称空间字节一致；用于逻辑 Skill 与方法延续身份。 */
export function skillUuid5(namespace:string,name:string):string {
  if(!isSkillUuid(namespace))throw new SkillLearningInvalid();
  const bytes=createHash('sha1').update(Buffer.from(namespace.replaceAll('-',''),'hex')).update(name,'utf8').digest().subarray(0,16);
  bytes[6]=(bytes[6]&15)|0x50;bytes[8]=(bytes[8]&63)|0x80;
  const hex=bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function skillContentDigest(value:unknown):string {return skillDigest(value);}
export function learningInputText(materials:readonly unknown[],targets:readonly unknown[]):string {
  return JSON.stringify({materials,existing_skills:targets});
}
export function codepointLength(value:string):number{return Array.from(value).length;}
function codePoints(value:string):number{return codepointLength(value);}
function record(value:unknown):value is Record<string,any>{return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
function nonblank(value:unknown,maximum:number):value is string {
  return typeof value==='string'&&value.trim().length>0&&codePoints(value)<=maximum;
}
function sameKeys(value:Record<string,unknown>,keys:readonly string[]):boolean {
  return Object.keys(value).sort().join(',')===[...keys].sort().join(',');
}
function textValues(value:unknown):string[]{
  if(typeof value==='string')return [value];
  if(Array.isArray(value))return value.flatMap(textValues);
  if(record(value))return Object.values(value).flatMap(textValues);
  return [];
}
export function batchKey(input:Omit<SkillLearningBatch,'key'|'ready'>):string {
  return skillContentDigest({
    materials:input.materials,targets:input.targets,revision:input.library_revision,
    scope_revision:input.scope_revision,source_generation:input.source_generation,
  });
}
export function finishBatch(input:Omit<SkillLearningBatch,'key'|'ready'>):SkillLearningBatch {
  const key=batchKey(input);
  const singleSize=input.materials.length===1?codepointLength(learningInputText(input.materials,[])):0;
  const largeSingle=input.materials.length===1
    && MAX_LEARNING_INPUT_CHARS/2<singleSize&&singleSize<=MAX_LEARNING_INPUT_CHARS;
  const ready=input.materials.length>=2||largeSingle||Boolean(input.materials.length)
    &&input.material_budget_limited||input.materials.some(item=>item.priority==='correction');
  return {...input,key,ready};
}
/** 模型输出必须完整符合建议合同；任何未知目标、越权命名或原文复述都拒绝。 */
export function normalizeProposal(scope:SkillLearningScope,batch:SkillLearningBatch,value:unknown):{proposal:NormalizedProposal|null;outcome:'no_change'|'reuse'|'draft'} {
  if(!record(value))throw new SkillLearningInvalid();
  const outcome=value.outcome;
  if(outcome==='no_change')return {proposal:null,outcome};
  if(!['reuse','draft'].includes(outcome as string))throw new SkillLearningInvalid();
  const available=new Map(batch.targets.map(item=>[item.skill_id,item]));
  const targetIds=value.target_skill_ids??[];
  if(!Array.isArray(targetIds)||targetIds.some(id=>typeof id!=='string')
    ||new Set(targetIds).size!==targetIds.length||targetIds.some(id=>!available.has(id)))throw new SkillLearningInvalid();
  if(outcome==='reuse'&&targetIds.length)return {proposal:null,outcome:'reuse'};
  const kind=value.proposal_kind;
  if(outcome!=='draft'||!['create','update','merge'].includes(kind)
    ||kind==='create'&&targetIds.length||kind==='update'&&targetIds.length!==1
    ||kind==='merge'&&targetIds.length<2)throw new SkillLearningInvalid();
  const name=value.name,description=value.description,scene=value.scene;
  if(typeof name!=='string'||codePoints(name)>64||!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)
    ||typeof description!=='string'||!description.trim()||codePoints(description)>1024
    ||typeof scene!=='string'||!scene.trim()||codePoints(scene)>256)throw new SkillLearningInvalid();
  if(kind==='create'&&batch.targets.some(item=>item.name===name))throw new SkillLearningInvalid();
  const suggestion=value.scope_suggestion;
  if(!record(suggestion)||!sameKeys(suggestion,['kind','reason'])
    ||!['contact','scene','owner'].includes(suggestion.kind)
    ||typeof suggestion.reason!=='string'||!suggestion.reason.trim()||codePoints(suggestion.reason)>1024)
    throw new SkillLearningInvalid();
  const methods=value.methods;
  if(!Array.isArray(methods)||methods.length<1||methods.length>6)throw new SkillLearningInvalid();
  const targets=targetIds.map(id=>available.get(id)!);
  const logical=targets.length?targetIds[0]:skillUuid5(scope.contact_id,`learned_skill:${name}`);
  const targetMethods=new Set(targets.flatMap(target=>target.methods.map(method=>method.method_id)));
  const normalized:NormalizedMethod[]=[],seen=new Set<string>();
  for(const method of methods){
    if(!record(method)||Object.keys(method).some(key=>!['key','title','instruction','replaces_method_ids'].includes(key)))
      throw new SkillLearningInvalid();
    const key=method.key,title=method.title,instruction=method.instruction;
    if(typeof key!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(key)||seen.has(key)
      ||typeof title!=='string'||!title.trim()||codePoints(title)>256
      ||typeof instruction!=='string'||!instruction.trim()||codePoints(instruction)>2048)
      throw new SkillLearningInvalid();
    seen.add(key);
    const replaces=method.replaces_method_ids??[...targetMethods].sort();
    if(!Array.isArray(replaces)||replaces.some(id=>typeof id!=='string'||!targetMethods.has(id))
      ||new Set(replaces).size!==replaces.length||targets.length&&!replaces.length)throw new SkillLearningInvalid();
    normalized.push({method_id:skillUuid5(logical,`method:${key}`),logical_skill_id:logical,key,title,instruction,
      replaces_method_ids:[...replaces],mapping_status:targets.length?'requires_review':'new'});
  }
  const replaced=new Set(normalized.flatMap(method=>method.replaces_method_ids));
  if([...targetMethods].some(id=>!replaced.has(id)))throw new SkillLearningInvalid();
  const body='# '+scene+'\n\n'+normalized.map(method=>'## '+method.title+'\n'+method.instruction).join('\n\n');
  const document=`---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}`;
  try{validatePackage(name,Buffer.from(document),[]);}catch{throw new SkillLearningInvalid();}
  const strategy:NormalizedStrategy={name,description,scene,document,methods:normalized,
    scope_suggestion:{kind:suggestion.kind,reason:suggestion.reason,
      contact_id:suggestion.kind==='contact'?scope.contact_id:null}};
  const strategyText=JSON.stringify(strategy);
  for(const material of batch.materials){
    for(const text of textValues({content:material.content,candidates:material.candidates,external_messages:material.external_messages})){
      const trimmed=text.trim();
      if(codePoints(trimmed)>=16&&strategyText.includes(trimmed))throw new SkillLearningInvalid();
    }
  }
  return {outcome:'draft',proposal:{logical_skill_id:logical,proposal_kind:kind,strategy,
    target_versions:targets.map(target=>({skill_id:target.skill_id,version_id:target.version_id,version_number:target.version_number}))}};
}
export function reviewInput(value:unknown):ReviewInput {
  if(!record(value)||!sameKeys(value,['incoming_text','intent','scene']))throw new SkillLearningInvalid();
  const limits={incoming_text:8192,intent:4096,scene:256};
  if(Object.entries(limits).some(([key,limit])=>!nonblank(value[key],limit)))throw new SkillLearningInvalid();
  return {incoming_text:value.incoming_text.trim(),intent:value.intent.trim(),scene:value.scene.trim()};
}
export function publicationScope(value:unknown,contactId:string,scene?:string):SkillPublicationScope {
  if(!record(value)||!sameKeys(value,['kind','contact_id','scene']))throw new SkillLearningInvalid();
  const kind=value.kind;
  const contact=typeof value.contact_id==='string'?value.contact_id.toLowerCase():value.contact_id;
  const declared=value.scene;
  if(kind==='contact'&&contact===contactId&&declared===null)return {kind,contact_id:contact,scene:null};
  if(kind==='owner'&&contact===null&&declared===null)return {kind,contact_id:null,scene:null};
  if(kind==='scene'&&contact===null&&typeof declared==='string'&&declared.trim()===declared
    &&codePoints(declared)>=1&&codePoints(declared)<=256&&(scene===undefined||scene===declared))
    return {kind,contact_id:null,scene:declared};
  throw new SkillLearningInvalid();
}
export function policyScope(value:unknown,contactId:string):SkillPublicationScope {
  if(!record(value)||!sameKeys(value,['kind','contact_id','scene']))throw new SkillLearningInvalid();
  const contact=typeof value.contact_id==='string'?value.contact_id.toLowerCase():value.contact_id;
  if(contact!==null&&contact!==contactId)throw new SkillLearningInvalid();
  if(value.kind==='owner'&&contact===null&&value.scene===null)return {kind:'owner',contact_id:null,scene:null};
  if(value.kind==='contact'&&contact===contactId&&value.scene===null)return {kind:'contact',contact_id:contactId,scene:null};
  if(value.kind==='scene'&&typeof value.scene==='string'&&value.scene.trim()===value.scene
    &&codePoints(value.scene)>=1&&codePoints(value.scene)<=256)
    return {kind:'scene',contact_id:contact,scene:value.scene};
  throw new SkillLearningInvalid();
}
export function editedStrategy(scope:SkillLearningScope,draft:Record<string,any>,value:unknown):NormalizedStrategy {
  if(!record(value)||!sameKeys(value,['name','description','scene','methods']))throw new SkillLearningInvalid();
  const existing=draft.strategy,evidence=draft.private_evidence;
  if(!record(existing))throw new SkillLearningInvalid();
  if(!record(evidence)||!Array.isArray(evidence.materials)||!Array.isArray(evidence.existing_skills))
    throw new SkillLearningInvalid();
  const targetIds=(draft.target_versions as Record<string,any>[]).map(item=>item.skill_id);
  const batch=finishBatch({materials:evidence.materials,targets:evidence.existing_skills,dependency_ids:[],
    library_revision:0,scope_revision:0,source_generation:{},material_budget_limited:false});
  const proposal={...value,outcome:'draft',proposal_kind:draft.proposal_kind,target_skill_ids:targetIds,
    scope_suggestion:{kind:existing.scope_suggestion.kind,reason:existing.scope_suggestion.reason}};
  const normalized=normalizeProposal(scope,batch,proposal);
  if(!normalized.proposal||normalized.proposal.logical_skill_id!==draft.logical_skill_id)throw new SkillLearningInvalid();
  if(!targetIds.length&&normalized.proposal.strategy.name!==existing.name){
    const logical=draft.logical_skill_id as string;
    for(const method of normalized.proposal.strategy.methods){
      method.logical_skill_id=logical;method.method_id=skillUuid5(logical,`method:${method.key}`);
    }
  }
  return normalized.proposal.strategy;
}
export {serializeSkillDocument};
