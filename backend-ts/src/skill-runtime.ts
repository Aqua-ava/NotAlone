/** 每次回复独占的 Skill 读取视图；不接受模型提供的业务范围。 */
import {createHash} from 'node:crypto';
import type {SkillUse,SkillUseMetadata} from './skill-port.ts';
import {SkillFileError} from './skill-files.ts';
export interface SkillScope {readonly ownerId:string;readonly contactId:string;readonly scene:string}
export interface SkillEntry {readonly skillId:string;readonly versionId:string;readonly name:string;readonly description:string;readonly contentHash:string;readonly resourcePaths:readonly string[]}
export interface SkillCatalog {readonly revision:string;readonly entries:readonly SkillEntry[]}
/** port 负责事务范围、来源和文件完整性；contentHash 是不可变文档摘要；port 另须复验 execution_view。 */
export interface SkillReadPort {
 dispose?():void;
 catalog(scope:SkillScope,signal?:AbortSignal):Promise<SkillCatalog>;
 loadVersion(scope:SkillScope,entry:SkillEntry,revision:string,signal?:AbortSignal):Promise<{content:string;contentHash:string}>;
 resource(scope:SkillScope,entry:SkillEntry,revision:string,path:string,signal?:AbortSignal):Promise<{content:Uint8Array}>;
 validate(scope:SkillScope,revision:string,selected:SkillEntry|null,signal?:AbortSignal):Promise<void>;
 captureUse?(scope:SkillScope,entry:SkillEntry,revision:string,metadata:SkillUseMetadata,signal?:AbortSignal):Promise<SkillUse>;
}
async function abortable<T>(work:Promise<T>,signal?:AbortSignal):Promise<T>{
 if(!signal)return work;
 if(signal.aborted){void work.catch(()=>{});signal.throwIfAborted();}
 return new Promise<T>((resolve,reject)=>{
  const abort=()=>reject(signal.reason);
  signal.addEventListener('abort',abort,{once:true});
  work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
 });
}
export const SKILL_VIRTUAL_ROOT='/notalone/reply-skills';
export class SkillRuntimeError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
export class SkillRuntime {
 private readonly controller=new AbortController();
 private selected:SkillEntry|null=null;
 private loaded=false;
 private readonly resources=new Set<string>();
 private resourceFailed=false;
 private executionHash:string|null=null;
 private readonly port:SkillReadPort;
 private readonly modelVersionId:(versionId:string)=>string;
 readonly scope:SkillScope;
 readonly catalog:SkillCatalog;
 private constructor(port:SkillReadPort,scope:SkillScope,catalog:SkillCatalog,modelVersionId:(versionId:string)=>string,signal?:AbortSignal){
  this.port=port;this.scope=Object.freeze({...scope});this.modelVersionId=modelVersionId;
  this.catalog=Object.freeze({revision:catalog.revision,entries:Object.freeze(catalog.entries.map(e=>Object.freeze({...e,resourcePaths:Object.freeze([...e.resourcePaths])})))});
  if(signal){if(signal.aborted)this.cancel();else signal.addEventListener('abort',()=>this.cancel(),{once:true,signal:this.controller.signal});}
 }
 static async open(port:SkillReadPort,scope:SkillScope,signal?:AbortSignal,modelVersionId?:(versionId:string)=>string){
  signal?.throwIfAborted();const frozenScope=Object.freeze({...scope});
  let catalog:SkillCatalog;
  try{catalog=await abortable(port.catalog(frozenScope,signal),signal);signal?.throwIfAborted();}
  catch(error){port.dispose?.();throw error;}
  const names=new Set<string>();
  for(const e of catalog.entries){if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(e.name)||names.has(e.name)){port.dispose?.();throw new SkillRuntimeError('skill_catalog_invalid');}names.add(e.name);}
  const aliases=new Map<string,string>();
  const render=modelVersionId??((versionId:string)=>{let alias=aliases.get(versionId);if(!alias){alias=`k${aliases.size+1}`;aliases.set(versionId,alias);}return alias;});
  const run=new SkillRuntime(port,frozenScope,catalog,render,signal);await run.validate();return run;
 }
 get signal(){return this.controller.signal;}
 get loadedResourcePaths():readonly string[]{return Object.freeze([...this.resources]);}
 get loadState():'unused'|'loaded'|'resource_failed'{return this.resourceFailed?'resource_failed':this.loaded?'loaded':'unused';}
 async captureUse(metadata:Pick<SkillUseMetadata,'selection_method'|'selection_reason'>={},signal?:AbortSignal):Promise<SkillUse|null>{
  await this.validate(signal);
  if(!this.loaded||!this.selected||this.resourceFailed)return null;
  if(!this.port.captureUse)throw new SkillRuntimeError('skill_receipt_unavailable');
  const receipt=await abortable(this.port.captureUse(this.scope,this.selected,this.catalog.revision,{...metadata,resource_paths:[...this.resources],load_state:this.resourceFailed?'resource_failed':'loaded'},this.combined(signal)),this.combined(signal));
  await this.validate(signal);return receipt;
 }
 get usedVersionId(){return this.loaded?this.selected?.versionId??null:null;}
 cancel(){this.selected=null;this.loaded=false;this.resources.clear();this.resourceFailed=false;this.executionHash=null;this.controller.abort(new SkillRuntimeError('skill_run_invalidated'));this.port.dispose?.();}
 async validate(signal?:AbortSignal){
  this.signal.throwIfAborted();signal?.throwIfAborted();
  try{await abortable(this.port.validate(this.scope,this.catalog.revision,this.selected,this.combined(signal)),this.combined(signal));this.signal.throwIfAborted();signal?.throwIfAborted();}
  catch(error){this.cancel();throw error;}
 }
 private combined(signal?:AbortSignal){return signal?AbortSignal.any([this.signal,signal]):this.signal;}
 async readFile(path:string,offset=0,limit=1000,signal?:AbortSignal):Promise<string>{
  this.signal.throwIfAborted();signal?.throwIfAborted();
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>1000)throw new SkillRuntimeError('skill_page_invalid');
  const prefix=SKILL_VIRTUAL_ROOT+'/';
  if(typeof path!=='string'||!path.startsWith(prefix))throw new SkillRuntimeError('skill_path_invalid');
  const parts=path.slice(prefix.length).split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||p.includes('\\')||p.includes('\0')))throw new SkillRuntimeError('skill_path_invalid');
  const entry=this.catalog.entries.find(e=>e.name===parts[0]),relative=parts.slice(1).join('/');
  if(!entry || relative!=='SKILL.md'&&(!/^(references|assets)\//.test(relative)||!entry.resourcePaths.includes(relative)))throw new SkillRuntimeError('skill_path_invalid');
  if(this.selected&&this.selected.versionId!==entry.versionId)throw new SkillRuntimeError('second_skill_load');
  if(relative!=='SKILL.md'&&!this.loaded)throw new SkillRuntimeError('skill_body_required');
  // 在首次 await 之前占用版本，防止并行读取混用两个策略。
  this.selected=entry;
  try{
   await this.validate(signal);
   if(relative==='SKILL.md'){
    const value=await abortable(this.port.loadVersion(this.scope,entry,this.catalog.revision,this.combined(signal)),this.combined(signal));
    const hash=createHash('sha256').update(value.content).digest('hex');
    if(value.contentHash!==entry.contentHash||this.executionHash!==null&&this.executionHash!==hash)throw new SkillRuntimeError('skill_content_changed');
    this.executionHash=hash;
    await this.validate(signal);this.loaded=true;
    const lines=value.content.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);if(lines.at(-1)==='')lines.pop();
    return '[NotAlone Skill 读取回执]\n'+JSON.stringify({used_skill_version_id:this.modelVersionId(entry.versionId)})+'\n\n'+lines.slice(offset,offset+limit).join('\n');
   }
   const value=await abortable(this.port.resource(this.scope,entry,this.catalog.revision,relative,this.combined(signal)),this.combined(signal));
   let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(value.content);}catch{throw new SkillFileError();}
   await this.validate(signal);this.resources.add(relative);return text;
  }catch(error){
   if(relative!=='SKILL.md'&&this.loaded&&error instanceof SkillFileError){
    await this.validate(signal);this.resourceFailed=true;
    return '[Skill 辅助资源不可用；停止读取辅助资源，直接基于当前上下文生成候选]';
   }
   this.cancel();throw error;
  }
 }
}
