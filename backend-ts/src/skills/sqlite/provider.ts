/** 官方 DSH scoped provider；Skill 只提供文字，不产生业务权限或执行能力。 */
import type {Context} from '@deepseek-ai/cordis';
import {scopeOf} from '@deepseek-ai/dsh-scope';
import type SkillRegistry from '@deepseek-ai/dsh-skill';
import type {SkillCandidate,SkillProvider,SkillProviderControl} from '@deepseek-ai/dsh-skill';
import {sha256,validateResourcePath} from '../skill-package.ts';
import {SqliteSkillLibrary,SqliteSkillError,skillAnchor} from './library.ts';
import type {DirectorySnapshot} from './library.ts';
import type {LoadedSkill,PreloadedSkill,SkillAnchor,SkillPackageState,SkillPreloadOrigin,SkillPreloadSelection,SkillPreloadTrace,SkillRunProtection,SkillRunRevision,SkillRunScope} from './contracts.ts';

const providerName='notalone-sqlite-skills';
const virtualRoot='/notalone/reply-skills';
const catalogRevision=(items: SkillPackageState[])=>JSON.stringify(items.map(i=>[i.id,i.headRevision.toString()]));
async function abortable<T>(work: Promise<T>,signal: AbortSignal): Promise<T> {
  if(signal.aborted){void work.catch(()=>{});signal.throwIfAborted();}
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
    work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
export interface SqliteSkillRunRequest {contactId: string; callId: string}
/** 多 anchor 预加载入口的可选参数；显式 selectedPackageId 优先于自动集合。 */
export interface SqliteSkillPreloadOptions {
  /** 显式兼容入口：只预加载指定单包，来源记为 explicit，与自动集合互斥。 */
  selectedPackageId?: string;
  /** 自动入口的包集合；缺省为全部 enabled+verified+current。顺序按冻结目录。 */
  preloadPackageIds?: readonly string[];
  signal?: AbortSignal;
}
/**
 * 冻结目录后按来源选出本轮 anchor；纯选择不读字节，实际内容由 assertAnchor 独立复核。
 * 显式入口只选指定单包；自动入口缺省选择全部 eligible，便于正常路径一次预加载。
 */
export function planSkillPreload(items: SkillPackageState[],options: Pick<SqliteSkillPreloadOptions,'selectedPackageId'|'preloadPackageIds'>={}): SkillPreloadSelection {
  const catalog=[...items],catalogSnapshot=catalogRevision(catalog);
  const available=catalog.filter(item=>item.enabledState==='enabled' && item.verificationState==='verified' && item.currentRevisionNo!==null);
  let origin: SkillPreloadOrigin,chosen: SkillPackageState[];
  if(options.selectedPackageId){
    origin='explicit';const item=available.find(entry=>entry.id===options.selectedPackageId);
    if(!item)throw new SqliteSkillError('skill_selection_unavailable');
    chosen=[item];
  }else{
    origin='auto_preload';
    if(options.preloadPackageIds!==undefined){
      if(!Array.isArray(options.preloadPackageIds)||options.preloadPackageIds.some(id=>typeof id!=='string'||!id))throw new SqliteSkillError('skill_preload_invalid');
      const ids=new Set(options.preloadPackageIds);
      if(ids.size!==options.preloadPackageIds.length)throw new SqliteSkillError('skill_preload_invalid');
      chosen=available.filter(item=>ids.has(item.id));
      if(chosen.length!==ids.size)throw new SqliteSkillError('skill_preload_unavailable');
    }else chosen=available;
  }
  return {origin,catalogRevision:catalogSnapshot,anchors:chosen.map(item=>skillAnchor(item))};
}
/**
 * 打开一次 Skill 运行。
 * 第四个参数传字符串（或省略）时保持旧的显式单包兼容入口；传参数对象时进入多 anchor
 * 预加载入口：全部正文读取并写入实际输入后才返回，任一 anchor 失效即整体失败。
 */
export function openSqliteSkillRun(library: SqliteSkillLibrary,request: SqliteSkillRunRequest,protection: SkillRunProtection,selectedPackageId?: string,signal?: AbortSignal): Promise<SqliteSkillRun>;
export function openSqliteSkillRun(library: SqliteSkillLibrary,request: SqliteSkillRunRequest,protection: SkillRunProtection,options: SqliteSkillPreloadOptions): Promise<SqliteSkillRun>;
export async function openSqliteSkillRun(library: SqliteSkillLibrary,request: SqliteSkillRunRequest,protection: SkillRunProtection,selection?: string|SqliteSkillPreloadOptions,signal?: AbortSignal): Promise<SqliteSkillRun> {
  if(selection!==undefined && typeof selection==='object')return openSqliteSkillPreload(library,request,protection,selection);
  return openSqliteSkillRunLegacy(library,request,protection,selection,signal);
}
/** 多 anchor 预加载的显式入口；与 openSqliteSkillRun 的对象参数形式等价。 */
export function openSqliteSkillPreload(library: SqliteSkillLibrary,request: SqliteSkillRunRequest,protection: SkillRunProtection,options: SqliteSkillPreloadOptions={}): Promise<SqliteSkillRun> {
  return openPreloadedRun(library,request,protection,options);
}
async function openSqliteSkillRunLegacy(library: SqliteSkillLibrary,request: SqliteSkillRunRequest,protection: SkillRunProtection,selectedPackageId?: string,signal?: AbortSignal): Promise<SqliteSkillRun> {
  if(!request.contactId || !request.callId || !protection?.assertCurrent || !protection.recordInput || !protection.recordSelection)throw new SqliteSkillError('skill_protection_required');
  const scope=Object.freeze({ownerId:library.ownerId,contactId:request.contactId,callId:request.callId});
  signal?.throwIfAborted();await protection.assertCurrent(scope,null,signal);
  const items=await library.list(signal);
  const available=items.filter(item=>item.enabledState==='enabled' && item.verificationState==='verified' && item.currentRevisionNo!==null);
  for(const item of available)await library.assertAnchor(skillAnchor(item),signal);
  const selected=selectedPackageId?available.find(item=>item.id===selectedPackageId):undefined;
  if(selectedPackageId && !selected)throw new SqliteSkillError('skill_selection_unavailable');
  const run=new SqliteSkillRun(library,scope,protection,items,{selected:selected?skillAnchor(selected):null},signal);
  try {
    await run.validate();
    await protection.recordSelection(scope,run.selection,signal);
    await run.validate();
    return run;
  }catch(error){run.close();throw error;}
}
async function openPreloadedRun(library: SqliteSkillLibrary,request: SqliteSkillRunRequest,protection: SkillRunProtection,options: SqliteSkillPreloadOptions): Promise<SqliteSkillRun> {
  if(!request.contactId || !request.callId || !protection?.assertCurrent || !protection.recordInput || !protection.recordSelection)throw new SqliteSkillError('skill_protection_required');
  const signal=options.signal,scope=Object.freeze({ownerId:library.ownerId,contactId:request.contactId,callId:request.callId});
  signal?.throwIfAborted();await protection.assertCurrent(scope,null,signal);
  const items=await library.list(signal);
  const plan=planSkillPreload(items,options);
  // 每个 anchor 独立复验 package、修订、目录身份及 manifest/content digest；任一失败不读正文。
  for(const anchor of plan.anchors)await library.assertAnchor(anchor,signal);
  const projection=plan.origin==='explicit'||plan.anchors.length===1?plan.anchors[0]??null:null;
  const run=new SqliteSkillRun(library,scope,protection,items,{selected:projection,preload:{origin:plan.origin,anchors:plan.anchors}},signal);
  try {
    await run.validate();
    await run.preload(signal);
    await run.validate();
    return run;
  }catch(error){run.close();throw error;}
}
export class SqliteSkillRun {
  readonly scope: SkillRunScope;
  private readonly selected: SkillAnchor | null;
  private readonly preloadPlan: {origin: SkillPreloadOrigin;anchors: SkillAnchor[]} | null;
  private readonly loadedByName=new Map<string,LoadedSkill>();
  private readonly preloadedByName=new Map<string,PreloadedSkill>();
  private failureReason: unknown=null;
  private readonly library: SqliteSkillLibrary;
  private readonly protection: SkillRunProtection;
  private readonly catalog: SkillPackageState[];
  private readonly catalogIdentity: string;
  private readonly controller=new AbortController();
  private preloadStarted=false;
  private unregister?: ()=>void;
  constructor(library: SqliteSkillLibrary,scope: SkillRunScope,protection: SkillRunProtection,items: SkillPackageState[],options: {selected?: SkillAnchor|null;preload?: {origin: SkillPreloadOrigin;anchors: readonly SkillAnchor[]}}={},signal?: AbortSignal) {
    this.library=library;this.scope=scope;this.protection=protection;this.catalog=structuredClone(items);this.catalogIdentity=catalogRevision(items);
    this.selected=options.selected?Object.freeze({...options.selected}):null;
    this.preloadPlan=options.preload?{origin:options.preload.origin,anchors:options.preload.anchors.map(anchor=>Object.freeze({...anchor}))}:null;
    if(signal?.aborted)this.close();else signal?.addEventListener('abort',()=>this.close(),{once:true,signal:this.controller.signal});
  }
  /** 单值兼容投影：显式定向或唯一预加载 anchor；多个自动预加载时没有单值可投影。 */
  get selection(): SkillAnchor|null {return this.selected?{...this.selected}:null;}
  /** 本轮冻结目录快照的摘要，用于追踪自动/显式来源的同一目录。 */
  get catalogRevision(): string {return this.catalogIdentity;}
  /** 预加载来源；旧兼容入口不预加载正文时为 null。 */
  get preloadOrigin(): SkillPreloadOrigin|null {return this.preloadPlan?.origin??null;}
  /** 本轮完整预加载选择；旧兼容入口不预加载正文时为 null。 */
  get preloadSelection(): SkillPreloadSelection|null {
    if(!this.preloadPlan)return null;
    return {origin:this.preloadPlan.origin,catalogRevision:this.catalogIdentity,anchors:this.preloadPlan.anchors.map(anchor=>({...anchor}))};
  }
  /** 预加载正文只来自打开运行前成功读取的完整内容，失败时不保留任何部分正文。 */
  get preloadedSkills(): PreloadedSkill[] {return structuredClone([...this.preloadedByName.values()]);}
  get loadedSkills(): LoadedSkill[] {return structuredClone([...this.loadedByName.values()]);}
  get revision(): SkillRunRevision {return this.frozenRevision();}
  /** 官方 Tool 可能归一化异常；保留原始失败供宿主区分授权失效和策略不可读。 */
  get failure(): unknown|null {return this.failureReason;}
  /** 每次实际模型发送和业务提交前，12必须复验；registry缓存不是资格凭证。 */
  async validate(signal?: AbortSignal): Promise<void> {
    try {
      const combined=this.signal(signal);combined.throwIfAborted();
      await abortable(this.protection.assertCurrent(this.scope,this.frozenRevision(),combined),combined);
      if(catalogRevision(await this.library.list(combined))!==this.catalogIdentity)throw new SqliteSkillError('skill_run_invalidated');
      for(const item of this.eligible())await this.library.assertAnchor(skillAnchor(item),combined);
      await abortable(this.protection.assertCurrent(this.scope,this.frozenRevision(),combined),combined);
      combined.throwIfAborted();
    }catch(error){this.rememberFailure(error);this.close();throw error;}
  }
  mount(context: Context): ()=>void {
    if(scopeOf(context)===undefined || this.unregister || this.controller.signal.aborted)throw new SqliteSkillError('skill_scope_required');
    const registry=context.get('skills') as SkillRegistry|undefined;
    if(!registry)throw new SqliteSkillError('skill_registry_unavailable');
    this.unregister=registry.registerProvider(control=>this.provider(control));
    return ()=>this.close();
  }
  async readResource(anchor: SkillAnchor,relativePath: string,signal?: AbortSignal): Promise<string> {
    try{
      const item=this.eligible().find(item=>item.id===anchor.packageId);
      if(!item || JSON.stringify(skillAnchor(item),bigintJson)!==JSON.stringify(anchor,bigintJson))throw new SqliteSkillError('skill_candidate_invalid');
      const loaded=this.loadedByName.get(item.displayName);
      if(!loaded || JSON.stringify(loaded.anchor,bigintJson)!==JSON.stringify(anchor,bigintJson))throw new SqliteSkillError('skill_body_required');
      try{validateResourcePath(relativePath);}catch{throw new SqliteSkillError('skill_path_invalid');}
      if(!loaded.resources.some(resource=>resource.relativePath===relativePath))throw new SqliteSkillError('skill_path_invalid');
      await this.validate(signal);
      const snapshot=await this.library.assertAnchor(anchor,this.signal(signal));
      const resource=snapshot.pkg.resources.find(r=>r.relative_path===relativePath);
      if(!resource)throw new SqliteSkillError('skill_path_invalid');
      const preload=this.preloadedByName.has(loaded.name)&&this.preloadPlan?{origin:this.preloadPlan.origin,catalogRevision:this.catalogIdentity}:undefined;
      return await this.record(anchor,loaded.name,relativePath,resource.content.toString('utf8'),signal,preload);
    }catch(error){this.rememberFailure(error);throw error;}
  }
  async readLoadedResource(name: string,relativePath: string,signal?: AbortSignal): Promise<string> {
    const loaded=this.loadedByName.get(name);
    if(!loaded){const error=new SqliteSkillError('skill_body_required');this.rememberFailure(error);throw error;}
    return this.readResource(loaded.anchor,relativePath,signal);
  }
  /**
   * 多 anchor 预加载：先逐 anchor 独立复验并读取全部正文，全部通过后才记录选择和实际输入。
   * 由多 anchor 打开入口调用一次；任一读取或写入失败即关闭运行且不保留已读正文，
   * 调用方沿整体无 Skill 降级处理。重复调用或旧兼容运行拒绝。
   */
  async preload(signal?: AbortSignal): Promise<void> {
    if(!this.preloadPlan || this.preloadStarted || this.controller.signal.aborted)throw new SqliteSkillError('skill_run_invalidated');
    this.preloadStarted=true;
    const anchors=this.preloadPlan.anchors;
    const snapshots: {anchor: SkillAnchor;name: string;snapshot: DirectorySnapshot}[]=[];
    try {
      for(const anchor of anchors){
        const item=this.eligible().find(entry=>entry.id===anchor.packageId);
        if(!item)throw new SqliteSkillError('skill_candidate_invalid');
        // 独立复验 package、revision、目录身份、manifest digest 和 content digest。
        const snapshot=await this.library.assertAnchor(anchor,this.signal(signal));
        snapshots.push({anchor:{...anchor},name:item.displayName,snapshot});
      }
      this.signal(signal).throwIfAborted();
    }catch(error){this.rememberFailure(error);this.close();throw error;}
    const preloaded: PreloadedSkill[]=[];
    const trace:SkillPreloadTrace={origin:this.preloadPlan.origin,catalogRevision:this.catalogIdentity};
    try {
      for(const target of snapshots)await this.protection.recordSelection(this.scope,{...target.anchor},this.signal(signal),{name:target.name,preload:trace});
      for(const target of snapshots){
        const content=await this.record(target.anchor,target.name,'SKILL.md',target.snapshot.pkg.content,signal,trace);
        preloaded.push({anchor:{...target.anchor},name:target.name,content,
          resources:target.snapshot.pkg.resources.map(resource=>({relativePath:resource.relative_path,mediaType:resource.media_type,bytes:resource.content.length,payloadDigest:resource.content_sha256}))});
      }
    }catch(error){this.rememberFailure(error);this.close();throw error;}
    for(const skill of preloaded){
      this.loadedByName.set(skill.name,{anchor:{...skill.anchor},name:skill.name,resources:structuredClone(skill.resources)});
      this.preloadedByName.set(skill.name,structuredClone(skill));
    }
  }
  close(): void {
    if(!this.controller.signal.aborted)this.controller.abort(new SqliteSkillError('skill_run_invalidated'));
    const unregister=this.unregister;this.unregister=undefined;unregister?.();
  }
  private signal(signal?: AbortSignal): AbortSignal {return signal?AbortSignal.any([this.controller.signal,signal]):this.controller.signal;}
  private rememberFailure(error: unknown): void {if(this.failureReason===null)this.failureReason=error;}
  private frozenRevision(): SkillRunRevision {
    return {packages:this.catalog.map(item=>({id:item.id,headRevision:item.headRevision})),eligible:this.eligible().map(skillAnchor)};
  }
  private eligible(): SkillPackageState[] {
    const available=this.catalog.filter(item=>item.enabledState==='enabled' && item.verificationState==='verified' && item.currentRevisionNo!==null);
    const plan=this.preloadPlan;
    if(plan)return available.filter(item=>plan.anchors.some(anchor=>anchor.packageId===item.id));
    const selected=this.selected;
    return selected?available.filter(item=>item.id===selected.packageId):available;
  }
  private provider(control: SkillProviderControl): SkillProvider {
    if(control.signal.aborted)this.close();else control.signal.addEventListener('abort',()=>this.close(),{once:true,signal:this.controller.signal});
    this.controller.signal.addEventListener('abort',()=>control.invalidate(),{once:true});
    const candidates: SkillCandidate[]=this.eligible().map(item=>({name:item.displayName,description:item.description,provider:providerName,source:'notalone',rank:0,
      path:`${virtualRoot}/${item.displayName}/SKILL.md`,resourceBase:{kind:'opaque',description:'仅允许本次修订清单内的只读文字资源'},
      invocation:{modelInvocable:true,userInvocable:false},locator:item.id}));
    return {name:providerName,
      list:async options=>{await this.validate(options.signal);return candidates;},
      get:async(candidate,options)=>{
        try{
          const trusted=candidates.find(item=>item===candidate);
          const item=this.eligible().find(item=>item.id===trusted?.locator);
          if(!trusted || !item)throw new SqliteSkillError('skill_candidate_invalid');
          await this.validate(options.signal);
          const preloaded=this.preloadedByName.get(trusted.name);
          if(preloaded){
            this.signal(options.signal).throwIfAborted();
            return {name:trusted.name,description:trusted.description,provider:providerName,source:'notalone',path:trusted.path,resourceBase:trusted.resourceBase,invocation:trusted.invocation,content:preloaded.content};
          }
          const anchor=skillAnchor(item),snapshot=await this.library.assertAnchor(anchor,this.signal(options.signal));
          if(!this.selected){
            try{await abortable(this.protection.recordSelection(this.scope,anchor,this.signal(options.signal)),this.signal(options.signal));}
            catch(error){this.close();throw error;}
          }
          const content=await this.record(anchor,trusted.name,'SKILL.md',snapshot.pkg.content,options.signal);
          this.signal(options.signal).throwIfAborted();
          this.loadedByName.set(trusted.name,{anchor:{...anchor},name:trusted.name,resources:snapshot.pkg.resources.map(resource=>({relativePath:resource.relative_path,mediaType:resource.media_type,bytes:resource.content.length,payloadDigest:resource.content_sha256}))});
          return {name:trusted.name,description:trusted.description,provider:providerName,source:'notalone',path:trusted.path,resourceBase:trusted.resourceBase,invocation:trusted.invocation,content};
        }catch(error){this.rememberFailure(error);throw error;}
      }};
  }
  private async record(anchor: SkillAnchor,name: string,relativePath: string,text: string,signal?: AbortSignal,preload?: SkillPreloadTrace): Promise<string> {
    try {
      await this.validate(signal);
      const combined=this.signal(signal);
      await abortable(this.protection.recordInput({scope:this.scope,runRevision:this.frozenRevision(),selected:{...anchor},loaded:{...anchor},relativePath,text,payloadDigest:sha256(text),name,...(preload?{preload:{...preload}}:{})},combined),combined);
      await this.validate(signal);
      return text;
    }catch(error){this.rememberFailure(error);this.close();throw error;}
  }
}
function bigintJson(_key: string,value: unknown): unknown {return typeof value==='bigint'?value.toString():value;}
