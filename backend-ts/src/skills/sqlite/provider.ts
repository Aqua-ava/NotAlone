/** 官方 DSH scoped provider；Skill 只提供文字，不产生业务权限或执行能力。 */
import type {Context} from '@deepseek-ai/cordis';
import {scopeOf} from '@deepseek-ai/dsh-scope';
import type SkillRegistry from '@deepseek-ai/dsh-skill';
import type {SkillCandidate,SkillProvider,SkillProviderControl} from '@deepseek-ai/dsh-skill';
import {sha256,validateResourcePath} from '../skill-package.ts';
import {SqliteSkillLibrary,SqliteSkillError,skillAnchor,type VerifiedSkillSnapshot} from './library.ts';
import {inSkillGroup,skillRunGroup,type SkillGroupScope} from './groups.ts';
import type {LoadedSkill,SkillAnchor,SkillPackageState,SkillRunProtection,SkillRunRevision,SkillRunScope} from './contracts.ts';

const providerName='notalone-sqlite-skills';
const virtualRoot='/notalone/reply-skills';
async function abortable<T>(work: Promise<T>,signal: AbortSignal): Promise<T> {
  if(signal.aborted){void work.catch(()=>{});signal.throwIfAborted();}
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
    work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
export interface SqliteSkillRunRequest {contactId: string; callId: string}
/** 打开本轮受控目录；正文仅由模型通过官方 skill 工具按需载入。 */
export async function openSqliteSkillRun(library: SqliteSkillLibrary,request: SqliteSkillRunRequest,protection: SkillRunProtection,signal?: AbortSignal): Promise<SqliteSkillRun> {
  if(!request.contactId || !request.callId || !protection?.assertCurrent || !protection.recordInput || !protection.recordSelection)throw new SqliteSkillError('skill_protection_required');
  const scope=Object.freeze({ownerId:library.ownerId,contactId:request.contactId,callId:request.callId});
  signal?.throwIfAborted();await protection.assertCurrent(scope,null,signal);
  const items=await library.list(signal),group=await library.groupScope(request.contactId,signal);
  const run=new SqliteSkillRun(library,scope,protection,items,{group},signal);
  try {
    // 打开只做数据库资格复验；目录字节在每次读取、每次模型发送和候选提交前复验，不在此重复读取全部目录。
    await run.validateQualification();
    // 选择事件在写事务内复验调用与冻结修订，无需再追加一次分离的资格检查。
    await protection.recordSelection(scope,null,signal);
    return run;
  }catch(error){run.close();throw error;}
}
export class SqliteSkillRun {
  readonly scope: SkillRunScope;
  /** 打开时冻结的联系人分组范围；之后的分配或绑定变化由资格复验拒绝。 */
  private readonly group: SkillGroupScope;
  private readonly loadedByName=new Map<string,LoadedSkill>();
  private failureReason: unknown=null;
  private readonly library: SqliteSkillLibrary;
  private readonly protection: SkillRunProtection;
  private readonly catalog: SkillPackageState[];
  private readonly controller=new AbortController();
  private unregister?: ()=>void;
  constructor(library: SqliteSkillLibrary,scope: SkillRunScope,protection: SkillRunProtection,items: SkillPackageState[],options: {group: SkillGroupScope},signal?: AbortSignal) {
    this.library=library;this.scope=scope;this.protection=protection;this.catalog=structuredClone(items);
    this.group=Object.freeze({groupId:options.group.groupId,revision:options.group.revision,packageIds:[...options.group.packageIds]});
    if(signal?.aborted)this.close();else signal?.addEventListener('abort',()=>this.close(),{once:true,signal:this.controller.signal});
  }
  get loadedSkills(): LoadedSkill[] {return structuredClone([...this.loadedByName.values()]);}
  get revision(): SkillRunRevision {return this.frozenRevision();}
  /** 官方 Tool 可能归一化异常；保留原始失败供宿主区分授权失效和策略不可读。 */
  get failure(): unknown|null {return this.failureReason;}
  /** 一次批量复验目录与全部 anchor，发送与提交共用相同资格检查。 */
  private async inspect(signal?: AbortSignal): Promise<VerifiedSkillSnapshot[]> {
    const combined=this.signal(signal);combined.throwIfAborted();
    // assertCurrent 在同一短事务核验包集合、head 与全部冻结 anchor（合同见 SkillRunProtection），
    // 前后各一次夹住目录字节读取；冻结目录与其一致，无需再读目录列表或重复分离复验。
    await abortable(this.protection.assertCurrent(this.scope,this.frozenRevision(),combined),combined);
    const verified=await this.library.readAnchorSnapshots(this.eligible().map(skillAnchor),combined,this.catalog);
    await abortable(this.protection.assertCurrent(this.scope,this.frozenRevision(),combined),combined);
    combined.throwIfAborted();return verified;
  }
  /** 仅数据库资格复验：授权、调用与冻结修订，不读目录字节。 */
  private async qualify(signal?: AbortSignal): Promise<void> {
    const combined=this.signal(signal);combined.throwIfAborted();
    await abortable(this.protection.assertCurrent(this.scope,this.frozenRevision(),combined),combined);
    combined.throwIfAborted();
  }
  /** 每次实际模型发送和业务提交前，12必须复验；registry缓存不是资格凭证。 */
  async validate(signal?: AbortSignal): Promise<void> {
    try {
      await this.inspect(signal);
    }catch(error){this.rememberFailure(error);this.close();throw error;}
  }
  /** 仅数据库资格复验，不读目录字节；用于读取前后等不出站的步骤，出站与提交仍须 validate。 */
  async validateQualification(signal?: AbortSignal): Promise<void> {
    try {
      await this.qualify(signal);
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
      await this.validateQualification(signal);
      const snapshot=await this.library.assertAnchor(anchor,this.signal(signal));
      const resource=snapshot.pkg.resources.find(r=>r.relative_path===relativePath);
      if(!resource)throw new SqliteSkillError('skill_path_invalid');
      return await this.record(anchor,loaded.name,relativePath,resource.content.toString('utf8'),signal);
    }catch(error){this.rememberFailure(error);throw error;}
  }
  async readLoadedResource(name: string,relativePath: string,signal?: AbortSignal): Promise<string> {
    const loaded=this.loadedByName.get(name);
    if(!loaded){const error=new SqliteSkillError('skill_body_required');this.rememberFailure(error);throw error;}
    return this.readResource(loaded.anchor,relativePath,signal);
  }
  close(): void {
    if(!this.controller.signal.aborted)this.controller.abort(new SqliteSkillError('skill_run_invalidated'));
    const unregister=this.unregister;this.unregister=undefined;unregister?.();
  }
  private signal(signal?: AbortSignal): AbortSignal {return signal?AbortSignal.any([this.controller.signal,signal]):this.controller.signal;}
  private rememberFailure(error: unknown): void {if(this.failureReason===null)this.failureReason=error;}
  private frozenRevision(): SkillRunRevision {
    return {packages:this.catalog.map(item=>({id:item.id,headRevision:item.headRevision})),eligible:this.eligible().map(skillAnchor),group:skillRunGroup(this.scope.contactId,this.group)};
  }
  private eligible(): SkillPackageState[] {
    const available=inSkillGroup(this.catalog.filter(item=>item.enabledState==='enabled' && item.verificationState==='verified' && item.currentRevisionNo!==null),this.group);
    return available;
  }
  private provider(control: SkillProviderControl): SkillProvider {
    if(control.signal.aborted)this.close();else control.signal.addEventListener('abort',()=>this.close(),{once:true,signal:this.controller.signal});
    this.controller.signal.addEventListener('abort',()=>control.invalidate(),{once:true});
    const candidates: SkillCandidate[]=this.eligible().map(item=>({name:item.displayName,description:item.description,provider:providerName,source:'notalone',rank:0,
      path:`${virtualRoot}/${item.displayName}/SKILL.md`,resourceBase:{kind:'opaque',description:'仅允许本次修订清单内的只读文字资源'},
      invocation:{modelInvocable:true,userInvocable:false},locator:item.id}));
    return {name:providerName,
      list:async options=>{await this.validateQualification(options.signal);return candidates;},
      get:async(candidate,options)=>{
        try{
          const trusted=candidates.find(item=>item===candidate);
          const item=this.eligible().find(item=>item.id===trusted?.locator);
          if(!trusted || !item)throw new SqliteSkillError('skill_candidate_invalid');
          await this.validateQualification(options.signal);
          const anchor=skillAnchor(item),snapshot=await this.library.assertAnchor(anchor,this.signal(options.signal));
          try{await abortable(this.protection.recordSelection(this.scope,anchor,this.signal(options.signal)),this.signal(options.signal));}
          catch(error){this.close();throw error;}
          const content=await this.record(anchor,trusted.name,'SKILL.md',snapshot.pkg.content,options.signal);
          this.signal(options.signal).throwIfAborted();
          this.loadedByName.set(trusted.name,{anchor:{...anchor},name:trusted.name,resources:snapshot.pkg.resources.map(resource=>({relativePath:resource.relative_path,mediaType:resource.media_type,bytes:resource.content.length,payloadDigest:resource.content_sha256}))});
          return {name:trusted.name,description:trusted.description,provider:providerName,source:'notalone',path:trusted.path,resourceBase:trusted.resourceBase,invocation:trusted.invocation,content};
        }catch(error){this.rememberFailure(error);throw error;}
      }};
  }
  private async record(anchor: SkillAnchor,name: string,relativePath: string,text: string,signal?: AbortSignal): Promise<string> {
    try {
      await this.validateQualification(signal);
      const combined=this.signal(signal);
      // 输入记录在写事务内复验调用、联系人、来源与冻结修订（合同见 SkillRunProtection.recordInput）。
      await abortable(this.protection.recordInput({scope:this.scope,runRevision:this.frozenRevision(),selected:{...anchor},loaded:{...anchor},relativePath,text,payloadDigest:sha256(text),name},combined),combined);
      combined.throwIfAborted();
      return text;
    }catch(error){this.rememberFailure(error);this.close();throw error;}
  }
}
function bigintJson(_key: string,value: unknown): unknown {return typeof value==='bigint'?value.toString():value;}
